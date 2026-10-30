/** Local Docker Desktop or Linux acceptance; isolated project, volumes and fake credentials only. */
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const project = `ocx-custom-test-${randomUUID().slice(0, 12)}`;
const image = process.argv[2] ?? "opencodex-custom:20261030-1";
if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image))
  throw new Error("Invalid image reference");
const env = {
  ...process.env,
  OPENCODEX_IMAGE: image,
  OPENCODEX_PLATFORM: "linux/amd64",
  OPENCODEX_PORT: "0",
  OPENCODEX_BIND_ADDRESS: "127.0.0.1",
  OPENCODEX_MEMORY_LIMIT: "640m",
  OPENCODEX_MEMORY_RESERVATION: "384m",
  OPENCODEX_MEMORY_SWAP_LIMIT: "896m",
  OPENCODEX_CPUS: "1.0",
};
const args = [
  "compose",
  "--project-name",
  project,
  "-f",
  resolve(root, "deploy/compose.yaml"),
];

async function run(command: string[], timeout = 60_000): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), timeout);
  async function read(stream: ReadableStream<Uint8Array>) {
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        child.kill();
        throw new Error("Command output exceeded limit");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString();
  }
  try {
    const [out, err, status] = await Promise.all([
      read(child.stdout),
      read(child.stderr),
      child.exited,
    ]);
    if (status !== 0) {
      // Fixtures only print fixed assertions, never token values or HTTP bodies.
      console.error(err.slice(-3000));
      throw new Error(`Docker acceptance command failed (${status})`);
    }
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}
const compose = (command: string[], timeout?: number) =>
  run(["docker", ...args, ...command], timeout);
const fixture = (mode: string, running = true) =>
  compose(
    [
      ...(running ? ["exec", "-T"] : ["run", "--rm", "-T", "--no-deps"]),
      "-e",
      "OCX_CUSTOM_SMOKE=1",
      "hub",
      "bun",
      "docker/custom/smoke-fixture.ts",
      mode,
    ],
    90_000,
  );
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const [metadata] = JSON.parse(await run(["docker", "image", "inspect", image]));
check(
  metadata.Os === "linux" && metadata.Architecture === "amd64",
  "Acceptance requires Linux amd64",
);
let idle = "";
let withCore = "";

try {
  console.log("custom-smoke: initialize isolated volumes");
  await compose([
    "run",
    "--rm",
    "-T",
    "--no-deps",
    "hub",
    "bun",
    "docker/custom/init.ts",
  ]);
  console.log(await fixture("seed", false));
  await compose([
    "run",
    "--rm",
    "-T",
    "--no-deps",
    "hub",
    "bun",
    "docker/custom/init.ts",
  ]);
  console.log("custom-smoke: start under production resource limits");
  await compose(
    ["up", "-d", "--wait", "--wait-timeout", "90", "--no-build", "hub"],
    120_000,
  );
  const id = await compose(["ps", "-q", "hub"]);
  const [container] = JSON.parse(await run(["docker", "inspect", id]));
  check(
    container.Config.Labels["com.docker.compose.project"] === project,
    "Unexpected container owner",
  );
  check(
    container.Config.User === "bun" &&
      container.HostConfig.ReadonlyRootfs &&
      !container.HostConfig.Privileged,
    "Missing container isolation",
  );
  check(
    container.HostConfig.CapDrop.includes("ALL") &&
      container.HostConfig.Memory === 640 * 1024 * 1024 &&
      container.HostConfig.MemorySwap === 896 * 1024 * 1024,
    "Resource limits not applied",
  );
  check(
    container.HostConfig.LogConfig.Config["max-size"] === "10m",
    "Log rotation missing",
  );
  const published = Object.values(container.NetworkSettings.Ports)
    .flat()
    .filter(Boolean) as Array<{
    HostIp: string;
    HostPort: string;
  }>;
  check(
    published.length === 1 && published[0]!.HostIp === "127.0.0.1",
    "Unexpected published port",
  );
  const origin = `http://127.0.0.1:${published[0]!.HostPort}`;
  for (const path of ["/healthz", "/readyz", "/"]) {
    const response = await fetch(origin + path, {
      signal: AbortSignal.timeout(10_000),
    });
    check(response.ok, `Container endpoint failed: ${path}`);
    await response.body?.cancel();
  }
  idle = await run([
    "docker",
    "stats",
    "--no-stream",
    "--format",
    "{{.MemUsage}}",
    id,
  ]);
  console.log("custom-smoke: idle", idle);
  console.log(await fixture("exercise"));
  withCore = await run([
    "docker",
    "stats",
    "--no-stream",
    "--format",
    "{{.MemUsage}}",
    id,
  ]);
  console.log("custom-smoke: with core", withCore);
  console.log("custom-smoke: recreate container and verify persistence");
  await compose(
    [
      "up",
      "-d",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "90",
      "--no-build",
      "hub",
    ],
    120_000,
  );
  console.log(await fixture("persisted"));
  console.log("custom-smoke: all acceptance checks passed");
} finally {
  // Unique random project; never prune global Docker resources or touch other applications.
  await compose(["down", "--volumes", "--timeout", "10"], 60_000);
  for (const kind of ["container", "volume", "network"]) {
    const left = await run([
      "docker",
      kind,
      "ls",
      "-q",
      ...(kind === "container" ? ["-a"] : []),
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]);
    check(!left, "Isolated test resources remain");
  }
  console.log("custom-smoke: isolated resources removed; built image retained");
}
// Reached only when acceptance AND cleanup both succeed. Never attach credentials.
mkdirSync(resolve(root, ".tmp"), { recursive: true });
const receipt = resolve(root, ".tmp/custom-docker-acceptance.json");
const temporary = `${receipt}.${randomUUID()}.tmp`;
writeFileSync(
  temporary,
  JSON.stringify(
    {
      image,
      imageId: metadata.Id,
      platform: "linux/amd64",
      passed: true,
      completedAt: new Date().toISOString(),
      memory: { idle, withCore },
      coverage: [
        "container isolation",
        "health and dashboard",
        "management authorization",
        "HTTP routing",
        "Mihomo routing",
        "cross-provider bulk assignment",
        "disabled route refusal",
        "traffic accounting",
        "recreation persistence",
        "token retention",
        "isolated resource cleanup",
      ],
      limitations:
        "Synthetic local providers; not VPS load or real provider acceptance.",
    },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
);
renameSync(temporary, receipt);
console.log("custom-smoke: acceptance receipt saved");
