#!/usr/bin/env bash
# Stage 20: pin the OS and Xcode — no automatic updates, non-interactive Xcode install.
# Run as root (sudo).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_macos
require_root

AGENT_USER="${SUDO_USER:-$(stat -f%Su /dev/console)}"

# Pin: set XCODE_VERSION in credentials.env or the environment to override.
load_credentials
XCODE_VERSION="${XCODE_VERSION:-}"

log "Disabling automatic macOS software updates"
defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled -bool false
defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool false
defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
defaults write /Library/Preferences/com.apple.SoftwareUpdate ConfigDataInstall -bool false
defaults write /Library/Preferences/com.apple.SoftwareUpdate CriticalUpdateInstall -bool false
defaults write /Library/Preferences/com.apple.commerce AutoUpdate -bool false
ok "software update: all automatic channels disabled"

log "Installing Xcode Command Line Tools (if missing)"
if xcode-select -p >/dev/null 2>&1; then
  ok "CLT present at $(xcode-select -p)"
else
  # Trigger non-interactive CLT install
  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  PROD="$(softwareupdate -l 2>/dev/null | grep -o 'Command Line Tools.*' | head -1 || true)"
  if [[ -n "$PROD" ]]; then
    softwareupdate -i "$PROD" --agree-to-license || warn "CLT install failed; install manually: xcode-select --install"
  else
    warn "no CLT package found via softwareupdate; run xcode-select --install"
  fi
  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
fi

log "Xcode install/pin"
if [[ -n "$XCODE_VERSION" ]]; then
  if command -v xcodes >/dev/null 2>&1; then
    sudo -u "$AGENT_USER" xcodes install "$XCODE_VERSION" --select \
      || warn "xcodes install $XCODE_VERSION failed (needs Apple ID or Xcodes.app auth); install manually"
  else
    warn "xcodes CLI not installed yet (stage 30 installs it); re-run this stage after"
  fi
else
  warn "XCODE_VERSION not pinned in credentials.env — using whatever Xcode is selected"
fi

if [[ -d "/Applications/Xcode.app" || -n "$(ls -d /Applications/Xcode*.app 2>/dev/null || true)" ]]; then
  log "Accepting Xcode license + first-launch setup (non-interactive)"
  xcodebuild -license accept 2>/dev/null && ok "license accepted" || warn "xcodebuild -license accept failed"
  xcodebuild -runFirstLaunch 2>/dev/null && ok "first launch complete" || warn "runFirstLaunch failed"

  log "Downloading iOS simulator runtime (no Apple ID required)"
  xcodebuild -downloadPlatform iOS 2>/dev/null && ok "iOS platform downloaded" \
    || warn "simulator download failed; run: xcodebuild -downloadPlatform iOS"
else
  warn "Xcode.app not found in /Applications — install it (xcodes or App Store) then re-run stage 20"
fi

log "Disabling Xcode auto-updates via App Store (already covered by commerce AutoUpdate=false)"
ok "Xcode pinned: update only deliberately, never mid-run"

log "Stage 20 complete"
