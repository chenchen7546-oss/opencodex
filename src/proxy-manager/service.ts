import { ACCOUNT_EGRESS_SENT, type EgressAccount, type EgressScope, type EgressSend } from "../lib/account-egress";
import { ProxyStore } from "./store";
import { bodyBytes, countedStream, TrafficLedger } from "./traffic";
import { accountKey, ProxyManagerError, type ManagedAccount, type ProxyChoice } from "./types";
import type { ManagedProxyCore } from "./core";
export interface AccountSource {
  list(): Array<{
    account: EgressAccount;
    label: string;
    alias?: string;
    email?: string;
  }>;
  resolve(input: RequestInfo | URL, init?: RequestInit, provider?: string): EgressAccount[];
}
export class ProxyManager {
  readonly traffic: TrafficLedger;
  private activeProbes = 0;
  constructor(
    readonly store: ProxyStore,
    readonly source: AccountSource,
    readonly core?: ManagedProxyCore,
  ) {
    this.traffic = new TrafficLedger(store);
  }
  accounts(): ManagedAccount[] {
    const known = this.source.list().map((row) => ({ ...row, choice: this.store.choice(row.account) }));
    const keys = new Set(known.map((row) => accountKey(row.account)));
    return [
      ...known,
      ...this.store
        .bindings()
        .filter((b) => !keys.has(accountKey(b.account)))
        .map((b) => ({ ...b, label: b.account.id, orphaned: true })),
    ];
  }
  bind(accounts: EgressAccount[], choice: ProxyChoice): void {
    const known = new Set(this.accounts().map((row) => accountKey(row.account)));
    if (accounts.some((a) => !known.has(accountKey(a)))) throw new ProxyManagerError("account_not_found", 404);
    this.store.bind(accounts, choice);
  }
  private resolve(
    input: RequestInfo | URL,
    init?: RequestInit,
    scope?: EgressScope,
  ): {
    account?: EgressAccount;
    choice: ProxyChoice;
  } {
    if (scope?.proxyId) return { account: scope.account, choice: { mode: "proxy", proxyId: scope.proxyId } };
    // Physical bearer wins over a stale ambient account when a retry switched credentials.
    const hint = scope?.provider?.startsWith("<") ? undefined : scope?.provider;
    const found = this.source.resolve(input, init, scope?.account?.provider ?? hint);
    const scopedMatch = scope?.account && found.find((a) => accountKey(a) === accountKey(scope.account!));
    if (found.length > 1 && !scopedMatch && found.some((a) => this.choice(a).mode !== "inherit"))
      throw new ProxyManagerError("ambiguous_proxy_account", 409);
    const account = scopedMatch ?? (found.length === 1 ? found[0] : scope?.account);
    if (account) {
      return { account, choice: this.choice(account) };
    }
    if (scope?.provider) {
      const provisional: EgressAccount = { kind: "oauth", provider: scope.provider, id: "@new" };
      return { account: provisional, choice: this.store.choice(provisional) };
    }
    return { choice: { mode: "inherit" } };
  }
  private choice(account: EgressAccount): ProxyChoice {
    const own = this.store.choice(account);
    return own.mode !== "inherit" ? own : this.store.choice({ kind: "oauth", provider: account.provider, id: "@new" });
  }
  explicit(input: RequestInfo | URL, init?: RequestInit, scope?: EgressScope): boolean {
    return this.resolve(input, init, scope).choice.mode !== "inherit";
  }
  async send(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    next: EgressSend,
    scope?: EgressScope,
  ): Promise<Response> {
    const { account, choice } = this.resolve(input, init, scope);
    if (choice.mode === "inherit") return next(input, init);
    const profile = choice.mode === "proxy" ? this.store.profile(choice.proxyId) : undefined;
    if (choice.mode === "proxy" && !profile?.enabled) throw new ProxyManagerError("proxy_unavailable", 503);
    if (profile?.monthlyLimitBytes && profile.limitAction === "block" && this.traffic.persistenceFailed)
      throw new ProxyManagerError("proxy_traffic_unavailable", 503);
    if (
      profile?.monthlyLimitBytes &&
      profile.limitAction === "block" &&
      this.store.monthBytes(profile.id) + this.traffic.bufferedBytes(profile.id) >= profile.monthlyLimitBytes
    )
      throw new ProxyManagerError("proxy_traffic_limit", 429);
    const lease = profile?.node ? await this.core?.acquire(profile.id) : undefined;
    if (profile?.node && !lease) throw new ProxyManagerError("proxy_core_not_installed", 503);
    const proxy = lease?.url ?? profile?.url ?? false;
    const id = profile?.id ?? "direct",
      key = account ? accountKey(account) : "probe",
      purpose = scope?.purpose ?? "request";
    const record = (delta: Parameters<TrafficLedger["add"]>[3]) => this.traffic.add(id, key, purpose, delta);
    const options = {
      ...init,
      proxy,
      [ACCOUNT_EGRESS_SENT]: true,
      redirect: (init?.redirect === "error" ? "error" : "manual") as RequestRedirect,
    };
    let failed = false;
    const failure = () => {
      if (!failed) {
        failed = true;
        record({ failures: 1 });
      }
    };
    try {
      const sourceBody = init?.body ?? (input instanceof Request ? input.body : undefined);
      const size = bodyBytes(sourceBody);
      if (size !== undefined) record({ upload: size });
      else if (sourceBody instanceof ReadableStream)
        options.body = countedStream(
          sourceBody,
          (n) => record({ upload: n }),
          (bad) => {
            if (bad) failure();
          },
        );
      else if (sourceBody instanceof FormData) {
        const encoded = new Request("https://multipart.invalid", { method: "POST", body: sourceBody });
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (!headers.has("content-type")) headers.set("content-type", encoded.headers.get("content-type")!);
        options.headers = headers;
        options.body = countedStream(
          encoded.body!,
          (n) => record({ upload: n }),
          (bad) => {
            if (bad) failure();
          },
        );
      } else record({ incomplete: 1 });
      record({ requests: 1 });
      const response = await next(input, options);
      if (!response.ok) failure();
      if (!response.body) {
        lease?.release();
        return response;
      }
      const body = countedStream(
        response.body,
        (n) => record({ download: n }),
        (bad) => {
          lease?.release();
          if (bad) {
            failure();
            record({ incomplete: 1 });
          }
        },
      );
      const result = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      for (const field of ["url", "redirected", "type"] as const)
        Object.defineProperty(result, field, { value: response[field] });
      return result;
    } catch (error) {
      lease?.release();
      failure();
      record({ incomplete: 1 });
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ProxyManagerError) throw error;
      // Native proxy errors may contain a credential-bearing URL. Never expose it to logs/UI.
      throw new ProxyManagerError("proxy_connection_failed", 502);
    }
  }
  async probe(
    id: string,
    next: EgressSend,
  ): Promise<{
    ok: boolean;
    latencyMs: number;
    exitIp?: string;
    code?: string;
  }> {
    if (this.activeProbes >= this.store.settings().probeConcurrency)
      throw new ProxyManagerError("proxy_probe_busy", 429);
    this.activeProbes++;
    const start = performance.now();
    try {
      const response = await this.send(
        "https://api.ipify.org?format=json",
        { signal: AbortSignal.timeout(10000) },
        next,
        { proxyId: id, purpose: "probe" },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProxyManagerError("proxy_probe_http_error");
      }
      const reader = response.body?.getReader();
      let length = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          while (true) {
            const r = await reader.read();
            if (r.done) break;
            length += r.value.length;
            if (length > 4096) {
              await reader.cancel();
              throw new ProxyManagerError("proxy_probe_invalid_response");
            }
            chunks.push(r.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof data.ip !== "string" || !/^[\da-fA-F:.]{3,45}$/.test(data.ip))
        throw new ProxyManagerError("proxy_probe_invalid_response");
      return { ok: true, latencyMs: Math.round(performance.now() - start), exitIp: data.ip };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - start),
        code: error instanceof ProxyManagerError ? error.code : "proxy_probe_failed",
      };
    } finally {
      this.activeProbes--;
    }
  }
  close(): void {
    this.core?.close();
    this.traffic.close();
    this.store.close();
  }
}
