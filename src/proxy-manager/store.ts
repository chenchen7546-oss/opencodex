import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, lstatSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  accountKey,
  DEFAULT_PROXY_SETTINGS,
  ProxyManagerError,
  type AccountBinding,
  type EgressAccount,
  type ProxyChoice,
  type ProxyProfile,
  type ProxyPublic,
  type ProxySettings,
  type TrafficRow,
} from "./types";
import type { ProxySubscription } from "./types";
import { hardenSecretDir } from "../lib/windows-secret-acl";
/** One independent, versioned store; no changes to upstream credential formats. */
export class ProxyStore {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (lstatSync(directory).isSymbolicLink() || (existsSync(path) && lstatSync(path).isSymbolicLink()))
        throw new ProxyManagerError("proxy_store_unsafe_path", 503);
      chmodSync(directory, 0o700);
      hardenSecretDir(directory, { required: true });
    }
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2048; PRAGMA foreign_keys=ON;",
    );
    const version = (
      this.db.query("PRAGMA user_version").get() as {
        user_version: number;
      }
    ).user_version;
    if (version > 1) {
      this.db.close();
      throw new ProxyManagerError("proxy_store_newer_version", 503);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS proxies(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(account_key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS traffic(day TEXT NOT NULL, proxy_id TEXT NOT NULL, account_key TEXT NOT NULL, purpose TEXT NOT NULL,
        upload INTEGER NOT NULL, download INTEGER NOT NULL, requests INTEGER NOT NULL, failures INTEGER NOT NULL, incomplete INTEGER NOT NULL,
        PRIMARY KEY(day,proxy_id,account_key,purpose));
      CREATE INDEX IF NOT EXISTS traffic_proxy_day ON traffic(proxy_id,day);
      PRAGMA user_version=1;`);
  }
  profiles(): ProxyProfile[] {
    return (
      this.db.query("SELECT data FROM proxies ORDER BY id").all() as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data));
  }
  profile(id: string): ProxyProfile | undefined {
    const row = this.db.query("SELECT data FROM proxies WHERE id=?").get(id) as {
      data: string;
    } | null;
    return row ? JSON.parse(row.data) : undefined;
  }
  publicProfiles(): ProxyPublic[] {
    const bindings = this.bindings();
    return this.profiles().map(({ url, node, ...profile }) => {
      const parsed = new URL(url);
      return {
        ...profile,
        protocol: parsed.protocol.slice(0, -1) as ProxyPublic["protocol"],
        host: node ? String(node.server) : parsed.hostname,
        port: node ? Number(node.port) : Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
        username: node ? "" : decodeURIComponent(parsed.username),
        hasPassword: node ? true : !!parsed.password,
        ...(node ? { nodeType: String(node.type) } : {}),
        bindings: bindings.filter((b) => b.choice.mode === "proxy" && b.choice.proxyId === profile.id).length,
      };
    });
  }
  save(input: Omit<ProxyProfile, "id" | "createdAt" | "updatedAt">, id?: string): ProxyProfile {
    const previous = id ? this.profile(id) : undefined;
    if (id && !previous) throw new ProxyManagerError("proxy_not_found", 404);
    if (!previous && this.profiles().length >= 500) throw new ProxyManagerError("proxy_limit_reached");
    const now = Date.now();
    const profile = {
      ...input,
      id: previous?.id ?? randomUUID(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (profile.node) {
      const used = new Set(this.profiles().map((p) => p.corePort));
      let port = previous?.corePort ?? 28000;
      while (!previous?.corePort && used.has(port)) port++;
      if (port > 28999) throw new ProxyManagerError("proxy_listener_limit");
      profile.corePort = port;
      profile.url = `http://127.0.0.1:${port}`;
    }
    this.db.query("INSERT OR REPLACE INTO proxies VALUES(?,?)").run(profile.id, JSON.stringify(profile));
    return profile;
  }
  remove(id: string): void {
    if (
      this.bindings().some((b) => b.choice.mode === "proxy" && b.choice.proxyId === id) ||
      this.subscriptions().some((s) => s.proxyId === id)
    )
      throw new ProxyManagerError("proxy_in_use", 409);
    this.db.query("DELETE FROM proxies WHERE id=?").run(id);
  }
  bindings(): AccountBinding[] {
    return (
      this.db.query("SELECT data FROM bindings").all() as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data));
  }
  choice(account: EgressAccount): ProxyChoice {
    const row = this.db.query("SELECT data FROM bindings WHERE account_key=?").get(accountKey(account)) as {
      data: string;
    } | null;
    return row ? (JSON.parse(row.data) as AccountBinding).choice : { mode: "inherit" };
  }
  bind(accounts: EgressAccount[], choice: ProxyChoice): void {
    if (accounts.length === 0 || accounts.length > 500) throw new ProxyManagerError("invalid_account_count");
    if (choice.mode === "proxy" && !this.profile(choice.proxyId)?.enabled)
      throw new ProxyManagerError("proxy_unavailable", 409);
    this.db.transaction(() => {
      for (const account of accounts) {
        const key = accountKey(account);
        if (choice.mode === "inherit") this.db.query("DELETE FROM bindings WHERE account_key=?").run(key);
        else
          this.db
            .query("INSERT OR REPLACE INTO bindings VALUES(?,?)")
            .run(key, JSON.stringify({ account, choice, updatedAt: Date.now() }));
      }
    })();
  }
  settings(): ProxySettings {
    const row = this.db.query("SELECT data FROM settings WHERE id=1").get() as {
      data: string;
    } | null;
    return { ...DEFAULT_PROXY_SETTINGS, ...(row ? JSON.parse(row.data) : {}) };
  }
  saveSettings(settings: ProxySettings): void {
    this.db.query("INSERT OR REPLACE INTO settings VALUES(1,?)").run(JSON.stringify(settings));
  }
  addTraffic(rows: TrafficRow[]): void {
    const write = this.db
      .query(`INSERT INTO traffic VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(day,proxy_id,account_key,purpose) DO UPDATE SET
      upload=upload+excluded.upload,download=download+excluded.download,requests=requests+excluded.requests,
      failures=failures+excluded.failures,incomplete=incomplete+excluded.incomplete`);
    this.db.transaction(() => {
      for (const r of rows)
        write.run(
          r.day,
          r.proxyId,
          r.accountKey,
          r.purpose,
          r.upload,
          r.download,
          r.requests,
          r.failures,
          r.incomplete,
        );
    })();
  }
  traffic(since: string): TrafficRow[] {
    return this.db
      .query(
        `SELECT day,proxy_id AS proxyId,account_key AS accountKey,purpose,upload,download,requests,failures,incomplete
      FROM traffic WHERE day>=? ORDER BY day DESC LIMIT 10000`,
      )
      .all(since) as TrafficRow[];
  }
  monthBytes(id: string): number {
    const row = this.db
      .query("SELECT COALESCE(SUM(upload+download),0) AS total FROM traffic WHERE proxy_id=? AND day>=?")
      .get(id, new Date().toISOString().slice(0, 7)) as {
      total: number;
    };
    return row.total;
  }
  trafficTotals(since: string): Array<Omit<TrafficRow, "day" | "accountKey" | "purpose">> {
    return this.db
      .query(
        `SELECT proxy_id AS proxyId,SUM(upload) AS upload,SUM(download) AS download,
      SUM(requests) AS requests,SUM(failures) AS failures,SUM(incomplete) AS incomplete FROM traffic WHERE day>=? GROUP BY proxy_id`,
      )
      .all(since) as Array<Omit<TrafficRow, "day" | "accountKey" | "purpose">>;
  }
  subscriptions(): ProxySubscription[] {
    return (
      this.db.query("SELECT data FROM subscriptions ORDER BY id").all() as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }
  saveSubscription(value: ProxySubscription): void {
    this.db.query("INSERT OR REPLACE INTO subscriptions VALUES(?,?)").run(value.id, JSON.stringify(value));
  }
  removeSubscription(id: string): void {
    this.db.query("DELETE FROM subscriptions WHERE id=?").run(id);
  }
  prune(): void {
    const cutoff = [
      new Date(Date.now() - this.settings().retentionDays * 86400000).toISOString().slice(0, 10),
      new Date().toISOString().slice(0, 7) + "-01",
    ].sort()[0]!;
    this.db.query("DELETE FROM traffic WHERE day<?").run(cutoff);
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
  close(): void {
    this.db.close();
  }
}
