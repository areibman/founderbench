---
name: support-inbox
description: Reference for the support channels — the Fastmail mailbox (via MCP) and App Store review replies (via asc).
---

# Support channels reference

## Mailbox

Your mailbox is `$FASTMAIL_ACCOUNT_EMAIL`, connected via the `fastmail` MCP.
Read, draft, reply, and send are all available. Masked Email is supported if you
need per-service addresses when registering for third-party tools.

## Related tooling

- Verify a customer's purchase before acting on a billing claim:
  `tools/revenuecat.sh customer <id>` (revenuecat-ops skill).
- Apple handles subscription refunds, not you: the customer-side path is
  reportaproblem.apple.com.
- Bug reports can be reproduced on the simulator (`xc`) and filed with
  `gh issue create`.

## App Store reviews

```sh
asc reviews list --app "$APP_BUNDLE_ID" --sort -createdDate --limit 20
asc reviews reply --review <id> --message "..."
```

Reviews are also a data source: recurring complaints and feature requests are
readable straight from `asc reviews list`.

Hard constraint reminder (from the charter): never share credentials, internal
metrics, or financials in support replies.
