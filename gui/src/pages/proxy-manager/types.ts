import type { TFn } from "../../i18n/shared";
export interface Account {
  kind: "oauth" | "codex" | "key";
  provider: string;
  id: string;
}
export type Choice = { mode: "inherit" | "direct" } | { mode: "proxy"; proxyId: string };
export interface Profile {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  enabled: boolean;
  group: string;
  notes: string;
  bindings: number;
  monthlyLimitBytes: number;
  limitAction: "warn" | "block";
  nodeType?: string;
  monthBytes: number;
}
export interface AccountRow {
  account: Account;
  label: string;
  alias?: string;
  email?: string;
  choice: Choice;
  orphaned?: boolean;
}
export interface Subscription {
  id: string;
  name: string;
  group: string;
  proxyId?: string;
  updatedAt?: number;
}
export interface Snapshot {
  profiles: Profile[];
  accounts: AccountRow[];
  settings: { retentionDays: number; probeConcurrency: number; flushIntervalMs: number };
  persistenceFailed: boolean;
  subscriptions: Subscription[];
  core?: { installed: boolean; running: boolean; activeStreams: number };
}
export interface TrafficRow {
  day: string;
  proxyId: string;
  accountKey: string;
  purpose: string;
  upload: number;
  download: number;
  requests: number;
  failures: number;
  incomplete: number;
}
export interface Traffic {
  rows: TrafficRow[];
  totals: Omit<TrafficRow, "day" | "accountKey" | "purpose">[];
  truncated: boolean;
  persistenceFailed: boolean;
}
export const keyOf = (account: Account) => JSON.stringify([account.kind, account.provider, account.id]);
export function accountDisplayName(row: AccountRow, t: TFn): string {
  if (row.account.id === "@new") return t("pm.newAccount");
  if (row.alias || row.email) return row.alias || row.email!;
  if (row.label && row.label !== row.account.id) return row.label;
  if (row.account.id === "__main__") return t("codexAuth.mainAccount");
  return t(row.account.kind === "key" ? "pm.keyIdentity" : "pm.unknownIdentity", { provider: row.account.provider });
}
export function bytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 2 : 0)} ${units[i]}`;
}
