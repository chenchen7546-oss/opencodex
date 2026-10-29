/** Import seam for provider-owned validation, refresh and quota fetches. */
import { configuredOutboundFetch } from "./proxy-env";
export const fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => configuredOutboundFetch(input, init),
  { preconnect: (...args: Parameters<typeof globalThis.fetch.preconnect>) => globalThis.fetch.preconnect?.(...args) },
) as typeof globalThis.fetch;
