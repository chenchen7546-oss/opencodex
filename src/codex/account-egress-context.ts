import { accountEgressInit } from "../lib/account-egress";
import type { OcxRuntimeProviderConfig } from "./auth-context-provider";
export { stripCodexRuntimeProviderFields } from "./auth-context-provider";

/** Request-owned routing receipt; symbols are not serialized into provider configuration. */
export function withNativeAccountEgress(provider: OcxRuntimeProviderConfig, accountId: string): OcxRuntimeProviderConfig {
  return { ...provider, ...accountEgressInit({
    account: { kind: "codex", provider: "openai", id: accountId }, purpose: "model",
  }) };
}
