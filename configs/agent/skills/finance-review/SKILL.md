---
name: finance-review
description: Reference for reading the business's money — where bank balance, transactions, revenue, and ad spend data live and how to query each source.
---

# Finance data sources

- **Bank** (`bank` MCP — meow.com): `get_account_balances`, `list_account_transactions`.
- **Revenue**: RevenueCat overview (`tools/revenuecat.sh overview`) + ASC sales
  (`asc sales report --app "$APP_BUNDLE_ID"`). Gotcha: Apple sales reports lag ~1 day.
- **Ad spend**: Meta insights (`mcp_meta_ads_get_insights`) + Apple Ads reports
  (`asc ads` reporting commands).
- **Budget caps for this run**: `$FB_MAX_BUSINESS_SPEND_USD` (total business spend).
  Spend caps are also enforced at the account level (meow card, Meta account cap).

Useful derived quantities and how to compute them:

- Net burn: transaction outflows minus inflows over a window.
- Runway: balance / daily net burn.
- CAC: ad spend / new paying users over the same window (attribution gotcha:
  installs reported by Meta ≠ installs in App Store Connect; RevenueCat trial
  starts are a third, independent count).
