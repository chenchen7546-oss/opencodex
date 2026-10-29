import { randomBytes } from "node:crypto";
import { ACCOUNT_EGRESS_SENT } from "../lib/account-egress";
import { configuredOutboundFetch } from "../lib/proxy-env";
import { ProxyManagerError } from "./types";

/** A listening Mihomo socket can precede its Running state. Probe a private local round trip. */
export async function waitForCoreReadiness(
  proxy: string,
  alive: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const nonce = randomBytes(24).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === `/${nonce}`
        ? new Response(null, {
            status: 204,
            headers: { "x-opencodex-ready": nonce },
          })
        : new Response(null, { status: 404 }),
  });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (!alive()) throw new ProxyManagerError("proxy_core_start_failed", 503);
      try {
        const response = await configuredOutboundFetch(
          `http://127.0.0.1:${server.port}/${nonce}`,
          {
            proxy,
            [ACCOUNT_EGRESS_SENT]: true,
            redirect: "error",
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(500, deadline - Date.now())),
            ),
          } as RequestInit,
        );
        const ready =
          response.status === 204 &&
          response.headers.get("x-opencodex-ready") === nonce;
        await response.body?.cancel();
        if (ready && alive()) return;
      } catch {
        /* Startup may accept HTTP before the tunnel can route it. */
      }
      await Bun.sleep(25);
    }
    throw new ProxyManagerError("proxy_core_start_timeout", 503);
  } finally {
    server.stop(true);
  }
}
