---
title: Account proxies (custom build)
description: Manage proxy endpoints, bind individual accounts and inspect application traffic in this custom branch.
---

This custom build adds **Proxy manager** to the dashboard. Its profiles and assignments are stored
separately from upstream OAuth/account files. This page describes the customization, not a feature
guaranteed by the upstream 2.94.0 release.

## Set up an exit

1. Open **Proxy manager → Proxies → Add proxy**.
2. Enter HTTP, HTTPS, SOCKS5 or SOCKS5h host, port and optional authentication. An IP alone is not
   a proxy service: a self-hosted VPS must already run a proxy listener. A commercial endpoint
   uses the protocol and authentication its vendor supplies.
3. Use **Test exit** to contact `api.ipify.org` through the profile. The result is the current exit
   IP and probe latency, not a guarantee that every provider will accept that IP.
4. Select accounts in **Account bindings**, choose the profile, and apply it. Accounts from
   different providers can share a profile or have different profiles.

`127.0.0.1` means the OpenCodex server, not the browser's computer. For a US server accessing a
service that requires mainland China egress, configure an exit that actually has the required
regional connectivity. Merely adding the US VPS address does not change its region.

## Inheritance and login

Each account can inherit, connect directly, or use a profile. Inheritance first uses the managed
**Provider default (including new logins)** row, then existing provider/global proxy settings.
Set that default before importing or logging into the first regional account. Reauthentication,
token refresh, account quota probes and model requests use the account binding when identity is
known. Server-side OAuth calls are controlled here; browser login pages use the browser's network.

A stopped, missing or unreachable assigned proxy causes a failure. There is no automatic direct
fallback. Reassign bound accounts before deleting a profile. Account rotation reselects the route
for the credential actually sent. Native Codex WebSocket requests and Cursor model calls use
HTTP/SSE or HTTP/1.1 when needed to carry an explicit account route.

Opaque custom fetch executors refuse explicitly bound requests. Vendor CLI subprocess adapters
(Claude CLI, CodeBuddy, Qoder) retain their original network settings: account bindings do not
control their external model connections. Plugin rewrites to local sidecars refuse explicit account routes.
Unknown client-forwarded credentials are not new managed accounts.

## Advanced nodes and subscriptions

Bulk import accepts proxy URLs, common SS, VMess, VLESS/Reality, Trojan, Hysteria2, TUIC and AnyTLS
links, Base64 link lists, and Clash-compatible `proxies` YAML/JSON lists. Other supported node
definitions include SSR, Hysteria, WireGuard and SSH. Unsupported options are rejected rather than
ignored; an arbitrary full Clash configuration is not installed.

Advanced nodes need an independently installed **Mihomo** executable on the server. Set
`OPENCODEX_PROXY_CORE` to its absolute path or put `mihomo` on PATH, then restart OpenCodex.
HTTP/HTTPS/SOCKS profiles need no extra core. This build starts one shared core per process only
when an advanced node is used. It binds authenticated loopback ports and exposes no controller.
Generated configuration is validated before startup. Use a matching Mihomo version and run
**Test exit** before assigning a node. See the [Mihomo listener documentation](https://wiki.metacubex.one/en/config/inbound/listeners/).

The custom Docker image already includes checksum-pinned Mihomo 1.19.33 and sets the executable
path. No extra installation or exposed core port is needed in that image.
Startup waits for a private loopback round trip before handing model requests to the core; a listening
TCP port alone does not establish readiness. This probe uses no provider credentials or upstream traffic.

Save a subscription URL under **Subscriptions**, optionally choose a proxy for downloading it,
then click **Update nodes**. Updates are manual to save memory and network usage. Nodes retain
bindings by original subscription name; removed nodes are disabled and duplicate names reject the
update. Removing the source retains its proxies. URLs and node credentials are not returned to the
browser after saving. An edit's empty password field preserves the previous password.

## Traffic

The Traffic tab shows uploads, downloads, requests, failures and account detail for a selected
date range. Exported CSV is limited to 10,000 returned daily detail rows; aggregate totals include
all rows. Day boundaries and monthly limits use UTC. Probes and retries contribute to usage.

These are **application-body counters**: submitted upload bytes and consumed download bytes.
A failed submitted request can count upload bytes. HTTP/TLS/proxy overhead, other software and
wire compression differences are excluded, so these totals are not the proxy vendor's bill.
Cancelling a stream records the partial transfer. A process crash may lose the current buffer;
failed persistence displays an incomplete-statistics warning.

Monthly limits can warn or block **new** requests. Active streams continue; simultaneous requests
can exceed the threshold. This is not a precise billing cutoff.

## Resource settings and backup

Defaults are 90-day retention, two simultaneous exit checks, and a 15-second flush interval.
Counters are bounded in memory and use a small SQLite cache; there is no additional database server.
Current-month counters survive a shorter retention setting so monthly limits remain consistent.
The optional core and the underlying OpenCodex runtime still consume memory. On a 1-GB VPS,
build the GUI elsewhere, begin with low request concurrency, and measure the complete service.

Stop the service before backing up `$OPENCODEX_HOME/proxy-manager/` with the rest of the application
state. It contains secrets and must not be committed or shared. If the service cannot be stopped,
use SQLite's online backup mechanism rather than copying only the main database while WAL is live.
Use the custom branch's merge-and-rebuild procedure for upgrades; installing an official package
over this checkout can replace the customization.

## Custom Docker Compose workflow

Build on a development machine with `docker compose -f deploy/compose.build.yaml build hub`,
then run `bun scripts/custom/docker-smoke.ts` and `bun scripts/custom/export-image.ts`.
The export contains a tested Linux amd64 image, a separate runtime Compose file, an environment
example, checksums and deployment instructions. No account state or volume is exported.
The server loads the archive, runs `bun docker/custom/init.ts` inside a one-off Compose container,
then starts the `hub` service. Keep the Compose project name stable across upgrades so it reuses
the two state volumes; never remove volumes as part of an ordinary update.

The default runtime caps RAM at 640 MiB and RAM plus swap at 896 MiB, rotates Docker logs, and
publishes only on loopback. Limits do not guarantee capacity. Initial OpenAI concurrency is one;
each additional provider needs its own low-concurrency setting. Existing volumes keep their config.
Access through an SSH tunnel, use the management admin token for the dashboard and the separate
service token for model clients. The full step-by-step guide is `deploy/README.zh-CN.md` in the checkout
and exported bundle; build files stay in the checkout. The upstream root container recipe is unchanged.

OAuth link copying falls back inside the active native modal when the Clipboard API is unavailable.
If the browser refuses both methods, a selectable full-link field appears for manual copying.

Subscription import accepts built-in Shadowsocks obfs, v2ray-plugin, gost-plugin and shadow-tls options, TUIC request timeout and AnyTLS idle-session options. Legacy top-level brutal options are moved under smux; null VLESS flow is omitted. Executable plugins and filesystem credential paths remain disallowed. Adding the same subscription URL again returns a duplicate notice without creating a record.
Account bindings show aliases and returned email addresses first, with shortened internal IDs underneath. Providers that return neither remain explicitly unnamed; use Edit alias in the row to name them. Aliases are shared with the provider account page and do not change proxy bindings. The main native Codex account retains its upstream read-only alias policy.
