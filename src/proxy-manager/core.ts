import { join } from "node:path";
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { randomBytes } from "node:crypto";
import type { Subprocess } from "bun";
import { ProxyManagerError, type ProxyProfile } from "./types";
import { waitForCoreReadiness } from "./core-readiness";
export function coreConfiguration(
  profiles: ProxyProfile[],
  password: string,
  readinessPort?: number,
): Record<string, unknown> {
  const nodes = profiles.filter((p) => p.node && p.enabled);
  return {
    mode: "rule",
    "allow-lan": false,
    "log-level": "silent",
    ipv6: true,
    listeners: [
      ...nodes.map((p) => ({
        name: p.id,
        type: "mixed",
        listen: "127.0.0.1",
        port: p.corePort,
        proxy: p.id,
        udp: false,
        users: [{ username: "opencodex", password }],
      })),
      ...(readinessPort
        ? [
            {
              name: "opencodex-readiness",
              type: "http",
              listen: "127.0.0.1",
              port: readinessPort,
              proxy: "DIRECT",
              users: [{ username: "opencodex-ready", password }],
            },
          ]
        : []),
    ],
    proxies: nodes.map((p) => ({ ...p.node, name: p.id })),
    rules: ["MATCH,REJECT"],
  };
}
async function reservePort(): Promise<{
  server: Server;
  port: number;
}> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    port: (
      server.address() as {
        port: number;
      }
    ).port,
  };
}
/** One optional process, shared across nodes. Changes wait for active response streams to drain. */
export class ManagedProxyCore {
  private child: Subprocess | undefined;
  private validating: Subprocess | undefined;
  private signature = "";
  private readonly password = randomBytes(24).toString("hex");
  private starting: Promise<void> | undefined;
  private closed = false;
  private leases = 0;
  private runtimeDirectory: string | undefined;
  private ports = new Map<string, number>();
  constructor(
    private readonly directory: string,
    private readonly profiles: () => ProxyProfile[],
  ) {}
  status(): {
    installed: boolean;
    running: boolean;
    activeStreams: number;
  } {
    return {
      installed: !!Bun.which(
        process.env.OPENCODEX_PROXY_CORE?.trim() || "mihomo",
      ),
      running: !!this.child && this.child.exitCode === null,
      activeStreams: this.leases,
    };
  }
  async acquire(id: string): Promise<{
    url: string;
    release(): void;
  }> {
    if (this.closed) throw new ProxyManagerError("proxy_core_closed", 503);
    const nodes = this.profiles().filter((p) => p.node && p.enabled);
    const profile = nodes.find((p) => p.id === id);
    if (!profile) throw new ProxyManagerError("proxy_unavailable", 503);
    const configuration = JSON.stringify(
      coreConfiguration(nodes, this.password),
    );
    if (this.starting) {
      await this.starting;
      return this.acquire(id);
    }
    if (
      !this.child ||
      this.child.exitCode !== null ||
      this.signature !== configuration
    ) {
      if (this.leases) throw new ProxyManagerError("proxy_core_busy", 503);
      const work = this.start(configuration, nodes);
      this.starting = work;
      try {
        await work;
      } finally {
        if (this.starting === work) this.starting = undefined;
      }
      return this.acquire(id);
    }
    this.leases++;
    let released = false;
    return {
      url: `http://opencodex:${this.password}@127.0.0.1:${this.ports.get(profile.id)}`,
      release: () => {
        if (!released) {
          released = true;
          this.leases--;
        }
      },
    };
  }
  private async start(
    configuration: string,
    nodes: ProxyProfile[],
  ): Promise<void> {
    const executable = process.env.OPENCODEX_PROXY_CORE?.trim() || "mihomo";
    this.runtimeDirectory ??= mkdtempSync(join(this.directory, "core-"));
    chmodSync(this.runtimeDirectory, 0o700);
    const reserved: Array<{
      server: Server;
      port: number;
    }> = [];
    try {
      for (const _node of nodes) reserved.push(await reservePort());
      reserved.push(await reservePort());
    } catch {
      for (const entry of reserved) entry.server.close();
      throw new ProxyManagerError("proxy_core_listener_failed", 503);
    }
    const releasePorts = () => {
      for (const entry of reserved) entry.server.close();
    };
    const runtimeNodes = nodes.map((p, i) => ({
      ...p,
      corePort: reserved[i]!.port,
    }));
    const readinessPort = reserved[nodes.length]!.port;
    const file = join(this.runtimeDirectory, "mihomo.json");
    let code: number;
    try {
      try {
        writeFileSync(
          file,
          JSON.stringify(
            coreConfiguration(runtimeNodes, this.password, readinessPort),
          ),
          { mode: 0o600 },
        );
        chmodSync(file, 0o600);
      } catch {
        throw new ProxyManagerError("proxy_core_config_write_failed", 503);
      }
      if (this.closed) throw new ProxyManagerError("proxy_core_closed", 503);
      try {
        this.validating = Bun.spawn(
          [executable, "-t", "-f", file, "-d", this.runtimeDirectory],
          {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
          },
        );
      } catch {
        throw new ProxyManagerError("proxy_core_not_installed", 503);
      }
      const validation = this.validating;
      const timer = setTimeout(() => validation.kill(), 10000);
      try {
        code = await validation.exited;
      } finally {
        clearTimeout(timer);
        this.validating = undefined;
      }
    } finally {
      releasePorts();
    }
    if (this.closed) throw new ProxyManagerError("proxy_core_closed", 503);
    if (code !== 0)
      throw new ProxyManagerError("proxy_core_config_rejected", 503);
    if (this.child) {
      this.child.kill();
      await this.child.exited;
      this.child = undefined;
    }
    if (this.closed) throw new ProxyManagerError("proxy_core_closed", 503);
    const child = Bun.spawn(
      [executable, "-f", file, "-d", this.runtimeDirectory],
      {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      },
    );
    this.child = child;
    const deadline = Date.now() + 5000;
    try {
      for (const profile of runtimeNodes) {
        while (true) {
          if (this.closed || child.exitCode !== null)
            throw new ProxyManagerError("proxy_core_start_failed", 503);
          try {
            const socket = await Bun.connect({
              hostname: "127.0.0.1",
              port: profile.corePort!,
              socket: {
                data() {},
                open(s) {
                  s.end();
                },
                error() {},
              },
            });
            socket.end();
            break;
          } catch {
            if (Date.now() >= deadline)
              throw new ProxyManagerError("proxy_core_start_timeout", 503);
            await Bun.sleep(50);
          }
        }
      }
      await waitForCoreReadiness(
        `http://opencodex-ready:${this.password}@127.0.0.1:${readinessPort}`,
        () => !this.closed && child.exitCode === null,
      );
      this.signature = configuration;
      this.ports = new Map(runtimeNodes.map((p) => [p.id, p.corePort!]));
    } catch (error) {
      child.kill();
      await child.exited;
      this.child = undefined;
      throw error;
    }
  }
  close(): void {
    this.closed = true;
    this.validating?.kill();
    this.child?.kill();
    this.signature = "";
    const directory = this.runtimeDirectory;
    if (directory)
      void Promise.allSettled([
        this.starting,
        this.validating?.exited,
        this.child?.exited,
      ]).then(() => {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {
          /* private runtime cache can be removed after shutdown */
        }
      });
  }
}
