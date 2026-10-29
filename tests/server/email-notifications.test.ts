import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationStore } from "../../src/notifications/store";
import { NotificationService } from "../../src/notifications/service";
import { publicSettings, type AccountObservation } from "../../src/notifications/types";
import { mailContent, mailFailure } from "../../src/notifications/smtp";
import { closeNotifications } from "../../src/notifications/runtime";
import { handleNotificationRoutes } from "../../src/server/management/notification-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

const roots: string[] = [], stores: NotificationStore[] = [];
const originalHome = process.env.OPENCODEX_HOME;
afterEach(() => {
  closeNotifications();
  for (const store of stores.splice(0)) store.close();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const observation: AccountObservation = { id: "fake-account", label: "Account alias", state: "reauth", reason: "refresh_failed" };
function settings(store: NotificationStore, enabled = true) {
  return { ...store.settings(), enabled, smtp: { host: "smtp.example.invalid", port: 465, security: "tls", username: "sender@example.test", password: "fake-smtp-secret", from: "sender@example.test" },
    recipients: [{ id: "first", address: "first@example.test", enabled: true }, { id: "second", address: "second@example.test", enabled: true }, { id: "off", address: "off@example.test", enabled: false }] };
}
function store() { const value = new NotificationStore(":memory:"); stores.push(value); return value; }

test("recipients are independent: failure does not block another address, retries are bounded, unknown status does not clear dedup", async () => {
  const db = store(); db.save(settings(db));
  let observations = [observation];
  const sent: string[] = [];
  const service = new NotificationService(db, async () => observations, async (_, recipient) => {
    sent.push(recipient.address); return recipient.address.startsWith("first") ? "smtp_auth_failed" : "sent";
  });
  await service.tick(1000);
  expect(sent).toEqual(["first@example.test", "second@example.test"]);
  await service.tick(2000); expect(sent).toHaveLength(2);
  observations = [{ ...observation, state: "unknown" }]; await service.tick(3000);
  observations = [observation]; await service.tick(1000 + 15 * 60_000);
  await service.tick(1000 + 30 * 60_000);
  await service.tick(1000 + 45 * 60_000);
  expect(sent.filter((address) => address.startsWith("first"))).toHaveLength(3);
  expect(sent.filter((address) => address.startsWith("second"))).toHaveLength(1);
  observations = [{ ...observation, state: "healthy" }]; await service.tick(3000000);
  observations = [observation]; await service.tick(3001000);
  expect(sent.filter((address) => address.startsWith("second"))).toHaveLength(2);
});

test("notification incidents and per-recipient success survive process replacement; a new enabled recipient can receive the incident", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ocx-mail-test-")); roots.push(directory);
  const path = join(directory, "mail", "state.sqlite");
  const first = new NotificationStore(path); first.save(settings(first));
  const sent: string[] = [];
  const send = async (_: unknown, recipient: { address: string }) => { sent.push(recipient.address); return "sent" as const; };
  const service = new NotificationService(first, async () => [observation], send);
  await service.tick(1000); service.close();
  const second = new NotificationStore(path); stores.push(second);
  const next = new NotificationService(second, async () => [observation], send);
  await next.tick(2000); expect(sent).toHaveLength(2);
  const config = second.settings(); config.recipients[2]!.enabled = true; second.save(config);
  await next.tick(3000); expect(sent).toHaveLength(3); expect(sent[2]).toBe("off@example.test");
}, 20_000); // Windows secret-directory ACL hardening can take several seconds under build load.

test("disabled notification service does no observation or delivery; a removed account cannot notify", async () => {
  const db = store(); db.save(settings(db, false));
  let reads = 0, deliveries = 0;
  const service = new NotificationService(db, async () => { reads++; return []; }, async () => { deliveries++; return "sent"; });
  await service.tick(); expect(reads).toBe(0); expect(deliveries).toBe(0);
  db.observe([observation], 1000); db.save({ ...db.settings(), enabled: true });
  await service.tick(); expect(db.incidents()).toHaveLength(0); expect(deliveries).toBe(0);
});

test("settings validate encrypted SMTP, duplicate/injected addresses, revision conflict and preserve the write-only secret", () => {
  const db = store(); const saved = db.save(settings(db));
  const dto = publicSettings(saved); expect(JSON.stringify(dto)).not.toContain("fake-smtp-secret"); expect(dto.smtp.hasPassword).toBe(true);
  db.save({ ...dto, smtp: { ...dto.smtp, password: "" } }); expect(db.settings().smtp.password).toBe("fake-smtp-secret");
  expect(() => db.save(dto)).toThrow("settings_conflict");
  const current = publicSettings(db.settings());
  expect(() => db.save({ ...current, recipients: [{ address: "victim@example.test\r\nBcc: other@example.test", enabled: true }] })).toThrow("invalid_settings");
  expect(() => db.save({ ...current, recipients: [...current.recipients, { address: "FIRST@example.test", enabled: true }] })).toThrow("duplicate_recipient");
  expect(() => db.save({ ...current, smtp: { ...current.smtp, security: "none" } })).toThrow("invalid_smtp_security");
  expect(() => db.save({ ...current, smtp: { ...current.smtp, clearPassword: true } })).toThrow("smtp_incomplete");
});

test("management auth and redaction apply to notification reads and writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ocx-mail-api-")); roots.push(directory); process.env.OPENCODEX_HOME = directory;
  const config = { providers: {} } as OcxConfig;
  const request = async (principal: ManagementContext["principal"], method = "GET", value?: unknown) => {
    const req = new Request("http://localhost/api/notifications", { method, ...(value ? { body: JSON.stringify(value), headers: { "Content-Type": "application/json" } } : {}) });
    const response = (await handleNotificationRoutes({ req, url: new URL(req.url), config, principal } as ManagementContext))!;
    return { response, body: await response.json() };
  };
  expect((await request("api-key" as ManagementContext["principal"])).response.status).toBe(403);
  const initial = await request("admin-token"); expect(initial.body.settings.enabled).toBe(false);
  expect(initial.response.headers.get("cache-control")).toBe("no-store");
  const db = store();
  const saved = await request("gui-session", "PUT", settings(db, false));
  expect(saved.response.status).toBe(200); expect(saved.body.settings.smtp.hasPassword).toBe(true);
  expect(JSON.stringify(saved.body)).not.toContain("fake-smtp-secret");
});

test("SMTP failures and message content cannot reflect raw server responses, account IDs or token-expiry guesses", () => {
  expect(mailFailure({ code: "EAUTH", message: "server echoed fake-smtp-secret" })).toBe("smtp_auth_failed");
  const message = mailContent([{ id: "private-incident", accountId: "private-id", label: "Alias", reason: "unknown-secret", detectedAt: 1000 }]);
  expect(message.text).not.toContain("private-id"); expect(message.text).not.toContain("unknown-secret");
  expect(message.text).not.toContain("令牌已过期");
});
