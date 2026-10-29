import { useEffect, useRef, useState } from "react";
import { useT, type TKey } from "../i18n/shared";
import { EmptyState, Notice, Switch } from "../ui";
import { IconMail, IconPlus, IconRefresh, IconTrash } from "../icons";
import "./proxy-manager/styles.css";
import "./notifications.css";

interface Recipient { id: string; address: string; enabled: boolean }
interface Settings {
  revision: number; enabled: boolean;
  smtp: { host: string; port: number; security: "tls" | "starttls"; username: string; from: string; hasPassword: boolean };
  recipients: Recipient[];
}
interface Snapshot {
  settings: Settings; lastCheckedAt?: number; lastError?: string;
  history: { recipientId: string; kind: "test" | "reauth"; at: number; result: string; count: number }[];
}
const messages: Record<string, TKey> = {
  sent: "mail.sent", smtp_auth_failed: "mail.authError", smtp_connection_failed: "mail.connectionError",
  smtp_tls_failed: "mail.tlsError", smtp_timeout: "mail.timeoutError", smtp_rejected: "mail.rejectedError",
  smtp_incomplete: "mail.incompleteError", invalid_email: "mail.recipientError", duplicate_recipient: "mail.recipientError",
  no_enabled_recipient: "mail.recipientError", recipient_disabled: "mail.recipientError", recipient_limit: "mail.recipientError",
  settings_conflict: "mail.conflictError", notification_busy: "mail.busyError", cancelled: "mail.cancelled",
};

export default function Notifications({ apiBase }: { apiBase: string }) {
  return <NotificationsPanel key={apiBase} apiBase={apiBase} />;
}
function NotificationsPanel({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [draft, setDraft] = useState<Settings>();
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<"saved" | "testSent" | "">("");
  const lifecycle = useRef<AbortController | null>(null);
  const acting = useRef(false);
  const recipientSequence = useRef(0);
  const message = (code: string) => t(messages[code] ?? "mail.error");
  function adopt(value: Snapshot) {
    setSnapshot(value); setDraft(value.settings); setPassword(""); setClearPassword(false); setDirty(false);
  }
  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller; acting.current = false;
    void fetch(`${apiBase}/api/notifications`, { signal: controller.signal }).then(async (response) => {
      const value = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) setError(value.error ?? "notification_unavailable"); else adopt(value);
    }).catch(() => { if (!controller.signal.aborted) setError("notification_unavailable"); });
    return () => controller.abort();
  }, [apiBase]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function change(next: Settings) { setDraft(next); setDirty(true); setNotice(""); }
  async function request(path: string, method: string, body?: unknown) {
    if (acting.current) return;
    const controller = lifecycle.current;
    acting.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${apiBase}/api/notifications${path}`, { method, signal: controller?.signal,
        ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      const value = await response.json();
      if (controller !== lifecycle.current || controller?.signal.aborted) return;
      if (value.settings) adopt(value);
      if (!response.ok) setError(value.error ?? value.result ?? "notification_unavailable");
      else setNotice(path === "/test" ? "testSent" : method === "PUT" ? "saved" : "");
    } catch { if (!controller?.signal.aborted) setError("notification_unavailable"); }
    finally { if (controller === lifecycle.current && !controller?.signal.aborted) { acting.current = false; setBusy(false); } }
  }
  return <div className="pm-page mail-page">
    <header className="pm-toolbar pm-page-head">
      <div><h1>{t("mail.title")}</h1><p className="muted">{t("mail.subtitle")}</p></div>
      <button type="button" className="btn btn-ghost" disabled={busy || dirty} onClick={() => void request("", "GET")}>
        <IconRefresh aria-hidden="true" />{t("pm.refresh")}
      </button>
    </header>
    {error && <Notice tone="err">{message(error)}</Notice>}
    {notice && <Notice tone="ok">{t(`mail.${notice}`)}</Notice>}
    {!draft && !error && <p>{t("pm.loading")}</p>}
    {draft && <form className="mail-form" onSubmit={(event) => { event.preventDefault(); void request("", "PUT", {
      ...draft, smtp: { ...draft.smtp, ...(password ? { password } : {}), clearPassword },
    }); }}>
      <section className="pm-section pm-profiles">
        <div className="pm-section-head">
          <div><h2>{t("mail.rule")}</h2><p className="mail-state" aria-live="polite">{t(snapshot?.settings.enabled ? "mail.on" : "mail.off")}</p></div>
          <Switch on={draft.enabled} disabled={busy} label={t("mail.enabled")} showLabel onClick={() => change({ ...draft, enabled: !draft.enabled })} />
        </div>
        <p className="muted mail-hint">{t("mail.ruleHint")}</p>
      </section>
      <section className="panel pm-editor" aria-label={t("mail.smtp")}>
        <div><h2>{t("mail.smtp")}</h2><p className="muted mail-hint">{t("mail.smtpHint")}</p></div>
        <div className="pm-form-grid mail-smtp-grid">
          <label>{t("mail.host")}<input autoComplete="off" required={draft.enabled} maxLength={253} disabled={busy} value={draft.smtp.host}
            onChange={(e) => change({ ...draft, smtp: { ...draft.smtp, host: e.target.value } })} /></label>
          <label>{t("mail.port")}<input type="number" min={1} max={65535} required disabled={busy} value={draft.smtp.port}
            onChange={(e) => change({ ...draft, smtp: { ...draft.smtp, port: Number(e.target.value) } })} /></label>
          <label>{t("mail.security")}<select disabled={busy} value={draft.smtp.security}
            onChange={(e) => change({ ...draft, smtp: { ...draft.smtp, security: e.target.value as "tls" | "starttls" } })}>
            <option value="tls">{t("mail.tls")}</option><option value="starttls">{t("mail.starttls")}</option>
          </select></label>
          <label>{t("mail.username")}<input autoComplete="off" maxLength={254} required={draft.enabled} disabled={busy} value={draft.smtp.username}
            onChange={(e) => change({ ...draft, smtp: { ...draft.smtp, username: e.target.value } })} /></label>
          <label>{t("mail.password")}<input type="password" autoComplete="new-password" maxLength={4096} disabled={busy || clearPassword}
            required={draft.enabled && !draft.smtp.hasPassword} value={password} onChange={(e) => { setPassword(e.target.value); setDirty(true); setNotice(""); }} />
            {draft.smtp.hasPassword && <small>{t("mail.passwordHint")}</small>}
          </label>
          <label>{t("mail.from")}<input type="email" autoComplete="off" required={draft.enabled} maxLength={254} disabled={busy} value={draft.smtp.from}
            onChange={(e) => change({ ...draft, smtp: { ...draft.smtp, from: e.target.value } })} /></label>
        </div>
        {draft.smtp.hasPassword && <label className="pm-check"><input type="checkbox" checked={clearPassword} disabled={busy}
          onChange={(e) => { setClearPassword(e.target.checked); setPassword(""); setDirty(true); setNotice(""); }} />{t("mail.clearPassword")}</label>}
      </section>
      <section className="pm-section pm-profiles" aria-label={t("mail.recipients")}>
        <div className="pm-section-head"><h2>{t("mail.recipients")} <span className="pm-count">{draft.recipients.length}</span></h2>
          <button type="button" className="btn btn-ghost" disabled={busy || draft.recipients.length >= 20}
            onClick={() => change({ ...draft, recipients: [...draft.recipients, { id: `draft-${++recipientSequence.current}`, address: "", enabled: true }] })}>
            <IconPlus aria-hidden="true" />{t("mail.addRecipient")}
          </button>
        </div>
        <p className="muted mail-hint">{t("mail.recipientHint")}</p>
        {!draft.recipients.length && <EmptyState className="pm-empty" icon={<span className="pm-empty-icon"><IconMail aria-hidden="true" /></span>}
          title={t("mail.emptyRecipients")}>{t("mail.emptyRecipientsHint")}</EmptyState>}
        {draft.recipients.map((recipient, index) => <div className="mail-recipient" key={recipient.id}>
          <label className="mail-address"><span>{t("mail.address")} {index + 1}</span><input type="email" required maxLength={254} autoComplete="off"
            disabled={busy} value={recipient.address} onChange={(e) => change({ ...draft, recipients: draft.recipients.map((row) => row.id === recipient.id ? { ...row, address: e.target.value } : row) })} /></label>
          <Switch on={recipient.enabled} disabled={busy} label={`${t("mail.recipientEnabled")} ${index + 1}`} showLabel
            onClick={() => change({ ...draft, recipients: draft.recipients.map((row) => row.id === recipient.id ? { ...row, enabled: !row.enabled } : row) })} />
          <div className="pm-actions"><button type="button" className="btn btn-ghost btn-sm" disabled={busy || dirty || !recipient.enabled} title={t("mail.testHint")}
            onClick={() => void request("/test", "POST", { recipientId: recipient.id })}>{t("mail.test")}</button>
          <button type="button" className="btn btn-ghost btn-sm pm-danger" disabled={busy} aria-label={`${t("mail.removeRecipient")} ${index + 1}`}
            onClick={() => change({ ...draft, recipients: draft.recipients.filter((row) => row.id !== recipient.id) })}>
            <IconTrash aria-hidden="true" />{t("pm.delete")}
          </button></div>
        </div>)}
        {draft.recipients.length > 0 && <p className="muted mail-hint">{t("mail.testHint")}</p>}
      </section>
      <div className="mail-save-bar"><span role="status">{dirty ? t("mail.unsaved") : ""}</span>
        <button className="btn btn-primary" type="submit" disabled={busy || !dirty}>{t(busy ? "mail.saving" : "mail.save")}</button>
      </div>
    </form>}
    {snapshot && <section className="pm-section pm-profiles" aria-label={t("mail.history")}>
      <div className="pm-section-head"><h2>{t("mail.history")}</h2>
        {snapshot.lastCheckedAt && <small>{t("mail.checked", { time: new Date(snapshot.lastCheckedAt).toLocaleString() })}</small>}
      </div>
      <p className="muted mail-hint">{t("mail.retryHint")}</p>
      {snapshot.lastError && <Notice tone="warn">{t("mail.checkError")}</Notice>}
      {snapshot.history.length ? <div className="pm-table" role="region" aria-label={t("mail.history")} tabIndex={0}>
        <table><thead><tr>{(["mail.time", "mail.address", "mail.kind", "mail.result"] as const).map((key) => <th key={key}>{t(key)}</th>)}</tr></thead>
          <tbody>{snapshot.history.map((row, index) => <tr key={index}>
            <td>{new Date(row.at).toLocaleString()}</td><td>{snapshot.settings.recipients.find((recipient) => recipient.id === row.recipientId)?.address ?? t("mail.removedRecipient")}</td>
            <td>{row.kind === "test" ? t("mail.testKind") : t("mail.reauthKind", { count: row.count })}</td>
            <td className={row.result === "sent" ? "pm-core-status" : "pm-warning"}>{message(row.result)}</td>
          </tr>)}</tbody>
        </table>
      </div> : <EmptyState className="pm-empty" title={t("mail.emptyHistory")} />}
    </section>}
  </div>;
}
