/** Upstream account-store adapter. Keep upstream identity changes confined to this file. */
import type { OcxConfig } from "../types";
import type { EgressAccount } from "../lib/account-egress";
import { loadAuthStore } from "../oauth/store";
import { loadCodexAccountStore } from "../codex/account-store";
import { resolveProviderApiKey } from "../providers/api-key-resolve";
import type { AccountSource } from "./service";
import { accountKey } from "./types";
import { apiKeyPoolEntryId } from "../providers/api-keys";
import { PROVIDER_REGISTRY } from "../providers/registry";
import { readCodexTokensResult } from "../codex/auth-collision";
interface Row {
  account: EgressAccount;
  label: string;
  secrets: string[];
}
function rows(config: OcxConfig, secrets = true, providerHint?: string): Row[] {
  const result: Row[] = [];
  for (const [provider, set] of Object.entries(loadAuthStore())) {
    if (providerHint && provider !== providerHint) continue;
    for (const row of set.accounts)
      result.push({
        account: { kind: "oauth", provider, id: row.id },
        label: row.alias ?? row.credential.email ?? row.id,
        secrets: [row.credential.access, row.credential.refresh].filter(Boolean),
      });
  }
  if (!providerHint || providerHint === "openai") {
    const native = loadCodexAccountStore();
    const main = readCodexTokensResult(undefined, { bounded: true });
    if (main.status === "ok")
      result.push({
        account: { kind: "codex", provider: "openai", id: "__main__" },
        label: "__main__",
        secrets: [main.tokens.access_token],
      });
    for (const row of config.codexAccounts ?? []) {
      if (row.id === "__main__" && main.status === "ok") continue;
      const credential = native[row.id];
      result.push({
        account: { kind: "codex", provider: "openai", id: row.id },
        label: row.alias ?? row.email ?? row.id,
        secrets: credential ? [credential.accessToken, credential.refreshToken].filter(Boolean) : [],
      });
    }
  }
  for (const [provider, value] of Object.entries(config.providers)) {
    if (providerHint && provider !== providerHint) continue;
    if (value.authMode === "oauth" || value.authMode === "forward") continue;
    const keys = value.apiKeyPool?.length
      ? value.apiKeyPool
      : value.apiKey
        ? [{ id: apiKeyPoolEntryId(value.apiKey), key: value.apiKey }]
        : [];
    for (const key of keys) {
      let resolved: string | undefined;
      try {
        if (secrets) resolved = resolveProviderApiKey(key.key);
      } catch {
        /* unavailable key stores cannot identify an outgoing token */
      }
      result.push({
        account: { kind: "key", provider, id: key.id },
        label: ("label" in key && key.label) || key.id,
        secrets: resolved ? [resolved] : [],
      });
    }
  }
  return result;
}
/** Match only credential fields, never prompts, arbitrary body text or substrings. */
function sentCredentials(input: RequestInfo | URL, init?: RequestInit): Set<string> {
  const values = new Set<string>();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const name of ["authorization", "x-api-key", "api-key", "x-goog-api-key", "x-dsh-auth-token", "x-auth-token"]) {
    const value = headers.get(name);
    if (value) values.add(value.replace(/^(Bearer|Token)\s+/i, ""));
  }
  const url = new URL(input instanceof Request ? input.url : String(input));
  for (const name of ["key", "api_key"]) {
    const value = url.searchParams.get(name);
    if (value) values.add(value);
  }
  if (typeof init?.body === "string" && init.body.length <= 16384 && /refresh_token|access_token/.test(init.body)) {
    try {
      const body = JSON.parse(init.body);
      for (const name of ["refresh_token", "access_token"]) if (typeof body[name] === "string") values.add(body[name]);
    } catch {
      /* not a JSON token exchange */
    }
    try {
      const body = new URLSearchParams(init.body);
      for (const name of ["refresh_token", "access_token"]) {
        const value = body.get(name);
        if (value) values.add(value);
      }
    } catch {
      /* not form encoded */
    }
  }
  return values;
}
export function upstreamAccounts(configSource: OcxConfig | (() => OcxConfig)): AccountSource {
  const config = () => (typeof configSource === "function" ? configSource() : configSource);
  return {
    list: () => {
      const accounts = rows(config(), false).map(({ account, label }) => ({ account, label }));
      for (const provider of new Set([
        ...Object.keys(config().providers),
        ...PROVIDER_REGISTRY.filter((p) => p.oauthId).map((p) => p.oauthId!),
      ]))
        accounts.push({ account: { kind: "oauth", provider, id: "@new" }, label: "@new" });
      return accounts;
    },
    resolve: (input, init, provider) => {
      const sent = sentCredentials(input, init);
      if (!sent.size) return [];
      const matches = rows(config(), true, provider).filter(
        (row) => (!provider || row.account.provider === provider) && row.secrets.some((secret) => sent.has(secret)),
      );
      return [...new Map(matches.map((row) => [accountKey(row.account), row.account])).values()];
    },
  };
}
