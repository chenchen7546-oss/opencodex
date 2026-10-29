import {
  ProxyManagerError,
  type EgressAccount,
  type ProxyChoice,
  type ProxyProfile,
  type ProxySettings,
} from "./types";
const text = (value: unknown, max = 200): string => {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f]/.test(value))
    throw new ProxyManagerError("invalid_proxy_field");
  return value.trim();
};
export function proxyUrl(raw: unknown): string {
  try {
    const value = text(raw, 4096);
    const url = new URL(value);
    if (
      !["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) ||
      !url.hostname ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== "/")
    )
      throw 0;
    if (url.protocol.startsWith("socks") && !url.port) throw 0;
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url.toString();
  } catch {
    throw new ProxyManagerError("invalid_proxy_url");
  }
}
export function profileInput(
  raw: unknown,
  previous?: ProxyProfile,
): Omit<ProxyProfile, "id" | "createdAt" | "updatedAt"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProxyManagerError("invalid_proxy_profile");
  const value = raw as Record<string, unknown>;
  const name = text(value.name ?? previous?.name);
  if (!name) throw new ProxyManagerError("proxy_name_required");
  let url: string;
  if (typeof value.url === "string") url = proxyUrl(value.url);
  else if (typeof value.host === "string") {
    const protocol = text(value.protocol, 10);
    const host = text(value.host, 253);
    const port = Number(value.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || /[\s/@?#]/.test(host))
      throw new ProxyManagerError("invalid_proxy_address");
    const parsed = new URL(`${protocol}://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`);
    parsed.username = typeof value.username === "string" ? value.username : "";
    parsed.password =
      typeof value.password === "string"
        ? value.password
        : previous
          ? decodeURIComponent(new URL(previous.url).password)
          : "";
    url = proxyUrl(parsed.toString());
  } else if (previous) url = previous.url;
  else throw new ProxyManagerError("proxy_address_required");
  const limit = Number(value.monthlyLimitBytes ?? previous?.monthlyLimitBytes ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new ProxyManagerError("invalid_traffic_limit");
  const action = value.limitAction ?? previous?.limitAction ?? "warn";
  if (action !== "warn" && action !== "block") throw new ProxyManagerError("invalid_limit_action");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    throw new ProxyManagerError("invalid_proxy_enabled");
  return {
    name,
    url,
    enabled: (value.enabled as boolean) ?? previous?.enabled ?? true,
    group: text(value.group ?? previous?.group ?? ""),
    notes: text(value.notes ?? previous?.notes ?? "", 1000),
    monthlyLimitBytes: limit,
    limitAction: action,
    ...(previous?.node ? { node: previous.node, corePort: previous.corePort } : {}),
    ...(previous?.subscriptionId
      ? { subscriptionId: previous.subscriptionId, subscriptionName: previous.subscriptionName }
      : {}),
  };
}
export function parseAccount(raw: unknown): EgressAccount {
  const r = raw as Record<string, unknown> | null;
  if (!r || !["oauth", "codex", "key"].includes(String(r.kind))) throw new ProxyManagerError("invalid_account");
  const provider = text(r.provider, 100),
    id = text(r.id, 256);
  if (!provider || !id) throw new ProxyManagerError("invalid_account");
  return { kind: r.kind as EgressAccount["kind"], provider, id };
}
export function parseChoice(raw: unknown): ProxyChoice {
  const r = raw as Record<string, unknown> | null;
  if (r?.mode === "inherit" || r?.mode === "direct") return { mode: r.mode };
  if (r?.mode === "proxy" && typeof r.proxyId === "string" && r.proxyId.length <= 100)
    return { mode: "proxy", proxyId: r.proxyId };
  throw new ProxyManagerError("invalid_proxy_choice");
}
export function parseSettings(raw: Record<string, unknown>, current: ProxySettings): ProxySettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProxyManagerError("invalid_proxy_settings");
  const result = { ...current };
  for (const [key, min, max] of [
    ["retentionDays", 7, 365],
    ["probeConcurrency", 1, 4],
    ["flushIntervalMs", 5000, 60000],
  ] as const) {
    if (raw[key] !== undefined) {
      const n = Number(raw[key]);
      if (!Number.isInteger(n) || n < min || n > max) throw new ProxyManagerError("invalid_proxy_settings");
      result[key] = n;
    }
  }
  return result;
}
