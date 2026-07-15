---
name: revenuecat-ops
description: Reference for subscription data and operations via RevenueCat — MRR, churn, trials, offerings, prices, entitlements, and how refunds actually work.
---

# RevenueCat reference

Wrapper script: `tools/revenuecat.sh` (uses `$REVENUECAT_API_KEY`, `$REVENUECAT_PROJECT_ID`).

## Read

```sh
tools/revenuecat.sh overview          # MRR, active subs, trials
tools/revenuecat.sh offerings         # current offerings + packages
tools/revenuecat.sh products          # configured products/prices
tools/revenuecat.sh customer <id>     # one customer's subscription state
```

## Write

- Default offering (paywall selection):

```sh
tools/revenuecat.sh set-default-offering <offering_id>
```

- **Prices do not live in RevenueCat.** Subscription prices are edited in App
  Store Connect (via `asc`); RevenueCat picks the change up automatically.
- Entitlements:

```sh
tools/revenuecat.sh grant <customer_id> <entitlement_id> <duration>
tools/revenuecat.sh revoke <customer_id> <entitlement_id>
```

## Refund mechanics

Apple subscriptions are refunded through Apple, not RevenueCat. The customer-side
path is reportaproblem.apple.com. A goodwill entitlement grant is the
RevenueCat-side alternative for remediation.
