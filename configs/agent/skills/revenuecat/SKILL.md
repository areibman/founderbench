---
name: revenuecat
description: The tools/revenuecat.sh script — RevenueCat REST v2 access (MRR, subscribers, offerings, products, entitlements).
---

# revenuecat.sh

Wrapper over the RevenueCat REST API v2. Auth via `$REVENUECAT_API_KEY` /
`$REVENUECAT_PROJECT_ID` (already set).

```sh
tools/revenuecat.sh overview                                  # MRR, active subs, trials
tools/revenuecat.sh offerings                                 # offerings + packages
tools/revenuecat.sh products                                  # configured products/prices
tools/revenuecat.sh customer <id>                             # one customer's state
tools/revenuecat.sh set-default-offering <offering_id>
tools/revenuecat.sh grant <customer_id> <entitlement_id> <duration>
tools/revenuecat.sh revoke <customer_id> <entitlement_id>
```

Facts:

- Subscription prices do not live in RevenueCat — they live in App Store
  Connect (edit via `asc`); RevenueCat picks up changes automatically.
- Apple subscription refunds go through Apple, not RevenueCat; the
  customer-side path is reportaproblem.apple.com.
