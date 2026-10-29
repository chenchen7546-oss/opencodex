/** Synthetic container acceptance. Refuses to seed unless explicitly enabled in a fresh test volume. */
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateConfigCandidate } from "../../src/config/diagnostics";

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
check(process.env.OCX_CUSTOM_SMOKE === "1", "Test opt-in is required");
const home = process.env.OPENCODEX_HOME!;
const marker = join(home, "custom-smoke.json");
const configPath = join(home, "config.json");
const mode = process.argv[2];
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

if (mode === "seed") {
  const original = JSON.parse(readFileSync(configPath, "utf8"));
  const shipped = JSON.parse(readFileSync("docker/custom/config.json", "utf8"));
  check(
    JSON.stringify(original) === JSON.stringify(shipped),
    "Refusing to replace a non-fresh config",
  );
  const provider = {
    adapter: "openai-chat",
    baseUrl: "http://upstream.fixture.test/v1",
    authMode: "key",
    apiKey: "fixture-upstream-key",
    models: ["fixture-model"],
    liveModels: false,
    requestPacing: { enabled: true, maxConcurrentRequests: 1 },
  };
  const config = {
    ...original,
    providers: {
      "fixture-a": provider,
      "fixture-b": { ...provider, apiKey: "fixture-upstream-key-b" },
    },
    defaultProvider: "fixture-a",
  };
  check(validateConfigCandidate(config).ok, "Invalid synthetic config");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(
    marker,
    JSON.stringify({ tokenHash: hash(join(home, "service-api-token")) }),
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  console.log("Synthetic providers seeded; no real account credentials used.");
} else {
  const saved = JSON.parse(readFileSync(marker, "utf8"));
  check(
    hash(join(home, "service-api-token")) === saved.tokenHash,
    "Service token changed",
  );
  check(process.getuid?.() !== 0, "Container must not run as root");
  const admin = readFileSync(join(home, "admin-api-token"), "utf8").trim();
  const dataToken = readFileSync(
    join(home, "service-api-token"),
    "utf8",
  ).trim();
  const origin = "http://127.0.0.1:10100";
  async function api(path = "", method = "GET", body?: unknown) {
    const response = await fetch(`${origin}/api/proxy-manager${path}`, {
      method,
      signal: AbortSignal.timeout(20_000),
      headers: {
        "x-opencodex-api-key": admin,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    check(response.ok, `Management request failed (${response.status})`);
    return response.json();
  }
  if (mode === "persisted") {
    const snapshot = await api();
    check(
      snapshot.profiles.length === 2 &&
        snapshot.core.installed &&
        !snapshot.core.running,
      "Profiles/core restart state changed",
    );
    for (const account of snapshot.accounts.filter(
      (row: { account: { kind: string } }) => row.account.kind === "key",
    ))
      check(
        account.choice.proxyId === saved.nativeId,
        "Account binding lost after recreation",
      );
    const traffic = await api("/traffic?days=30");
    check(
      JSON.stringify(traffic.totals) === JSON.stringify(saved.totals),
      "Traffic changed across recreation",
    );
    for (const path of [
      configPath,
      join(home, "service-api-token"),
      join(home, "proxy-manager/state.sqlite"),
    ])
      check(
        (statSync(path).mode & 0o777) === 0o600,
        "Private state permissions changed",
      );
    console.log(
      "PASS: recreation retains bindings, traffic and token; core remains lazy.",
    );
  } else if (mode === "exercise") {
    const noAuth = await fetch(`${origin}/api/proxy-manager`);
    await noAuth.body?.cancel();
    check(
      noAuth.status === 401 || noAuth.status === 403,
      "Management accepted missing credentials",
    );
    const dataAuth = await fetch(`${origin}/api/proxy-manager`, {
      headers: { "x-opencodex-api-key": dataToken },
    });
    await dataAuth.body?.cancel();
    check(
      dataAuth.status === 401 || dataAuth.status === 403,
      "Data token admitted to proxy management",
    );
    const before = await api();
    check(
      before.core.installed && !before.core.running,
      "Core should be installed but idle",
    );
    let calls = 0;
    let connections = 0;
    let tunnels = 0;
    const sockets = new Set<import("node:net").Socket>();
    function proxy(label: string) {
      return createServer((socket) => {
        connections++;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        let buffer = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([
            buffer,
            typeof chunk === "string" ? Buffer.from(chunk) : chunk,
          ]);
          if (buffer.length > 1024 * 1024) return socket.destroy();
          let boundary = buffer.indexOf("\r\n\r\n");
          if (boundary < 0) return;
          if (buffer.subarray(0, 8).toString() === "CONNECT ") {
            tunnels++;
            buffer = buffer.subarray(boundary + 4);
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            boundary = buffer.indexOf("\r\n\r\n");
            if (boundary < 0) return;
          }
          const headers = buffer.subarray(0, boundary).toString();
          const length = Number(
            /content-length:\s*(\d+)/i.exec(headers)?.[1] ?? 0,
          );
          if (buffer.length < boundary + 4 + length) return;
          calls++;
          const completion = {
            id: "fixture",
            object: "chat.completion",
            model: "fixture-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: label },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
          const request = JSON.parse(
            buffer.subarray(boundary + 4, boundary + 4 + length).toString() ||
              "{}",
          );
          const streaming = request.stream === true;
          const events = [
            {
              ...completion,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: label },
                  finish_reason: null,
                },
              ],
            },
            {
              ...completion,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ];
          const body = streaming
            ? events
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join("") + "data: [DONE]\n\n"
            : JSON.stringify(completion);
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Type: ${streaming ? "text/event-stream" : "application/json"}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
        });
      });
    }
    const first = proxy("via-native-proxy"),
      second = proxy("via-mihomo-proxy");
    await Promise.all(
      [first, second].map(
        (server) =>
          new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
          ),
      ),
    );
    const port = (server: ReturnType<typeof proxy>) =>
      (server.address() as { port: number }).port;
    try {
      const native = await api("/profiles", "POST", {
        name: "Native fixture",
        url: `http://127.0.0.1:${port(first)}`,
      });
      const advanced = await api("/import", "POST", {
        urls: [
          {
            name: "Core fixture",
            type: "http",
            server: "127.0.0.1",
            port: port(second),
          },
        ],
      });
      const accounts = before.accounts.filter(
        (row: { account: { kind: string } }) => row.account.kind === "key",
      );
      check(accounts.length === 2, "Synthetic accounts missing");
      for (const row of accounts)
        await api("/bindings", "PUT", {
          accounts: [row.account],
          choice: {
            mode: "proxy",
            proxyId:
              row.account.provider === "fixture-a"
                ? native.id
                : advanced.ids[0],
          },
        });
      async function model(provider: string) {
        const response = await fetch(`${origin}/v1/responses`, {
          method: "POST",
          signal: AbortSignal.timeout(25_000),
          headers: {
            "x-opencodex-api-key": dataToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: `${provider}/fixture-model`,
            input: "Synthetic fixture only",
            stream: false,
          }),
        });
        return { status: response.status, body: await response.text() };
      }
      const direct = await model("fixture-a");
      check(
        direct.status === 200 && direct.body.includes("via-native-proxy"),
        `HTTP proxy model request failed (${direct.status})`,
      );
      const core = await model("fixture-b");
      if (core.status !== 200) {
        const code = core.body.match(/proxy_[a-z_]+/)?.[0] ?? "unclassified";
        console.error(
          `Mihomo fixture diagnostic: ${code}; coreRunning=${(await api()).core.running}; proxyCalls=${calls}`,
        );
        console.error(
          `Synthetic proxy connections=${connections}; CONNECTs=${tunnels}`,
        );
      }
      check(
        core.status === 200 && core.body.includes("via-mihomo-proxy"),
        `Mihomo model request failed (${core.status})`,
      );
      check((await api()).core.running, "Mihomo did not start");
      for (let attempt = 0; attempt < 20; attempt++) {
        const useFirst = attempt % 2 === 0;
        await api(`/profiles/${advanced.ids[0]}`, "PATCH", {
          nodeInput: {
            name: "Core fixture",
            type: "http",
            server: "127.0.0.1",
            port: port(useFirst ? first : second),
          },
        });
        const updated = await model("fixture-b");
        if (updated.status !== 200) {
          console.error(
            `Synthetic core restart attempt=${attempt}; connections=${connections}; tunnels=${tunnels}; calls=${calls}`,
          );
        }
        check(
          updated.status === 200 &&
            updated.body.includes(
              useFirst ? "via-native-proxy" : "via-mihomo-proxy",
            ),
          `Core profile update failed (${updated.status})`,
        );
      }
      await api("/bindings", "PUT", {
        accounts: accounts.map((row: { account: unknown }) => row.account),
        choice: { mode: "proxy", proxyId: native.id },
      });
      const reassigned = await model("fixture-b");
      check(
        reassigned.status === 200 &&
          reassigned.body.includes("via-native-proxy"),
        "Bulk binding did not change the egress",
      );
      await api(`/profiles/${native.id}`, "PATCH", { enabled: false });
      const sent = calls;
      const denied = await model("fixture-a");
      check(
        denied.status >= 400 && calls === sent,
        "Disabled proxy did not refuse the model request",
      );
      const traffic = await api("/traffic?days=30");
      check(
        traffic.totals.length === 2 &&
          traffic.totals.every(
            (row: { upload: number; download: number }) =>
              row.upload > 0 && row.download > 0,
          ),
        "Traffic counters missing",
      );
      writeFileSync(
        marker,
        JSON.stringify({
          ...saved,
          nativeId: native.id,
          totals: traffic.totals,
        }),
        { mode: 0o600 },
      );
      console.log(
        "PASS: admin boundary, HTTP + Mihomo model routing, cross-provider bulk binding, refusal and traffic.",
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      first.close();
      second.close();
    }
  } else throw new Error("Unknown fixture phase");
}
