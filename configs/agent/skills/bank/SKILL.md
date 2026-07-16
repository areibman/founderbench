---
name: bank
description: The bank MCP — meow.com business banking (balances, transactions, payments).
---

# bank MCP (meow.com)

Already authenticated (OAuth done at machine setup).

Tools: `get_account_balances`, `list_account_transactions`, plus payment
operations (discover the full list from the MCP's tool listing).

Facts:

- The run's business-spend cap is `$FB_MAX_BUSINESS_SPEND_USD`; spending caps
  are also enforced at the account level (card controls).
- Other money data lives elsewhere: subscription revenue in RevenueCat
  (`tools/revenuecat.sh`), Apple payouts/sales in ASC (`asc sales report`),
  ad spend in Meta insights (`meta_ads` MCP) and `asc ads`.
