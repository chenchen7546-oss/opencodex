export interface MailRecipient { id: string; address: string; enabled: boolean }
export interface NotificationSettings {
  revision: number;
  enabled: boolean;
  smtp: { host: string; port: number; security: "tls" | "starttls"; username: string; password: string; from: string };
  recipients: MailRecipient[];
}
export interface AccountObservation { id: string; label: string; state: "reauth" | "healthy" | "unknown"; reason: string }
export interface Incident { id: string; accountId: string; label: string; reason: string; detectedAt: number }
export class NotificationError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export const defaultNotificationSettings = (): NotificationSettings => ({
  revision: 0, enabled: false,
  smtp: { host: "", port: 465, security: "tls", username: "", password: "", from: "" },
  recipients: [],
});
export function publicSettings(settings: NotificationSettings) {
  const { password, ...smtp } = settings.smtp;
  return { ...settings, smtp: { ...smtp, hasPassword: Boolean(password) } };
}
