---
name: meta-ads
description: Operate Meta Facebook and Instagram advertising through the local FounderBench MCP, which calls the official Meta Graph and Marketing API directly. Use for Meta ad-account audits, Pages, pixels, media, campaigns, ad sets, creatives, ads, targeting, budgets, status changes, deletion, and performance insights.
---

# Direct Meta Ads

Use the local `meta_ads` MCP. It runs `tools/meta-ads-mcp.sh` over stdio and sends
requests directly to `graph.facebook.com`; no hosted MCP broker receives credentials
or ad data.

## Authentication and scope

Read credentials from the gitignored `credentials.env`:

- `META_ACCESS_TOKEN`: preferably a System User token from the business's Meta app.
- `META_AD_ACCOUNT_ID`: the only ad account this MCP may operate.
- `META_APP_SECRET`: optional but recommended; adds `appsecret_proof` to requests.
- `META_PAGE_IDS`: required comma-separated Page allowlist for creative writes.
- `META_ALLOW_ACTIVATION`: leave false unless live activation is explicitly authorized.
- `META_GRAPH_API_VERSION`: pinned Graph API version, currently `v25.0`.

Spend limits belong on the Meta ad account itself. This MCP does not prescribe
daily or lifetime budget ceilings — choose budgets that fit the bank and the
account cap.

The token needs `ads_read` for reads and `ads_management` for writes. Add
`business_management` only for Business Portfolio asset management. Never print,
commit, or pass the token as a tool argument.

## Safety contract

- Start with `get_mcp_status`. Require identity `founderbench-local-meta-ads`, local
  stdio transport, upstream origin `https://graph.facebook.com`, and no hosted broker.
- Keep every write inside configured `META_AD_ACCOUNT_ID`; no caller-supplied fallback exists.
- Require each creative to identify exactly one Page in `META_PAGE_IDS`, including
  an `object_story_id` Page prefix when using an existing post.
- Pass `confirm: true` for every write.
- New campaigns, ad sets, and ads always start `PAUSED`.
- Activate only when `META_ALLOW_ACTIVATION=true`, and after billing, creative,
  targeting, and the account-level spend cap are verified.
- Read the object back after every write. For deletions, re-list the parent edge.
- Treat `status` and `effective_status` separately. A child may remain configured
  `ACTIVE` while being effectively deleted by its parent.

## Discovery workflow

1. Call `get_mcp_status`, then `get_ad_accounts` and `get_account_info`.
2. Call `get_account_pages`, `get_instagram_accounts`, and `get_pixels`.
3. Call `get_campaigns`, `get_adsets`, `get_ads`, `get_ad_creatives`, and
   `list_ad_images` with pagination until no `paging.next` remains.
4. Use `get_insights` for spend and delivery evidence.
5. Use `get_account_activities` to verify who changed status or budget.

`get_ad_creatives` supports account-wide discovery. Prefer it over walking only
visible ads when locating orphaned or historical media dependencies.

## Creation workflow

1. Upload media with `upload_ad_image`.
2. Create a paused campaign with `create_campaign`.
3. Create a paused ad set with `create_adset`.
4. Create content with `create_ad_creative`; pass the official AdCreative fields in
   `spec`.
5. Create a paused ad with `create_ad`.
6. Read back every object and preview it in Ads Manager.
7. If live activation is authorized, set `META_ALLOW_ACTIVATION=true`, then
   activate the ad set, ad, and campaign only after billing, targeting,
   schedule, attribution, Page identity, destination, and budget are verified.

Budgets are integers in the account's minor currency unit; USD values are cents.
App-install campaign objective is `OUTCOME_APP_PROMOTION`.

## Updating and deleting

Use `update_campaign`, `update_adset`, or `update_ad` with a `changes` object.
Set `status` to `ACTIVE`, `PAUSED`, or `DELETED` explicitly.

Meta dependencies are:

`campaign → ad set → ad → creative → image/video`

To fully remove old media, delete or detach child ads first, then delete creatives,
then call `delete_ad_image`. Deleting only a campaign may leave configured-active
children and creative references behind.

## Failure handling

- Permission error: verify token validity, `ads_management`, System User asset
  assignment, and that the ad account is `ACTIVE` rather than pending closure.
- Object rejected as outside allowlist: fix `META_AD_ACCOUNT_ID` or `META_PAGE_IDS`;
  do not weaken the guard for convenience.
- Activation refused: keep objects paused unless live activation was authorized;
  then set `META_ALLOW_ACTIVATION=true`.
- Image still used: locate hashes through account-wide `get_ad_creatives`, delete or
  detach the referencing ads, delete the creatives, then retry the image.
- Rate limit: honor Meta's retry guidance and reduce pagination size or call volume.

Official API entry points: [Marketing API setup](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started), [authentication](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authentication), and [permissions](https://developers.facebook.com/docs/permissions).

Apple Ads is separate; use the `asc-cli` skill.
