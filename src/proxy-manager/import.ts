import { ProxyManagerError, type ProxyProfile } from "./types";
import { profileInput } from "./validation";
const TYPES = new Set([
  "ss",
  "ssr",
  "vmess",
  "vless",
  "trojan",
  "hysteria",
  "hysteria2",
  "tuic",
  "wireguard",
  "ssh",
  "anytls",
  "socks5",
  "http",
]);
// Never accept a full executable core config, providers, filesystem paths or remote controllers.
const FIELDS = new Set([
  "type",
  "server",
  "port",
  "cipher",
  "password",
  "uuid",
  "alterId",
  "network",
  "tls",
  "servername",
  "sni",
  "client-fingerprint",
  "fingerprint",
  "alpn",
  "udp",
  "udp-over-tcp",
  "skip-cert-verify",
  "flow",
  "reality-opts",
  "ws-opts",
  "grpc-opts",
  "http-opts",
  "h2-opts",
  "smux",
  "obfs",
  "obfs-password",
  "auth",
  "auth-str",
  "up",
  "down",
  "congestion-controller",
  "udp-relay-mode",
  "reduce-rtt",
  "fast-open",
  "heartbeat-interval",
  "disable-sni",
  "username",
  "private-key",
  "public-key",
  "pre-shared-key",
  "ip",
  "ipv6",
  "mtu",
  "remote-dns-resolve",
  "dns",
  "protocol",
  "protocol-param",
  "obfs-param",
]);
const NESTED = new Set([
  "public-key",
  "short-id",
  "path",
  "headers",
  "Host",
  "host",
  "grpc-service-name",
  "max-early-data",
  "early-data-header-name",
  "mode",
  "enabled",
  "protocol",
  "max-connections",
  "min-streams",
  "max-streams",
  "padding",
  "statistic",
  "only-tcp",
]);
function safeNode(raw: Record<string, unknown>): Record<string, unknown> {
  if (
    !TYPES.has(String(raw.type)) ||
    typeof raw.server !== "string" ||
    !raw.server ||
    raw.server.length > 253 ||
    /[\s/@?#]/.test(raw.server) ||
    !Number.isInteger(Number(raw.port)) ||
    Number(raw.port) < 1 ||
    Number(raw.port) > 65535
  )
    throw new ProxyManagerError("invalid_proxy_node");
  const required: Record<string, string[]> = {
    ss: ["cipher", "password"],
    ssr: ["cipher", "password", "protocol", "obfs"],
    vmess: ["uuid"],
    vless: ["uuid"],
    trojan: ["password"],
    hysteria2: ["password"],
    tuic: ["uuid", "password"],
    anytls: ["password"],
    ssh: ["username"],
    wireguard: ["private-key", "public-key", "ip"],
  };
  for (const key of required[String(raw.type)] ?? [])
    if (typeof raw[key] !== "string" || !raw[key]) throw new ProxyManagerError("invalid_proxy_node");
  const node: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "name") continue;
    if (!FIELDS.has(key)) throw new ProxyManagerError("unsupported_proxy_node_field");
    const check = (entry: unknown, depth = 0): void => {
      if (depth > 3) throw new ProxyManagerError("invalid_proxy_node");
      if (entry === null || typeof entry === "number" || typeof entry === "boolean") return;
      if (typeof entry === "string") {
        if (entry.length > 4096 || entry.includes("\0")) throw new ProxyManagerError("invalid_proxy_node");
        return;
      }
      if (Array.isArray(entry)) {
        if (entry.length > 32) throw new ProxyManagerError("invalid_proxy_node");
        entry.forEach((v) => check(v, depth + 1));
        return;
      }
      if (entry && typeof entry === "object") {
        for (const [k, v] of Object.entries(entry)) {
          if (!NESTED.has(k)) throw new ProxyManagerError("unsupported_proxy_node_field");
          check(v, depth + 1);
        }
        return;
      }
      throw new ProxyManagerError("invalid_proxy_node");
    };
    check(value);
    node[key] = value;
  }
  if (node.type === "ssh" && typeof node["private-key"] === "string" && !node["private-key"].startsWith("-----BEGIN "))
    throw new ProxyManagerError("unsupported_proxy_node_field");
  node.port = Number(raw.port);
  return node;
}
const decode64 = (value: string) =>
  Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
function uriNode(raw: string): {
  name: string;
  node: Record<string, unknown>;
} {
  if (raw.startsWith("vmess://")) {
    const v = JSON.parse(decode64(raw.slice(8)));
    const node: Record<string, unknown> = {
      type: "vmess",
      server: v.add,
      port: Number(v.port),
      uuid: v.id,
      alterId: Number(v.aid ?? 0),
      cipher: v.scy ?? "auto",
      tls: v.tls === "tls",
    };
    if (v.tls && !["tls", "none"].includes(v.tls)) throw new ProxyManagerError("unsupported_proxy_uri_option");
    if (v.type && v.type !== "none") throw new ProxyManagerError("unsupported_proxy_uri_option");
    if (v.sni) node.servername = v.sni;
    if (v.net && !["tcp", "ws", "grpc"].includes(v.net)) throw new ProxyManagerError("unsupported_proxy_uri_option");
    if (v.net && v.net !== "tcp") node.network = v.net;
    if (v.net === "ws") node["ws-opts"] = { path: v.path || "/", headers: { Host: v.host || v.add } };
    if (v.net === "grpc") node["grpc-opts"] = { "grpc-service-name": v.path || "" };
    return { name: v.ps || v.add, node };
  }
  let value = raw;
  if (raw.startsWith("ss://") && !raw.slice(5).split("#")[0]!.includes("@"))
    value = "ss://" + decode64(raw.slice(5).split("#")[0]!) + (raw.includes("#") ? "#" + raw.split("#")[1] : "");
  const u = new URL(value),
    type = u.protocol.slice(0, -1).replace("hy2", "hysteria2"),
    params = u.searchParams;
  const supported = new Set([
    "security",
    "flow",
    "sni",
    "peer",
    "fp",
    "alpn",
    "pbk",
    "sid",
    "type",
    "path",
    "host",
    "serviceName",
    "obfs",
    "obfs-password",
    "insecure",
    "allowInsecure",
    "allow_insecure",
    "encryption",
    "headerType",
    "congestion_control",
    "congestion-controller",
    "udp_relay_mode",
    "udp-relay-mode",
  ]);
  for (const key of params.keys()) if (!supported.has(key)) throw new ProxyManagerError("unsupported_proxy_uri_option");
  if (
    (params.has("encryption") && params.get("encryption") !== "none") ||
    (params.has("headerType") && params.get("headerType") !== "none")
  )
    throw new ProxyManagerError("unsupported_proxy_uri_option");
  const node: Record<string, unknown> = {
    type,
    server: u.hostname.replace(/^\[|\]$/g, ""),
    port: Number(u.port || 443),
  };
  if (type === "ss") {
    const pair = u.password
      ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
      : decode64(decodeURIComponent(u.username));
    const i = pair.indexOf(":");
    if (i < 1) throw 0;
    node.cipher = pair.slice(0, i);
    node.password = pair.slice(i + 1);
    if (params.has("plugin")) throw new ProxyManagerError("unsupported_proxy_node_field");
  } else if (type === "vless") {
    node.uuid = decodeURIComponent(u.username);
    if (params.get("flow")) node.flow = params.get("flow");
  } else if (type === "tuic") {
    node.uuid = decodeURIComponent(u.username);
    node.password = decodeURIComponent(u.password);
  } else if (type === "trojan" || type === "hysteria2" || type === "anytls")
    node.password = decodeURIComponent(u.username) + (u.password ? ":" + decodeURIComponent(u.password) : "");
  else throw new ProxyManagerError("unsupported_proxy_uri");
  const security = params.get("security");
  if (security && !["none", "tls", "reality"].includes(security))
    throw new ProxyManagerError("unsupported_proxy_uri_option");
  if (params.has("type") && !["tcp", "ws", "grpc"].includes(params.get("type")!))
    throw new ProxyManagerError("unsupported_proxy_uri_option");
  if (type === "vless") node.tls = security === "tls" || security === "reality";
  const sni = params.get("sni") || params.get("peer");
  if (sni) node[type === "vless" ? "servername" : "sni"] = sni;
  if (params.get("fp")) node["client-fingerprint"] = params.get("fp");
  if (params.get("alpn")) node.alpn = params.get("alpn")!.split(",");
  if (["insecure", "allowInsecure", "allow_insecure"].some((k) => ["1", "true"].includes(params.get(k) ?? "")))
    node["skip-cert-verify"] = true;
  if (params.get("congestion_control") || params.get("congestion-controller"))
    node["congestion-controller"] = params.get("congestion_control") || params.get("congestion-controller");
  if (params.get("udp_relay_mode") || params.get("udp-relay-mode"))
    node["udp-relay-mode"] = params.get("udp_relay_mode") || params.get("udp-relay-mode");
  if (security === "reality")
    node["reality-opts"] = { "public-key": params.get("pbk") ?? "", "short-id": params.get("sid") ?? "" };
  if (params.get("type") === "ws") {
    node.network = "ws";
    node["ws-opts"] = { path: params.get("path") || "/", headers: { Host: params.get("host") || u.hostname } };
  }
  if (params.get("type") === "grpc") {
    node.network = "grpc";
    node["grpc-opts"] = { "grpc-service-name": params.get("serviceName") || "" };
  }
  if (params.get("obfs")) node.obfs = params.get("obfs");
  if (params.get("obfs-password")) node["obfs-password"] = params.get("obfs-password");
  return { name: decodeURIComponent(u.hash.slice(1)) || u.hostname, node };
}
export function importProxy(raw: unknown, group = ""): Omit<ProxyProfile, "id" | "createdAt" | "updatedAt"> {
  try {
    if (typeof raw === "string" && /^(https?|socks5h?):\/\//i.test(raw))
      return profileInput({ name: new URL(raw).hostname, url: raw, group });
    const parsed = typeof raw === "string" ? uriNode(raw) : { name: (raw as Record<string, unknown>)?.name, node: raw };
    const node = safeNode(parsed.node as Record<string, unknown>);
    const base = profileInput({ name: parsed.name || String(node.server), url: "http://127.0.0.1:28000", group });
    return { ...base, node };
  } catch (error) {
    if (error instanceof ProxyManagerError) throw error;
    throw new ProxyManagerError("invalid_proxy_import");
  }
}
export function parseSubscription(text: string): unknown[] {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new ProxyManagerError("proxy_subscription_too_large");
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch {
    /* URI list */
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Array.isArray(
      (
        parsed as {
          proxies?: unknown;
        }
      ).proxies,
    )
  )
    return (
      parsed as {
        proxies: unknown[];
      }
    ).proxies;
  if (Array.isArray(parsed)) return parsed;
  if (!text.includes("://")) text = decode64(text.trim());
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
