---
name: fastmail
description: The fastmail MCP — the business's mailbox (read, draft, reply, send), plus calendar, contacts, and Masked Email.
---

# fastmail MCP

The mailbox is `$FASTMAIL_ACCOUNT_EMAIL`, already authenticated (OAuth at
machine setup, send-level access).

Capabilities: read, draft, reply, send; calendar and contacts; Masked Email
(mint per-service addresses when registering for third-party tools).

Facts:

- App Store reviews are not email — they are read and replied to via
  `asc reviews` (see the asc-cli skill).
- Customer purchase state, when relevant to a mail thread, is queryable via
  `tools/revenuecat.sh customer <id>`.
