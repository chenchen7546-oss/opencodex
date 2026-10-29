import { ACCOUNT_EGRESS_SCOPE, accountEgressInit } from "../lib/account-egress";
import type { OcxProviderConfig } from "../types";
import type { OcxRuntimeProviderConfig } from "./auth-context";

/** Request-owned routing receipt; symbols are not serialized into provider configuration. */
export function withNativeAccountEgress(provider: OcxRuntimeProviderConfig, accountId: string): OcxRuntimeProviderConfig {
  return { ...provider, ...accountEgressInit({
    account: { kind: "codex", provider: "openai", id: accountId }, purpose: "model",
  }) };
}

/** Reselection must drop the previous native credential and its egress identity together. */
export function stripCodexRuntimeProviderFields(provider: OcxProviderConfig): OcxProviderConfig {
  const {
    _codexAccountOverride: _override,
    _codexAccountRequired: _required,
    [ACCOUNT_EGRESS_SCOPE]: _egress,
    ...safeProvider
  } = provider as OcxRuntimeProviderConfig & Record<symbol, unknown>;
  return safeProvider;
}
