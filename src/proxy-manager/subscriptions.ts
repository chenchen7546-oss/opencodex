import { randomUUID } from "node:crypto";
import type { ProxyManager } from "./service";
import { importProxy, parseSubscription } from "./import";
import { ProxyManagerError, type ProxySubscription } from "./types";
import { configuredOutboundFetch } from "../lib/proxy-env";
import { ACCOUNT_EGRESS_SENT } from "../lib/account-egress";
export function subscriptionInput(raw: Record<string, unknown>): ProxySubscription {
  let url: URL;
  try {
    url = new URL(String(raw.url));
  } catch {
    throw new ProxyManagerError("invalid_subscription_url");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.href.length > 4096)
    throw new ProxyManagerError("invalid_subscription_url");
  if (
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    raw.name.length > 200 ||
    typeof (raw.group ?? "") !== "string" ||
    String(raw.group ?? "").length > 200
  )
    throw new ProxyManagerError("invalid_proxy_field");
  return {
    id: randomUUID(),
    name: raw.name.trim(),
    url: url.href,
    group: String(raw.group ?? ""),
    ...(typeof raw.proxyId === "string" && raw.proxyId ? { proxyId: raw.proxyId } : {}),
  };
}
/** Credentials in subscription URLs never leave the protected store or enter a public DTO. */
export async function refreshSubscription(
  manager: ProxyManager,
  source: ProxySubscription,
): Promise<{
  added: number;
  updated: number;
  disabled: number;
}> {
  const init: RequestInit = { redirect: "manual", signal: AbortSignal.timeout(20000) };
  const response = source.proxyId
    ? await manager.send(source.url, init, configuredOutboundFetch, { proxyId: source.proxyId, purpose: "probe" })
    : await configuredOutboundFetch(source.url, { ...init, [ACCOUNT_EGRESS_SENT]: true } as RequestInit);
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProxyManagerError("subscription_fetch_failed", 502);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new ProxyManagerError("proxy_subscription_too_large");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const raw = parseSubscription(Buffer.concat(chunks).toString("utf8"));
  if (!raw.length || raw.length > 500) throw new ProxyManagerError("invalid_proxy_import");
  const items = raw.map((row) => importProxy(row, source.group));
  const names = new Set(items.map((p) => p.name));
  if (names.size !== items.length) throw new ProxyManagerError("duplicate_subscription_names");
  const old = manager.store.profiles().filter((p) => p.subscriptionId === source.id);
  const lookup = new Map(old.map((p) => [p.subscriptionName, p]));
  let added = 0,
    updated = 0,
    disabled = 0;
  manager.store.db.transaction(() => {
    for (const item of items) {
      const prior = lookup.get(item.name);
      manager.store.save(
        {
          ...item,
          ...(prior
            ? {
                name: prior.name,
                enabled: prior.enabled,
                monthlyLimitBytes: prior.monthlyLimitBytes,
                limitAction: prior.limitAction,
                notes: prior.notes,
              }
            : {}),
          subscriptionId: source.id,
          subscriptionName: item.name,
        },
        prior?.id,
      );
      prior ? updated++ : added++;
    }
    for (const p of old)
      if (!names.has(p.subscriptionName!)) {
        manager.store.save({ ...p, enabled: false }, p.id);
        disabled++;
      }
    manager.store.saveSubscription({ ...source, updatedAt: Date.now() });
  })();
  return { added, updated, disabled };
}
