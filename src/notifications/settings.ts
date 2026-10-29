import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { NotificationError, type NotificationSettings } from "./types";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotificationError("invalid_settings");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || /[\r\n\0]/.test(value)) throw new NotificationError("invalid_settings");
  return value.trim();
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new NotificationError("invalid_settings");
  return value;
}
function email(value: unknown, optional = false): string {
  const address = text(value, 254);
  if (optional && !address) return address;
  // Single ASCII mailbox only: no display names, recipient lists, headers or SMTP commands.
  if (!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(address))
    throw new NotificationError("invalid_email");
  return address;
}
export function requireMailConfiguration(settings: NotificationSettings): void {
  if (!settings.smtp.host || !settings.smtp.from || !settings.smtp.username || !settings.smtp.password)
    throw new NotificationError("smtp_incomplete");
}
export function parseNotificationSettings(value: unknown, previous: NotificationSettings): NotificationSettings {
  const body = object(value), rawSmtp = object(body.smtp);
  if (body.revision !== previous.revision) throw new NotificationError("settings_conflict", 409);
  const host = text(rawSmtp.host, 253);
  if (host && !isIP(host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))
    throw new NotificationError("invalid_smtp_host");
  const port = rawSmtp.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new NotificationError("invalid_smtp_port");
  if (rawSmtp.security !== "tls" && rawSmtp.security !== "starttls") throw new NotificationError("invalid_smtp_security");
  let password = previous.smtp.password;
  if (rawSmtp.password !== undefined) {
    if (typeof rawSmtp.password !== "string" || rawSmtp.password.length > 4096 || /[\r\n\0]/.test(rawSmtp.password))
      throw new NotificationError("invalid_settings");
    if (rawSmtp.password) password = rawSmtp.password;
  }
  if (rawSmtp.clearPassword === true) password = "";
  if (!Array.isArray(body.recipients) || body.recipients.length > 20) throw new NotificationError("recipient_limit");
  const seen = new Set<string>(), ids = new Set<string>();
  const recipients = body.recipients.map((entry) => {
    const row = object(entry), address = email(row.address);
    if (seen.has(address.toLowerCase())) throw new NotificationError("duplicate_recipient");
    seen.add(address.toLowerCase());
    const existing = previous.recipients.find((r) => r.id === row.id);
    // Replacing an address starts a fresh delivery identity; a new mailbox has not received old mail.
    const id = existing?.address.toLowerCase() === address.toLowerCase() ? existing.id : randomUUID();
    if (ids.has(id)) throw new NotificationError("duplicate_recipient");
    ids.add(id);
    return { id, address, enabled: flag(row.enabled) };
  });
  const next: NotificationSettings = { revision: previous.revision + 1, enabled: flag(body.enabled),
    smtp: { host, port, security: rawSmtp.security, username: text(rawSmtp.username, 254), password, from: email(rawSmtp.from, true) }, recipients };
  if (next.enabled) {
    requireMailConfiguration(next);
    if (!recipients.some((row) => row.enabled)) throw new NotificationError("no_enabled_recipient");
  }
  return next;
}
