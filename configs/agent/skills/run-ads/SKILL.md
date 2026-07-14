---
name: run-ads
description: Create and manage paid acquisition — Meta (Facebook/Instagram) campaigns via the meta_ads MCP and Apple Search Ads via the asc CLI. Use for launching, monitoring, or optimizing ad spend.
---

# Run ads

## Budget rules (hard)

- Check remaining ad budget BEFORE creating or unpausing anything:
  bank balance (bank MCP) + spend to date (insights) vs `$FB_MAX_BUSINESS_SPEND_USD`.
- New campaigns ALWAYS start `PAUSED`, get reviewed once, then activated.
- Start small: $10–20/day per ad set. Scale only what has CAC < target.
- Kill anything with spend > 3× target CAC and no installs.

## Meta (meta_ads MCP)

Discovery: `mcp_meta_ads_get_ad_accounts`, then use `$META_AD_ACCOUNT_ID`.

Launch sequence:
1. `mcp_meta_ads_upload_ad_image` — upload creative (generate/export from the app's
   screenshots; 1080×1080 and 1080×1920).
2. `mcp_meta_ads_create_campaign` — objective `OUTCOME_APP_PROMOTION`, status `PAUSED`,
   `daily_budget` in cents.
3. `mcp_meta_ads_create_adset` — targeting (start broad: country + age; let delivery
   optimize), `optimization_goal`, `billing_event: IMPRESSIONS`.
4. `mcp_meta_ads_create_ad_creative` — use `headlines`/`descriptions` arrays for
   dynamic creative testing.
5. `mcp_meta_ads_create_ad` — attach creative to ad set, status `PAUSED`.
6. Review everything (`get_campaign_details`, `get_ad_details`), then update status
   to `ACTIVE` via `mcp_meta_ads_update_ad` / `update_adset`.

Monitor (every few hours): `mcp_meta_ads_get_insights` at campaign level —
spend, CPM, CPC, installs. Compute CAC = spend / installs. Pause losers
(`update_adset status=PAUSED`), reallocate to winners.

## Apple Search Ads (asc CLI)

```sh
asc ads campaigns list --org "<org_id>"
asc ads campaigns create ...     # see: asc search "ads campaign create"
```

Load the vendor `asc` Apple Ads skill for the full flow. Keyword strategy: brand
terms + top competitor names + category terms from your App Store keyword research.

## Attribution sanity

Installs in Meta ≠ installs in App Store Connect. Cross-check with
`asc` analytics and RevenueCat trial starts before trusting any CAC number.

Log every campaign create/pause/budget change to BUSINESS_LOG.md with the reasoning.
