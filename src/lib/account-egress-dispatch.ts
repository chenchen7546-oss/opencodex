import type { OcxProviderConfig } from "../types";
import { apiKeyPoolEntryId } from "../providers/api-keys";
import type { EgressScope } from "./account-egress";
/** Translate upstream dispatch receipts once, without importing the optional manager. */
export function dispatchEgressScope(
  provider: string,
  config: OcxProviderConfig,
  binding?:
    | {
        kind: "oauth";
        snapshot: {
          provider: string;
          accountId: string;
        };
      }
    | {
        kind: "api-key";
        provider: OcxProviderConfig;
      },
): EgressScope {
  if (binding?.kind === "oauth")
    return {
      provider,
      purpose: "model",
      account: { kind: "oauth", provider: binding.snapshot.provider, id: binding.snapshot.accountId },
    };
  const keyConfig = binding?.kind === "api-key" ? binding.provider : config;
  const id =
    keyConfig._apiKeyAttempt?.entryId ??
    (keyConfig._apiKeyAttempt?.reference
      ? apiKeyPoolEntryId(keyConfig._apiKeyAttempt.reference)
      : keyConfig.authMode !== "oauth" && keyConfig.authMode !== "forward" && keyConfig.apiKey
        ? apiKeyPoolEntryId(keyConfig.apiKey)
        : undefined);
  return { provider, purpose: "model", ...(id ? { account: { kind: "key" as const, provider, id } } : {}) };
}
