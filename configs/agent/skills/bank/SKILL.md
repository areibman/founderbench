---
name: bank
version: 1.0.0
description: "Meow business banking via the REST API: accounts, balances, transactions, virtual cards, ACH/wire/book/USDC transfers, contacts, and invoicing. Use when the user wants to check balances, review transactions, issue or revoke virtual cards, send payments, or create invoices."
tags: [fintech, banking, payments, rest-api, cards, invoicing]
metadata:
  openclaw:
    emoji: "🐱"
    homepage: https://www.meow.com
---

# Meow (REST API)

Your bank is a Meow business account, operated **directly through the REST
API** with `curl` + `jq`. There is no CLI and no MCP server in this setup —
the API is the whole surface.

## Authentication

- Base URL: `https://api.meow.com/v1`
- Every request: header `x-api-key: $MEOW_API_TOKEN` (pre-provisioned).
- Multi-entity keys: add `x-entity-id: <entity_id>` to scope a request.

```bash
MEOW="https://api.meow.com/v1"
auth=(-H "x-api-key: $MEOW_API_TOKEN")

# Who am I / what can this key do (type + scopes)?
curl -s "${auth[@]}" "$MEOW/api-keys/current" | jq
# Which entities can it reach (for x-entity-id)?
curl -s "${auth[@]}" "$MEOW/api-keys/accessible-entities" | jq
```

If a call returns 401/403, check `/api-keys/current` first — the key may lack
the scope for that endpoint. Report exactly which scope is missing.

## Accounts, balances, transactions

Account ids are nested in the list response:
`.accounts[].depositAccount.accountId` (they look like `cash_account_<uuid>`).

```bash
curl -s "${auth[@]}" "$MEOW/accounts" | jq                          # list accounts
ACCOUNT_ID=$(curl -s "${auth[@]}" "$MEOW/accounts" \
  | jq -r '.accounts[0].depositAccount.accountId')
curl -s "${auth[@]}" "$MEOW/accounts/$ACCOUNT_ID" | jq              # one account
curl -s "${auth[@]}" "$MEOW/accounts/$ACCOUNT_ID/balances" | jq     # balances
curl -s "${auth[@]}" "$MEOW/accounts/$ACCOUNT_ID/transactions" | jq # transactions
```

## Virtual cards

```bash
curl -s "${auth[@]}" "$MEOW/cards" | jq                    # list cards
curl -s "${auth[@]}" "$MEOW/cards/transactions" | jq       # card transactions
curl -s "${auth[@]}" "$MEOW/cards/$CARD_ID/limits" | jq    # limits + remaining

# Create a virtual card. CAUTION: the LIVE schema is older than the published
# docs — it requires amount (USD), merchant_name, and task_description, while
# the docs describe nickname + spending_controls. Send the union of both;
# unknown fields are ignored. If a 400 names a missing field, add it and retry.
# single_use defaults to true (auto-revokes after first authorization).
# The card id is at .metadata.card_id (or .card_id) in the response.
curl -s "${auth[@]}" -H "Content-Type: application/json" \
  -X POST "$MEOW/cards" -d '{
    "nickname": "meta-ads-jul",
    "amount": 50,
    "merchant_name": "Meta Ads",
    "task_description": "Meta ads budget for July",
    "spending_controls": { "per_transaction_limit": 50, "monthly_limit": 100 },
    "single_use": false,
    "purpose": "Meta ads budget for July"
  }' | jq

# Full card number for checkout (PAN + CVC + expiry). The LIVE API returns it
# directly in ONE call:
curl -s "${auth[@]}" -X POST "$MEOW/cards/$CARD_ID/pan" | jq
# → { "card_number": "...", "cvc": "...", "exp_month": n, "exp_year": n }
#
# (The published docs describe a newer two-step flow instead — the POST returns
# {reveal_url, reveal_token} and you GET the reveal_url with both the api key
# and "Authorization: Bearer <reveal_token>". If the response ever has
# reveal_url instead of card_number, do that second step.)
# Handle the PAN carefully: use it at the checkout, do not write it to files.

# Freeze / unfreeze / change limits:
curl -s "${auth[@]}" -H "Content-Type: application/json" \
  -X PATCH "$MEOW/cards/$CARD_ID" -d '{"status":"frozen"}' | jq

# Revoke immediately:
curl -s "${auth[@]}" -X POST "$MEOW/cards/$CARD_ID/revoke" | jq
```

To restrict a card to specific merchants, look them up first with
`GET /cards/merchants?query=<name>` and pass their ids as
`spending_restriction`.

## Transfers (real money — verify before sending)

Transfers need a contact (counterparty) first. Amounts are USD. Send an
`Idempotency-Key` header on every money-moving POST so a retry can't
double-pay.

```bash
curl -s "${auth[@]}" "$MEOW/contacts" | jq                 # find counterparty_id
# Create one if needed: POST /contacts with ACH, wire, check, or USDC details.

# ACH:
curl -s "${auth[@]}" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -X POST "$MEOW/accounts/$ACCOUNT_ID/ach" -d '{
    "amount": 25.00,
    "counterparty_id": "'"$CONTACT_ID"'",
    "description": "invoice 42"
  }' | jq

# Same shape for: /wire, /book (internal between own accounts),
# /crypto (USDC — destination from a crypto contact).
# Check status: GET /accounts/$ACCOUNT_ID/achs/$TRANSFER_ID (wires/{id} for wires).
```

Daily withdrawal cap: `GET /limits/daily-withdrawal` shows the cap and what's
left today; `PUT` the same path adjusts it (whole dollars; 0 blocks all
outbound transfers).

## Invoicing (collect revenue)

```bash
curl -s "${auth[@]}" "$MEOW/billing/invoices" | jq         # list invoices
# Flow: POST /billing/products → POST /billing/customers →
#       POST /billing/invoices (line items reference product ids).
# GET /billing/collection-accounts — where paid invoices land.
```

## Error handling

| Response | Action |
| -------- | ------ |
| 401 | Key invalid/expired — check `/api-keys/current`; a new key must come from the Meow dashboard |
| 403 | Key lacks the scope for this endpoint — report which scope |
| 400 | Read the JSON error body, fix the field, retry |
| 429 | Back off and retry after a delay |
| 5xx | Retry once after a delay |

Never invent required fields; if something is missing (contact details,
account id), look it up first.

## Full reference

- Docs index (fetchable): https://developer.meow.com/llms.txt
- OpenAPI spec: https://developer.meow.com/openapi.yaml
- Errors reference: https://developer.meow.com/errors.md
