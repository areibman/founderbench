#!/usr/bin/env bash
# Fastmail JMAP helper — scriptable path for the ORCHESTRATOR's independent inbox
# monitoring and metrics (the agent itself uses the fastmail MCP).
# Requires: FASTMAIL_JMAP_TOKEN.
#
# Usage:
#   fastmail-jmap.sh session          # verify token / fetch session
#   fastmail-jmap.sh unread-count     # number of unread messages in the inbox
#   fastmail-jmap.sh recent [n]       # subject lines of n most recent messages

set -euo pipefail

TOKEN="${FASTMAIL_JMAP_TOKEN:?FASTMAIL_JMAP_TOKEN not set}"
API="https://api.fastmail.com/jmap/api/"
SESSION_URL="https://api.fastmail.com/jmap/session"

session() { curl -sf --max-time 15 "$SESSION_URL" -H "Authorization: Bearer $TOKEN"; }

account_id() { session | jq -r '.primaryAccounts["urn:ietf:params:jmap:mail"]'; }

jmap() { # jmap <method-calls-json>
  curl -sf --max-time 30 "$API" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":$1}"
}

cmd="${1:?usage: fastmail-jmap.sh <session|unread-count|recent> ...}"

case "$cmd" in
  session)
    session | jq '{username, apiUrl, primaryAccounts}'
    ;;
  unread-count)
    acct="$(account_id)"
    jmap "[[\"Mailbox/query\",{\"accountId\":\"$acct\",\"filter\":{\"role\":\"inbox\"}},\"0\"],
          [\"Mailbox/get\",{\"accountId\":\"$acct\",\"#ids\":{\"resultOf\":\"0\",\"name\":\"Mailbox/query\",\"path\":\"/ids\"},\"properties\":[\"unreadEmails\"]},\"1\"]]" \
      | jq -r '.methodResponses[1][1].list[0].unreadEmails'
    ;;
  recent)
    n="${2:-10}"
    acct="$(account_id)"
    jmap "[[\"Email/query\",{\"accountId\":\"$acct\",\"sort\":[{\"property\":\"receivedAt\",\"isAscending\":false}],\"limit\":$n},\"0\"],
          [\"Email/get\",{\"accountId\":\"$acct\",\"#ids\":{\"resultOf\":\"0\",\"name\":\"Email/query\",\"path\":\"/ids\"},\"properties\":[\"subject\",\"from\",\"receivedAt\",\"keywords\"]},\"1\"]]" \
      | jq -r '.methodResponses[1][1].list[] | "\(.receivedAt)  \(.from[0].email // "?")  \(.subject)"'
    ;;
  *)
    echo "unknown command: $cmd" >&2; exit 1
    ;;
esac
