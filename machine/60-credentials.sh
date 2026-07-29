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

log "── Apple / App Store Connect ──"
asc_env() {
  export ASC_KEY_ID ASC_ISSUER_ID
  export ASC_PRIVATE_KEY_PATH
}
if [[ -n "${ASC_KEY_ID:-}" && -f "${ASC_PRIVATE_KEY_PATH/#\~/$HOME}" ]]; then
  asc_env
  must "asc: App Store Connect API reachable (asc apps list)" \
    asc apps list --limit 1
else
  fail "ASC_KEY_ID/ASC_PRIVATE_KEY_PATH not configured"; FAILURES=$((FAILURES+1))
fi

log "── Signing ──"
# Two supported modes:
#   p12 mode   — APPLE_CERT_P12 set: a distribution identity must live in the
#                build keychain (imported by stage 50).
#   cloud mode — no p12: xcodebuild signs via the ASC API key
#                (-allowProvisioningUpdates -authenticationKey*). Requires an
#                Admin-role key. APPLE_TEAM_ID is optional — the agent (or the
#                Xcode project) can resolve it; we only gate on the ASC key.
if [[ -n "${APPLE_CERT_P12:-}" ]]; then
  must "codesigning identity present in build keychain (p12 mode)" \
    bash -c 'security find-identity -v -p codesigning founderbench.keychain-db | grep -q "valid identities found" && ! security find-identity -v -p codesigning founderbench.keychain-db | grep -q "0 valid"'
else
  must "cloud signing prerequisites (no p12: ASC key + .p8 on disk)" \
    bash -c '[[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" && -f "${ASC_PRIVATE_KEY_PATH/#\~/$HOME}" ]]'
fi

log "── Model provider ──"
if [[ -n "${MODEL_API_KEY:-}" && -n "${MODEL_UPSTREAM_URL:-}" && -n "${MODEL_ID:-}" ]]; then
  # Azure OpenAI v1 endpoint accepts Bearer; api-key is sent too so the check
  # also passes on older Azure api-version surfaces. Harmless elsewhere.
  must "model API: chat completion round-trip ($MODEL_ID)" \
    curl -sf --max-time 30 "$MODEL_UPSTREAM_URL/chat/completions" \
      -H "Authorization: Bearer $MODEL_API_KEY" \
      -H "api-key: $MODEL_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"$MODEL_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_completion_tokens\":16}"
else
  fail "MODEL_API_KEY/MODEL_UPSTREAM_URL/MODEL_ID not set"; FAILURES=$((FAILURES+1))
fi

log "── RevenueCat ──"
if [[ -n "${REVENUECAT_API_KEY:-}" && -n "${REVENUECAT_PROJECT_ID:-}" ]]; then
  must "RevenueCat: project readable" \
    curl -sf --max-time 15 "https://api.revenuecat.com/v2/projects/$REVENUECAT_PROJECT_ID" \
      -H "Authorization: Bearer $REVENUECAT_API_KEY"
else
  warn "REVENUECAT_API_KEY/PROJECT_ID not set (required before pilot, optional for machine setup)"
fi

log "── Meta Ads (direct Graph API) ──"
# Token optional as of run block 2: pilot 1 hit a dev-mode/access wall the read
# probe below never caught (listing ad accounts worked; every write was
# rejected). If Meta is provisioned it must now prove WRITE capability —
# create a PAUSED campaign, then delete it — because that is what the agent
# actually needs. If Meta is deliberately out of the tool surface for this
# block, leave META_ACCESS_TOKEN unset AND remove the meta-ads skill + charter
# mention so the agent isn't handed a dead affordance.
if [[ -n "${META_ACCESS_TOKEN:-}" ]]; then
  must "Meta Ads: token can list ad accounts" \
    curl -sf --max-time 20 \
      "https://graph.facebook.com/${META_GRAPH_API_VERSION:-v25.0}/me/adaccounts?fields=id,name&limit=1" \
      -H "Authorization: Bearer $META_ACCESS_TOKEN"
  must "Meta Ads: WRITE path (create+delete PAUSED probe campaign)" bash -c '
    GV="${META_GRAPH_API_VERSION:-v25.0}"
    ACCT="${META_AD_ACCOUNT_ID:-}"
    if [[ -z "$ACCT" ]]; then
      ACCT=$(curl -sf --max-time 20 \
        "https://graph.facebook.com/$GV/me/adaccounts?fields=id&limit=1" \
        -H "Authorization: Bearer $META_ACCESS_TOKEN" | jq -r ".data[0].id // empty")
    fi
    [[ -n "$ACCT" ]] || { echo "no ad account discoverable"; exit 1; }
    RESP=$(curl -sf --max-time 30 -X POST \
      "https://graph.facebook.com/$GV/$ACCT/campaigns" \
      -H "Authorization: Bearer $META_ACCESS_TOKEN" \
      -d "name=founderbench-verify-probe" \
      -d "objective=OUTCOME_APP_PROMOTION" \
      -d "status=PAUSED" \
      -d "special_ad_categories=[]") || { echo "campaign create rejected — dev-mode/access-tier wall"; exit 1; }
    CID=$(jq -r ".id // empty" <<<"$RESP")
    [[ -n "$CID" ]] || { echo "create returned no id: $RESP"; exit 1; }
    curl -sf --max-time 20 -X DELETE \
      "https://graph.facebook.com/$GV/$CID" \
      -H "Authorization: Bearer $META_ACCESS_TOKEN" >/dev/null'
else
  warn "META_ACCESS_TOKEN not set — Meta is OUT of the tool surface this block (also remove the meta-ads skill + charter mention)"
fi

log "── Fastmail (JMAP) ──"
if [[ -n "${FASTMAIL_JMAP_TOKEN:-}" ]]; then
  must "Fastmail: JMAP session fetch" \
    curl -sf --max-time 15 "https://api.fastmail.com/jmap/session" \
      -H "Authorization: Bearer $FASTMAIL_JMAP_TOKEN"
else
  fail "FASTMAIL_JMAP_TOKEN not set"; FAILURES=$((FAILURES+1))
fi

log "── Exa ──"
if [[ -n "${EXA_API_KEY:-}" ]]; then
  should "Exa: search API reachable" \
    curl -sf --max-time 20 "https://api.exa.ai/search" \
      -H "x-api-key: $EXA_API_KEY" -H "Content-Type: application/json" \
      -d '{"query":"ping","numResults":1}'
else
  warn "EXA_API_KEY not set (exa MCP can also use OAuth; token recommended)"
fi

log "── meow.com banking ──"
# Pilot 1 lesson: a valid key does NOT mean the account's endpoints are
# enabled — meow support had to enable one mid-run. Probe every endpoint
# family the agent depends on, including the card-issuance WRITE path (the
# probe card is single-use, $0.01, expires in 5 minutes, and is revoked
# immediately — it self-cleans even if the revoke fails).
if [[ -n "${MEOW_API_TOKEN:-}" ]]; then
  MEOW="npx -y @joinmeow/cli"
  must "meow: API key valid (get-my-entity)" \
    $MEOW get-my-entity --api-key "$MEOW_API_TOKEN"
  must "meow: accounts endpoint (list-bank-accounts)" \
    $MEOW list-bank-accounts --api-key "$MEOW_API_TOKEN"
  must "meow: balances endpoint (get-account-balances)" \
    $MEOW get-account-balances --api-key "$MEOW_API_TOKEN"
  must "meow: cards endpoint (list-cards)" \
    $MEOW list-cards --api-key "$MEOW_API_TOKEN"
  must "meow: card transactions endpoint (list-card-transactions)" \
    $MEOW list-card-transactions --api-key "$MEOW_API_TOKEN"
  must "meow: card issuance WRITE path (create + revoke probe card)" bash -c '
    OUT=$(npx -y @joinmeow/cli create-card --api-key "$MEOW_API_TOKEN" \
      --amount-cents 1 --merchant-name "FounderBench verify" \
      --task-description "preflight write-path probe" \
      --expires-in-minutes 5 --single-use true) || { echo "create-card rejected — endpoint not enabled for this account"; exit 1; }
    CID=$(grep -oE "\"(card_)?id\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" <<<"$OUT" | head -1 | sed -E "s/.*:[[:space:]]*\"([^\"]+)\"/\1/")
    [[ -n "$CID" ]] || { echo "no card id in create-card output"; exit 1; }
    npx -y @joinmeow/cli revoke-card --api-key "$MEOW_API_TOKEN" --card-id "$CID" \
      || echo "revoke failed — probe card self-expires in 5 min"'
else
  fail "MEOW_API_TOKEN not set — the agent's banking runs on the meow CLI with this key"; FAILURES=$((FAILURES+1))
fi

log "── AgentCard (virtual Visa cards) ──"
# Pilot 1 lesson: AgentCard got de-authed mid-run and nothing had checked it.
# Auth is a stored login session (agent-cards CLI / AgentCard MCP), not an env
# credential — if these fail, re-login interactively on this machine
# (`agent-cards` CLI) and re-auth the MCP, then re-run this stage. Only the
# non-interactive commands are used here (whoami, cards list).
if command -v agent-cards >/dev/null 2>&1; then
  must "agent-cards: session authenticated (whoami)" \
    agent-cards whoami
  must "agent-cards: cards endpoint (cards list)" \
    agent-cards cards list
else
  warn "agent-cards CLI not installed — AgentCard is OUT of the tool surface this block (also remove the agent-card skill + charter mention)"
fi

log "── OAuth-based MCPs (verified in stage 65) ──"
MCP_AUTH_FILE="$HOME/.local/share/opencode/mcp-auth.json"
if [[ -f "$MCP_AUTH_FILE" ]]; then
  for server in fastmail; do
    if jq -e --arg s "$server" 'has($s)' "$MCP_AUTH_FILE" >/dev/null 2>&1; then
      ok "opencode mcp auth: $server credentials stored"
    else
      warn "opencode mcp auth: $server not yet authorized (run stage 65)"
    fi
  done
else
  warn "no OpenCode MCP auth store yet (run stage 65)"
fi

echo
if [[ $FAILURES -gt 0 ]]; then
  die "$FAILURES required credential check(s) FAILED — fix before running"
fi
log "Stage 60 complete — all required credentials verified"
