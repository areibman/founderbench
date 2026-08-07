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
  # if-form, not `[[ ]] &&`: under set -e a failing && chain as the last loop
  # statement kills the whole script the first time something is not installed
  if [[ -n "$p" ]]; then CLIENTS+=("$p"); fi
done
CLIENTS+=("/Applications/Utilities/Terminal.app" "/System/Applications/Utilities/Terminal.app")

log "TCC clients to grant: ${#CLIENTS[@]} binaries"

# GUI run-wrapper apps. TCC attributes an automation/capture request to the
# *responsible* process — the app that owns the session the agent runs under
# (the terminal or multiplexer), NOT the CLI binary underneath it. So the app
# hosting the run must itself hold Accessibility / Screen Recording / Input
# Monitoring, or macOS pops a first-run dialog the moment the agent drives the
# GUI. That is the "cmux.app would like to control this computer" prompt.
#
# Every app that could host or front a run belongs here. Extend the list per
# deployment with FB_TCC_APPS (colon-separated names or absolute .app paths;
# names may contain spaces), e.g. FB_TCC_APPS="cmux:/Applications/MyRunner.app".
DEFAULT_APPS=(
  cmux Terminal iTerm Ghostty WezTerm kitty Alacritty Warp
  "Visual Studio Code" Cursor "Google Chrome"
)
EXTRA_APPS=()
if [[ -n "${FB_TCC_APPS:-}" ]]; then
  IFS=':' read -r -a EXTRA_APPS <<< "${FB_TCC_APPS}"
fi

APP_BUNDLES=()
resolve_app() {  # bare name -> first matching bundle; absolute path passed through
  local q="$1" base
  if [[ "$q" == /* && -d "$q" ]]; then APP_BUNDLES+=("$q"); return 0; fi
  for base in "/Applications" "/Applications/Utilities" "/System/Applications/Utilities" "$AGENT_HOME/Applications"; do
    if [[ -d "$base/$q.app" ]]; then APP_BUNDLES+=("$base/$q.app"); return 0; fi
  done
  # Not installed is fine — but return 0 explicitly, or under set -e the first
  # absent app (e.g. no iTerm) exits the script before any grant is written.
  # That silent death is exactly what happened on hb-41.
  return 0
}
for a in "${DEFAULT_APPS[@]}" ${EXTRA_APPS+"${EXTRA_APPS[@]}"}; do
  [[ -n "$a" ]] || continue
  resolve_app "$a"
done

bundle_id() {  # best-effort CFBundleIdentifier for an .app path
  /usr/bin/defaults read "$1/Contents/Info" CFBundleIdentifier 2>/dev/null \
    || /usr/bin/mdls -name kMDItemCFBundleIdentifier -raw "$1" 2>/dev/null
}

log "GUI run-wrapper apps found on disk: ${#APP_BUNDLES[@]}"

sip_relaxed() { csrutil status 2>/dev/null | grep -qi "disabled"; }

# Insert one TCC grant. Schema (macOS 15+, 17 columns) — INSERT positionally.
#   service, client, client_type(1=path), auth_value(2=allow), auth_reason, auth_version,
#   csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier,
#   indirect_object_code_identity, flags, last_modified, pid, pid_version, boot_uuid, last_reminded
# client_type: 1 = absolute path (CLI binaries), 0 = bundle identifier (the form
# tccd uses to key GUI .app bundles). Default 1 preserves prior behaviour.
tcc_grant() {
  local db="$1" service="$2" client="$3" indirect="${4:-UNUSED}" ctype="${5:-1}"
  sqlite3 "$db" "INSERT OR REPLACE INTO access VALUES(
    '$service','$client',$ctype,2,0,1,
    NULL,NULL,0,'$indirect',
    NULL,NULL,strftime('%s','now'),
    NULL,NULL,'UNUSED',strftime('%s','now'));" 2>/dev/null
}

# Services every hosting surface may need for unattended GUI automation.
# kTCCServiceListenEvent is Input Monitoring — required for synthetic keyboard
# input and event taps (peekaboo, and GUI wrappers that read the event stream);
# it was the one commonly-missing grant behind mid-run input dialogs.
#
# The per-FOLDER services matter even though SystemPolicyAllFiles (FDA) is
# granted above them: FDA lives ONLY in the system TCC.db, so with SIP enabled
# it never lands — and macOS then falls back to per-folder prompts the first
# time anything under the app touches ~/Downloads etc. ("cmux would like to
# access files in your Downloads folder", observed mid-run when the git shadow
# scanned ~). Folder grants live in the USER TCC.db, writable regardless of
# SIP, so they close that prompt class on every machine.
FOLDER_SERVICES=(
  kTCCServiceSystemPolicyDownloadsFolder
  kTCCServiceSystemPolicyDesktopFolder
  kTCCServiceSystemPolicyDocumentsFolder
  kTCCServiceSystemPolicyNetworkVolumes
  kTCCServiceSystemPolicyRemovableVolumes
)
APP_SERVICES=(kTCCServiceAccessibility kTCCServiceScreenCapture kTCCServiceListenEvent kTCCServiceAppleEvents kTCCServiceSystemPolicyAllFiles "${FOLDER_SERVICES[@]}")

grant_all() {
  local db="$1" scope="$2"
  local granted=0
  for client in "${CLIENTS[@]}"; do
    [[ -e "$client" ]] || continue
    for service in kTCCServiceAccessibility kTCCServiceScreenCapture kTCCServiceListenEvent kTCCServiceAppleEvents kTCCServiceSystemPolicyAllFiles kTCCServiceDeveloperTool "${FOLDER_SERVICES[@]}"; do
      # AppleEvents needs an indirect object (target app); grant System Events broadly.
      if [[ "$service" == "kTCCServiceAppleEvents" ]]; then
        tcc_grant "$db" "$service" "$client" "com.apple.systemevents" && granted=$((granted+1)) || true
      else
        tcc_grant "$db" "$service" "$client" && granted=$((granted+1)) || true
      fi
    done
  done
  if [[ $granted -gt 0 ]]; then
    ok "$scope TCC.db: $granted grants written"
  else
    warn "$scope TCC.db: 0 grants written — inserts are failing (db access or schema mismatch)"
  fi
}

# Grant GUI wrapper apps by BOTH bundle id (client_type 0, how tccd keys apps)
# and bundle path (client_type 1, belt-and-suspenders) across every service.
grant_apps() {
  local db="$1" scope="$2"
  local granted=0 app bid indirect
  for app in ${APP_BUNDLES+"${APP_BUNDLES[@]}"}; do
    [[ -d "$app" ]] || continue
    bid="$(bundle_id "$app")" || bid=""
    for service in "${APP_SERVICES[@]}"; do
      indirect="UNUSED"
      [[ "$service" == "kTCCServiceAppleEvents" ]] && indirect="com.apple.systemevents"
      if [[ -n "$bid" ]]; then
        tcc_grant "$db" "$service" "$bid" "$indirect" 0 && granted=$((granted+1)) || true
      fi
      tcc_grant "$db" "$service" "$app" "$indirect" 1 && granted=$((granted+1)) || true
    done
  done
  if [[ $granted -gt 0 ]]; then
    ok "$scope TCC.db: $granted app grants written (${#APP_BUNDLES[@]} apps)"
  else
    warn "$scope TCC.db: 0 app grants written — inserts are failing (db access or schema mismatch)"
  fi
}

# SIP is THE lever for this whole stage. TCC.db (both user and system) is
# SIP-protected: with SIP ENABLED, even root cannot write it unless the calling
# process holds Full Disk Access, and Screen Recording / FDA grants (system db
# only) are unattainable by any script at all — there is no Apple-supported CLI
# to grant TCC. With SIP DISABLED, root writes both dbs directly from ANY
# terminal (cmux included), no FDA dance. So the fleet standard is SIP off, and
# this stage is only fully effective there.
#
# (History: an earlier version tried to self-heal a non-FDA terminal by
# re-launching over SSH — sshd can hold FDA. It recursed ~40x on hb-41 because
# sudo strips the guard env var, and it can't work anyway when "Allow full disk
# access for remote users" is off. Removed: on a SIP-off box it's unnecessary,
# on a SIP-on box it's insufficient.)
if ! sip_relaxed; then
  fail "SIP is ENABLED — this stage cannot provision TCC on this machine."
  fail "  csrutil: $(csrutil status 2>/dev/null || echo unknown)"
  fail "Screen Recording + Full Disk Access live in the SIP-protected system"
  fail "TCC.db; no script can write them while SIP is on. The fleet standard is"
  fail "to relax SIP on these dedicated appliances:"
  fail "  1. shut down, boot to Recovery (Apple Silicon: hold power → Options)"
  fail "  2. Utilities → Terminal → 'csrutil disable' → reboot"
  fail "  3. re-run: sudo ./machine/40-tcc.sh   (writes all grants directly, no FDA needed)"
  fail "Alternative without relaxing SIP: enroll in MDM and push a PPPC profile,"
  fail "or grant each app manually in System Settings → Privacy & Security."
  exit 1
fi

# SIP is off: root can write both dbs directly from here. Sanity-check the
# write path anyway so a schema mismatch or an unexpected lock surfaces as a
# clear failure rather than 0 silent grants.
if ! sqlite3 "$USER_TCC" "SELECT count(*) FROM access;" >/dev/null 2>&1; then
  fail "SIP is off but $USER_TCC is still unreadable ($(sqlite3 "$USER_TCC" 'SELECT 1;' 2>&1 | head -1))."
  fail "Unexpected — check the db exists and is not mid-migration, then re-run."
  exit 1
fi

log "Writing user TCC grants"
if [[ -f "$USER_TCC" ]]; then
  grant_all "$USER_TCC" "user"
  grant_apps "$USER_TCC" "user"
else
  warn "user TCC.db not found at $USER_TCC (log in as $AGENT_USER once first)"
fi

log "Writing system TCC grants (Accessibility/Screen Recording/FDA live here)"
grant_all "$SYS_TCC" "system"
grant_apps "$SYS_TCC" "system"

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
  sqlite3 "$USER_TCC" "SELECT service, client, auth_value FROM access WHERE client LIKE '%axmcp%' OR client LIKE '%opencode%' OR client LIKE '%cmux%' LIMIT 10;" 2>/dev/null || true
fi

log "Stage 40 complete"
