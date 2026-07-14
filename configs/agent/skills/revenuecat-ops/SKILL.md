---
name: revenuecat-ops
description: Inspect and manage subscriptions via RevenueCat — MRR, churn, trials, refunds, offerings, prices, entitlements. Use for any monetization question or pricing change.
---

# RevenueCat operations

Wrapper script: `tools/revenuecat.sh` (uses `$REVENUECAT_API_KEY`, `$REVENUECAT_PROJECT_ID`).

## Read (safe, do freely)

```sh
tools/revenuecat.sh overview          # MRR, active subs, trials — the money dashboard
tools/revenuecat.sh offerings         # current offerings + packages
tools/revenuecat.sh products          # configured products/prices
tools/revenuecat.sh customer <id>     # one customer's subscription state
```

Metrics to watch: MRR trend, trial→paid conversion, churn. Pull `overview` at the start
of every finance review.

## Write (log every change to BUSINESS_LOG.md first)

- **Change which offering is default** (paywall experiment):

```sh
tools/revenuecat.sh set-default-offering <offering_id>
```

- **Price changes** happen in App Store Connect (products live there), then sync:
  use `asc` to edit the subscription price, and note RevenueCat picks it up
  automatically. Watch conversion for several hours before iterating.

- **Grant/revoke entitlement** (support remediation only):

```sh
tools/revenuecat.sh grant <customer_id> <entitlement_id> <duration>
tools/revenuecat.sh revoke <customer_id> <entitlement_id>
```

## Refunds

Apple subscriptions are refunded through Apple, not RevenueCat. For a customer refund
request: verify their purchase (`customer <id>`), then direct them to
reportaproblem.apple.com in your reply, or issue a goodwill entitlement grant if
appropriate. Log every case.

## Rules

- Never change prices and offerings in the same cycle — you won't know what moved.
- A/B one variable at a time; give each experiment several hours minimum.
