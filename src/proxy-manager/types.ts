import type { EgressAccount } from "../lib/account-egress";
export type { EgressAccount };
export type ProxyProtocol = "http" | "https" | "socks5" | "socks5h";
export interface ProxyProfile {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  group: string;
  notes: string;
  monthlyLimitBytes: number;
  limitAction: "warn" | "block";
  createdAt: number;
  updatedAt: number;
  /** Validated outbound definition consumed only by the optional managed Mihomo process. */
  node?: Record<string, unknown>;
  corePort?: number;
  subscriptionId?: string;
  subscriptionName?: string;
}
export interface ProxyPublic extends Omit<ProxyProfile, "url" | "node"> {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  bindings: number;
  nodeType?: string;
}
export type ProxyChoice =
  | {
      mode: "inherit";
    }
  | {
      mode: "direct";
    }
  | {
      mode: "proxy";
      proxyId: string;
    };
export interface AccountBinding {
  account: EgressAccount;
  choice: ProxyChoice;
  updatedAt: number;
}
export interface ManagedAccount {
  account: EgressAccount;
  label: string;
  choice: ProxyChoice;
  orphaned?: boolean;
}
export interface ProxySettings {
  retentionDays: number;
  probeConcurrency: number;
  flushIntervalMs: number;
}
export interface TrafficDelta {
  upload: number;
  download: number;
  requests: number;
  failures: number;
  incomplete: number;
}
export interface TrafficRow extends TrafficDelta {
  day: string;
  proxyId: string;
  accountKey: string;
  purpose: string;
}
export interface ProxySubscription {
  id: string;
  name: string;
  url: string;
  group: string;
  proxyId?: string;
  updatedAt?: number;
}
export const accountKey = (account: EgressAccount): string =>
  JSON.stringify([account.kind, account.provider, account.id]);
export const DEFAULT_PROXY_SETTINGS: ProxySettings = { retentionDays: 90, probeConcurrency: 2, flushIntervalMs: 15000 };
export class ProxyManagerError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
    this.name = "ProxyManagerError";
  }
}
