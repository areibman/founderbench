#!/usr/bin/env bash
# RevenueCat CLI wrapper (REST API v2). Used by the agent via the revenuecat-ops skill.
# Requires: REVENUECAT_API_KEY, REVENUECAT_PROJECT_ID (from credentials.env).
#
# Usage:
#   revenuecat.sh overview                     # MRR, active subs, trials
#   revenuecat.sh offerings                    # offerings + packages
#   revenuecat.sh products                     # configured products
#   revenuecat.sh customer <id>                # one customer's state
#   revenuecat.sh set-default-offering <id>    # paywall experiment
#   revenuecat.sh grant <customer> <entitlement> <duration>
#   revenuecat.sh revoke <customer> <entitlement>

set -euo pipefail

API="https://api.revenuecat.com/v2"
KEY="${REVENUECAT_API_KEY:?REVENUECAT_API_KEY not set}"
PROJECT="${REVENUECAT_PROJECT_ID:?REVENUECAT_PROJECT_ID not set}"

rc() { # rc <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  local args=(-sf --max-time 30 -X "$method" "$API$path"
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json")
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}"
}

# Log the call into the run trace if available (structured side-effect event).
trace() {
  [[ -n "${FB_TRACE_DIR:-}" && -d "${FB_TRACE_DIR:-}" ]] || return 0
  printf '{"ts":%s,"type":"tool.revenuecat","source":"tools","data":{"cmd":%s}}\n' \
    "$(date +%s)000" "$(printf '%s' "$*" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    >> "$FB_TRACE_DIR/trace.jsonl" 2>/dev/null || true
}

cmd="${1:?usage: revenuecat.sh <overview|offerings|products|customer|set-default-offering|grant|revoke> ...}"
trace "$@"

case "$cmd" in
  overview)
    rc GET "/projects/$PROJECT/metrics/overview" | jq .
    ;;
  offerings)
    rc GET "/projects/$PROJECT/offerings?expand=items.package" | jq .
    ;;
  products)
    rc GET "/projects/$PROJECT/products" | jq .
    ;;
  customer)
    id="${2:?customer id required}"
    rc GET "/projects/$PROJECT/customers/$id?expand=attributes,active_entitlements" | jq .
    ;;
  set-default-offering)
    offering="${2:?offering id required}"
    rc POST "/projects/$PROJECT/offerings/$offering/actions/set_default" "{}" | jq .
    ;;
  grant)
    customer="${2:?customer id}"; ent="${3:?entitlement id}"; dur="${4:?duration (e.g. monthly, lifetime)}"
    rc POST "/projects/$PROJECT/customers/$customer/entitlements/$ent/actions/grant" \
      "{\"duration\":\"$dur\"}" | jq .
    ;;
  revoke)
    customer="${2:?customer id}"; ent="${3:?entitlement id}"
    rc POST "/projects/$PROJECT/customers/$customer/entitlements/$ent/actions/revoke" "{}" | jq .
    ;;
  *)
    echo "unknown command: $cmd" >&2; exit 1
    ;;
esac
