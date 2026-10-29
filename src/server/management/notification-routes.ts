import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { getNotifications } from "../../notifications/runtime";
import { NotificationError, publicSettings } from "../../notifications/types";

export async function handleNotificationRoutes(ctx: ManagementContext): Promise<Response | null> {
  const prefix = "/api/notifications";
  if (ctx.url.pathname !== prefix && !ctx.url.pathname.startsWith(prefix + "/")) return null;
  const reply = (body: unknown, status = 200) => {
    const response = jsonResponse(body, status, ctx.req, ctx.config);
    response.headers.set("Cache-Control", "no-store"); return response;
  };
  if (ctx.principal !== "admin-token" && ctx.principal !== "gui-session") return reply({ error: "notification_unauthorized" }, 403);
  try {
    const service = getNotifications(ctx.config, true)!;
    const snapshot = () => ({ settings: publicSettings(service.store.settings()), history: service.store.history(),
      lastCheckedAt: service.lastCheckedAt, lastError: service.lastError });
    if (ctx.url.pathname === prefix && ctx.req.method === "GET") return reply(snapshot());
    if (ctx.url.pathname === prefix && ctx.req.method === "PUT") {
      service.store.save(await readManagementJsonBody(ctx.req)); service.configure(); return reply(snapshot());
    }
    if (ctx.url.pathname === `${prefix}/test` && ctx.req.method === "POST") {
      const body = await readManagementJsonBody<{ recipientId?: unknown }>(ctx.req);
      if (typeof body.recipientId !== "string") throw new NotificationError("invalid_recipient");
      const result = await service.test(body.recipientId);
      return reply({ ...snapshot(), result }, result === "sent" ? 200 : 502);
    }
    return reply({ error: "notification_route_not_found" }, 404);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return reply({ error: error instanceof NotificationError ? error.code : "notification_unavailable" }, error instanceof NotificationError ? error.status : 503);
  }
}
