import { expect, test } from "bun:test";
import { waitForCoreReadiness } from "../../src/proxy-manager/core-readiness";
import { coreConfiguration } from "../../src/proxy-manager/core";

test("core readiness requires a routed round trip after the port accepts connections", async () => {
  let calls = 0;
  let forwarded = 0;
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls++;
      if (calls === 1) return new Response(null, { status: 502 });
      forwarded++;
      return fetch(request.url, { proxy: false } as RequestInit);
    },
  });
  try {
    await waitForCoreReadiness(
      `http://127.0.0.1:${proxy.port}`,
      () => true,
      2000,
    );
    expect(calls).toBe(2);
    expect(forwarded).toBe(1);
  } finally {
    proxy.stop(true);
  }
});

test("a live port cannot fake readiness and a dead process fails promptly", async () => {
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 204 }),
  });
  try {
    await expect(
      waitForCoreReadiness(`http://127.0.0.1:${proxy.port}`, () => true, 100),
    ).rejects.toThrow("proxy_core_start_timeout");
    await expect(
      waitForCoreReadiness(`http://127.0.0.1:${proxy.port}`, () => false),
    ).rejects.toThrow("proxy_core_start_failed");
  } finally {
    proxy.stop(true);
  }
});

test("readiness is authenticated loopback; account listeners keep their explicit route", () => {
  const config = coreConfiguration(
    [
      {
        id: "account-route",
        enabled: true,
        node: { type: "http" },
        corePort: 21000,
      } as never,
    ],
    "synthetic",
    21001,
  ) as { listeners: Record<string, unknown>[]; rules: string[] };
  expect(config.listeners[0]?.proxy).toBe("account-route");
  expect(config.listeners[1]).toMatchObject({
    name: "opencodex-readiness",
    listen: "127.0.0.1",
    port: 21001,
    proxy: "DIRECT",
    users: [{ username: "opencodex-ready", password: "synthetic" }],
  });
  expect(config.rules).toEqual(["MATCH,REJECT"]);
});
