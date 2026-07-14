#!/usr/bin/env bash
# Stage 80: install the orchestrator as a launchd LaunchAgent (GUI session, KeepAlive).
# Run as the agent user.
#
# Usage: ./80-install-launchd.sh configs/pilot-24h.toml

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_macos
require_not_root

CONFIG_REL="${1:?usage: 80-install-launchd.sh <config.toml relative to repo root>}"
CONFIG_ABS="$FB_ROOT/$CONFIG_REL"
[[ -f "$CONFIG_ABS" ]] || die "config not found: $CONFIG_ABS"

LABEL="com.founderbench.orchestrator"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

log "Rendering launchd plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__FB_ROOT__|$FB_ROOT|g" -e "s|__CONFIG__|$CONFIG_ABS|g" \
  launchd/$LABEL.plist.template > "$PLIST_DST"
chmod +x "$FB_ROOT/orchestrator/run-daemon.sh"
ok "$PLIST_DST"

log "(Re)loading LaunchAgent"
launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
ok "orchestrator running under launchd (KeepAlive)"

log "Manage with:"
log "  launchctl print gui/$(id -u)/$LABEL     # status"
log "  launchctl kickstart -k gui/$(id -u)/$LABEL  # restart"
log "  launchctl bootout gui/$(id -u) $PLIST_DST   # stop + uninstall"
log "Logs: runs/orchestrator.launchd.log"
