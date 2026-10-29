import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OcxConfig } from "../types";
import { getConfigDir } from "../config/paths";
import { runPassiveRead } from "../lib/passive-read";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { NotificationStore } from "./store";
import { NotificationService } from "./service";
import type { AccountObservation } from "./types";

let active: { path: string; config: OcxConfig; service: NotificationService } | undefined;
export async function observeCodexReauthentication(config: OcxConfig): Promise<AccountObservation[]> {
  const { listCodexAuthAccountsSnapshot } = await import("../codex/auth-api/account-list");
  const { accounts } = await runPassiveRead(() => listCodexAuthAccountsSnapshot(config));
  return accounts.map((row) => ({
    id: row.id, label: row.alias || row.email,
    state: row.needsReauth || row.health.status === "reauth_required" ? "reauth"
      : row.hasCredential && row.health.status === "healthy" ? "healthy" : "unknown",
    reason: row.reauthReason ?? "refresh_failed",
  }));
}
export function closeNotifications() { active?.service.close(); active = undefined; }
export function getNotifications(config: OcxConfig, create = false): NotificationService | undefined {
  const path = join(getConfigDir(), "notifications", "state.sqlite");
  if (active && active.path !== path) closeNotifications();
  if (active) active.config = config;
  if (!active && (create || existsSync(path))) {
    assertNotRealHomeUnderTest(path);
    const service = new NotificationService(new NotificationStore(path), () => observeCodexReauthentication(active?.config ?? config));
    active = { path, config, service };
    registerOptionalShutdownHook("email-notifications", closeNotifications);
    service.configure();
  }
  return active?.service;
}
/** Called only by the server composition root; disabled installations start no timer or SMTP connection. */
export function configureNotifications(config: OcxConfig): void {
  try { getNotifications(config); } catch { console.warn("[notifications] notification_store_unavailable"); }
}
