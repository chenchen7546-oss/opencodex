/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProxyManager from "../src/pages/ProxyManager";
import { LanguageProvider } from "../src/i18n/provider";
import type { Snapshot, Traffic } from "../src/pages/proxy-manager/types";

let testWindow: Window, root: Root | undefined;
const names = ["window", "document", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "fetch"] as const;
let saved: Record<string, unknown>;
let calls: Array<{ path: string; method: string; body: unknown }>;
const snapshot: Snapshot = {
  profiles: [
    {
      id: "cn",
      name: "Domestic",
      protocol: "socks5",
      host: "proxy.invalid",
      port: 1080,
      username: "",
      hasPassword: true,
      enabled: true,
      group: "CN",
      notes: "",
      bindings: 0,
      monthlyLimitBytes: 0,
      limitAction: "warn",
      monthBytes: 0,
    },
  ],
  accounts: [
    {
      account: { kind: "oauth", provider: "dsh-account", id: "one" },
      label: "DSH account",
      choice: { mode: "inherit" },
    },
    {
      account: { kind: "key", provider: "openrouter", id: "two" },
      label: "Other provider",
      choice: { mode: "inherit" },
    },
  ],
  settings: { retentionDays: 90, probeConcurrency: 2, flushIntervalMs: 15000 },
  subscriptions: [],
  core: { installed: false, running: false, activeStreams: 0 },
  persistenceFailed: false,
};
const traffic: Traffic = {
  rows: [],
  totals: [{ proxyId: "cn", upload: 1024, download: 2048, requests: 12, failures: 0, incomplete: 0 }],
  truncated: false,
  persistenceFailed: false,
};
beforeEach(() => {
  saved = Object.fromEntries(names.map((name) => [name, Reflect.get(globalThis, name)]));
  testWindow = new Window({ url: "http://localhost/" });
  calls = [];
  for (const name of ["window", "document", "navigator", "localStorage"] as const)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "window" ? testWindow : testWindow[name],
    });
  localStorage.setItem("ocx-lang", "en");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json(
        init?.method && init.method !== "GET" ? { ok: true } : path.includes("/traffic") ? traffic : snapshot,
      );
    },
    { preconnect: () => {} },
  ) as typeof fetch;
});
afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = undefined;
  }
  testWindow.close();
  for (const name of names)
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: saved[name] });
});
async function mount() {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ProxyManager apiBase="" />
      </LanguageProvider>,
    );
  });
  return container;
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

test("bulk assignment includes selected accounts from different providers and clears selection on success", async () => {
  await mount();
  await click("Account bindings");
  const all = document.querySelector('input[aria-label="Select visible accounts"]') as HTMLInputElement;
  await act(async () => all.click());
  const select = document.querySelector('select[aria-label="Assigned proxy"]') as HTMLSelectElement;
  await act(async () => {
    select.value = "cn";
    select.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as unknown as Event);
  });
  await click("Assign to selected");
  const sent = calls.find((c) => c.path.endsWith("/bindings"));
  expect(sent?.method).toBe("PUT");
  expect(sent?.body).toEqual({
    accounts: snapshot.accounts.map((a) => a.account),
    choice: { mode: "proxy", proxyId: "cn" },
  });
  expect(document.body.textContent).toContain("Selected: 0");
});
test("traffic cards use complete server totals even when the detail rows are empty", async () => {
  await mount();
  await click("Traffic");
  expect(document.body.textContent).toContain("3.00 KiB");
  expect(document.body.textContent).toContain("12");
  expect(document.body.textContent).toContain("not ISP billing traffic");
});
test("metadata editing preserves the saved secret unless a replacement is entered", async () => {
  await mount();
  await click("Edit");
  await click("Save");
  const sent = calls.find((c) => c.method === "PATCH");
  expect(sent?.path).toEndWith("/profiles/cn");
  expect(sent?.body).not.toHaveProperty("password");
});
