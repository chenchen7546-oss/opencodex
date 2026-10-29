/** Core-owned extension seam. No account stores, UI, database or proxy engines on this path. */
import { AsyncLocalStorage } from "node:async_hooks";
export interface EgressAccount {
  kind: "oauth" | "codex" | "key";
  provider: string;
  id: string;
}
export interface EgressScope {
  account?: EgressAccount;
  provider?: string;
  purpose?: "login" | "refresh" | "quota" | "model" | "probe";
  proxyId?: string;
}
export type EgressSend = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface AccountEgressHooks {
  send: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    next: EgressSend,
    scope?: EgressScope,
  ) => Promise<Response>;
  explicit: (input: RequestInfo | URL, init?: RequestInit, scope?: EgressScope) => boolean;
}
const scopes = new AsyncLocalStorage<EgressScope>();
let hooks: AccountEgressHooks | undefined;
export const ACCOUNT_EGRESS_SCOPE = Symbol.for("opencodex.account-egress.scope");
export const ACCOUNT_EGRESS_SENT = Symbol.for("opencodex.account-egress.sent");
export function registerAccountEgress(next: AccountEgressHooks | undefined): void {
  hooks = next;
}
export function withAccountEgress<T>(scope: EgressScope, run: () => T): T {
  return scopes.run(scope, run);
}
export function currentAccountEgress(): EgressScope | undefined {
  return scopes.getStore();
}
export function accountEgressInit(scope: EgressScope): Record<symbol, EgressScope> {
  return { [ACCOUNT_EGRESS_SCOPE]: scope };
}
export function hasExplicitAccountEgress(input: RequestInfo | URL, init?: RequestInit, provider?: string): boolean {
  const scope = (init as Record<symbol, EgressScope> | undefined)?.[ACCOUNT_EGRESS_SCOPE] ?? scopes.getStore();
  return hooks?.explicit(input, init, { ...scope, provider: provider ?? scope?.provider }) ?? false;
}
export function sendWithAccountEgress(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  next: EgressSend,
): Promise<Response> {
  if (!hooks || (init as Record<symbol, unknown> | undefined)?.[ACCOUNT_EGRESS_SENT]) return next(input, init);
  const scope = (init as Record<symbol, EgressScope> | undefined)?.[ACCOUNT_EGRESS_SCOPE] ?? scopes.getStore();
  return hooks.send(input, init, next, scope);
}
