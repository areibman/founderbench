#!/usr/bin/env bash
# Stage 40: pre-grant TCC privacy permissions so no dialog ever appears mid-run.
# Run as root (sudo).
#
# Two macOS gates block unattended automation:
#   1. TCC (privacy): Accessibility, Full Disk Access, Screen Recording, AppleEvents.
#      Pre-granted here by writing TCC.db directly (system db requires SIP relaxation
#      on this dedicated box) — or deliver a PPPC profile via MDM if enrolled.
#   2. Authorization Services (UI-automation mode): handled by `automationmodetool`.
#
# Reference: system db is SIP-protected; check `csrutil status`. On this appliance we
# accept SIP relaxation as a deliberate tradeoff (documented in docs/mac-checklist.md).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_macos
require_root

AGENT_USER="${SUDO_USER:-$(stat -f%Su /dev/console)}"
AGENT_HOME="$(dscl . -read "/Users/$AGENT_USER" NFSHomeDirectory | awk '{print $2}')"
USER_TCC="$AGENT_HOME/Library/Application Support/com.apple.TCC/TCC.db"
SYS_TCC="/Library/Application Support/com.apple.TCC/TCC.db"

# Binaries that need TCC grants. Paths resolved for the agent user.
resolve() { sudo -u "$AGENT_USER" -H bash -lc "command -v $1" 2>/dev/null || true; }

CLIENTS=()
for cmd in axmcp xcmcp ax xc computer-use-mcp peekaboo opencode node; do
  p="$(resolve "$cmd")"
  [[ -n "$p" ]] && CLIENTS+=("$p")
done
CLIENTS+=("/Applications/Utilities/Terminal.app" "/System/Applications/Utilities/Terminal.app")

log "TCC clients to grant: ${#CLIENTS[@]} binaries"

sip_relaxed() { csrutil status 2>/dev/null | grep -qi "disabled"; }

# Insert one TCC grant. Schema (macOS 15+, 17 columns) — INSERT positionally.
#   service, client, client_type(1=path), auth_value(2=allow), auth_reason, auth_version,
#   csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier,
#   indirect_object_code_identity, flags, last_modified, pid, pid_version, boot_uuid, last_reminded
tcc_grant() {
  local db="$1" service="$2" client="$3" indirect="${4:-UNUSED}"
  sqlite3 "$db" "INSERT OR REPLACE INTO access VALUES(
    '$service','$client',1,2,0,1,
    NULL,NULL,0,'$indirect',
    NULL,NULL,strftime('%s','now'),
    NULL,NULL,'UNUSED',strftime('%s','now'));" 2>/dev/null
}

grant_all() {
  local db="$1" scope="$2"
  local granted=0
  for client in "${CLIENTS[@]}"; do
    [[ -e "$client" ]] || continue
    for service in kTCCServiceAccessibility kTCCServiceScreenCapture kTCCServiceAppleEvents kTCCServiceSystemPolicyAllFiles kTCCServiceDeveloperTool; do
      # AppleEvents needs an indirect object (target app); grant System Events broadly.
      if [[ "$service" == "kTCCServiceAppleEvents" ]]; then
        tcc_grant "$db" "$service" "$client" "com.apple.systemevents" && granted=$((granted+1)) || true
      else
        tcc_grant "$db" "$service" "$client" && granted=$((granted+1)) || true
      fi
    done
  done
  ok "$scope TCC.db: $granted grants written"
}

log "Writing user TCC grants"
if [[ -f "$USER_TCC" ]]; then
  grant_all "$USER_TCC" "user"
else
  warn "user TCC.db not found at $USER_TCC (log in as $AGENT_USER once first)"
fi

log "Writing system TCC grants (Accessibility/Screen Recording/FDA live here)"
if sip_relaxed; then
  grant_all "$SYS_TCC" "system"
else
  warn "SIP is enabled — cannot write system TCC.db."
  warn "Options:"
  warn "  a) boot to Recovery, run 'csrutil disable', re-run this stage (accepted tradeoff on this appliance)"
  warn "  b) enroll in MDM and push a PPPC profile granting these services"
  warn "  c) grant manually in System Settings → Privacy & Security for each binary listed above"
fi

log "Restarting tccd so grants take effect"
launchctl kickstart -k system/com.apple.tccd 2>/dev/null || true
AGENT_UID="$(id -u "$AGENT_USER")"
launchctl kickstart -k "gui/$AGENT_UID/com.apple.tccd" 2>/dev/null || true
ok "tccd restarted"

log "Enabling UI-automation mode (Authorization Services gate)"
if command -v automationmodetool >/dev/null 2>&1; then
  automationmodetool enable-automationmode-without-authentication 2>/dev/null \
    && ok "automation mode enabled without authentication" \
    || warn "automationmodetool failed — run manually: sudo automationmodetool enable-automationmode-without-authentication"
else
  warn "automationmodetool not found (ships with Xcode); re-run after Xcode install"
fi

log "Verifying grants (spot check)"
if [[ -f "$USER_TCC" ]]; then
  sqlite3 "$USER_TCC" "SELECT service, client, auth_value FROM access WHERE client LIKE '%axmcp%' OR client LIKE '%opencode%' LIMIT 10;" 2>/dev/null || true
fi

log "Stage 40 complete"
