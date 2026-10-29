import { NotificationError, type AccountObservation } from "./types";
import { NotificationStore } from "./store";
import { sendSmtpMail, type SendMail } from "./smtp";
import { requireMailConfiguration } from "./settings";

export class NotificationService {
  private timer?: ReturnType<typeof setTimeout>;
  private controller = new AbortController();
  private running = false;
  private stopped = false;
  private lastTest = 0;
  lastCheckedAt?: number;
  lastError?: string;
  constructor(readonly store: NotificationStore, private observe: () => Promise<AccountObservation[]>, private send: SendMail = sendSmtpMail) {}
  configure(): void {
    clearTimeout(this.timer);
    this.controller.abort();
    this.controller = new AbortController();
    if (this.store.settings().enabled && !this.stopped) this.schedule(1000);
  }
  private schedule(delay = 60_000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.tick().finally(() => {
      if (!this.stopped && this.store.settings().enabled) this.schedule();
    }); }, delay);
    this.timer.unref();
  }
  async tick(now = Date.now()): Promise<void> {
    if (this.running || this.stopped || !this.store.settings().enabled) return;
    this.running = true;
    const signal = this.controller.signal;
    try {
      const accounts = await this.observe();
      if (signal.aborted) return;
      this.store.observe(accounts, now);
      this.lastCheckedAt = now;
      this.lastError = undefined;
      const recipientIds = this.store.settings().recipients.filter((row) => row.enabled).map((row) => row.id);
      for (const id of recipientIds) {
        if (signal.aborted || this.stopped) break;
        const settings = this.store.settings();
        const recipient = settings.recipients.find((row) => row.id === id && row.enabled);
        if (!settings.enabled || !recipient) continue;
        const incidents = this.store.claim(id, now);
        if (!incidents.length) continue;
        const result = await this.send(settings, recipient, incidents, signal).catch(() => "smtp_failed" as const);
        if (!this.stopped) this.store.finish(id, incidents, result, Date.now());
      }
    } catch { this.lastError = "notification_check_failed"; }
    finally { this.running = false; }
  }
  async test(recipientId: string): Promise<string> {
    if (this.running || Date.now() - this.lastTest < 10_000) throw new NotificationError("notification_busy", 429);
    const settings = this.store.settings(), recipient = settings.recipients.find((row) => row.id === recipientId && row.enabled);
    if (!recipient) throw new NotificationError("recipient_disabled");
    requireMailConfiguration(settings);
    this.running = true; this.lastTest = Date.now();
    try {
      const result = await this.send(settings, recipient, [], this.controller.signal, true).catch(() => "smtp_failed" as const);
      if (!this.stopped) this.store.record(recipient.id, "test", result, 0, Date.now());
      return result;
    } finally { this.running = false; }
  }
  close() { this.stopped = true; clearTimeout(this.timer); this.controller.abort(); this.store.close(); }
}
