import { NotificationError, type Incident, type MailRecipient, type NotificationSettings } from "./types";
import { requireMailConfiguration } from "./settings";

export type MailResult = "sent" | "smtp_auth_failed" | "smtp_tls_failed" | "smtp_timeout" | "smtp_connection_failed" | "smtp_rejected" | "smtp_failed" | "cancelled";
export function mailFailure(error: unknown): MailResult {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "EAUTH") return "smtp_auth_failed";
  if (code === "ETIMEDOUT" || code === "ETIMEOUT") return "smtp_timeout";
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(code)) return "smtp_tls_failed";
  if (["ECONNECTION", "ECONNREFUSED", "EDNS", "ENOTFOUND", "ESOCKET"].includes(code)) return "smtp_connection_failed";
  if (["EENVELOPE", "EMESSAGE"].includes(code)) return "smtp_rejected";
  return "smtp_failed";
}
const reasons: Record<string, string> = {
  missing_credential: "缺少登录凭据 / Missing credentials",
  refresh_failed: "登录凭据无法自动刷新 / Credentials could not be refreshed",
  unauthorized: "服务商拒绝了登录凭据 / Credentials were rejected",
  quota_unauthorized: "额度接口拒绝了登录凭据 / Quota endpoint rejected credentials",
  forbidden: "账号访问被拒绝 / Account access was denied",
};
export function mailContent(incidents: Incident[], test = false): { subject: string; text: string } {
  if (test) return { subject: "OpenCodex · 测试通知 / Test notification", text: "这是一封 OpenCodex 测试邮件。收到此邮件说明 SMTP 通知配置可用。\nThis is a test notification from OpenCodex." };
  return {
    subject: `OpenCodex · ${incidents.length} 个 Codex 账号需要重新认证 / Reauthentication required`,
    text: ["以下 Codex 账号需要重新认证 / These Codex accounts need reauthentication:", "",
      ...incidents.map((incident) => `${incident.label.replace(/[\r\n\0]/g, " ").slice(0, 200)}\n${reasons[incident.reason] ?? reasons.refresh_failed}\n${new Date(incident.detectedAt).toISOString()}\n`),
      "请打开 OpenCodex → 提供方 → Codex 账号池，重新认证对应账号。",
      "Open OpenCodex → Providers → Codex account pool and reauthenticate the affected account.",
      "同一次异常不会重复提醒；恢复后再次异常会重新提醒。 / Each incident is notified once after successful delivery.",
    ].join("\n"),
  };
}
export type SendMail = (settings: NotificationSettings, recipient: MailRecipient, incidents: Incident[], signal: AbortSignal, test?: boolean) => Promise<MailResult>;
/** The SMTP compatibility adapter is loaded only for an actual delivery; never log SMTP errors or credentials. */
export const sendSmtpMail: SendMail = async (settings, recipient, incidents, signal, test) => {
  requireMailConfiguration(settings);
  if (signal.aborted) return "cancelled";
  const { default: nodemailer } = await import("nodemailer");
  const smtp = settings.smtp;
  const transport = nodemailer.createTransport({
    pool: true, maxConnections: 1, maxMessages: 1,
    host: smtp.host, port: smtp.port, secure: smtp.security === "tls", requireTLS: smtp.security === "starttls",
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth: { user: smtp.username, pass: smtp.password }, name: "opencodex.local",
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 15_000, dnsTimeout: 10_000,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => { transport.close(); reject(new NotificationError("cancelled")); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { transport.close(); reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })); }, 30_000);
      if (signal.aborted) abort();
    });
    const info = await Promise.race([transport.sendMail({
      from: { name: "OpenCodex", address: smtp.from }, to: { address: recipient.address, name: "" },
      envelope: { from: smtp.from, to: [recipient.address] }, ...mailContent(incidents, test),
    }), interrupted]);
    return info.accepted?.length === 1 ? "sent" : "smtp_rejected";
  } catch (error) { return signal.aborted ? "cancelled" : mailFailure(error); }
  finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); transport.close(); }
};
