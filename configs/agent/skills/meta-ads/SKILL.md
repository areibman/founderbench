---
name: meta-ads
description: Operate Meta Facebook and Instagram advertising via the official Graph/Marketing API with curl (or any HTTP client). Use for ad-account audits, Pages, pixels, media, campaigns, ad sets, creatives, ads, targeting, budgets, status changes, and insights.
---

<!-- Source: Meta Marketing API docs
     (developers.facebook.com/documentation/ads-commerce/marketing-api). -->

# Meta Ads (Graph / Marketing API)

Call `https://graph.facebook.com` directly. Credentials are in the environment
(from `credentials.env`):

- `META_ACCESS_TOKEN` — preferably a System User token (`ads_read` + `ads_management`)
- `META_AD_ACCOUNT_ID` — e.g. `act_…`
- `META_GRAPH_API_VERSION` — pinned version, currently `v25.0`
- `META_APP_SECRET` — optional; use for `appsecret_proof` when you want it
- `META_PAGE_IDS` / `META_BUSINESS_ID` — account context hints

Never print or commit the token.

## Call pattern

```sh
curl -sS \
  "https://graph.facebook.com/${META_GRAPH_API_VERSION}/${META_AD_ACCOUNT_ID}?fields=id,name,account_status,amount_spent,balance,currency,spend_cap" \
  -H "Authorization: Bearer ${META_ACCESS_TOKEN}"
```

Writes are `POST` (form or JSON) to the same host; deletes are `DELETE`.
Budgets are integers in the account's minor currency unit (USD cents).
App-install objective is `OUTCOME_APP_PROMOTION`.

Common edges under the ad account: `campaigns`, `adsets`, `ads`, `adcreatives`,
`adimages`, `adspixels`, `insights`, `activities`, `promote_pages`,
`instagram_accounts`. Object updates are `POST /{object-id}` with fields to change
(including `status=ACTIVE|PAUSED|DELETED`).

Spend blast radius is the Meta ad-account spending cap. Official entry points:
[Marketing API setup](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started),
[authentication](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authentication),
[permissions](https://developers.facebook.com/docs/permissions).

Apple Ads is separate; use the `asc-cli` skill.
