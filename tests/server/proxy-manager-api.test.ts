import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleProxyManagerRoutes } from "../../src/server/management/proxy-manager-routes";
import { getProxyManager } from "../../src/proxy-manager/runtime";
import { runOptionalShutdownHooks, resetOptionalShutdownHooksForTests } from "../../src/lib/optional-shutdown-hooks";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

const originalHome = process.env.OPENCODEX_HOME;
const roots: string[] = [];
afterEach(() => {
  runOptionalShutdownHooks();
  resetOptionalShutdownHooksForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ocx-proxy-api-"));
  roots.push(home);
  process.env.OPENCODEX_HOME = home;
  const config = {
    providers: { sample: { adapter: "openai-chat", baseUrl: "https://example.invalid", apiKey: "fake-test-key" } },
  } as unknown as OcxConfig;
  const request = async (
    path = "",
    method = "GET",
    body?: unknown,
    principal: ManagementContext["principal"] = "admin-token",
  ) => {
    const req = new Request(`http://localhost/api/proxy-manager${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    });
    const response = (await handleProxyManagerRoutes({
      req,
      url: new URL(req.url),
      config,
      principal,
    } as ManagementContext))!;
    return { response, body: await response.json() };
  };
  return { request, config };
}
test("management credentials are required; API responses never return proxy or subscription secrets", async () => {
  const { request } = setup();
  expect((await request("", "GET", undefined, "api-key" as ManagementContext["principal"])).response.status).toBe(403);
  expect(
    (await request("/profiles", "POST", { name: "proxy", url: "http://alice:proxy-secret@127.0.0.1:8888" })).response
      .status,
  ).toBe(201);
  expect(
    (
      await request("/subscriptions", "POST", {
        name: "source",
        url: "https://subscription.invalid/?token=subscription-secret",
      })
    ).response.status,
  ).toBe(201);
  const { body, response } = await request();
  const serialized = JSON.stringify(body);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(serialized).not.toContain("proxy-secret");
  expect(serialized).not.toContain("subscription-secret");
  expect(body.profiles[0].hasPassword).toBe(true);
});
test("binding mutation is atomic; disabling a bound proxy refuses sends; credentials survive metadata edits", async () => {
  const { request, config } = setup();
  const created = await request("/profiles", "POST", { name: "proxy", url: "http://alice:retained@127.0.0.1:8888" });
  const id = created.body.id;
  const snapshot = (await request()).body;
  const account = snapshot.accounts.find((r: { account: { kind: string } }) => r.account.kind === "key").account;
  expect(
    (
      await request("/bindings", "PUT", {
        accounts: [account, { ...account, id: "missing" }],
        choice: { mode: "proxy", proxyId: id },
      })
    ).response.status,
  ).toBe(404);
  expect(getProxyManager(config)!.store.choice(account).mode).toBe("inherit");
  expect(
    (await request("/bindings", "PUT", { accounts: [account], choice: { mode: "proxy", proxyId: id } })).response
      .status,
  ).toBe(200);
  expect((await request(`/profiles/${id}`, "DELETE")).response.status).toBe(409);
  await request(`/profiles/${id}`, "PATCH", { name: "renamed", enabled: false });
  expect(getProxyManager(config)!.store.profile(id)?.url).toContain(":retained@");
  await expect(
    getProxyManager(config)!.send(
      "https://example.invalid",
      { headers: { authorization: "Bearer fake-test-key" } },
      async () => new Response(),
    ),
  ).rejects.toThrow("proxy_unavailable");
});
test("bulk import rejects the entire batch; SQLite statistics and bindings survive restart", async () => {
  const { request, config } = setup();
  const created = await request("/profiles", "POST", { name: "proxy", url: "http://127.0.0.1:8888" });
  const id = created.body.id;
  expect((await request("/import", "POST", { urls: ["http://127.0.0.1:1234", "vless://bad"] })).response.status).toBe(
    400,
  );
  expect((await request()).body.profiles).toHaveLength(1);
  const manager = getProxyManager(config)!;
  const account = manager.accounts().find((r) => r.account.kind === "key")!.account;
  manager.bind([account], { mode: "proxy", proxyId: id });
  const result = await manager.send("https://example.invalid", undefined, async () => new Response("12345"), {
    account,
  });
  await result.text();
  runOptionalShutdownHooks();
  resetOptionalShutdownHooksForTests();
  const restored = getProxyManager(config)!;
  expect(restored.store.choice(account)).toEqual({ mode: "proxy", proxyId: id });
  expect((await request("/traffic?days=1")).body.totals[0]).toMatchObject({ download: 5, requests: 1 });
  expect((await request("/settings", "PATCH", { retentionDays: 0 })).response.status).toBe(400);
});
