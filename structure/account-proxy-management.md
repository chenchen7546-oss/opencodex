# Account Proxy Management

This customization keeps proxy profiles, bindings and counters outside upstream account records.
`src/proxy-manager/` owns the optional subsystem. `src/lib/account-egress.ts` is its small,
core-owned transport seam; the seam imports no database, account store, UI or proxy executable.

## Identity and route selection

An account key is the JSON tuple `(kind, provider, id)`. Kinds are `oauth`, `codex` and `key`.
OAuth slot IDs, native Codex pool IDs (`__main__` for main), and API-key pool IDs remain upstream
identities. `accounts.ts` is the adapter to `src/oauth/store.ts`, `src/codex/account-store.ts`,
native main auth, and configured API-key references. Public account rows contain no credentials. Generic `chatgpt` OAuth staging rows are omitted from the management list unless a standalone provider is configured; wire matching and stored credentials remain unchanged. Explicit historical bindings stay available as retained orphan rows until cleared. Native slots and other providers are never merged by email.
Keychain/environment references resolve through the existing key resolver for wire matching.

Precedence is account binding, managed provider default (`oauth/provider/@new`), then the existing
provider/global route. A binding is inherit, explicit direct, or a profile ID. Direct passes Bun's
`proxy: false`; it never clears process environment variables. Missing/disabled bound profiles fail
closed. Deleting a profile still used by a binding or subscription is refused. Bindings are resolved at each physical send, including retries and reused dispatchers. A binding change during core startup is rechecked before sending; repeated churn refuses after bounded retries. Existing streams finish on their original lease. Switching between existing nodes needs no core restart; editing node definitions waits for active leases to drain.

The final outgoing credential is matched against stored credentials, using only authentication
headers, API-key query fields and small token-exchange bodies. Prompts and arbitrary body fields
are never scanned. A unique wire match supersedes stale ambient identity after retry/rotation.
An explicit dispatch receipt disambiguates matching duplicate credentials. Otherwise ambiguous
credentials with managed routes are refused. Unknown forwarded credentials cannot be assigned to
a stored account; provider defaults apply where a provider is known.

`src/lib/account-egress-dispatch.ts` maps request-owned OAuth and API-key dispatch receipts into
the seam. `src/codex/account-egress-context.ts` carries a nonserialized native pool identity on request-owned providers, including source-linked credentials; stripping runtime auth on reselection also strips that identity. `src/server/responses/request-transport.ts` updates that scope after reselection.
The account manager applies the route at the physical send in
`src/server/responses/fetch-helpers.ts`; a symbol prevents nested transport wrappers from counting
or routing twice. Opt-in agent-task recovery also enters the account fetch seam with the OpenAI provider hint. Account-bound Codex WebSocket sends use HTTP/SSE, including dispatch-time fallback.
`src/adapters/cursor/live-transport.ts` and `live-models.ts` select HTTP/1.1 when a managed route is
explicit. The model stream remains streamed; no complete response is buffered for accounting.

`src/lib/provider-outbound.ts` carries the same route into discovery/connection probes before
choosing DNS-pinned direct transport or proxied fetch. Existing destination checks, private-network
restrictions, credential ownership checks and manual redirects remain in force.

OAuth login/refresh scopes are created by `src/oauth/index.ts`. Native pool login in
`src/codex/auth-api/login-flow.ts` supplies the native account/default scope rather than the temporary
ChatGPT OAuth slot. All native warmup callers (login, deferred validation, quota auto-refresh and token guardian) pass the pool ID into `src/codex/warmup.ts`; model fallback retains it. Native main/pool refresh, quota, Reserve and reset-credit probes supply their stable native identity.
`src/providers/quota.ts` and `quota-key-accounts.ts` scope each account probe independently.
Provider-owned bare fetches import `src/lib/account-fetch.ts`, which enters the same configured
outbound transport. Browser pages opened during OAuth are outside this server's network control.

Opaque custom fetch executors refuse explicit routes. Claude CLI, CodeBuddy and Qoder subprocess
adapters retain their original network settings by explicit operator choice: account bindings do not
control those external model connections. In-process helper fetches still use the seam. A plugin rewrite to loopback is refused when an account route is explicit rather
than sending local-sidecar credentials to a remote proxy. TLS profile restrictions remain upstream
restrictions; a transport that cannot preserve direct/proxy semantics fails closed.

## Persistence and management surface

`store.ts` opens `$OPENCODEX_HOME/proxy-manager/state.sqlite` (default
`~/.opencodex/proxy-manager/state.sqlite`) lazily. Schema version 1 contains profiles, bindings,
subscriptions, settings and daily traffic aggregates. SQLite WAL, NORMAL synchronization,
a 3-second busy timeout and a 2-MiB page cache bound baseline storage overhead. The directory is
owner-only; the database is mode 0600 on POSIX. Windows uses the existing required secret ACL
hardener. Parent credentials are not migrated, rewritten or re-identified.

`src/server/index.ts` and relevant commands in `src/cli/index.ts` install the hooks. Config reloads
update the account source without closing active streams. Shutdown flushes counters and terminates
the optional child; a process-exit hook also covers CLI commands. Inherited/unmanaged sends retain
upstream behavior. No database is created until the management surface is used.

`src/server/management/proxy-manager-routes.ts` joins the existing management dispatcher. It requires
an admin token or GUI session, retains dispatcher origin/body checks and response CORS behavior,
and returns `Cache-Control: no-store`. Passwords, raw node definitions and subscription URLs are
write-only. Transport errors expose stable codes, not credential-bearing URLs.

| Route under `/api/proxy-manager` | Operation |
| --- | --- |
| GET root | Redacted profiles, accounts, settings, subscriptions, core availability |
| POST `/profiles`; PATCH/DELETE `/profiles/:id` | Validated profile CRUD; metadata edits retain secrets |
| POST `/import` | Atomic import of up to 100 URLs or parsed nodes |
| POST `/profiles/:id/probe` | Bounded request to `api.ipify.org`, reporting exit and latency |
| PUT `/bindings` | Atomic assignment for 1–500 known account IDs |
| GET `/traffic?days=...` | Up to 10,000 detail rows and complete per-profile totals |
| PATCH `/settings` | Retention, probe concurrency and flush interval |
| POST `/subscriptions` | Save a private subscription source |
| POST `/subscriptions/:id/refresh` | Bounded manual refresh, at most 500 nodes |
| DELETE `/subscriptions/:id` | Remove source while retaining imported profiles |

`gui/src/pages/ProxyManager.tsx` and its `proxy-manager/` components implement the dashboard.
Bulk account selection spans providers; filtering, grouping labels, exit checks, monthly caps,
secret-preserving edits and CSV export are included. Fetches are cancelled on API-target changes.
Traffic refresh is manual; subscriptions and exit probes do not poll in the background.
Proxy lists use a full empty state without orphan table headers and a distinct filtered-empty state.
Add/import editors are mutually exclusive; connection and usage settings are grouped in the editor.
The scoped responsive styles retain horizontal table scrolling and use shared light/dark tokens.

## Protocols and optional core

Clash subscriptions accept the documented TUIC timeout and AnyTLS idle-session options and built-in SS obfs/v2ray/gost/ShadowTLS transports. Executable plugin names and certificate/private-key file options remain refused. Legacy top-level `brutal-opts` is normalized into `smux.brutal-opts`; conflicting definitions are refused. Regression fixtures use synthetic credentials only.

HTTP, HTTPS, SOCKS5 and SOCKS5h use the existing transport, with optional username/password.
Self-hosted and commercial services use the same protocol fields. WireGuard, SSH, SS/SSR, VMess,
VLESS/Reality, Trojan, Hysteria/Hysteria2, TUIC and AnyTLS definitions use optional Mihomo.
Common SS, VMess, VLESS, Trojan, Hysteria2, TUIC and AnyTLS links are parsed directly; other supported
definitions use a Clash-compatible `proxies` YAML/JSON list. Unsupported fields fail explicitly.
Subscriptions accept node lists, not executable core configuration, filesystem references, arbitrary
controllers, providers or scripts. A subscription is capped at 1 MiB and 20 seconds.

`core.ts` starts one process per OpenCodex process on first advanced-node use. It uses
`OPENCODEX_PROXY_CORE` or `mihomo` on PATH, validates the generated configuration first, creates
private runtime files and authenticated loopback listeners on ephemeral ports, and has no public
controller. Each listener is pinned to its node and the final rule is REJECT. Separate transient
CLI processes cannot collide with server listener ports. Changes to node configuration wait for
active streams to drain; a new request receives `proxy_core_busy` while a restart would interrupt
one. An absent/failed core never falls back to direct. No binary is downloaded automatically.

Subscription refresh matches nodes by original subscription name, preserving profile IDs and
bindings. Duplicate names reject the refresh. Missing nodes are disabled, not silently rebound.
Renamed nodes are new identities. Imported credentials never appear in GET responses.

## Traffic and resource limits

Counters represent submitted request-body bytes and consumed response-body bytes, not wire bytes.
Retries and probes are included. Buffered uploads may be counted before a connection succeeds;
TLS, proxy handshakes, HTTP headers, compression differences and other applications are excluded.
Cancelling a response propagates upstream and marks the partial request incomplete.

The ledger retains at most 1,024 pending `(UTC day, profile, account, purpose)` aggregates. Flush
defaults to 15 seconds (5–60), and daily retention to 90 days (7–365). Current-month data survives
shorter retention so caps stay correct. Disk failure retains bounded pending counters; overflow
sets a visible incomplete flag. A crash may lose the current buffer. Complete totals are calculated
in SQL independently of the detail row cap. GUI detail shows 500 rows; CSV exports returned rows.

Monthly caps warn or block new requests after persisted plus buffered application bytes reach the
limit. Existing streams continue and concurrent admitted requests can exceed the cap. Accounting
failures refuse capped new sends. This is not a hard ISP billing limit.

Probe concurrency defaults to 2 (1–4); profiles are capped at 500; subscriptions at 20. There is no
new database service, resident scheduler, per-account process or full-response accounting buffer.
The optional core is additional memory. Actual capacity depends on the upstream application,
concurrency, context sizes and other VPS workloads; this module does not establish a 1-GB capacity
guarantee. Deployment and merge procedures are in [`../CUSTOMIZATION.md`](../CUSTOMIZATION.md).

Regression owners: `tests/lib/account-proxy-manager.test.ts`, `tests/lib/account-proxy-import.test.ts`,
`tests/server/proxy-manager-api.test.ts`, and `gui/tests/proxy-manager.test.tsx`.

## Custom container delivery

`src/proxy-manager/core-readiness.ts` gates first use on an authenticated loopback HTTP round trip,
because Mihomo opens its listeners before its tunnel reaches Running. A separate private readiness
listener routes only the agent's local probe via DIRECT; account listeners retain their pinned node.
No model request is retried by readiness, no upstream endpoint is contacted, and the temporary echo
server closes after success or timeout. `tests/lib/account-proxy-core-readiness.test.ts` covers the
listening-but-unready state, forged success, dead processes and the separation of account routes.

`deploy/compose.build.yaml` reuses the upstream runtime stage as a named build context;
`docker/custom/Dockerfile` adds a checksum-pinned Mihomo binary and low-concurrency initial config.
`deploy/compose.yaml` runs that image with separate application/Codex volumes, loopback publishing,
read-only root, dropped capabilities and bounded memory/logs. It performs no server-side build.
`docker/custom/init.ts` generates the data token inside the volume and preserves existing tokens.
`scripts/custom/docker-smoke.ts` uses synthetic providers in an isolated Compose project, exercises
the real HTTP and Mihomo routes, and writes an image-ID-bound receipt after cleanup succeeds.
`scripts/custom/export-image.ts` requires that receipt and streams the image into a fresh deployment
bundle without reading runtime volumes. `tests/ci-workflows/build-custom-compose.test.ts` covers
asset selection, checksum rejection, compressed-size limits and executable validation.
Instructions live in [`../deploy/README.zh-CN.md`](../deploy/README.zh-CN.md).
`gui/src/pages/proxy-manager/AccountIdentity.tsx` shows allowlisted alias/email with internal IDs as secondary text; identity-less accounts are explicitly unnamed. Editing reuses the upstream OAuth, API-key and Codex alias endpoints and never changes binding identity. Provider-default rows use system-network wording; account rows describe inheritance. Duplicate canonical subscription URLs are rejected with HTTP 409.
