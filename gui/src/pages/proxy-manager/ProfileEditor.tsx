import { useState } from "react";
import { useT } from "../../i18n/shared";
import type { Profile } from "./types";

export function ProfileEditor({
  profile,
  busy,
  onSave,
  onCancel,
}: {
  profile?: Profile;
  busy: boolean;
  onSave: (value: unknown) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState({
    name: profile?.name ?? "",
    protocol: profile?.protocol ?? "socks5",
    host: profile?.host ?? "",
    port: profile?.port ?? 1080,
    username: profile?.username ?? "",
    password: "",
    group: profile?.group ?? "",
    notes: profile?.notes ?? "",
    enabled: profile?.enabled ?? true,
    limitGiB: (profile?.monthlyLimitBytes ?? 0) / 1073741824,
    limitAction: profile?.limitAction ?? "warn",
  });
  const [clearPassword, setClearPassword] = useState(false);
  const [nodeInput, setNodeInput] = useState("");
  const set = (field: string, value: unknown) => setDraft((current) => ({ ...current, [field]: value }));
  return (
    <form
      className="panel pm-editor"
      onSubmit={(event) => {
        event.preventDefault();
        const { limitGiB, password, protocol, host, port, username, ...rest } = draft;
        onSave({
          ...rest,
          monthlyLimitBytes: Math.round(limitGiB * 1073741824),
          ...(profile?.nodeType
            ? nodeInput
              ? { nodeInput }
              : {}
            : {
                protocol,
                host,
                port,
                username,
                ...(password || clearPassword || !profile ? { password: clearPassword ? "" : password } : {}),
              }),
        });
      }}
    >
      <h3>{t(profile ? "pm.edit" : "pm.add")}</h3>
      <div className="pm-form-grid">
        <label>
          {t("pm.name")}
          <input required maxLength={200} value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        {!profile?.nodeType && (
          <>
            <label>
              {t("pm.protocol")}
              <select value={draft.protocol} onChange={(e) => set("protocol", e.target.value)}>
                {["http", "https", "socks5", "socks5h"].map((p) => (
                  <option key={p} value={p}>
                    {p.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("pm.host")}
              <input required value={draft.host} onChange={(e) => set("host", e.target.value)} />
            </label>
            <label>
              {t("pm.port")}
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(e) => set("port", Number(e.target.value))}
              />
            </label>
            <label>
              {t("pm.username")}
              <input autoComplete="off" value={draft.username} onChange={(e) => set("username", e.target.value)} />
            </label>
            <label>
              {t("pm.password")}
              <input
                type="password"
                autoComplete="new-password"
                value={draft.password}
                onChange={(e) => set("password", e.target.value)}
              />
              {profile?.hasPassword && <small>{t("pm.passwordHint")}</small>}
            </label>
          </>
        )}
        <label>
          {t("pm.group")}
          <input value={draft.group} onChange={(e) => set("group", e.target.value)} />
        </label>
        <label>
          {t("pm.limit")}
          <input
            type="number"
            min={0}
            step="any"
            value={draft.limitGiB}
            onChange={(e) => set("limitGiB", Number(e.target.value))}
          />
        </label>
        <label>
          {t("pm.limitAction")}
          <select value={draft.limitAction} onChange={(e) => set("limitAction", e.target.value)}>
            <option value="warn">{t("pm.warn")}</option>
            <option value="block">{t("pm.block")}</option>
          </select>
        </label>
        <label>
          {t("pm.notes")}
          <input maxLength={1000} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
        </label>
      </div>
      {profile?.nodeType && (
        <label>
          {t("pm.replaceNode")}
          <input
            type="password"
            autoComplete="new-password"
            value={nodeInput}
            onChange={(e) => setNodeInput(e.target.value)}
          />
          <small>{t("pm.passwordHint")}</small>
        </label>
      )}
      <label className="pm-check">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        {t("pm.enabled")}
      </label>
      {profile?.hasPassword && !profile.nodeType && (
        <label className="pm-check">
          <input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} />
          {t("pm.removePassword")}
        </label>
      )}
      <div className="pm-toolbar">
        <button className="btn btn-primary" disabled={busy} type="submit">
          {t("pm.save")}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          {t("pm.cancel")}
        </button>
      </div>
    </form>
  );
}
