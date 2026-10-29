---
title: Email notifications (custom build)
description: Receive SMTP alerts when Codex accounts require reauthentication.
---

This custom build adds **Email notifications** to the sidebar. Notifications are off
by default. The server needs an outbound connection to your SMTP service.

## Set up SMTP and recipients

1. Open **Email notifications** and fill in the SMTP hostname, port, encryption,
   username, app password and sender email supplied by your mailbox provider.
   TLS usually uses port 465; STARTTLS usually uses port 587. Certificate verification
   is always enabled. Use the provider's SMTP app password when required.
2. Add up to 20 recipient addresses. Enable or disable each address independently.
   Each message has a separate recipient envelope, so addresses are not shared with
   other recipients. The saved SMTP password is never displayed again; leave it blank
   to retain it when editing other settings.
3. **Save settings**, then use **Send test email** beside an enabled address. This
   sends one real test message to that address, even with automatic alerts disabled.
   SMTP acceptance does not guarantee inbox delivery; check spam folders too.
4. Turn on **Enable notifications** and save again. Draft switches and recipient
   edits take effect only after saving. Existing observed account failures can be
   notified on the next check.

## What triggers an alert

Once a minute, the service reads the Codex account health already observed by
OpenCodex. It does not make extra model calls, refresh tokens or query quotas.
Inactive accounts are not proactively authenticated by this notification feature.
An expired access token that refreshes successfully is not a notification condition.
Confirmed reauthentication requirements, including missing/rejected credentials and
terminal refresh failures, are reported with their actual reason.

Successful alerts are deduplicated per account incident and recipient, including
after restart. Recovery enables a new notification for a later incident. Failed
deliveries retry every 15 minutes, at most three attempts. A rare crash between SMTP
acceptance and saving the result can repeat a message. Review **Sending log** for
the latest 50 results; it records SMTP acceptance, not final inbox delivery.

Settings and delivery state live in `$OPENCODEX_HOME/notifications/state.sqlite`,
separate from account and proxy records. The normal OpenCodex Docker state volume
persists them. SMTP connections use the server's direct network, independently of
account proxy bindings. Backups containing this database contain the SMTP secret
and must be handled as private credentials.
