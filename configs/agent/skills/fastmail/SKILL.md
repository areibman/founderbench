---
name: fastmail
description: Fastmail — the business's mailbox, calendar, and contacts via the official Fastmail MCP server; JMAP API as the scripted fallback.
---

<!-- Source: official Fastmail MCP announcement and API documentation
     (fastmail.com/blog/an-mcp-server-for-fastmail, fastmail.com/dev).
     Fastmail publishes no SKILL.md; this card is assembled from their
     official documentation. -->

# Fastmail

The mailbox is `$FASTMAIL_ACCOUNT_EMAIL`.

## Official MCP server (connected on this machine as the `fastmail` MCP)

Endpoint: `https://api.fastmail.com/mcp`. OAuth consent has three access
levels — read-only (see mail/contacts/calendars), write (drafts, edit
contacts/events), and **send** (send emails). This machine is authorized at
the send level, so read, draft, reply, and send are all available, plus
calendar and contacts.

## JMAP API (scripted fallback)

Fastmail's underlying API is JMAP (RFC 8620/8621), sitting alongside
IMAP/CalDAV/CardDAV. Session endpoint: `https://api.fastmail.com/jmap/session`
with `Authorization: Bearer $FASTMAIL_JMAP_TOKEN`. API tokens are created in
Settings → Privacy & Security → API tokens.

## Facts

- Masked Email is supported: mint per-service addresses when registering for
  third-party tools.
- App Store reviews are not email — read and reply via `asc reviews`
  (asc-cli skill).
- Customer purchase state, when relevant to a mail thread, is queryable via
  RevenueCat (`tools/revenuecat.sh customer <id>`).
