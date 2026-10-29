/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Notifications from "../src/pages/Notifications";
import { LanguageProvider } from "../src/i18n/provider";

let win: Window, root: Root | undefined;
const names = ["window", "document", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "fetch"] as const;
let previous: Record<string, unknown>;
let calls: { method: string; path: string; body: Record<string, any> | undefined }[];
let snapshot: any;
beforeEach(() => {
  previous = Object.fromEntries(names.map((name) => [name, Reflect.get(globalThis, name)]));
  win = new Window({ url: "http://localhost/" }); calls = [];
  for (const name of ["window", "document", "navigator", "localStorage"] as const)
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? win : win[name] });
  localStorage.setItem("ocx-lang", "en"); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  snapshot = { settings: { revision: 1, enabled: false,
    smtp: { host: "smtp.example.invalid", port: 465, security: "tls", username: "sender@example.test", from: "sender@example.test", hasPassword: true },
    recipients: [{ id: "one", address: "first@example.test", enabled: true }, { id: "two", address: "second@example.test", enabled: false }] }, history: [] };
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.method === "PUT") {
      const { password: _password, clearPassword: _clearPassword, ...smtp } = call.body.smtp;
      snapshot = { ...snapshot, settings: { ...call.body, revision: 2, smtp } };
    }
    return Response.json({ ...snapshot, ...(call.path.endsWith("/test") ? { result: "sent" } : {}) });
  }, { preconnect: () => {} }) as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined; win.close();
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: previous[name] });
});
async function mount() {
  const { createRoot } = await import("react-dom/client"); const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<LanguageProvider><Notifications apiBase="" /></LanguageProvider>));
}
function button(text: string) { return [...document.querySelectorAll("button")].find((row) => row.textContent === text)! as HTMLButtonElement; }

test("recipient toggles stay independent, dirty settings disable tests, and saving preserves SMTP secrets", async () => {
  await mount();
  const password = document.querySelector('input[type="password"]') as HTMLInputElement;
  expect(password.value).toBe("");
  const tests = [...document.querySelectorAll("button")].filter((row) => row.textContent === "Send test email") as HTMLButtonElement[];
  expect(tests[0]!.disabled).toBe(false); expect(tests[1]!.disabled).toBe(true);
  await act(async () => button("Receive notifications 2").click());
  expect(document.body.textContent).toContain("Unsaved changes");
  expect(tests[0]!.disabled).toBe(true);
  await act(async () => button("Save settings").click());
  const update = calls.find((row) => row.method === "PUT")!;
  expect(update.body!.smtp).not.toHaveProperty("password");
  expect(update.body!.recipients.map((row: { enabled: boolean }) => row.enabled)).toEqual([true, true]);
  expect(document.body.textContent).toContain("Settings saved");
});

test("test sends only the chosen saved recipient and reports SMTP acceptance", async () => {
  await mount();
  await act(async () => button("Send test email").click());
  expect(calls.find((row) => row.path.endsWith("/test"))!.body).toEqual({ recipientId: "one" });
  expect(document.body.textContent).toContain("Test email accepted by the SMTP server");
});

test("adding and removing recipients is a draft change until settings are saved", async () => {
  snapshot.settings.recipients = [];
  await mount(); expect(document.body.textContent).toContain("No recipients yet");
  await act(async () => button("Add recipient").click());
  expect(document.querySelectorAll('input[type="email"]')).toHaveLength(2);
  const remove = document.querySelector('button[aria-label="Remove recipient 1"]') as HTMLButtonElement;
  await act(async () => remove.click());
  expect(document.body.textContent).toContain("No recipients yet");
  expect(calls.filter((row) => row.method !== "GET")).toHaveLength(0);
});
