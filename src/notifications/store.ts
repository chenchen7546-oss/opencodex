import { Database } from "bun:sqlite";
import { mkdirSync, lstatSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { defaultNotificationSettings, NotificationError, type NotificationSettings, type Incident, type AccountObservation } from "./types";
import { parseNotificationSettings } from "./settings";

/** Independent schema: no writes to provider credentials or proxy-manager storage. */
export class NotificationStore {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const folder = lstatSync(directory), previous = lstatSync(path, { throwIfNoEntry: false });
      if (!folder.isDirectory() || folder.isSymbolicLink() || (previous && (!previous.isFile() || previous.isSymbolicLink()))) throw new NotificationError("unsafe_store", 503);
      chmodSync(directory, 0o700);
      hardenSecretDir(directory, { required: true });
    }
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-512;");
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > 1) { this.db.close(); throw new NotificationError("newer_store_version", 503); }
    this.db.exec(`CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incidents(account_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(incident_id TEXT NOT NULL, recipient_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0, delivered_at INTEGER, PRIMARY KEY(incident_id,recipient_id));
      CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, recipient_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, result TEXT NOT NULL, count INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  settings(): NotificationSettings {
    const row = this.db.query("SELECT data FROM settings WHERE id=1").get() as { data: string } | null;
    return row ? JSON.parse(row.data) : defaultNotificationSettings();
  }
  save(value: unknown): NotificationSettings {
    return this.db.transaction(() => {
      const next = parseNotificationSettings(value, this.settings());
      this.db.query("INSERT OR REPLACE INTO settings(id,data) VALUES(1,?)").run(JSON.stringify(next));
      const live = new Set(next.recipients.map((row) => row.id));
      for (const row of this.db.query("SELECT DISTINCT recipient_id FROM deliveries").all() as { recipient_id: string }[])
        if (!live.has(row.recipient_id)) this.db.query("DELETE FROM deliveries WHERE recipient_id=?").run(row.recipient_id);
      return next;
    }).immediate();
  }
  observe(accounts: AccountObservation[], now: number): void {
    this.db.transaction(() => {
      const live = new Set(accounts.map((account) => account.id));
      for (const incident of this.incidents()) if (!live.has(incident.accountId)) this.resolve(incident.accountId);
      for (const account of accounts) {
        if (account.state === "healthy") this.resolve(account.id);
        if (account.state !== "reauth") continue;
        const incident: Incident = { id: randomUUID(), accountId: account.id, label: account.label, reason: account.reason, detectedAt: now };
        this.db.query("INSERT OR IGNORE INTO incidents(account_id,id,data) VALUES(?,?,?)").run(account.id, incident.id, JSON.stringify(incident));
      }
      this.db.exec("DELETE FROM deliveries WHERE incident_id NOT IN (SELECT id FROM incidents)");
    }).immediate();
  }
  private resolve(accountId: string) { this.db.query("DELETE FROM incidents WHERE account_id=?").run(accountId); }
  incidents(): Incident[] { return (this.db.query("SELECT data FROM incidents ORDER BY rowid").all() as { data: string }[]).map((row) => JSON.parse(row.data)); }
  claim(recipientId: string, now: number): Incident[] {
    return this.db.transaction(() => {
      const rows = this.db.query(`SELECT i.data FROM incidents i LEFT JOIN deliveries d ON d.incident_id=i.id AND d.recipient_id=?
        WHERE d.delivered_at IS NULL AND COALESCE(d.attempts,0)<3 AND COALESCE(d.next_attempt,0)<=? ORDER BY i.rowid LIMIT 20`)
        .all(recipientId, now) as { data: string }[];
      const incidents: Incident[] = rows.map((row) => JSON.parse(row.data));
      for (const incident of incidents) this.db.query(`INSERT INTO deliveries(incident_id,recipient_id,attempts,next_attempt) VALUES(?,?,1,?)
        ON CONFLICT(incident_id,recipient_id) DO UPDATE SET attempts=attempts+1,next_attempt=excluded.next_attempt`)
        .run(incident.id, recipientId, now + 15 * 60_000);
      return incidents;
    }).immediate();
  }
  finish(recipientId: string, incidents: Incident[], result: string, now: number): void {
    this.db.transaction(() => {
      if (result === "sent") for (const incident of incidents) this.db.query("UPDATE deliveries SET delivered_at=? WHERE incident_id=? AND recipient_id=?").run(now, incident.id, recipientId);
      this.record(recipientId, "reauth", result, incidents.length, now);
    }).immediate();
  }
  record(recipientId: string, kind: "test" | "reauth", result: string, count: number, now: number) {
    this.db.query("INSERT INTO history(recipient_id,kind,at,result,count) VALUES(?,?,?,?,?)").run(recipientId, kind, now, result, count);
    this.db.exec("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 100)");
  }
  history() { return this.db.query("SELECT recipient_id AS recipientId,kind,at,result,count FROM history ORDER BY id DESC LIMIT 50").all(); }
  close() { this.db.close(); }
}
