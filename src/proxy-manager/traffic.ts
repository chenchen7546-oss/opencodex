import type { ProxyStore } from "./store";
import type { TrafficDelta, TrafficRow } from "./types";
/** Bounded daily aggregates, no request bodies, headers, tokens or unbounded request history. */
export class TrafficLedger {
  private pending = new Map<string, TrafficRow>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPrune = 0;
  private dropped = false;
  private closed = false;
  persistenceFailed = false;
  constructor(private readonly store: ProxyStore) {}
  add(proxyId: string, accountKey: string, purpose: string, delta: Partial<TrafficDelta>): void {
    if (this.closed) return;
    const day = new Date().toISOString().slice(0, 10),
      key = JSON.stringify([day, proxyId, accountKey, purpose]);
    if (this.pending.size >= 1024 && !this.pending.has(key)) this.flush();
    // Failure remains visible; bound memory even on a full disk.
    if (this.pending.size >= 1024 && !this.pending.has(key)) {
      this.dropped = true;
      this.persistenceFailed = true;
      return;
    }
    const row = this.pending.get(key) ?? {
      day,
      proxyId,
      accountKey,
      purpose,
      upload: 0,
      download: 0,
      requests: 0,
      failures: 0,
      incomplete: 0,
    };
    for (const field of ["upload", "download", "requests", "failures", "incomplete"] as const)
      row[field] += delta[field] ?? 0;
    this.pending.set(key, row);
    if (!this.timer) {
      this.timer = setInterval(() => this.flush(), this.store.settings().flushIntervalMs);
      this.timer.unref();
    }
  }
  bufferedBytes(proxyId: string): number {
    const month = new Date().toISOString().slice(0, 7);
    return [...this.pending.values()]
      .filter((r) => r.proxyId === proxyId && r.day.startsWith(month))
      .reduce((sum, r) => sum + r.upload + r.download, 0);
  }
  flush(): void {
    try {
      if (this.pending.size) {
        this.store.addTraffic([...this.pending.values()]);
        this.pending.clear();
      }
      if (Date.now() - this.lastPrune > 86400000) {
        this.store.prune();
        this.lastPrune = Date.now();
      }
      this.persistenceFailed = this.dropped;
    } catch {
      this.persistenceFailed = true;
    }
  }
  rows(since: string): TrafficRow[] {
    this.flush();
    return this.store.traffic(since);
  }
  reconfigure(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
  }
  close(): void {
    this.reconfigure();
    this.closed = true;
  }
}
/** Counts bytes consumed at the fetch body boundary. This is NOT ISP/billing wire traffic. */
export function countedStream(
  source: ReadableStream<Uint8Array>,
  onBytes: (n: number) => void,
  onEnd: (failed: boolean) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let ended = false;
  const finish = (failed: boolean) => {
    if (!ended) {
      ended = true;
      onEnd(failed);
    }
  };
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            finish(false);
            reader.releaseLock();
            controller.close();
          } else {
            onBytes(result.value.byteLength);
            controller.enqueue(result.value);
          }
        } catch (error) {
          finish(true);
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish(true);
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
}
export function bodyBytes(body: BodyInit | null | undefined): number | undefined {
  if (body == null) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString());
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}
