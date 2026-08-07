#!/usr/bin/env bash
# Stage 60: load credentials.env and verify EVERY credential with a live CLI call.
# Run as the agent user. Fails loudly per credential; exits non-zero if any required check fails.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_macos
require_not_root

[[ -f "$FB_CREDENTIALS" ]] || die "credentials.env not found. Copy configs/credentials.env.example to $FB_CREDENTIALS and fill it in."
load_credentials

FAILURES=0
must() {  # must <label> <command...>
  if ! check "$1" "${@:2}"; then FAILURES=$((FAILURES+1)); fi
}
should() {  # optional check — warns but doesn't fail the stage
  check "$1" "${@:2}" || warn "  (optional) $1 failed"
}

log "── Apple / App Store Connect (OPTIONAL — unprovisioned escape hatch) ──"
# iOS is no longer a provisioned lane. The toolchain (xcode, xcodebuild, asc,
# xcmcp) stays installed so an agent that decides an app is the right move can
# still build one, but we do not hand it App Store credentials or assume it
# wants them. Empty ASC_* is the expected default and must not fail the Mac.
asc_env() {
  export ASC_KEY_ID ASC_ISSUER_ID
  export ASC_PRIVATE_KEY_PATH
}
if [[ -n "${ASC_KEY_ID:-}" && -f "${ASC_PRIVATE_KEY_PATH/#\~/$HOME}" ]]; then
  asc_env
  should "asc: App Store Connect API reachable (asc apps list)" \
    asc apps list --limit 1
else
  log "  ASC_* not set — skipping (iOS is an escape hatch this block, not a lane)"
fi

log "── Signing (OPTIONAL — only meaningful if iOS is provisioned) ──"
# Two supported modes:
#   p12 mode   — APPLE_CERT_P12 set: a distribution identity must live in the
#                build keychain (imported by stage 50).
#   cloud mode — no p12: xcodebuild signs via the ASC API key
#                (-allowProvisioningUpdates -authenticationKey*). Requires an
#                Admin-role key.
# With neither configured the agent can still build and run in the simulator;
# it just cannot ship to a device or TestFlight.
if [[ -n "${APPLE_CERT_P12:-}" ]]; then
  should "codesigning identity present in build keychain (p12 mode)" \
    bash -c 'security find-identity -v -p codesigning founderbench.keychain-db | grep -q "valid identities found" && ! security find-identity -v -p codesigning founderbench.keychain-db | grep -q "0 valid"'
elif [[ -n "${ASC_KEY_ID:-}" ]]; then
  should "cloud signing prerequisites (no p12: ASC key + .p8 on disk)" \
    bash -c '[[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" && -f "${ASC_PRIVATE_KEY_PATH/#\~/$HOME}" ]]'
else
  log "  no p12 and no ASC key — simulator builds only, no device or TestFlight distribution"
fi

log "── Model provider ──"
if [[ -n "${MODEL_API_KEY:-}" && -n "${MODEL_UPSTREAM_URL:-}" && -n "${MODEL_ID:-}" ]]; then
  # The fleet spans access shapes (Azure deployment, OpenRouter, direct
  # provider keys on OpenAI-compat surfaces — see configs/arms/). Match the
  # proxy's per-host behavior: OpenAI/Azure reasoning models reject max_tokens
  # and demand max_completion_tokens; every other OpenAI-compatible upstream
  # takes plain max_tokens.
  case "$MODEL_UPSTREAM_URL" in
    *azure.com*|*api.openai.com*) TOK_FIELD="max_completion_tokens" ;;
    *)                            TOK_FIELD="max_tokens" ;;
  esac
  # Azure OpenAI v1 endpoint accepts Bearer; api-key is sent too so the check
  # also passes on older Azure api-version surfaces. Harmless elsewhere.
  # -sS --fail-with-body (not -sf): on an HTTP error the provider's JSON body
  # is the diagnosis (bad key, wrong region, unknown model) — print it.
  must "model API: chat completion round-trip ($MODEL_ID @ $MODEL_UPSTREAM_URL)" \
    curl -sS --fail-with-body --max-time 30 "$MODEL_UPSTREAM_URL/chat/completions" \
      -H "Authorization: Bearer $MODEL_API_KEY" \
      -H "api-key: $MODEL_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"$MODEL_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"$TOK_FIELD\":16}"
else
  fail "MODEL_API_KEY/MODEL_UPSTREAM_URL/MODEL_ID not set (per-arm block — see configs/arms/)"; FAILURES=$((FAILURES+1))
fi

log "── Browserbase (cloud browsers — CAPTCHA fallback) ──"
# Create a session and release it immediately. A key that authenticates but
# cannot start a session (wrong project, plan lapsed, concurrency exhausted) is
# exactly the failure we need to catch before a run, not during one.
if [[ -n "${BROWSERBASE_API_KEY:-}" && -n "${BROWSERBASE_PROJECT_ID:-}" ]]; then
  must "Browserbase: session create + release" bash -c '
    RESP=$(curl -s --max-time 45 -X POST "https://api.browserbase.com/v1/sessions" \
      -H "X-BB-API-Key: $BROWSERBASE_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"projectId\":\"$BROWSERBASE_PROJECT_ID\",\"timeout\":60}")
    SID=$(jq -r ".id // empty" <<<"$RESP")
    if [[ -z "$SID" ]]; then
      echo "session create rejected:"; echo "$RESP"; exit 1
    fi
    jq -e ".connectUrl" <<<"$RESP" >/dev/null || { echo "session has no connectUrl:"; echo "$RESP"; exit 1; }
    curl -s --max-time 20 -X POST "https://api.browserbase.com/v1/sessions/$SID" \
      -H "X-BB-API-Key: $BROWSERBASE_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"status\":\"REQUEST_RELEASE\"}" >/dev/null \
      || echo "release failed — session $SID will bill until its 60s timeout"'
  # Proxies are the main IP-reputation unblocker and they are plan-gated: a free
  # account 402s here. Report it at preflight rather than letting the agent
  # discover mid-run that its one escape route is billing-locked.
  should "Browserbase: residential proxies available on this plan" bash -c '
    RESP=$(curl -s --max-time 45 -X POST "https://api.browserbase.com/v1/sessions" \
      -H "X-BB-API-Key: $BROWSERBASE_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"projectId\":\"$BROWSERBASE_PROJECT_ID\",\"timeout\":60,\"proxies\":true}")
    SID=$(jq -r ".id // empty" <<<"$RESP")
    if [[ -z "$SID" ]]; then
      echo "proxies unavailable: $(jq -r ".message // ." <<<"$RESP")"
      echo "the agent gets a clean cloud IP but cannot change country or"
      echo "rotate away from a blocked address. Upgrade the plan to enable."
      exit 1
    fi
    curl -s --max-time 20 -X POST "https://api.browserbase.com/v1/sessions/$SID" \
      -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H "Content-Type: application/json" \
      -d "{\"status\":\"REQUEST_RELEASE\"}" >/dev/null || true'
else
  warn "BROWSERBASE_API_KEY/PROJECT_ID not set (credentials.env, or Inkbox vault secrets named BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID) — without them the CAPTCHA fallback is OUT of the tool surface this block (also remove the browserbase skill + charter mention)"
fi

log "── Inkbox (agent identity: email, vault, tunnel) ──"
# Per-agent isolation proof, same shape as the meow one-account assertion: an
# agent-scoped key sees only its own identity, so /identities returning
# anything other than exactly one means an admin-scoped key leaked onto this
# Mac and the agent can read and act as its siblings.
if [[ -n "${INKBOX_API_KEY:-}" ]]; then
  must "Inkbox: key valid (/api-keys/self) and agent-scoped" bash -c '
    RESP=$(curl -s --max-time 20 "https://inkbox.ai/api/v1/api-keys/self" \
      -H "X-API-Key: $INKBOX_API_KEY")
    jq -e ".scoped_identity_id // empty" <<<"$RESP" >/dev/null || {
      echo "this key is NOT agent-scoped (scoped_identity_id is null) — it is an"
      echo "admin key with org-wide authority. Mint an agent-scoped key bound to"
      echo "this Mac'\''s identity and use that instead."
      echo "$RESP"
      exit 1
    }'
  # GET /identities returns a bare array; an agent-scoped key sees only its own
  # identity plus any explicitly granted to it. More than one means this Mac can
  # read and act as a sibling arm.
  must "Inkbox: identities — exactly 1 visible, and it is \$INKBOX_AGENT_HANDLE" bash -c '
    IDS=$(curl -s --max-time 20 "https://inkbox.ai/api/v1/identities" \
      -H "X-API-Key: $INKBOX_API_KEY")
    N=$(jq -r "if type == \"array\" then length else -1 end" <<<"$IDS" 2>/dev/null || echo -1)
    if [[ "$N" != "1" ]]; then
      echo "expected exactly 1 visible identity, got: $N"
      echo "sibling agents are reachable — per-arm isolation is broken."
      jq -c "[.[]? | {handle: .agent_handle, email: .email_address}]" <<<"$IDS" 2>/dev/null || echo "$IDS"
      exit 1
    fi
    GOT=$(jq -r ".[0].agent_handle" <<<"$IDS")
    if [[ -n "${INKBOX_AGENT_HANDLE:-}" && "$GOT" != "${INKBOX_AGENT_HANDLE#@}" ]]; then
      echo "key is bound to \"$GOT\" but INKBOX_AGENT_HANDLE says \"$INKBOX_AGENT_HANDLE\""
      echo "this Mac was provisioned with another arm'\''s credentials."
      exit 1
    fi
    echo "identity: $GOT <$(jq -r ".[0].email_address" <<<"$IDS")>"'
  must "Inkbox: mailbox reachable (unread listing for \$INKBOX_AGENT_HANDLE)" bash -c '
    [[ -n "${INKBOX_AGENT_HANDLE:-}" ]] || { echo "INKBOX_AGENT_HANDLE not set — identity-scoped CLI commands need it"; exit 1; }
    inkbox email unread -i "$INKBOX_AGENT_HANDLE" --json >/dev/null'
  # The vault is what lets the agent hold its own logins and generate TOTP
  # codes, which is the difference between "can sign up" and "can sign back in".
  if [[ -n "${INKBOX_VAULT_KEY:-}" ]]; then
    must "Inkbox: vault unlocks with INKBOX_VAULT_KEY" \
      inkbox vault info --json
  else
    warn "INKBOX_VAULT_KEY not set — no credential store or TOTP generation; the agent will lose any account behind 2FA"
  fi
else
  fail "INKBOX_API_KEY not set — the agent has no mailbox, no vault, and no public URL"; FAILURES=$((FAILURES+1))
fi

log "── Stripe (payment processing) ──"
# The agent's own account inside the Stripe Organization. charges_enabled with
# an empty requirements.currently_due is the difference between an account that
# can take money and one that only looks like it can.
if [[ -n "${STRIPE_API_KEY:-}" ]]; then
  case "$STRIPE_API_KEY" in
    sk_org_*) fail "STRIPE_API_KEY is an ORG key — that grants this agent the whole fleet. Use the member account's own key."; FAILURES=$((FAILURES+1)) ;;
    rk_*)     warn "STRIPE_API_KEY is a RESTRICTED key — /v1/account may pass while payment_links, invoices, or payouts are silently forbidden mid-run. A standard sk_live_ key for this member account is safer." ;;
    sk_test_*) warn "STRIPE_API_KEY is a TEST key — the agent can build a checkout that never takes real money. Intentional only for a dry run." ;;
  esac
  must "Stripe: account live (charges_enabled, no outstanding requirements)" bash -c '
    RESP=$(curl -s --max-time 20 "https://api.stripe.com/v1/account" -u "$STRIPE_API_KEY:")
    jq -e ".id" <<<"$RESP" >/dev/null || { echo "key rejected:"; echo "$RESP"; exit 1; }
    CHARGES=$(jq -r ".charges_enabled" <<<"$RESP")
    DUE=$(jq -r "(.requirements.currently_due // []) | length" <<<"$RESP")
    if [[ "$CHARGES" != "true" || "$DUE" != "0" ]]; then
      echo "account $(jq -r ".id" <<<"$RESP") is not ready to accept payments:"
      echo "  charges_enabled: $CHARGES"
      echo "  requirements.currently_due: $(jq -c ".requirements.currently_due // []" <<<"$RESP")"
      echo "finish onboarding in the Stripe dashboard before the run — an agent"
      echo "cannot complete KYB on its own inside the window."
      exit 1
    fi'
else
  fail "STRIPE_API_KEY not set — the agent has no way to charge anyone (set it in credentials.env, or store an Inkbox vault secret named STRIPE_API_KEY)"; FAILURES=$((FAILURES+1))
fi

log "── Exa ──"
if [[ -n "${EXA_API_KEY:-}" ]]; then
  should "Exa: search API reachable" \
    curl -sf --max-time 20 "https://api.exa.ai/search" \
      -H "x-api-key: $EXA_API_KEY" -H "Content-Type: application/json" \
      -d '{"query":"ping","numResults":1}'
else
  warn "EXA_API_KEY not set (credentials.env, or an Inkbox vault secret named EXA_API_KEY)"
fi

log "── meow.com banking (REST API) ──"
# Run-block-2 decision: the CLI/MCP surface is DROPPED — dashboard-issued keys
# are REST-type and the MCP surface rejects them ("Invalid API key type for
# MCP operations"). The bank skill and these probes now target the REST API
# directly: https://api.meow.com/v1, x-api-key header. Probe every endpoint
# family the agent depends on, including the card-issuance WRITE path (the
# probe card is single-use with a $1 per-transaction limit and is revoked
# immediately).
#
# Multi-agent (parallel-Macs) model: every Mac runs a DIFFERENT model and gets
# its OWN account-restricted key. One shared business entity holds a treasury
# account plus one checking account per agent; each agent's key is created with
# "Restrict to one bank account" ON, so the key can only read and initiate
# transfers from that single account and cannot see or drain a sibling's. The
# account probe below therefore asserts EXACTLY ONE account is visible — that is
# the machine-checkable proof the restriction is actually enabled on this key
# (an unrestricted entity key would return all sibling accounts and silently
# break per-arm isolation). Seeding each account and sweeping leftovers is done
# with the treasury/admin key, orchestrator-side, never with this key.
if [[ -n "${MEOW_API_TOKEN:-}" ]]; then
  meow_api() {  # meow_api <method> <path> [json-body] — fails on non-2xx, prints body
    local METHOD="$1" APIPATH="$2" BODY="${3:-}" RESP CODE
    local ARGS=(-s --max-time 20 -X "$METHOD" -H "x-api-key: $MEOW_API_TOKEN" \
                -w $'\n%{http_code}' "https://api.meow.com/v1$APIPATH")
    [[ -n "$BODY" ]] && ARGS+=(-H "Content-Type: application/json" -d "$BODY")
    RESP=$(curl "${ARGS[@]}") || { echo "curl failed reaching api.meow.com"; return 1; }
    CODE=${RESP##*$'\n'}
    RESP=${RESP%$'\n'*}
    if [[ "$CODE" != 2* ]]; then
      echo "HTTP $CODE: $RESP"
      return 1
    fi
    printf '%s\n' "$RESP"
  }
  must "meow REST: key valid + scopes (/api-keys/current)" bash -c "$(declare -f meow_api); "'
    OUT=$(meow_api GET /api-keys/current) || { echo "$OUT"; exit 1; }
    echo "$OUT" | jq -c "{type: (.type // .key_type // \"?\"), scopes: (.scopes // [])}" 2>/dev/null || true'
  must "meow REST: accounts (/accounts) — restricted to exactly 1 account" bash -c "$(declare -f meow_api); "'
    ACCTS=$(meow_api GET /accounts) || { echo "$ACCTS"; exit 1; }
    # Per-agent keys must be created with "Restrict to one bank account" ON.
    # Count both response shapes (.accounts[] nested, or flat .data[]).
    N=$(jq -r "(.accounts // .data // []) | length" <<<"$ACCTS")
    if [[ "$N" != "1" ]]; then
      echo "expected exactly 1 visible account (account-restricted key), got: $N"
      echo "this key is NOT restricted to a single account — sibling agents are"
      echo "reachable and per-arm isolation is broken. Re-issue the key with"
      echo "\"Restrict to one bank account\" enabled for this agent'\''s account."
      jq -c "[(.accounts // .data // [])[] | {id: (.depositAccount.accountId // .id), nickname: (.nickname // .depositAccount.nickname // null)}]" <<<"$ACCTS"
      exit 1
    fi'
  must "meow REST: balances (/accounts/{id}/balances)" bash -c "$(declare -f meow_api); "'
    ACCTS=$(meow_api GET /accounts) || { echo "$ACCTS"; exit 1; }
    # /accounts nests the id: .accounts[].depositAccount.accountId (cash_account_...)
    AID=$(jq -r ".accounts[0].depositAccount.accountId // .data[0].id // empty" <<<"$ACCTS")
    [[ -n "$AID" ]] || { echo "no account id in /accounts response:"; echo "$ACCTS"; exit 1; }
    meow_api GET "/accounts/$AID/balances" >/dev/null'
  must "meow REST: cards (/cards)" bash -c "$(declare -f meow_api); "'
    meow_api GET /cards >/dev/null'
  must "meow REST: card transactions (/cards/transactions)" bash -c "$(declare -f meow_api); "'
    meow_api GET /cards/transactions >/dev/null'
  # The LIVE create-card schema is OLDER than the published OpenAPI spec: it
  # requires amount + merchant_name + task_description (the MCP-era shape),
  # not nickname + spending_controls. Send the union of both schemas so the
  # probe survives either vintage; unknown fields are ignored.
  must "meow REST: card issuance WRITE path (create + PAN reveal + revoke)" bash -c "$(declare -f meow_api); "'
    # purpose/task_description must be printable ASCII (^[ -~]+$) — the live
    # API 400s on anything else (an em dash cost us a verify cycle).
    OUT=$(meow_api POST /cards "{\"nickname\":\"fb-verify-probe\",\"amount\":1,\"merchant_name\":\"FounderBench verify\",\"task_description\":\"preflight write-path probe - revoked immediately\",\"spending_controls\":{\"per_transaction_limit\":1},\"single_use\":true,\"purpose\":\"preflight write-path probe - revoked immediately\"}") \
      || { echo "card create rejected:"; echo "$OUT"; exit 1; }
    CID=$(jq -r ".metadata.card_id // .card_id // .id // empty" <<<"$OUT")
    [[ -n "$CID" ]] || { echo "card created but no id in response:"; echo "$OUT"; exit 1; }
    # PAN reveal is what makes a card usable at checkout. The LIVE API returns
    # the PAN directly from POST /cards/{id}/pan; the published spec describes
    # a two-step reveal (grant -> GET reveal_url). Accept either shape. Only
    # key presence is checked; the PAN itself is never logged.
    PANFAIL=""
    GRANT=$(meow_api POST "/cards/$CID/pan") || PANFAIL="pan claim rejected: $GRANT"
    if [[ -z "$PANFAIL" ]]; then
      if jq -e ".card_number and .cvc" <<<"$GRANT" >/dev/null 2>&1; then
        : # live (one-step) shape — PAN + CVC present, done
      else
        RURL=$(jq -r ".reveal_url // empty" <<<"$GRANT")
        RTOK=$(jq -r ".reveal_token // empty" <<<"$GRANT")
        if [[ -n "$RURL" && -n "$RTOK" ]]; then
          PAN=$(curl -s --max-time 20 -H "x-api-key: $MEOW_API_TOKEN" \
            -H "Authorization: Bearer $RTOK" "$RURL")
          jq -e ".card_number and .cvc" <<<"$PAN" >/dev/null \
            || PANFAIL="reveal_url returned no card_number/cvc; keys: $(jq -c "keys? // ." <<<"$PAN")"
        else
          PANFAIL="pan response has neither card_number/cvc nor reveal_url/reveal_token; keys: $(jq -c "keys? // ." <<<"$GRANT")"
        fi
      fi
    fi
    meow_api POST "/cards/$CID/revoke" >/dev/null \
      || echo "revoke failed — probe card is single-use with a \$1 limit; revoke manually: POST /cards/$CID/revoke"
    [[ -z "$PANFAIL" ]] || { echo "$PANFAIL"; exit 1; }'
else
  fail "MEOW_API_TOKEN not set — the agent's banking runs on the meow REST API with this key (dashboard-issued, x-api-key header). Set it in credentials.env, or store an Inkbox vault secret named MEOW_API_TOKEN"; FAILURES=$((FAILURES+1))
fi

log "── OAuth-based MCPs (verified in stage 65) ──"
# No MCP on the current surface uses OAuth: exa authenticates with a header key
# and xcmcp/axmcp are local binaries. Stage 65 stays in the pipeline so that
# adding an OAuth MCP later has a home; this block only reports what is stored.
OAUTH_MCPS=()
if [[ ${#OAUTH_MCPS[@]} -eq 0 ]]; then
  ok "no OAuth MCPs on this surface — nothing to check"
else
  MCP_AUTH_FILE="$HOME/.local/share/opencode/mcp-auth.json"
  if [[ -f "$MCP_AUTH_FILE" ]]; then
    for server in "${OAUTH_MCPS[@]}"; do
      if jq -e --arg s "$server" 'has($s)' "$MCP_AUTH_FILE" >/dev/null 2>&1; then
        ok "opencode mcp auth: $server credentials stored"
      else
        warn "opencode mcp auth: $server not yet authorized (run stage 65)"
      fi
    done
  else
    warn "no OpenCode MCP auth store yet (run stage 65)"
  fi
fi

echo
if [[ $FAILURES -gt 0 ]]; then
  die "$FAILURES required credential check(s) FAILED — fix before running"
fi
log "Stage 60 complete — all required credentials verified"
