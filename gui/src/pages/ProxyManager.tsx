import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { EmptyState, Notice } from "../ui";
import { IconCheck, IconDownload, IconLink, IconPlus, IconRefresh, IconSearch, IconServer } from "../icons";
import { ProfileEditor } from "./proxy-manager/ProfileEditor";
import { Subscriptions } from "./proxy-manager/Subscriptions";
import { AccountIdentity } from "./proxy-manager/AccountIdentity";
import { accountDisplayName, bytes, keyOf, type Choice, type Profile, type Snapshot, type Traffic } from "./proxy-manager/types";
import "./proxy-manager/styles.css";

export default function ProxyManager({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [data, setData] = useState<Snapshot>();
  const [traffic, setTraffic] = useState<Traffic>();
  const [tab, setTab] = useState<"proxies" | "accounts" | "traffic" | "settings">("proxies");
  const [filter, setFilter] = useState("");
  const [days, setDays] = useState(30);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignment, setAssignment] = useState("inherit");
  const [editor, setEditor] = useState<Profile | "new" | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [probes, setProbes] = useState<Record<string, string>>({});
  const lifetime = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const acting = useRef(false);
  const request = useCallback(
    async <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
      const controller = lifetime.current;
      const response = await fetch(`${apiBase}/api/proxy-manager${path}`, {
        method,
        signal: controller?.signal,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      controller?.signal.throwIfAborted();
      if (controller !== lifetime.current) throw new Error("request_cancelled");
      if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `HTTP ${response.status}`);
      return value;
    },
    [apiBase],
  );
  const load = useCallback(async () => {
    const epoch = generation.current;
    const [snapshot, stats] = await Promise.all([request<Snapshot>(""), request<Traffic>(`/traffic?days=${days}`)]);
    if (epoch !== generation.current) return;
    setData(snapshot);
    setTraffic(stats);
    const live = new Set(snapshot.accounts.map((row) => keyOf(row.account)));
    setSelected((old) => new Set([...old].filter((key) => live.has(key))));
  }, [request, days]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    generation.current++;
    acting.current = false;
    void load().catch((err) => {
      if (!controller.signal.aborted) setError(String(err.message ?? "request_failed"));
    });
    return () => {
      controller.abort();
    };
  }, [load]);
  async function act(work: () => Promise<void>, refreshed = false) {
    if (acting.current) return;
    acting.current = true;
    const epoch = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      if (epoch === generation.current) {
        await load();
        setNotice(t(refreshed ? "pm.refreshed" : "pm.saved"));
      }
    } catch (err) {
      if (epoch === generation.current) setError(err instanceof Error ? err.message : "request_failed");
    } finally {
      if (epoch === generation.current) {
        setBusy(false);
        acting.current = false;
      }
    }
  }
  const profiles = data?.profiles ?? [];
  const proxyName = (id: string) =>
    id === "direct" ? t("pm.direct") : (profiles.find((p) => p.id === id)?.name ?? id);
  const choiceName = (choice: Choice, providerDefault = false) =>
    choice.mode === "proxy" ? proxyName(choice.proxyId) : t(choice.mode === "direct" ? "pm.direct" : providerDefault ? "pm.systemNetwork" : "pm.accountInherit");
  const query = filter.toLocaleLowerCase();
  const accounts = (data?.accounts ?? []).filter((row) =>
    [accountDisplayName(row, t), row.email, row.account.provider, row.account.id, choiceName(row.choice, row.account.id === "@new")]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query),
  );
  const filteredProfiles = profiles.filter((row) =>
    [row.name, row.group, row.host, row.notes].join(" ").toLocaleLowerCase().includes(query),
  );
  const grouped = traffic?.totals ?? [];
  const totals = grouped.reduce(
    (a, r) => ({ upload: a.upload + r.upload, download: a.download + r.download, requests: a.requests + r.requests }),
    { upload: 0, download: 0, requests: 0 },
  );
  function exportCsv() {
    const cell = (value: unknown) => {
      const raw = String(value);
      return `"${(/^[=+@-]/.test(raw) ? "'" : "") + raw.replaceAll('"', '""')}"`;
    };
    const rows = [
      [
        "day_utc",
        "proxy",
        "account",
        "purpose",
        "upload_body_bytes",
        "download_body_bytes",
        "requests",
        "failures",
        "incomplete",
      ],
      ...(traffic?.rows ?? []).map((r) => [
        r.day,
        proxyName(r.proxyId),
        r.accountKey,
        r.purpose,
        r.upload,
        r.download,
        r.requests,
        r.failures,
        r.incomplete,
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob(["\ufeff" + rows.map((row) => row.map(cell).join(",")).join("\r\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "proxy-traffic.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="pm-page">
      <div className="pm-toolbar pm-page-head">
        <div>
          <h1>{t("pm.title")}</h1>
          <p className="muted">{t("pm.subtitle")}</p>
        </div>
        {notice && <span className="pm-saved" role="status"><IconCheck aria-hidden="true" />{notice}</span>}
        <button className="btn btn-ghost" disabled={busy} onClick={() => void act(async () => {}, true)}>
          <IconRefresh aria-hidden="true" />
          {t("pm.refresh")}
        </button>
      </div>
      <nav className="page-tabs pm-tabs" aria-label={t("pm.title")}>
        {(["proxies", "accounts", "traffic", "settings"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-current={tab === value ? "page" : undefined}
            className={`page-tab${tab === value ? " page-tab--active" : ""}`}
            onClick={() => { setTab(value); setFilter(""); setNotice(""); }}
          >
            {t(`pm.${value}`)}
          </button>
        ))}
      </nav>
      {error && <Notice tone="warn">{error === "duplicate_subscription" ? t("pm.duplicateSubscription") : error === "unsupported_proxy_node_field" ? t("pm.unsupportedNodeField") : t("pm.failed", { code: error })}</Notice>}
      {(data?.persistenceFailed || traffic?.persistenceFailed) && <Notice tone="warn">{t("pm.incomplete")}</Notice>}
      {!data && !error && <p>{t("pm.loading")}</p>}
      {data && tab === "proxies" && (
        <>
          <div className="pm-runtime">
            <span className={data.core?.installed ? "pm-core-status" : "pm-warning"}>
              <IconServer aria-hidden="true" />
              {t(data.core?.running ? "pm.coreRunning" : data.core?.installed ? "pm.coreReady" : "pm.coreMissing")}
            </span>
            <span className="muted">{t("pm.serverHint")}</span>
          </div>
          <section className="pm-section pm-profiles" aria-label={t("pm.proxies")}>
          <div className="pm-section-head">
            <h2>{t("pm.proxies")} <span className="pm-count">{profiles.length}</span></h2>
            <div className="pm-actions">
            <button className="btn btn-ghost" onClick={() => { setImportText(""); setEditor(null); }} disabled={busy}>
              <IconDownload aria-hidden="true" />{t("pm.import")}
            </button>
            <button className="btn btn-primary" onClick={() => { setEditor("new"); setImportText(null); }} disabled={busy}>
              <IconPlus aria-hidden="true" />
              {t("pm.add")}
            </button>
            </div>
          </div>
          {profiles.length > 0 && <label className="pm-search-wrap"><IconSearch aria-hidden="true" />
            <input className="pm-search" aria-label={t("pm.searchProxies")} placeholder={t("pm.searchProxies")}
              value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>}
          {editor && (
            <ProfileEditor
              key={editor === "new" ? "new" : editor.id}
              profile={editor === "new" ? undefined : editor}
              busy={busy}
              onCancel={() => setEditor(null)}
              onSave={(value) =>
                void act(async () => {
                  await request(
                    editor === "new" ? "/profiles" : `/profiles/${editor.id}`,
                    editor === "new" ? "POST" : "PATCH",
                    value,
                  );
                  setEditor(null);
                })
              }
            />
          )}
          {importText !== null && (
            <form
              className="panel pm-editor"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await request("/import", "POST", { text: importText });
                  setImportText(null);
                });
              }}
            >
              <label>
                {t("pm.importHint")}
                <textarea required rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} />
              </label>
              <div className="pm-form-footer">
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setImportText(null)}>
                  {t("pm.cancel")}
                </button>
                <button className="btn btn-primary" disabled={busy}>{t("pm.import")}</button>
              </div>
            </form>
          )}
          {filteredProfiles.length > 0 ? <div className="pm-table" role="region" aria-label={t("pm.proxies")} tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>{t("pm.name")}</th>
                  <th>{t("pm.host")}</th>
                  <th>{t("pm.group")}</th>
                  <th>{t("pm.accounts")}</th>
                  <th>{t("pm.month")}</th>
                  <th>{t("pm.exit")}</th>
                  <th>{t("pm.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredProfiles.map((profile) => (
                  <tr key={profile.id}>
                    <td>
                      <strong>{profile.name}</strong>
                      {!profile.enabled && <small>{t("pm.off")}</small>}
                    </td>
                    <td>
                      <code>
                        {profile.nodeType ?? profile.protocol}://{profile.host}:{profile.port}
                      </code>
                    </td>
                    <td>{profile.group}</td>
                    <td>{profile.bindings}</td>
                    <td>
                      {bytes(profile.monthBytes)}
                      {profile.monthlyLimitBytes > 0 && <small>{bytes(profile.monthlyLimitBytes)}</small>}
                      {profile.monthlyLimitBytes > 0 && profile.monthBytes >= profile.monthlyLimitBytes && (
                        <small className="pm-warning">{t("pm.limitReached")}</small>
                      )}
                    </td>
                    <td>{probes[profile.id] ?? "—"}</td>
                    <td>
                      <div className="pm-actions">
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busy}
                          title={t("pm.probeHint")}
                          onClick={() =>
                            void act(async () => {
                              const result = await request<{
                                ok: boolean;
                                exitIp?: string;
                                latencyMs: number;
                                code?: string;
                              }>(`/profiles/${profile.id}/probe`, "POST");
                              setProbes((old) => ({
                                ...old,
                                [profile.id]: result.ok
                                  ? `${result.exitIp} · ${result.latencyMs} ms`
                                  : (result.code ?? "failed"),
                              }));
                            })
                          }
                        >
                          {t("pm.probe")}
                        </button>
                        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setEditor(profile); setImportText(null); }}>
                          {t("pm.edit")}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm pm-danger"
                          disabled={busy || profile.bindings > 0}
                          onClick={() => {
                            if (window.confirm(t("pm.deleteConfirm", { name: profile.name })))
                              void act(async () => {
                                await request(`/profiles/${profile.id}`, "DELETE");
                              });
                          }}
                        >
                          {t("pm.delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div> : <EmptyState className="pm-empty" icon={<span className="pm-empty-icon"><IconLink aria-hidden="true" /></span>}
            title={t(filter ? "pm.noMatches" : "pm.emptyProxies")}>
            <p>{t(filter ? "pm.noMatchesHint" : "pm.emptyProxiesHint")}</p>
            {filter && <button className="btn btn-ghost" onClick={() => setFilter("")}>{t("pm.clearFilter")}</button>}
          </EmptyState>}
          </section>
          <Subscriptions key={apiBase} data={data} busy={busy} request={request} act={act} />
        </>
      )}
      {data && tab === "accounts" && (
        <>
          <label className="pm-search-wrap"><IconSearch aria-hidden="true" />
            <input className="pm-search" aria-label={t("pm.searchAccounts")} placeholder={t("pm.searchAccounts")}
              value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          <p className="muted">{t("pm.cliLimit")}</p>
          <p className="muted">{t("pm.bindingHelp")}</p>
          <div className="pm-toolbar pm-selection-bar">
            <span>{t("pm.selected", { count: selected.size })}</span>
            <select aria-label={t("pm.current")} value={assignment} onChange={(e) => setAssignment(e.target.value)}>
              <option value="inherit">{t("pm.inherit")}</option>
              <option value="direct">{t("pm.direct")}</option>
              {profiles
                .filter((p) => p.enabled)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <button
              className="btn btn-primary"
              disabled={busy || !selected.size}
              onClick={() =>
                void act(async () => {
                  const choice =
                    assignment === "inherit" || assignment === "direct"
                      ? { mode: assignment }
                      : { mode: "proxy", proxyId: assignment };
                  await request("/bindings", "PUT", {
                    accounts: data.accounts.filter((row) => selected.has(keyOf(row.account))).map((row) => row.account),
                    choice,
                  });
                  setSelected(new Set());
                })
              }
            >
              {t("pm.assign")}
            </button>
          </div>
          <div className="pm-table">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label={t("pm.selectAll")}
                      checked={accounts.length > 0 && accounts.every((row) => selected.has(keyOf(row.account)))}
                      onChange={(e) =>
                        setSelected((old) => {
                          const next = new Set(old);
                          for (const row of accounts) {
                            if (e.target.checked) next.add(keyOf(row.account));
                            else next.delete(keyOf(row.account));
                          }
                          return next;
                        })
                      }
                    />
                  </th>
                  <th>{t("pm.account")}</th>
                  <th>{t("pm.provider")}</th>
                  <th>{t("pm.current")}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((row) => (
                  <tr key={keyOf(row.account)}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={accountDisplayName(row, t)}
                        checked={selected.has(keyOf(row.account))}
                        onChange={(e) =>
                          setSelected((old) => {
                            const next = new Set(old);
                            if (e.target.checked) next.add(keyOf(row.account));
                            else next.delete(keyOf(row.account));
                            return next;
                          })
                        }
                      />
                    </td>
                    <td>
                      <AccountIdentity row={row} apiBase={apiBase} busy={busy} act={act} />
                    </td>
                    <td>{row.account.provider}</td>
                    <td>{choiceName(row.choice, row.account.id === "@new")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!accounts.length && <EmptyState className="pm-empty" title={t(filter ? "pm.noMatches" : "pm.empty")}>
              {filter && <button className="btn btn-ghost" onClick={() => setFilter("")}>{t("pm.clearFilter")}</button>}
            </EmptyState>}
          </div>
        </>
      )}
      {data && tab === "traffic" && (
        <>
          <div className="pm-toolbar">
            <label>
              {t("pm.days")}
              <select disabled={busy} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[1, 7, 30, 90].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" onClick={exportCsv}>
              {t("pm.export")}
            </button>
          </div>
          <p className="muted">{t("pm.measurement")}</p>
          {traffic?.truncated && <Notice tone="warn">{t("pm.truncated")}</Notice>}
          <div className="pm-stats">
            {(
              [
                ["pm.upload", bytes(totals.upload)],
                ["pm.download", bytes(totals.download)],
                ["pm.total", bytes(totals.upload + totals.download)],
                ["pm.requests", String(totals.requests)],
              ] as const
            ).map(([label, value]) => (
              <div className="panel" key={label}>
                <span>{t(label)}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <div className="pm-table" role="region" aria-label={t("pm.traffic")} tabIndex={0}>
            <table>
              <thead>
                <tr>
                  {(["pm.name", "pm.upload", "pm.download", "pm.total", "pm.requests", "pm.failures"] as const).map(
                    (k) => (
                      <th key={k}>{t(k)}</th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {grouped.map((row) => (
                  <tr key={row.proxyId}>
                    <td>
                      {proxyName(row.proxyId)}
                      {row.incomplete > 0 && <small>{t("pm.incomplete")}</small>}
                    </td>
                    <td>{bytes(row.upload)}</td>
                    <td>{bytes(row.download)}</td>
                    <td>{bytes(row.upload + row.download)}</td>
                    <td>{row.requests}</td>
                    <td>{row.failures}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!grouped.length && <EmptyState className="pm-empty" title={t("pm.emptyTraffic")}>{t("pm.emptyTrafficHint")}</EmptyState>}
          </div>
          <details>
            <summary>{t("pm.detail")}</summary>
            <p className="muted">{t("pm.detailLimit")}</p>
            <div className="pm-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("pm.account")}</th>
                    <th>{t("pm.current")}</th>
                    <th>{t("pm.upload")}</th>
                    <th>{t("pm.download")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(traffic?.rows ?? []).slice(0, 500).map((row, index) => (
                    <tr key={index}>
                      <td>
                        {data.accounts.find((a) => keyOf(a.account) === row.accountKey)?.label ?? row.accountKey}
                        <small>{row.day}</small>
                      </td>
                      <td>{proxyName(row.proxyId)}</td>
                      <td>{bytes(row.upload)}</td>
                      <td>{bytes(row.download)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      {data && tab === "settings" && (
        <form
          className="panel pm-editor"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            void act(async () => {
              await request("/settings", "PATCH", {
                retentionDays: Number(form.get("retention")),
                probeConcurrency: Number(form.get("concurrency")),
                flushIntervalMs: Number(form.get("flush")) * 1000,
              });
            });
          }}
        >
          <div className="pm-form-grid">
            <label>
              {t("pm.retention")}
              <input name="retention" type="number" min={7} max={365} defaultValue={data.settings.retentionDays} />
            </label>
            <label>
              {t("pm.concurrency")}
              <input name="concurrency" type="number" min={1} max={4} defaultValue={data.settings.probeConcurrency} />
            </label>
            <label>
              {t("pm.flush")}
              <input name="flush" type="number" min={5} max={60} defaultValue={data.settings.flushIntervalMs / 1000} />
            </label>
          </div>
          <div className="pm-form-footer"><button className="btn btn-primary" disabled={busy}>
            {t("pm.save")}
          </button></div>
        </form>
      )}
    </div>
  );
}
