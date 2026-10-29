import { useT } from "../../i18n/shared";
import { requestTextValue } from "../../action-dialogs";
import { credentialAliasRejection, CREDENTIAL_ALIAS_MAX_LENGTH } from "../../credential-alias";
import { accountDisplayName, type AccountRow } from "./types";

export function AccountIdentity({ row, apiBase, busy, act }: {
  row: AccountRow; apiBase: string; busy: boolean;
  act: (work: () => Promise<void>) => Promise<void>;
}) {
  const t = useT();
  if (row.account.id === "@new") return <>{t("pm.newAccount")}</>;
  const name = accountDisplayName(row, t);
  const unnamed = !row.alias && !row.email && (!row.label || row.label === row.account.id);
  async function editAlias() {
    const entered = await requestTextValue({ message: t("prov.aliasPrompt"), initialValue: row.alias ?? "",
      maxLength: CREDENTIAL_ALIAS_MAX_LENGTH, validate: value => credentialAliasRejection(value, t) });
    if (entered === null) return;
    await act(async () => {
      const { kind, provider, id } = row.account;
      const alias = entered.trim();
      const path = kind === "oauth" ? "/api/oauth/accounts/alias" : kind === "key" ? "/api/providers/keys/alias" : "/api/codex-auth/accounts/alias";
      const response = await fetch(apiBase + path, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "oauth" ? { provider, accountId: id, alias } : kind === "key" ? { name: provider, id, alias } : { id, alias }) });
      if (!response.ok) throw new Error(t("prov.aliasSaveFailed"));
    });
  }
  return <div className="pm-account-identity">
    <strong>{name}</strong>
    {row.alias && row.email && row.alias !== row.email && <small>{row.email}</small>}
    {unnamed && row.account.kind !== "key" && <small>{t("pm.identityMissing")}</small>}
    <small><code title={row.account.id}>ID: {row.account.id.length > 16 ? `${row.account.id.slice(0, 6)}…${row.account.id.slice(-6)}` : row.account.id}</code></small>
    {row.orphaned ? <small>{t("pm.orphan")}</small> : row.account.id !== "__main__" && <button className="btn btn-ghost btn-sm" disabled={busy}
      aria-label={t("pm.editIdentity", { name })} onClick={() => void editAlias()}>{t("prov.editAlias")}</button>}
  </div>;
}
