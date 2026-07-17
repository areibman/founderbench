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
#                Admin-role key. Prerequisites are checked here; the live proof
#                is verify.sh's signed archive.
if [[ -n "${APPLE_CERT_P12:-}" ]]; then
  must "codesigning identity present in build keychain (p12 mode)" \
    bash -c 'security find-identity -v -p codesigning founderbench.keychain-db | grep -q "valid identities found" && ! security find-identity -v -p codesigning founderbench.keychain-db | grep -q "0 valid"'
else
  must "cloud signing prerequisites (no p12: ASC key + APPLE_TEAM_ID)" \
    bash -c '[[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -f "${ASC_PRIVATE_KEY_PATH/#\~/$HOME}" ]]'
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
if [[ -n "${META_ACCESS_TOKEN:-}" && -n "${META_AD_ACCOUNT_ID:-}" ]]; then
  must "Meta Ads: configured ad account readable" \
    curl -sf --max-time 20 \
      "https://graph.facebook.com/${META_GRAPH_API_VERSION:-v25.0}/${META_AD_ACCOUNT_ID}?fields=id,name,account_status" \
      -H "Authorization: Bearer $META_ACCESS_TOKEN"
else
  fail "META_ACCESS_TOKEN/META_AD_ACCOUNT_ID not set"; FAILURES=$((FAILURES+1))
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
if [[ -n "${MEOW_API_TOKEN:-}" ]]; then
  must "meow: API key valid (get-my-entity via CLI)" \
    npx -y @joinmeow/cli get-my-entity --api-key "$MEOW_API_TOKEN"
else
  fail "MEOW_API_TOKEN not set — the agent's banking runs on the meow CLI with this key"; FAILURES=$((FAILURES+1))
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
