---
name: revenuecat
description: RevenueCat — subscription infrastructure (MRR, subscribers, products, offerings, entitlements, paywalls) via the official cloud MCP, the REST v2 API, or the local wrapper script.
---

<!-- Source: official RevenueCat docs (revenuecat.com/docs/tools/mcp; full doc
     index at revenuecat.com/docs/llms.txt). RevenueCat publishes no SKILL.md;
     this card is assembled from their official documentation. -->

# RevenueCat

Three access surfaces, same account (`$REVENUECAT_API_KEY` /
`$REVENUECAT_PROJECT_ID` are set):

## Official cloud MCP

URL: `https://mcp.revenuecat.ai/mcp` — auth via Bearer API v2 key or OAuth.
Capability areas (per official docs): project management, app management
(CRUD across platforms), product management (subscriptions + IAP), offering &
package management, paywall management, and analytics (charts + experiment
results).

## REST v2 API

`https://api.revenuecat.com/v2/projects/$REVENUECAT_PROJECT_ID/...` with
`Authorization: Bearer $REVENUECAT_API_KEY`. Full doc index:
`https://www.revenuecat.com/docs/llms.txt`.

## Local wrapper script

```sh
tools/revenuecat.sh overview                                  # MRR, active subs, trials
tools/revenuecat.sh offerings                                 # offerings + packages
tools/revenuecat.sh products                                  # configured products/prices
tools/revenuecat.sh customer <id>                             # one customer's state
tools/revenuecat.sh set-default-offering <offering_id>
tools/revenuecat.sh grant <customer_id> <entitlement_id> <duration>
tools/revenuecat.sh revoke <customer_id> <entitlement_id>
```

## Platform facts

- Subscription prices do not live in RevenueCat — they live in App Store
  Connect (edit via `asc`); RevenueCat picks up changes automatically.
- Apple subscription refunds go through Apple, not RevenueCat; the
  customer-side path is reportaproblem.apple.com. A goodwill entitlement
  grant is the RevenueCat-side remediation alternative.
