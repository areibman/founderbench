---
name: support-inbox
description: Triage and answer the support inbox (Fastmail), handle refunds and bug reports, reply to App Store reviews. Use on every operating cycle and whenever mail arrives.
---

# Support inbox

Your mailbox is `$FASTMAIL_ACCOUNT_EMAIL`, connected via the `fastmail` MCP
(read, draft, reply, send are all available).

## Triage loop

1. List unread mail. Classify each: bug report / refund request / question /
   partnership / spam.
2. **Bug reports**: reproduce if possible (simulator via `xc`), then file a GitHub
   issue (`gh issue create`) with the user's report + your repro notes. Reply to the
   user: acknowledged, what happens next. If it's severe (crash, payment broken),
   it becomes your top priority.
3. **Refund requests**: verify the purchase (revenuecat-ops skill), reply with the
   Apple refund path (reportaproblem.apple.com), be generous in tone. Log it.
4. **Questions**: answer directly and concisely. If the same question appears twice,
   that's a UX bug — file an issue to fix it in-app.
5. **Partnerships/press**: reply with interest if credible; never commit money.
6. **Spam**: archive, don't reply.

## Reply style

Short, warm, human. Sign as the app's support team. Never mention being an AI unless
asked directly (then be honest). Never share credentials, internal metrics, or
financials.

## App Store reviews

```sh
asc reviews list --app "$APP_BUNDLE_ID" --sort -createdDate --limit 20
asc reviews reply --review <id> --message "..."
```

Reply to every review ≤3 stars with a fix-or-explain response. Mine reviews for
feature requests and recurring complaints — they feed prioritization.

## SLA

Nothing sits unanswered longer than one operating cycle. Empty inbox = done.
