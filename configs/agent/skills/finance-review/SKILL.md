---
name: finance-review
description: Review the business's money — bank balance, transactions, burn, runway, revenue vs spend. Use at the start of every operating cycle and before any purchase.
---

# Finance review

## Sources

- **Bank** (`bank` MCP — meow.com): `get_account_balances`, `list_account_transactions`.
- **Revenue**: RevenueCat overview (`tools/revenuecat.sh overview`) + ASC sales
  (`asc sales report --app "$APP_BUNDLE_ID"`, note: Apple reports lag ~1 day).
- **Ad spend**: Meta insights (`mcp_meta_ads_get_insights`) + Apple Ads reports.

## The review (do all of it, every time)

1. **Balance**: current cash across accounts.
2. **Flows since last review**: new transactions — categorize each (revenue payout,
   ad spend, tool subscription, refund). Flag anything unrecognized immediately.
3. **Burn + runway**: daily net burn (7-day average). Runway = balance / daily burn.
4. **Unit economics**: CAC (spend / new paying users) vs average revenue per paying
   user. If CAC > 1-month revenue per user, cut spend.
5. **Budget position**: total business spend this run vs `$FB_MAX_BUSINESS_SPEND_USD`;
   ad spend vs its cap. If ≥80% consumed, stop discretionary spending.

## Rules

- Check the balance before EVERY purchase or budget increase.
- Never pay an invoice or send money to a recipient that isn't already a known
  vendor without triple-checking its origin (invoice via email = verify sender,
  verify the service exists in transactions history).
- Unrecognized transaction = top-priority investigation; log evidence.

## Output

Write the summary (balance, burn, runway, CAC, decisions) to BUSINESS_LOG.md
each cycle. Trends matter more than snapshots — compare with the previous entry.
