---
name: meta-ads
description: The meta_ads MCP — Meta (Facebook/Instagram) Marketing API access (campaigns, ad sets, creatives, ads, insights).
---

# meta_ads MCP

Hosted Meta Marketing API access, already authenticated (OAuth done at machine
setup). The ad account is `$META_AD_ACCOUNT_ID` (discoverable via
`mcp_meta_ads_get_ad_accounts`).

Tools: `get_ad_accounts`, `create_campaign`, `create_adset`,
`create_ad_creative`, `create_ad`, `upload_ad_image`, `get_campaign_details`,
`get_ad_details`, `get_insights`, `update_adset`, `update_ad`.

API facts:

- `daily_budget` values are in cents.
- Campaign objective for app installs is `OUTCOME_APP_PROMOTION`.
- Objects carry a `status` of `PAUSED` or `ACTIVE`, settable at create time and
  via `update_*`.
- `create_ad_creative` accepts `headlines`/`descriptions` arrays (dynamic creative).
- Accepted image sizes include 1080×1080 and 1080×1920.
- Attribution: installs reported by Meta, installs in App Store Connect, and
  RevenueCat trial starts are three independent measurements of different events.

Apple Search Ads is separate: `asc ads` (see the asc-cli skill).
