import { afterEach, describe, expect, test } from "bun:test";
import { ProxyStore } from "../../src/proxy-manager/store";
import { ProxyManager } from "../../src/proxy-manager/service";
import { profileInput } from "../../src/proxy-manager/validation";
import { accountKey, type EgressAccount } from "../../src/proxy-manager/types";
import { configuredOutboundFetch } from "../../src/lib/proxy-env";
import { registerAccountEgress, withAccountEgress } from "../../src/lib/account-egress";
import { validateDshAccountToken } from "../../src/oauth/dsh";
import { fetchDshAccountQuota } from "../../src/providers/quota/dsh-account";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../../src/types";
import { providerOutboundGet } from "../../src/lib/provider-outbound";
import { CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import { shouldUseCodexWsUpstream } from "../../src/server/responses/ws-upstream";
import { verifyCodexAccountWarmup } from "../../src/codex/auth-api/login-flow";
import { warmCodexAccount } from "../../src/codex/warmup";
import { fetchCodexUsage, resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { applyCodexAuthContextToProvider, stripCodexRuntimeProviderFields } from "../../src/codex/auth-context";

const a: EgressAccount = { kind: "oauth", provider: "dsh-account", id: "a" };
const b: EgressAccount = { kind: "oauth", provider: "dsh-account", id: "b" };
const managers: ProxyManager[] = [];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  registerAccountEgress(undefined);
  resetQuotaQueryBackoffForTests();
  for (const m of managers.splice(0)) m.close();
});
function fixture() {
  const store = new ProxyStore(":memory:");
  const manager = new ProxyManager(store, {
    list: () => [a, b].map((account) => ({ account, label: account.id })),
    resolve: (_input, init) => {
      const token = new Headers(init?.headers).get("x-dsh-auth-token");
      return token === "token-a" ? [a] : token === "token-b" ? [b] : [];
    },
  });
  managers.push(manager);
  const first = store.save(profileInput({ name: "CN", url: "http://user:password@127.0.0.1:3128" }));
  const second = store.save(profileInput({ name: "US", url: "http://127.0.0.1:3129" }));
  store.bind([a], { mode: "proxy", proxyId: first.id });
  store.bind([b], { mode: "proxy", proxyId: second.id });
  return { store, manager, first, second };
}
describe("account proxy routing", () => {
  test("concurrent accounts use their own exits; stale scope cannot override a reselected bearer", async () => {
    const { manager, first, second } = fixture();
    const seen: string[] = [];
    const send = async (_input: RequestInfo | URL, init?: RequestInit) => {
      await Bun.sleep(1);
      seen.push((init as { proxy: string }).proxy);
      return new Response("ok");
    };
    const responses = await Promise.all([
      manager.send("https://api.deepseek.com/anthropic", { headers: { "x-dsh-auth-token": "token-a" } }, send, {
        account: a,
      }),
      manager.send("https://api.deepseek.com/anthropic", { headers: { "x-dsh-auth-token": "token-b" } }, send, {
        account: a,
      }),
    ]);
    await Promise.all(responses.map((r) => r.text()));
    expect(seen.sort()).toEqual([first.url, second.url].sort());
  });
  test("validation, quota and models resolve the same DSH account proxy", async () => {
    const { manager, first } = fixture();
    for (const url of [
      "https://platform.deepseek.com/auth-api/v0/users/current",
      "https://platform.deepseek.com/api/v0/users/get_user_summary",
      "https://api.deepseek.com/anthropic/v1/messages",
    ]) {
      const response = await manager.send(url, { headers: { "x-dsh-auth-token": "token-a" } }, async (_url, init) => {
        expect((init as { proxy: string }).proxy).toBe(first.url);
        return new Response("{}");
      });
      await response.text();
    }
  });
  test("disabled or deleted assigned proxies never fall back", async () => {
    const { manager, store, first } = fixture();
    store.save({ ...first, enabled: false }, first.id);
    let calls = 0;
    await expect(
      manager.send("https://example.com", { headers: { "x-dsh-auth-token": "token-a" } }, async () => {
        calls++;
        return new Response();
      }),
    ).rejects.toThrow("proxy_unavailable");
    expect(calls).toBe(0);
    expect(() => store.remove(first.id)).toThrow("proxy_in_use");
  });
  test("batch validates all accounts and makes no partial writes", () => {
    const { manager, store, first } = fixture();
    expect(() => manager.bind([a, { ...b, id: "missing" }], { mode: "direct" })).toThrow("account_not_found");
    expect(store.choice(a)).toEqual({ mode: "proxy", proxyId: first.id });
    manager.bind([a, b], { mode: "direct" });
    expect(store.choice(b)).toEqual({ mode: "direct" });
  });
  test("new login and refresh scopes are isolated across async boundaries", async () => {
    const { manager, store, first } = fixture();
    store.bind([{ ...a, id: "@new" }], { mode: "proxy", proxyId: first.id });
    registerAccountEgress({
      send: (...args) => manager.send(...args),
      explicit: (...args) => manager.explicit(...args),
    });
    const seen: unknown[] = [];
    const stub = Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen.push((init as { proxy?: unknown } | undefined)?.proxy);
        return new Response("ok");
      },
      { preconnect: () => {} },
    ) as typeof fetch;
    const response = await withAccountEgress({ provider: a.provider, purpose: "login" }, () =>
      configuredOutboundFetch("https://platform.deepseek.com/login", undefined, stub),
    );
    await response.text();
    const plain = await configuredOutboundFetch("https://other.example", undefined, stub);
    await plain.text();
    expect(seen).toEqual([first.url, undefined]);
  });
  test("direct binding overrides inherited proxy and metadata never reveals password", async () => {
    const { manager, store, first } = fixture();
    store.bind([a], { mode: "direct" });
    const response = await manager.send(
      "https://example.com",
      { headers: { "x-dsh-auth-token": "token-a" } },
      async (_u, init) => {
        expect((init as { proxy: unknown }).proxy).toBe(false);
        return new Response();
      },
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(store.publicProfiles())).not.toContain("password");
    expect(store.publicProfiles().find((p) => p.id === first.id)?.hasPassword).toBe(true);
  });
  test.each([false, true])("real HTTP proxy and streaming accounting with environment bypass=%s", async (bypass) => {
    const savedNoProxy = process.env.NO_PROXY;
    if (bypass) process.env.NO_PROXY = "*";
    const proxy = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("stream"));
              c.enqueue(new TextEncoder().encode("ing"));
              c.close();
            },
          }),
        ),
    });
    const { manager, store, first } = fixture();
    store.save({ ...first, url: `http://127.0.0.1:${proxy.port}` }, first.id);
    registerAccountEgress({
      send: (...args) => manager.send(...args),
      explicit: (...args) => manager.explicit(...args),
    });
    try {
      const response = await configuredOutboundFetch("http://unreachable.invalid/model", {
        method: "POST",
        headers: { "x-dsh-auth-token": "token-a" },
        body: "hello",
      });
      expect(await response.text()).toBe("streaming");
      const rows = manager.traffic.rows("2000-01-01");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ upload: 5, download: 9, requests: 1, failures: 0, accountKey: accountKey(a) });
    } finally {
      proxy.stop(true);
      if (savedNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = savedNoProxy;
    }
  });
  test("errors are sanitized and failed sends contribute to the ledger", async () => {
    const { manager } = fixture();
    await expect(
      manager.send("https://example.com", { headers: { "x-dsh-auth-token": "token-a" } }, async () => {
        throw new Error("http://user:password@host");
      }),
    ).rejects.toThrow("proxy_connection_failed");
    expect(manager.traffic.rows("2000-01-01")[0]).toMatchObject({ requests: 1, failures: 1, incomplete: 1 });
  });
  test("monthly cap refuses only new sends after buffered traffic reaches limit", async () => {
    const { manager, store, first } = fixture();
    store.save({ ...first, monthlyLimitBytes: 2, limitAction: "block" }, first.id);
    const send = async () => new Response("123");
    const r = await manager.send("https://example.com", { headers: { "x-dsh-auth-token": "token-a" } }, send);
    await r.text();
    await expect(
      manager.send("https://example.com", { headers: { "x-dsh-auth-token": "token-a" } }, send),
    ).rejects.toThrow("proxy_traffic_limit");
  });
  test("DSH validation, quota and production model dispatcher all apply the binding exactly once", async () => {
    const { manager, first } = fixture();
    const seen: Array<{ url: string; proxy: unknown }> = [];
    registerAccountEgress({
      send: (...args) => manager.send(...args),
      explicit: (...args) => manager.explicit(...args),
    });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        seen.push({ url, proxy: (init as { proxy: unknown }).proxy });
        if (url.includes("users/current"))
          return Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: "test-dsh-account" } } });
        if (url.includes("get_user_summary"))
          return Response.json({ code: 0, data: { biz_code: 0, biz_data: { user_summary: { total_costs: 0 } } } });
        return new Response("data: model-output\n\n", { headers: { "content-type": "text/event-stream" } });
      },
      { preconnect: () => {} },
    ) as typeof fetch;
    expect((await validateDshAccountToken("token-a")).valid).toBe(true);
    expect(await fetchDshAccountQuota("dsh-account", "token-a")).toBeDefined();
    const send = providerFetch(
      { adapter: "anthropic", baseUrl: "https://api.deepseek.com/anthropic" } as OcxProviderConfig,
      undefined,
      { providerName: "dsh-account" },
    );
    expect(
      await (
        await send("https://api.deepseek.com/anthropic/v1/messages", {
          method: "POST",
          headers: { "x-dsh-auth-token": "token-a" },
          body: "{}",
        })
      ).text(),
    ).toContain("model-output");
    expect(seen).toHaveLength(3);
    expect(seen.every((r) => r.proxy === first.url)).toBe(true);
    expect(manager.traffic.rows("2000-01-01").reduce((n, r) => n + r.requests, 0)).toBe(3);
  });
  test("a stream is counted incrementally and cancellation reaches the underlying response", async () => {
    const { manager } = fixture();
    let cancelled = false;
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array(3));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await manager.send(
      "https://example.com",
      { headers: { "x-dsh-auth-token": "token-a" } },
      async () => new Response(source),
    );
    expect(pulls).toBe(0);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
    expect(pulls).toBe(1);
    expect(manager.traffic.rows("2000-01-01")[0]).toMatchObject({ download: 3, failures: 1, incomplete: 1 });
  });
  test("a failed managed WebSocket dial falls back over the same proxy and counts once", async () => {
    const { manager, first } = fixture();
    registerAccountEgress({
      send: (...args) => manager.send(...args),
      explicit: (...args) => manager.explicit(...args),
    });
    const originalSocket = globalThis.WebSocket;
    let dials = 0;
    globalThis.WebSocket = class {
      constructor() {
        dials++;
        throw new Error("unexpected WebSocket dial");
      }
    } as unknown as typeof WebSocket;
    const seen: unknown[] = [];
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push((init as { proxy: unknown }).proxy);
        return new Response("data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } });
      },
      { preconnect: () => {} },
    ) as typeof fetch;
    const init = { method: "POST", headers: { "x-dsh-auth-token": "token-a" }, body: JSON.stringify({ stream: true }) };
    try {
      expect(shouldUseCodexWsUpstream(CODEX_RESPONSES_HTTP_URL, init, "1.4.0")).toBe(true);
      const send = providerFetch(
        { adapter: "openai", baseUrl: "https://chatgpt.com/backend-api/codex" } as OcxProviderConfig,
        "1.4.0",
        { providerName: "dsh-account" },
      );
      const response = await send(CODEX_RESPONSES_HTTP_URL, init);
      await response.text();
      expect(dials).toBe(1);
      expect(seen).toEqual([first.url]);
      expect(manager.traffic.rows("2000-01-01")[0]?.requests).toBe(1);
    } finally {
      globalThis.WebSocket = originalSocket;
    }
  });
  test("opaque custom fetch transports refuse explicit routes before sending", async () => {
    const { manager } = fixture();
    registerAccountEgress({
      send: (...args) => manager.send(...args),
      explicit: (...args) => manager.explicit(...args),
    });
    let calls = 0;
    const config = {
      adapter: "anthropic",
      baseUrl: "https://example.com",
      fetch: async () => {
        calls++;
        return new Response();
      },
    } as unknown as OcxProviderConfig;
    await expect(
      providerFetch(config, undefined, { providerName: "dsh-account" })("https://example.com", {
        headers: { "x-dsh-auth-token": "token-a" },
      }),
    ).rejects.toThrow("account_proxy_transport_unsupported");
    expect(calls).toBe(0);
  });
  test("provider defaults apply to known accounts until direct or another proxy overrides them", async () => {
    const { store, manager, first } = fixture();
    store.bind([a], { mode: "inherit" });
    store.bind([{ ...a, id: "@new" }], { mode: "proxy", proxyId: first.id });
    const seen: unknown[] = [];
    const send = async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init as { proxy: unknown }).proxy);
      return new Response();
    };
    await manager.send("https://example.com", { headers: { "x-dsh-auth-token": "token-a" } }, send);
    store.bind([a], { mode: "direct" });
    await manager.send("https://example.com", { headers: { "x-dsh-auth-token": "token-a" } }, send);
    expect(seen).toEqual([first.url, false]);
  });
  test("provider connection probes select managed proxy transport while direct preserves DNS pinning", async () => {
    const { manager, store, first } = fixture();
    registerAccountEgress({
      send: (...args) => manager.send(...args),
      explicit: (...args) => manager.explicit(...args),
    });
    let proxied = 0,
      pinned = 0;
    globalThis.fetch = Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        proxied++;
        expect((init as { proxy: unknown }).proxy).toBe(first.url);
        expect(init?.redirect).toBe("manual");
        return new Response("proxy");
      },
      { preconnect: () => {} },
    ) as typeof fetch;
    const dependencies = {
      resolveAddresses: async () => ({
        hostname: "provider.invalid",
        addresses: [{ address: "93.184.216.34", family: 4 as const }],
        privateNetwork: false,
      }),
      pinnedGet: async () => {
        pinned++;
        return new Response("direct");
      },
    };
    const get = () =>
      providerOutboundGet(
        "dsh-account",
        { baseUrl: "https://provider.invalid" },
        "https://provider.invalid/models",
        { headers: { "x-dsh-auth-token": "token-a" } },
        dependencies,
      );
    expect(await (await get()).text()).toBe("proxy");
    store.bind([a], { mode: "direct" });
    expect(await (await get()).text()).toBe("direct");
    expect([proxied, pinned]).toEqual([1, 1]);
    expect(manager.traffic.rows("2000-01-01").reduce((n, r) => n + r.requests, 0)).toBe(2);
  });
});

describe("native Codex proxy identity across account operations", () => {
  // OAuth staging and a native pool row may carry the same credential. Native operations
  // must retain their own route even before the new row has been persisted.
  function nativeFixture() {
    const store = new ProxyStore(":memory:");
    const staged: EgressAccount = { kind: "oauth", provider: "chatgpt", id: "staged" };
    const existing: EgressAccount = { kind: "codex", provider: "openai", id: "existing" };
    const main: EgressAccount = { ...existing, id: "__main__" };
    const manager = new ProxyManager(store, {
      list: () => [staged, existing, main].map(account => ({ account, label: account.id })),
      resolve: (_url, init, provider) => {
        const bearer = new Headers(init?.headers).get("authorization");
        const matches = bearer === "Bearer fresh" ? [staged]
          : bearer === "Bearer shared" ? [staged, existing, main] : [];
        return matches.filter(account => !provider || account.provider === provider);
      },
    });
    managers.push(manager);
    const first = store.save(profileInput({ name: "default", url: "http://127.0.0.1:3128" }));
    const second = store.save(profileInput({ name: "account", url: "http://127.0.0.1:3129" }));
    store.bind([{ kind: "oauth", provider: "openai", id: "@new" }], { mode: "proxy", proxyId: first.id });
    store.bind([existing], { mode: "proxy", proxyId: second.id });
    store.bind([main], { mode: "direct" });
    registerAccountEgress({ send: (...args) => manager.send(...args), explicit: (...args) => manager.explicit(...args) });
    const seen: unknown[] = [];
    const mockSend = (reply: () => Response = () => new Response('data: {"type":"response.completed"}\n\n')) => {
      globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push((init as { proxy?: unknown })?.proxy);
        return reply();
      }, { preconnect: () => {} }) as typeof fetch;
    };
    mockSend();
    return { manager, store, first, second, existing, main, seen, mockSend };
  }
  test("new-login warmup uses OpenAI default despite the temporary ChatGPT OAuth credential", async () => {
    const { first, seen, manager } = nativeFixture();
    expect((await verifyCodexAccountWarmup("new-pool-id", "fresh", "tenant-id")).ok).toBe(true);
    expect(seen).toEqual([first.url]);
    expect(manager.traffic.rows("2000-01-01")[0]).toMatchObject({
      accountKey: accountKey({ kind: "codex", provider: "openai", id: "new-pool-id" }), purpose: "model", requests: 1,
    });
  });
  test("native model dispatch preserves the selected account with a new source-linked bearer and drops it on reselection", async () => {
    const { store, first, second, existing, seen } = nativeFixture();
    const provider = applyCodexAuthContextToProvider({ adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" }, {
      kind: "pool", accountId: existing.id, accessToken: "fresh", chatgptAccountId: "tenant-id", writerGeneration: 1, generation: 1,
    }, "pool");
    const send = providerFetch(provider, "1.4.0", { providerName: "openai" });
    const init = { method: "POST", headers: { authorization: "Bearer fresh" }, body: JSON.stringify({ stream: true }) };
    await (await send(CODEX_RESPONSES_HTTP_URL, init)).text();
    store.bind([existing], { mode: "proxy", proxyId: first.id });
    await (await send(CODEX_RESPONSES_HTTP_URL, init)).text();
    store.bind([existing], { mode: "direct" });
    await (await send(CODEX_RESPONSES_HTTP_URL, init)).text();
    const stripped = stripCodexRuntimeProviderFields(provider);
    await (await providerFetch(stripped, "1.4.0", { providerName: "openai" })(CODEX_RESPONSES_HTTP_URL, init)).text();
    expect(seen).toEqual([second.url, first.url, false, first.url]);
    expect(JSON.stringify(provider)).not.toContain(existing.id);
    expect(stripped).not.toHaveProperty("_codexAccountOverride");
  });
  test("reauth, background warmup and main direct overrides stay isolated under concurrency", async () => {
    const { second, seen } = nativeFixture();
    await Promise.all([
      verifyCodexAccountWarmup("existing", "fresh", "tenant-id"),
      warmCodexAccount({ poolAccountId: "existing", accessToken: "shared", chatgptAccountId: "tenant-id" }),
      warmCodexAccount({ poolAccountId: "__main__", accessToken: "shared", chatgptAccountId: "tenant-id" }),
    ]);
    expect(seen.filter(proxy => proxy === second.url)).toHaveLength(2);
    expect(seen.filter(proxy => proxy === false)).toHaveLength(1);
  });
  test("model fallback uses the same native proxy on both physical sends", async () => {
    const { second, seen, mockSend } = nativeFixture();
    let calls = 0;
    mockSend(() => ++calls === 1 ? new Response("", { status: 404 })
      : new Response('data: {"type":"response.completed"}\n\n'));
    expect((await verifyCodexAccountWarmup("existing", "fresh", "tenant-id")).ok).toBe(true);
    expect(seen).toEqual([second.url, second.url]);
  });
  test("quota queries select native bindings with shared OAuth and native bearers", async () => {
    const { second, seen, mockSend } = nativeFixture();
    mockSend(() => Response.json({ rate_limit: { allowed: true } }));
    for (const poolAccountId of ["existing", "__main__"]) {
      const result = await fetchCodexUsage(poolAccountId, { headers: { authorization: "Bearer shared" } }, undefined, { poolAccountId });
      expect(result?.kind).toBe("owner");
      if (result?.kind === "owner") { await result.response.json(); result.settle(true); }
    }
    expect(seen).toEqual([second.url, false]);
  });
  test("disabled account binding refuses warmup and quota without any direct send", async () => {
    const { store, second, seen } = nativeFixture();
    store.save({ ...second, enabled: false }, second.id);
    const result = await verifyCodexAccountWarmup("existing", "fresh", "tenant-id");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(502);
      expect(await result.response.json()).toMatchObject({ code: "codex_warmup_transport_failed", reason: "transport" });
    }
    await expect(fetchCodexUsage("disabled", { headers: { authorization: "Bearer shared" } }, undefined,
      { poolAccountId: "existing" })).rejects.toThrow("proxy_unavailable");
    expect(seen).toHaveLength(0);
  });
  test("connection failures do not imply expired credentials or expose proxy details", async () => {
    const { mockSend, seen } = nativeFixture();
    mockSend(() => { throw new Error("connect failed http://user:secret@127.0.0.1:3128"); });
    const result = await verifyCodexAccountWarmup("existing", "fresh", "tenant-id");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(502);
      const body = await result.response.json();
      expect(body.code).toBe("codex_warmup_transport_failed");
      expect(body.error).not.toContain("Reauthenticate");
      expect(JSON.stringify(body)).not.toContain("secret");
    }
    expect(seen).toHaveLength(1);
  });
  test.each([401, 403, 429])("upstream %i retains its existing authentication or rate-limit classification", async status => {
    const { mockSend } = nativeFixture();
    mockSend(() => new Response("", { status }));
    const result = await verifyCodexAccountWarmup("existing", "fresh", "tenant-id");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(status === 429 ? 429 : 401);
      expect((await result.response.json()).code).toBe(status === 429 ? "codex_warmup_rate_limited" : "codex_warmup_failed");
    }
  });
});

describe("live proxy reassignment", () => {
  test("a reused model dispatcher switches new sends while an existing stream finishes on its original exit", async () => {
    const { manager, store, first, second } = fixture();
    registerAccountEgress({ send: (...args) => manager.send(...args), explicit: (...args) => manager.explicit(...args) });
    const seen: unknown[] = [];
    let finish!: () => void;
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init as { proxy: unknown }).proxy);
      if (seen.length > 1) return new Response("new-route");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first-"));
          finish = () => { controller.enqueue(new TextEncoder().encode("finished")); controller.close(); };
        },
      }));
    }, { preconnect: () => {} }) as typeof fetch;
    const send = providerFetch({ adapter: "anthropic", baseUrl: "https://api.deepseek.com/anthropic" } as OcxProviderConfig,
      undefined, { providerName: "dsh-account" });
    const request = () => send("https://api.deepseek.com/anthropic/v1/messages", {
      method: "POST", headers: { "x-dsh-auth-token": "token-a" }, body: "{}",
    });
    const old = await request();
    const reading = old.text();
    manager.bind([a], { mode: "proxy", proxyId: second.id });
    expect(await (await request()).text()).toBe("new-route");
    manager.bind([a], { mode: "direct" });
    expect(await (await request()).text()).toBe("new-route");
    finish();
    expect(await reading).toBe("first-finished");
    expect(seen).toEqual([first.url, second.url, false]);
    expect(manager.traffic.rows("2000-01-01").map(row => row.proxyId).sort()).toEqual([first.id, second.id, "direct"].sort());
    store.bind([a], { mode: "proxy", proxyId: second.id });
    store.save({ ...second, enabled: false }, second.id);
    await expect(request()).rejects.toThrow("proxy_unavailable");
    expect(seen).toHaveLength(3);
  });
  test("a binding changed during core startup is rechecked before credentials are sent", async () => {
    const { store, first, second } = fixture();
    store.save({ ...first, node: { name: "fixture", type: "hysteria2", server: "proxy.invalid", port: 443, password: "fixture" } }, first.id);
    let unblock!: () => void;
    const waiting = new Promise<void>(resolve => { unblock = resolve; });
    let released = 0;
    const core = { acquire: async () => { await waiting; return { url: "http://127.0.0.1:40000", release: () => { released++; } }; }, close() {} };
    const manager = new ProxyManager(store, { list: () => [{ account: a, label: a.id }], resolve: () => [a] }, core as never);
    // The fixture manager owns the shared store; only flush the extra ledger at the end.
    const seen: unknown[] = [];
    const pending = manager.send("https://provider.invalid", {}, async (_url, init) => {
      seen.push((init as { proxy: unknown }).proxy); return new Response("ok");
    });
    manager.bind([a], { mode: "proxy", proxyId: second.id });
    unblock();
    expect(await (await pending).text()).toBe("ok");
    expect(seen).toEqual([second.url]);
    expect(released).toBe(1);
    manager.traffic.close();
  });
});
