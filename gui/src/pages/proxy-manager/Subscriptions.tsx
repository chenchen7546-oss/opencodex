import { useState } from "react";
import { useT } from "../../i18n/shared";
import { IconLink, IconPlus } from "../../icons";
import type { Snapshot } from "./types";

export function Subscriptions({
  data,
  busy,
  request,
  act,
}: {
  data: Snapshot;
  busy: boolean;
  request: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  act: (work: () => Promise<void>) => Promise<void>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  return (
    <section className="pm-section pm-subscriptions" aria-label={t("pm.subscriptions")}>
      <div className="pm-section-head">
        <h2>{t("pm.subscriptions")} <span className="pm-count">{data.subscriptions.length}</span></h2>
        <button className="btn btn-ghost" disabled={busy} aria-expanded={editing} onClick={() => setEditing(!editing)}>
          <IconPlus aria-hidden="true" />
          {t("pm.addSubscription")}
        </button>
      </div>
      <p className="muted">{t("pm.subscriptionHint")}</p>
      {!editing && !data.subscriptions.length && <div className="pm-empty-inline"><IconLink aria-hidden="true" />{t("pm.emptySubscriptions")}</div>}
      {editing && (
        <form
          className="panel pm-editor"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void act(async () => {
              await request("/subscriptions", "POST", Object.fromEntries(form));
              setEditing(false);
            });
          }}
        >
          <div className="pm-form-grid">
            <label>
              {t("pm.name")}
              <input name="name" required maxLength={200} />
            </label>
            <label>
              {t("pm.subscriptionUrl")}
              <input name="url" type="password" autoComplete="new-password" required maxLength={4096} />
            </label>
            <label>
              {t("pm.group")}
              <input name="group" maxLength={200} />
            </label>
            <label>
              {t("pm.subscriptionProxy")}
              <select name="proxyId">
                <option value="">{t("pm.inherit")}</option>
                {data.profiles
                  .filter((p) => p.enabled)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="pm-form-footer">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>
              {t("pm.cancel")}
            </button>
            <button className="btn btn-primary" disabled={busy}>{t("pm.save")}</button>
          </div>
        </form>
      )}
      {data.subscriptions.length > 0 && (
        <div className="pm-table">
          <table>
            <thead>
              <tr>
                <th>{t("pm.name")}</th>
                <th>{t("pm.group")}</th>
                <th>{t("pm.updated")}</th>
                <th>{t("pm.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.subscriptions.map((source) => (
                <tr key={source.id}>
                  <td>{source.name}</td>
                  <td>{source.group}</td>
                  <td>{source.updatedAt ? new Date(source.updatedAt).toLocaleString() : "—"}</td>
                  <td>
                    <div className="pm-actions">
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await request(`/subscriptions/${source.id}/refresh`, "POST");
                          })
                        }
                      >
                        {t("pm.updateSubscription")}
                      </button>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await request(`/subscriptions/${source.id}`, "DELETE");
                          })
                        }
                      >
                        {t("pm.removeSubscription")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
