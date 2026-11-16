import { ACCOUNT_EGRESS_SCOPE } from "../lib/account-egress";
import type { OcxProviderConfig } from "../types";

export type OcxRuntimeProviderConfig = OcxProviderConfig & {
  _codexAccountOverride?: { accessToken: string; chatgptAccountId: string; kind?: "pool" | "main-pool" };
  _codexAccountRequired?: boolean;
};

export function stripCodexRuntimeProviderFields(provider: OcxProviderConfig): OcxProviderConfig {
  const {
    _codexAccountOverride: _override,
    _codexAccountRequired: _required,
    [ACCOUNT_EGRESS_SCOPE]: _egress,
    ...safeProvider
  } = provider as OcxRuntimeProviderConfig & Record<symbol, unknown>;
  return safeProvider;
}
