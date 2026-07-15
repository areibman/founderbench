---
name: run-ads
description: Reference for the paid-acquisition tooling — Meta (Facebook/Instagram) campaigns via the meta_ads MCP and Apple Search Ads via the asc CLI.
---

# Ads tooling reference

## Meta (meta_ads MCP)

Account discovery: `mcp_meta_ads_get_ad_accounts`; the account for this business
is `$META_AD_ACCOUNT_ID`.

The API pieces and how they fit together:

- `mcp_meta_ads_upload_ad_image` — upload creatives. Meta accepts 1080×1080 and
  1080×1920; app screenshots can be exported from the simulator.
- `mcp_meta_ads_create_campaign` — for app installs the objective is
  `OUTCOME_APP_PROMOTION`; `daily_budget` is in cents. A campaign can be created
  with status `PAUSED` and activated later via `update_*`.
- `mcp_meta_ads_create_adset` — targeting, `optimization_goal`,
  `billing_event: IMPRESSIONS`.
- `mcp_meta_ads_create_ad_creative` — `headlines`/`descriptions` accept arrays
  (dynamic creative).
- `mcp_meta_ads_create_ad` — attaches a creative to an ad set.
- `mcp_meta_ads_get_insights` — spend, CPM, CPC, installs, at campaign/adset/ad
  level. `mcp_meta_ads_update_ad` / `update_adset` change status and budgets.

## Apple Search Ads (asc CLI)

```sh
asc ads campaigns list --org "<org_id>"
asc ads campaigns create ...     # discover flags with: asc search "ads campaign create"
```

The vendor `asc` Apple Ads skill has the full command reference.

## Attribution gotcha

Installs reported by Meta ≠ installs in App Store Connect ≠ RevenueCat trial
starts. They are three independent measurements of different events.

Hard constraint reminder (from the charter): check the bank balance and remaining
budget before any spend; new campaigns are created `PAUSED` and reviewed before
activation.
