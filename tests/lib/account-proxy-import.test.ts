import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { importProxy, parseSubscription } from "../../src/proxy-manager/import";
import { ProxyStore } from "../../src/proxy-manager/store";
import { ProxyManager } from "../../src/proxy-manager/service";
import { ManagedProxyCore, coreConfiguration } from "../../src/proxy-manager/core";
import { configuredOutboundFetch } from "../../src/lib/proxy-env";
import { refreshSubscription } from "../../src/proxy-manager/subscriptions";
import { accountKey, type EgressAccount } from "../../src/proxy-manager/types";

const account: EgressAccount = { kind: "key", provider: "test", id: "test-key" };
const managers: ProxyManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
});
function managerFor(store = new ProxyStore(":memory:"), core?: ManagedProxyCore) {
  const manager = new ProxyManager(store, { list: () => [{ account, label: "test" }], resolve: () => [account] }, core);
  managers.push(manager);
  return manager;
}

describe("proxy imports and protocol transport", () => {
  test("normalizes native URLs, SIP002, VMess, VLESS Reality, Trojan, HY2 and TUIC", () => {
    expect(importProxy("socks5://user:secret@127.0.0.1:1080").node).toBeUndefined();
    const ss = importProxy(`ss://${Buffer.from("aes-128-gcm:secret").toString("base64")}@proxy.test:8388#SS`);
    expect(ss.node).toMatchObject({
      type: "ss",
      cipher: "aes-128-gcm",
      password: "secret",
      server: "proxy.test",
      port: 8388,
    });
    const vm = importProxy(
      `vmess://${Buffer.from(JSON.stringify({ add: "proxy.test", port: 443, id: "00000000-0000-4000-8000-000000000000", net: "ws", tls: "tls", ps: "WS" })).toString("base64")}`,
    );
    expect(vm.node).toMatchObject({ type: "vmess", network: "ws", tls: true });
    expect(
      importProxy("vless://test-id@proxy.test:443?security=reality&pbk=test-key&sid=12&type=grpc&serviceName=svc").node,
    ).toMatchObject({
      type: "vless",
      tls: true,
      "reality-opts": { "public-key": "test-key", "short-id": "12" },
      "grpc-opts": { "grpc-service-name": "svc" },
    });
    for (const type of ["trojan", "hy2", "tuic", "anytls"])
      expect(importProxy(`${type}://user:secret@proxy.test:443`).node?.server).toBe("proxy.test");
  });
  test("subscription parsing accepts YAML and Base64 lists; external config directives are rejected", () => {
    const raw = "ss://YWVzLTEyOC1nY206c2VjcmV0@proxy.test:8388#node";
    expect(parseSubscription(Buffer.from(raw).toString("base64"))).toEqual([raw]);
    const [node] = parseSubscription(
      "proxies:\n  - name: node\n    type: trojan\n    server: proxy.test\n    port: 443\n    password: secret\n",
    );
    expect(importProxy(node).node?.type).toBe("trojan");
    expect(() => importProxy({ ...(node as object), "dialer-proxy": "DIRECT" })).toThrow(
      "unsupported_proxy_node_field",
    );
    expect(() =>
      importProxy({ type: "ssh", server: "proxy.test", port: 22, username: "user", "private-key": "/etc/secret" }),
    ).toThrow("unsupported_proxy_node_field");
    expect(() => parseSubscription("a".repeat(1048577))).toThrow("proxy_subscription_too_large");
    expect(() => importProxy("vless://id@proxy.test:443?security=unsupported")).toThrow("unsupported_proxy_uri_option");
    expect(() => importProxy("vless://id@proxy.test:443?unrecognized=value")).toThrow("unsupported_proxy_uri_option");
  });
  test("node DTOs omit credentials and listeners are authenticated loopback-only", () => {
    const manager = managerFor();
    const profile = manager.store.save(importProxy("trojan://private-node-secret@proxy.test:443#node"));
    expect(JSON.stringify(manager.store.publicProfiles())).not.toContain("private-node-secret");
    expect(manager.store.publicProfiles()[0]).toMatchObject({ nodeType: "trojan", host: "proxy.test", port: 443 });
    const config = coreConfiguration([profile], "fixture-password") as {
      listeners: Array<Record<string, unknown>>;
      rules: string[];
    };
    expect(config.listeners[0]).toMatchObject({
      listen: "127.0.0.1",
      proxy: profile.id,
      users: [{ username: "opencodex", password: "fixture-password" }],
    });
    expect(config.rules).toEqual(["MATCH,REJECT"]);
  });
  test("subscription refresh retains bound IDs and disables missing nodes atomically", async () => {
    let text =
      "proxies:\n  - {name: A, type: trojan, server: proxy.test, port: 443, password: one}\n  - {name: B, type: trojan, server: proxy.test, port: 443, password: two}";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(text) });
    const manager = managerFor();
    const source = { id: "source", name: "Source", url: `http://127.0.0.1:${server.port}`, group: "test" };
    try {
      await refreshSubscription(manager, source);
      const a = manager.store.profiles().find((p) => p.name === "A")!;
      const b = manager.store.profiles().find((p) => p.name === "B")!;
      manager.store.bind([account], { mode: "proxy", proxyId: a.id });
      // Subscription fetching uses the source's route, never an account inference binding.
      text = "proxies:\n  - {name: A, type: trojan, server: new.invalid, port: 443, password: updated}";
      await refreshSubscription(manager, source);
      expect(manager.store.profile(a.id)?.node?.password).toBe("updated");
      expect(manager.store.profile(b.id)?.enabled).toBe(false);
      expect(manager.store.choice(account)).toEqual({ mode: "proxy", proxyId: a.id });
      text = "proxies:\n - {name: A, type: invalid, server: proxy.test, port: 443}";
      await expect(refreshSubscription(manager, source)).rejects.toThrow();
      expect(manager.store.profile(a.id)?.node?.password).toBe("updated");
    } finally {
      server.stop(true);
    }
  });
  test("real SOCKS5 authentication and remote DNS reach the selected proxy", async () => {
    let requestedHost = "",
      authenticated = false;
    const server = createServer((socket) => {
      let stage = 0,
        buffer = Buffer.alloc(0);
      socket.on("data", (data) => {
        buffer = Buffer.concat([buffer, data]);
        if (stage === 0) {
          if (buffer.length < 2 + buffer[1]!) return;
          buffer = buffer.subarray(2 + buffer[1]!);
          socket.write(Buffer.from([5, 2]));
          stage = 1;
        }
        if (stage === 1) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]! + 1) return;
          const end = 3 + buffer[1]! + buffer[2 + buffer[1]!]!;
          if (buffer.length < end) return;
          authenticated = buffer.subarray(2, 2 + buffer[1]!).toString() === "user";
          buffer = buffer.subarray(end);
          socket.write(Buffer.from([1, 0]));
          stage = 2;
        }
        if (stage === 2) {
          if (buffer.length < 5) return;
          const length = buffer[3] === 3 ? buffer[4]! + 7 : 10;
          if (buffer.length < length) return;
          requestedHost = buffer.subarray(5, length - 2).toString();
          buffer = buffer.subarray(length);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          stage = 3;
        }
        if (stage === 3 && buffer.includes("\r\n\r\n")) {
          socket.end("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\npass");
          stage = 4;
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const manager = managerFor();
    const port = (server.address() as { port: number }).port;
    const profile = manager.store.save(importProxy(`socks5://user:secret@127.0.0.1:${port}`));
    manager.store.bind([account], { mode: "proxy", proxyId: profile.id });
    try {
      const response = await manager.send(
        "http://remote-only.invalid/resource",
        { signal: AbortSignal.timeout(3000) },
        configuredOutboundFetch,
      );
      expect(await response.text()).toBe("pass");
      expect(authenticated).toBe(true);
      expect(requestedHost).toBe("remote-only.invalid");
      expect(manager.traffic.rows("2000-01-01")[0]?.accountKey).toBe(accountKey(account));
    } finally {
      server.close();
    }
  });
  test.skipIf(!process.env.OCX_PROXY_CORE_TEST_BIN)(
    "real optional Mihomo process forwards through a node and protects in-flight streams",
    async () => {
      const previous = process.env.OPENCODEX_PROXY_CORE;
      process.env.OPENCODEX_PROXY_CORE = process.env.OCX_PROXY_CORE_TEST_BIN;
      const directory = mkdtempSync(join(tmpdir(), "ocx-proxy-core-"));
      const store = new ProxyStore(join(directory, "state.sqlite"));
      const core = new ManagedProxyCore(directory, () => store.profiles());
      const manager = managerFor(store, core);
      const upstream = createServer((socket) => {
        let buffered = "";
        socket.on("data", (data) => {
          buffered += data.toString();
          if (!buffered.includes("\r\n\r\n")) return;
          if (buffered.startsWith("CONNECT ")) {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            buffered = "";
          } else {
            socket.end("HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nthrough-core");
          }
        });
      });
      await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
      const profile = store.save(
        importProxy({
          name: "node",
          type: "http",
          server: "127.0.0.1",
          port: (upstream.address() as { port: number }).port,
        }),
      );
      store.bind([account], { mode: "proxy", proxyId: profile.id });
      try {
        const response = await manager.send(
          "http://unreachable.invalid/model",
          { signal: AbortSignal.timeout(15000) },
          configuredOutboundFetch,
        );
        expect(core.status()).toMatchObject({ installed: true, running: true, activeStreams: 1 });
        store.save({ ...profile, node: { ...profile.node, server: "localhost" } }, profile.id);
        await expect(core.acquire(profile.id)).rejects.toThrow("proxy_core_busy");
        expect(await response.text()).toBe("through-core");
        expect(core.status().activeStreams).toBe(0);
      } finally {
        core.close();
        upstream.close();
        manager.close();
        managers.splice(managers.indexOf(manager), 1);
        await Bun.sleep(150);
        rmSync(directory, { recursive: true, force: true });
        if (previous === undefined) delete process.env.OPENCODEX_PROXY_CORE;
        else process.env.OPENCODEX_PROXY_CORE = previous;
      }
    },
    25000,
  );
});
