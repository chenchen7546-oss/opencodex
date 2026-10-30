import { afterEach, beforeEach, expect, test } from "bun:test";
import { ProxyStore } from "../../src/proxy-manager/store";
import { ProxyManager } from "../../src/proxy-manager/service";
import { profileInput } from "../../src/proxy-manager/validation";
import { registerAccountEgress, accountEgressInit, ACCOUNT_EGRESS_SENT, type EgressAccount } from "../../src/lib/account-egress";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import { isCodexWsUpstreamResponse } from "../../src/server/responses/codex-ws-wire";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import { isNonReplayableResponse } from "../../src/lib/upstream-retry";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import { registerUpstreamRewriter, resetUpstreamRewritersForTests } from "../../src/plugins/upstream-hooks";
import { createServer } from "node:http";
import { createConnection } from "node:net";

const target = "https://chatgpt.com/backend-api/codex/responses";
const account: EgressAccount = { kind: "codex", provider: "openai", id: "fixture-a" };
const other: EgressAccount = { ...account, id: "fixture-b" };
const originalSocket = globalThis.WebSocket, originalFetch = globalThis.fetch;
const envKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let env: Record<string, string | undefined>, manager: ProxyManager, store: ProxyStore;
let first: ReturnType<ProxyStore["save"]>, second: ReturnType<ProxyStore["save"]>;
let httpProxies: unknown[];

class Socket extends EventTarget {
  static all: Socket[] = [];
  static failHandshake = false;
  static failAfterSend = false;
  readyState = 0;
  frames: any[] = [];
  constructor(readonly url: string, readonly options: { proxy?: string; headers: Record<string, string> }) {
    super(); Socket.all.push(this);
    queueMicrotask(() => {
      if (Socket.failHandshake) this.dispatchEvent(new Event("error"));
      else { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    });
  }
  send(text: string) {
    this.frames.push(JSON.parse(text));
    queueMicrotask(() => {
      if (Socket.failAfterSend) return this.close();
      const response = { id: `resp_fixture_${this.frames.length}`, status: "completed", output: [] };
      for (const type of ["response.created", "response.completed"])
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type, response }) }));
    });
  }
  close() { if (this.readyState !== 3) { this.readyState = 3; this.dispatchEvent(new Event("close")); } }
  terminate() { this.close(); }
  ref() {}
  unref() {}
}
function init(token = "fixture-a"): RequestInit {
  return { method: "POST", ...accountEgressInit({ account, purpose: "model" }), headers: {
    authorization: `Bearer ${token}`, "chatgpt-account-id": token, "thread-id": "fixture-thread",
    "user-agent": "fixture-client/1.0", originator: "fixture-client", "x-openai-internal-codex-responses-lite": "true",
  }, body: JSON.stringify({ model: "fixture-model", stream: true, store: false,
    input: [{ role: "user", content: [{ type: "input_text", text: "fixture" }] }],
    reasoning: { effort: "xhigh" }, client_metadata: { thread_id: "fixture-thread", turn_id: "fixture-turn" } }) };
}
function sender() {
  return providerFetch({ adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    "1.4.4", { providerName: "openai", dispatchOverride: (url, options, execute) => execute(url, options) });
}
beforeEach(() => {
  env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  store = new ProxyStore(":memory:");
  manager = new ProxyManager(store, { list: () => [account, other].map(account => ({ account, label: account.id })),
    resolve: (_input, init) => new Headers(init?.headers).get("authorization") === "Bearer fixture-b" ? [other] : [account] });
  first = store.save(profileInput({ name: "First", url: "http://fixture:secret@127.0.0.1:18080" }));
  second = store.save(profileInput({ name: "Second", url: "http://127.0.0.1:18081" }));
  store.bind([account], { mode: "proxy", proxyId: first.id });
  store.bind([other], { mode: "proxy", proxyId: second.id });
  registerAccountEgress({ send: (...args) => manager.send(...args), explicit: (...args) => manager.explicit(...args) });
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  httpProxies = [];
  globalThis.fetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    httpProxies.push(init?.proxy); return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }, { preconnect() {} }) as typeof fetch;
});
afterEach(() => {
  codexWsPool.dispose();
  for (const socket of Socket.all) socket.close();
  Socket.all = []; Socket.failHandshake = false; Socket.failAfterSend = false;
  globalThis.WebSocket = originalSocket; globalThis.fetch = originalFetch;
  registerAccountEgress(undefined); resetUpstreamRewritersForTests(); manager.close();
  for (const key of envKeys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
});

test("bound HTTP tunnel carries native frames, genuine client metadata and response provenance", async () => {
  process.env.ALL_PROXY = "socks5://127.0.0.1:19999";
  const response = await sender()(target, init());
  expect(isCodexWsUpstreamResponse(response)).toBe(true);
  await response.text();
  expect(Socket.all).toHaveLength(1); expect(httpProxies).toHaveLength(0);
  const socket = Socket.all[0]!;
  expect(socket.options.proxy).toBe(first.url);
  expect(socket.options.headers["user-agent"]).toBe("fixture-client/1.0");
  expect(socket.options.headers.originator).toBe("fixture-client");
  expect(socket.options.headers["x-oai-attestation"]).toBeUndefined();
  expect(socket.frames[0]).toMatchObject({ type: "response.create", model: "fixture-model", reasoning: { effort: "xhigh" },
    client_metadata: { ws_request_header_x_openai_internal_codex_responses_lite: "true" } });
  expect(socket.frames[0].input).toEqual(JSON.parse(init().body as string).input);
  expect(manager.traffic.rows("2000-01-01")[0]).toMatchObject({ proxyId: first.id, requests: 1, failures: 0 });
});

test("reused dispatcher resolves switched proxy and credential without reusing the old route", async () => {
  const send = sender();
  await (await send(target, init())).text(); await (await send(target, init())).text();
  manager.bind([account], { mode: "proxy", proxyId: second.id });
  await (await send(target, init())).text();
  expect(Socket.all.map(socket => socket.options.proxy)).toEqual([first.url, second.url]);
  expect(Socket.all[0]!.readyState).toBe(3);
  await (await send(target, init("fixture-b"))).text();
  expect(Socket.all.at(-1)!.options.proxy).toBe(second.url);
  manager.bind([account], { mode: "direct" });
  await (await send(target, init())).text();
  expect(httpProxies).toEqual([false]);
  expect(manager.traffic.rows("2000-01-01").reduce((n, row) => n + row.requests, 0)).toBe(5);
});

test("unavailable proxy refuses before any WebSocket or HTTP send", async () => {
  store.save({ ...first, enabled: false }, first.id);
  await expect(sender()(target, init())).rejects.toThrow("proxy_unavailable");
  expect(Socket.all).toHaveLength(0); expect(httpProxies).toHaveLength(0);
});

test("SOCKS and explicit direct retain their HTTP route, never the environment WS proxy", async () => {
  process.env.HTTPS_PROXY = "http://127.0.0.1:19999";
  store.bind([account], { mode: "direct" });
  await (await sender()(target, init())).text();
  const options = { ...init(), proxy: "socks5://127.0.0.1:19080", [ACCOUNT_EGRESS_SENT]: true };
  await (await codexWsUpstreamFetch(target, options, globalThis.fetch, "1.4.4")).text();
  expect(Socket.all).toHaveLength(0);
  expect(httpProxies).toEqual([false, options.proxy]);
});

test("failed handshake falls back once through the same account proxy", async () => {
  Socket.failHandshake = true;
  await (await sender()(target, init())).text();
  expect(httpProxies).toEqual([first.url]);
  expect(manager.traffic.rows("2000-01-01")[0]?.requests).toBe(1);
});

test("environment bypass keeps the managed request on enforced HTTP proxy rather than direct WS", async () => {
  process.env.NO_PROXY = "*";
  await (await sender()(target, init())).text();
  expect(Socket.all).toHaveLength(0);
  expect(httpProxies).toEqual([{ url: first.url, respectNoProxy: false }]);
});

test("a sent frame failure retains non-replayability across traffic accounting", async () => {
  Socket.failAfterSend = true;
  const response = await sender()(target, init());
  expect(isNonReplayableResponse(response)).toBe(true);
  await response.text();
  expect(httpProxies).toHaveLength(0);
});

test("a managed route cannot be rewritten to a direct loopback socket", async () => {
  registerUpstreamRewriter("fixture-rewriter", target => { target.url = target.url.replace("chatgpt.com", "127.0.0.1:19998"); });
  await expect(sender()(target, init())).rejects.toThrow();
  expect(Socket.all).toHaveLength(0); expect(httpProxies).toHaveLength(0);
});

test("real WebSocket tunnels switch between HTTP proxies without contacting an external host", async () => {
  globalThis.WebSocket = originalSocket; globalThis.fetch = originalFetch;
  const frames: Record<string, unknown>[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 }); },
    websocket: { message(socket, text) {
      frames.push(JSON.parse(String(text)));
      const response = { id: `resp_network_${frames.length}`, status: "completed", output: [] };
      socket.send(JSON.stringify({ type: "response.created", response }));
      socket.send(JSON.stringify({ type: "response.completed", response }));
    } },
  });
  const connections = new Set<{ destroy(): void }>();
  const tunnels: number[] = [];
  const proxies = [0, 1].map(index => {
    const proxy = createServer((_req, res) => { res.writeHead(502); res.end(); });
    proxy.on("connection", socket => { connections.add(socket); socket.on("close", () => connections.delete(socket)); });
    proxy.on("connect", (request, client, head) => {
      tunnels.push(index);
      const destination = createConnection({ host: "127.0.0.1", port: upstream.port! }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) destination.write(head);
        client.pipe(destination); destination.pipe(client);
      });
      connections.add(destination); destination.on("close", () => connections.delete(destination));
      destination.on("error", () => client.destroy()); client.on("error", () => destination.destroy());
      client.on("close", () => destination.destroy());
    });
    // Unencrypted ws:// uses an absolute-form Upgrade rather than a CONNECT tunnel.
    proxy.on("upgrade", (request, client, head) => {
      tunnels.push(index);
      const destination = createConnection({ host: "127.0.0.1", port: upstream.port! }, () => {
        const path = new URL(request.url!, "http://fixture.invalid").pathname;
        const headers = Object.entries(request.headers).filter(([name]) => name !== "proxy-authorization")
          .map(([name, value]) => `${name}: ${value}`).join("\r\n");
        destination.write(`GET ${path} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head.length) destination.write(head);
        client.pipe(destination); destination.pipe(client);
      });
      connections.add(destination); destination.on("close", () => connections.delete(destination));
      destination.on("error", () => client.destroy()); client.on("error", () => destination.destroy());
      client.on("close", () => destination.destroy());
    });
    return proxy;
  });
  try {
    await Promise.all(proxies.map(proxy => new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve))));
    for (const [index, profile] of [first, second].entries()) {
      const address = proxies[index]!.address() as { port: number };
      store.save(profileInput({ name: profile.name, url: `http://127.0.0.1:${address.port}` }), profile.id);
    }
    delete process.env.NO_PROXY;
    registerUpstreamRewriter("fixture-network", target => { target.url = `ws://upstream.fixture.invalid:${upstream.port}/responses`; });
    const send = sender();
    const a = await send(target, init()); expect(isCodexWsUpstreamResponse(a)).toBe(true); await a.text();
    manager.bind([account], { mode: "proxy", proxyId: second.id });
    const b = await send(target, init()); expect(isCodexWsUpstreamResponse(b)).toBe(true); await b.text();
    expect(tunnels).toEqual([0, 1]); expect(frames).toHaveLength(2);
    expect(manager.traffic.rows("2000-01-01").reduce((n, row) => n + row.requests, 0)).toBe(2);
  } finally {
    codexWsPool.dispose(); upstream.stop(true);
    for (const socket of connections) socket.destroy();
    await Promise.all(proxies.map(proxy => new Promise<void>(resolve => proxy.close(() => resolve()))));
  }
});
