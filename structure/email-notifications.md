# Email Notifications

`src/notifications/` is an optional SMTP notification subsystem. It owns its settings,
recipients, incident deduplication and delivery history in `notifications/state.sqlite`
under the existing OpenCodex state home. It never writes provider credential formats.
`src/server/index/custom-extensions.ts` activates it at the server composition root;
the existing shutdown hook aborts deliveries and closes the independent store.

## Detection and delivery

The disabled default opens no SMTP connection and runs no timer. When enabled, one
unreferenced timer observes native Codex main/pool account health every minute using
`listCodexAuthAccountsSnapshot` inside `runPassiveRead`. It sends no model, quota or
refresh request. The account/provider subsystem remains the authority for credential
health; this subsystem never infers reauthentication from token expiry timestamps.
Existing observed failures are eligible after enabling notifications. Unknown health
does not resolve an incident; healthy credentials or account deletion do.

Each incident has a stable UUID and each recipient a separate delivery record.
SQLite immediate transactions claim a batch of at most 20 incidents per recipient,
with a 15-minute lease/backoff and at most three attempts. Successful delivery is
remembered across restarts. Replacing a recipient address creates a new delivery
identity; disabling recipients retains their successful-delivery records. Removed
recipients and accounts lose obsolete delivery rows. History retains 100 rows and
returns at most 50. One delivery runs at a time, with a 30-second overall timeout.
A crash after SMTP acceptance but before persistence can cause one repeated delivery;
SMTP cannot provide transactional exactly-once delivery with the local database.

## SMTP and management boundary

`src/notifications/smtp.ts` dynamically loads the pinned Nodemailer compatibility
adapter only when sending. It supports implicit TLS and required STARTTLS, verifies
certificates, and refuses plaintext fallback. SMTP is a direct server connection,
independent of account proxy routing. One envelope contains one enabled recipient.
Messages use fixed bilingual text, a bounded account display label and allowlisted
reason; account IDs, access/refresh tokens and upstream bodies are excluded. Errors
are reduced to stable categories, with SMTP debugging and attachment/URL access off.

`src/server/management/notification-routes.ts` handles `/api/notifications` GET/PUT
and POST `/api/notifications/test`, behind the existing admin/GUI session dispatcher,
origin/body limits and no-store responses. Passwords are write-only; a blank edit
preserves the saved value and explicit clearing removes it. Settings use optimistic
revision checks. A maximum of 20 individually enabled recipients is enforced with
single-address validation. The private SQLite directory uses the existing Windows
secret ACL hardener and POSIX owner permissions. Test sends target one saved enabled
recipient, work with automatic alerts disabled, and have a ten-second throttle.

`gui/src/pages/Notifications.tsx` provides the independent sidebar page, draft-only
editing, an explicit save bar, per-recipient toggles/tests and SMTP acceptance history.
It aborts requests and remounts on API target changes; SMTP secrets never enter browser
storage. Localized keys are supplied through `gui/src/i18n/notification-copy.ts` to
all catalogs. Shared design tokens cover light/dark and narrow viewports.

Focused coverage: `tests/server/email-notifications.test.ts`,
`tests/server/email-smtp.test.ts`, and `gui/tests/notifications.test.tsx`.
The SMTP wire test trusts a temporary CA only in its child process; it does not
change OS trust or contact external mailboxes.
