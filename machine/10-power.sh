#!/usr/bin/env bash
# Stage 10: power, sleep, lock, login — make the machine an always-on appliance.
# Run as root (sudo).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_macos
require_root

AGENT_USER="${SUDO_USER:-$(stat -f%Su /dev/console)}"
AGENT_UID="$(id -u "$AGENT_USER")"

log "Configuring power management (never sleep)"
pmset -a sleep 0
pmset -a disksleep 0
pmset -a displaysleep 0
pmset -a autorestart 1        # restart automatically after power failure
pmset -a womp 1               # wake on network access
ok "pmset: sleep disabled, autorestart on"

log "Disabling screensaver and screen lock for $AGENT_USER"
sudo -u "$AGENT_USER" defaults -currentHost write com.apple.screensaver idleTime -int 0
# Disable "require password after sleep or screen saver begins"
sysadminctl -screenLock off -password - 2>/dev/null \
  || warn "screen lock: disable manually in System Settings → Lock Screen (needs GUI once)"
ok "screensaver idleTime=0"

log "Enabling automatic login for $AGENT_USER"
# Automatic login requires FileVault to be OFF.
if fdesetup status | grep -q "On"; then
  warn "FileVault is ON — automatic login will not work. Disable with: sudo fdesetup disable"
else
  current_autologin="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)"
  if [[ "$current_autologin" == "$AGENT_USER" ]]; then
    ok "automatic login already set to $AGENT_USER"
  else
    # Setting the /etc/kcpassword XOR-obfuscated password non-interactively is fragile;
    # use sysadminctl (macOS 13+) which handles it.
    warn "enable automatic login for $AGENT_USER in System Settings → Users & Groups → Automatically log in"
    warn "(or: sudo sysadminctl -autologin set -userName $AGENT_USER -password <pw>)"
  fi
fi

log "Disabling Spotlight indexing for work directories"
WORKDIR="/Users/$AGENT_USER/work"
sudo -u "$AGENT_USER" mkdir -p "$WORKDIR"
mdutil -i off "$WORKDIR" >/dev/null 2>&1 || warn "mdutil could not disable indexing on $WORKDIR"
ok "Spotlight indexing off for $WORKDIR"

log "Enabling remote access for rescue"
systemsetup -setremotelogin on >/dev/null 2>&1 && ok "SSH (Remote Login) enabled" \
  || warn "could not enable SSH via systemsetup; enable in System Settings → Sharing"
# Screen Sharing
launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist 2>/dev/null \
  && ok "Screen Sharing enabled" \
  || warn "could not enable Screen Sharing; enable in System Settings → Sharing"

log "Disabling crash reporter dialogs (write crash reports without UI)"
sudo -u "$AGENT_USER" defaults write com.apple.CrashReporter DialogType -string "none"
ok "CrashReporter DialogType=none"

log "Stage 10 complete"
