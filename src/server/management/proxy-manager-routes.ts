import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { configureAccountProxies, getProxyManager } from "../../proxy-manager/runtime";
import { parseAccount, parseChoice, parseSettings, profileInput } from "../../proxy-manager/validation";
import { ProxyManagerError } from "../../proxy-manager/types";
import { configuredOutboundFetch } from "../../lib/proxy-env";
import { importProxy, parseSubscription } from "../../proxy-manager/import";
import { refreshSubscription, subscriptionInput } from "../../proxy-manager/subscriptions";
const refreshing = new Set<string>();
/** Authenticated by the existing management dispatcher; no independent unauthenticated listener. */
export async function handleProxyManagerRoutes(ctx: ManagementContext): Promise<Response | null> {
  const prefix = "/api/proxy-manager";
  if (ctx.url.pathname !== prefix && !ctx.url.pathname.startsWith(prefix + "/")) return null;
  const reply = (value: unknown, status = 200) => {
    const response = jsonResponse(value, status, ctx.req, ctx.config);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  if (ctx.principal !== "admin-token" && ctx.principal !== "gui-session")
    return reply({ error: "proxy_management_unauthorized" }, 403);
  try {
    configureAccountProxies(ctx.config);
    const manager = getProxyManager(ctx.config, true)!;
    const path = ctx.url.pathname.slice(prefix.length),
      method = ctx.req.method;
    if (!path && method === "GET")
      return reply({
        profiles: manager.store
          .publicProfiles()
          .map((p) => ({ ...p, monthBytes: manager.store.monthBytes(p.id) + manager.traffic.bufferedBytes(p.id) })),
        accounts: manager.accounts(),
        settings: manager.store.settings(),
        subscriptions: manager.store.subscriptions().map(({ url, ...publicSource }) => publicSource),
        core: manager.core?.status(),
        measurement: "application-body-bytes",
        persistenceFailed: manager.traffic.persistenceFailed,
      });
    if (path === "/profiles" && method === "POST") {
      const value = await readManagementJsonBody(ctx.req);
      const profile = manager.store.save(profileInput(value));
      return reply({ id: profile.id }, 201);
    }
    if (path === "/import" && method === "POST") {
      const body = await readManagementJsonBody<{
        urls?: unknown;
        text?: unknown;
        group?: unknown;
      }>(ctx.req);
      const rows = typeof body.text === "string" ? parseSubscription(body.text) : body.urls;
      if (
        !Array.isArray(rows) ||
        rows.length < 1 ||
        rows.length > 100 ||
        (body.group !== undefined && typeof body.group !== "string")
      )
        throw new ProxyManagerError("invalid_proxy_import");
      const items = rows.map((raw) => importProxy(raw, (body.group as string) ?? ""));
      if (manager.store.profiles().length + items.length > 500) throw new ProxyManagerError("proxy_limit_reached");
      const ids = manager.store.db.transaction(() => items.map((item) => manager.store.save(item).id))();
      return reply({ ids }, 201);
    }
    if (path === "/bindings" && method === "PUT") {
      const body = await readManagementJsonBody<{
        accounts: unknown;
        choice: unknown;
      }>(ctx.req);
      if (!Array.isArray(body.accounts)) throw new ProxyManagerError("invalid_account_count");
      manager.bind(body.accounts.map(parseAccount), parseChoice(body.choice));
      return reply({ ok: true });
    }
    if (path === "/settings" && method === "PATCH") {
      manager.store.saveSettings(parseSettings(await readManagementJsonBody(ctx.req), manager.store.settings()));
      manager.traffic.reconfigure();
      return reply({ ok: true });
    }
    if (path === "/traffic" && method === "GET") {
      const days = Number(ctx.url.searchParams.get("days") ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new ProxyManagerError("invalid_traffic_range");
      const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      const rows = manager.traffic.rows(since);
      return reply({
        rows,
        totals: manager.store.trafficTotals(since),
        since,
        timezone: "UTC",
        measurement: "application-body-bytes",
        truncated: rows.length === 10000,
        persistenceFailed: manager.traffic.persistenceFailed,
      });
    }
    if (path === "/subscriptions" && method === "POST") {
      if (manager.store.subscriptions().length >= 20) throw new ProxyManagerError("subscription_limit_reached");
      const source = subscriptionInput(await readManagementJsonBody(ctx.req));
      if (source.proxyId && !manager.store.profile(source.proxyId)?.enabled)
        throw new ProxyManagerError("proxy_unavailable");
      manager.store.saveSubscription(source);
      return reply({ id: source.id }, 201);
    }
    const sub = /^\/subscriptions\/([^/]+)(\/refresh)?$/.exec(path);
    if (sub) {
      const source = manager.store.subscriptions().find((s) => s.id === sub[1]);
      if (!source) throw new ProxyManagerError("subscription_not_found", 404);
      if (sub[2] && method === "POST") {
        if (refreshing.has(source.id)) throw new ProxyManagerError("subscription_refresh_busy", 409);
        refreshing.add(source.id);
        try {
          return reply(await refreshSubscription(manager, source));
        } finally {
          refreshing.delete(source.id);
        }
      }
      if (!sub[2] && method === "DELETE") {
        if (refreshing.has(source.id)) throw new ProxyManagerError("subscription_refresh_busy", 409);
        manager.store.removeSubscription(source.id);
        return reply({ ok: true });
      }
    }
    const match = /^\/profiles\/([^/]+)(\/probe)?$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      if (!manager.store.profile(id)) throw new ProxyManagerError("proxy_not_found", 404);
      if (match[2] && method === "POST") return reply(await manager.probe(id, configuredOutboundFetch));
      if (!match[2] && method === "PATCH") {
        const body = await readManagementJsonBody<Record<string, unknown>>(ctx.req),
          previous = manager.store.profile(id)!;
        const next = profileInput(body, previous);
        if (body.nodeInput) {
          const imported = importProxy(body.nodeInput, next.group);
          next.node = imported.node;
          next.url = imported.url;
        }
        manager.store.save(next, id);
        return reply({ ok: true });
      }
      if (!match[2] && method === "DELETE") {
        manager.store.remove(id);
        return reply({ ok: true });
      }
    }
    return reply({ error: "proxy_route_not_found" }, 404);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    if (error instanceof SyntaxError) return reply({ error: "invalid_proxy_json" }, 400);
    return reply(
      { error: error instanceof ProxyManagerError ? error.code : "proxy_management_failed" },
      error instanceof ProxyManagerError ? error.status : 500,
    );
  }
}
