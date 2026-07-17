#!/usr/bin/env bash
# FounderBench machine verification gate.
# Must pass 100% before any unattended run. Every check is non-interactive —
# if anything pops a dialog, that is itself a FAILURE (fix and add a check here).
#
# Usage: ./verify.sh [--skip-upload]
#   --skip-upload   skip the TestFlight upload (for iterating on earlier stages)

set -uo pipefail  # no -e: we want to run ALL checks and report at the end
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_macos
require_not_root
load_credentials

SKIP_UPLOAD=false
[[ "${1:-}" == "--skip-upload" ]] && SKIP_UPLOAD=true

PASS=0; FAIL=0
v() {  # v <label> <command...>
  if check "$1" "${@:2}"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
}

log "══ 1. Machine state ══"
v "never sleep (pmset sleep=0)"        bash -c 'pmset -g | grep -E "^\s*sleep\s+0"'
v "display never sleeps"               bash -c 'pmset -g | grep -E "^\s*displaysleep\s+0"'
v "screensaver disabled"               bash -c '[[ "$(defaults -currentHost read com.apple.screensaver idleTime 2>/dev/null)" == "0" ]]'
v "FileVault off (needed for autologin)" bash -c 'fdesetup status | grep -q Off'
v "automatic login configured"         bash -c 'defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser >/dev/null 2>&1'
v "auto macOS updates disabled"        bash -c '[[ "$(defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled 2>/dev/null)" == "0" ]]'
v "SSH enabled"                        bash -c 'systemsetup -getremotelogin 2>/dev/null | grep -qi on || sudo -n systemsetup -getremotelogin 2>/dev/null | grep -qi on'
v "GUI console session owned by us"    bash -c '[[ "$(stat -f%Su /dev/console)" == "$(whoami)" ]]'

log "══ 2. Toolchain ══"
for c in git gh node go jq xcbeautify xcodes asc agent-browser opencode peekaboo; do
  v "cli: $c" command -v "$c"
done
for c in axmcp xcmcp ax xc computer-use-mcp; do
  v "cli: $c" bash -c "command -v $c || command -v \$HOME/go/bin/$c"
done
v "Xcode selected"                     xcode-select -p
v "xcodebuild works"                   xcodebuild -version
v "iOS simulator runtime present"      bash -c 'xcrun simctl list runtimes | grep -q iOS'
v "a simulator device exists"          bash -c 'xcrun simctl list devices available | grep -qE "iPhone"'

log "══ 3. Permissions (the zero-dialog gates) ══"
v "build keychain exists"              bash -c '[[ -f "$HOME/Library/Keychains/founderbench.keychain-db" ]]'
v "build keychain unlockable"          bash -c 'security show-keychain-info founderbench.keychain-db 2>&1 | grep -q "no-timeout\|timeout"'
v "codesign identity valid"            bash -c 'security find-identity -v -p codesigning founderbench.keychain-db | grep -qv "0 valid"'
v "screencapture works (Screen Recording TCC)" bash -c 'screencapture -x /tmp/fb-verify-screen.png && [[ -s /tmp/fb-verify-screen.png ]]'
v "AX API reachable (Accessibility TCC)" bash -c 'AXBIN=$(command -v ax || echo $HOME/go/bin/ax); "$AXBIN" apps 2>/dev/null | head -1 | grep -q .'
v "osascript System Events (AppleEvents TCC)" osascript -e 'tell application "System Events" to count processes'
v "peekaboo permissions granted" bash -c 'peekaboo permissions status 2>&1 | grep -qiv denied'
v "passwordless sudo (agent autonomy)" sudo -n true

log "══ 4. Credentials (live) ══"
bash ./60-credentials.sh >/dev/null 2>&1 && { ok "60-credentials.sh passes"; PASS=$((PASS+1)); } \
  || { fail "60-credentials.sh FAILED — run it directly for details"; FAIL=$((FAIL+1)); }

log "══ 5. End-to-end app build proof ══"
REPO_DIR="${APP_REPO_DIR:-$HOME/work/app}"
SCHEME="${APP_XCODE_SCHEME:-}"
if [[ -z "$SCHEME" ]]; then
  fail "APP_XCODE_SCHEME not set in credentials.env — cannot run build proof"; FAIL=$((FAIL+1))
else
  # Clone or update
  if [[ -d "$REPO_DIR/.git" ]]; then
    v "app repo: fetch" git -C "$REPO_DIR" fetch --quiet
  else
    v "app repo: clone" git clone "${APP_REPO_URL:?APP_REPO_URL not set}" "$REPO_DIR"
  fi

  # Container args: workspace beats project
  CONTAINER=()
  if [[ -n "${APP_XCODE_WORKSPACE:-}" ]]; then
    CONTAINER=(-workspace "$REPO_DIR/${APP_XCODE_WORKSPACE}")
  elif [[ -n "${APP_XCODE_PROJECT:-}" ]]; then
    CONTAINER=(-project "$REPO_DIR/${APP_XCODE_PROJECT}")
  fi

  DERIVED="$HOME/work/verify-derived"
  SIM_DEST="platform=iOS Simulator,name=$(xcrun simctl list devices available | grep -oE 'iPhone [^(]*' | head -1 | xargs)"

  v "xcodebuild: build for simulator" \
    xcodebuild "${CONTAINER[@]}" -scheme "$SCHEME" -destination "$SIM_DEST" \
      -derivedDataPath "$DERIVED" build CODE_SIGNING_ALLOWED=NO

  v "xcodebuild: tests on simulator" \
    xcodebuild "${CONTAINER[@]}" -scheme "$SCHEME" -destination "$SIM_DEST" \
      -derivedDataPath "$DERIVED" test CODE_SIGNING_ALLOWED=NO

  v "simulator: boot + screenshot" bash -c '
    UDID=$(xcrun simctl list devices available | grep -oE "[0-9A-F-]{36}" | head -1)
    xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID" 2>/dev/null || true
    xcrun simctl io "$UDID" screenshot /tmp/fb-verify-sim.png && [[ -s /tmp/fb-verify-sim.png ]]'

  ARCHIVE="$HOME/work/verify.xcarchive"
  v "xcodebuild: archive (signed)" \
    bash -c "security unlock-keychain -p \"\$FB_KEYCHAIN_PASSWORD\" founderbench.keychain-db && \
      xcodebuild ${CONTAINER[*]} -scheme '$SCHEME' -destination 'generic/platform=iOS' \
        -archivePath '$ARCHIVE' archive DEVELOPMENT_TEAM='${APPLE_TEAM_ID:-}'"

  if ! $SKIP_UPLOAD; then
    v "asc: TestFlight upload (throwaway build)" \
      bash -c '
        EXPORT_DIR="$HOME/work/verify-export"
        rm -rf "$EXPORT_DIR" && mkdir -p "$EXPORT_DIR"
        cat > /tmp/fb-export-options.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>'"${APPLE_TEAM_ID:-}"'</string>
</dict></plist>
PLIST
        xcodebuild -exportArchive -archivePath "$HOME/work/verify.xcarchive" \
          -exportOptionsPath /tmp/fb-export-options.plist -exportPath "$EXPORT_DIR" &&
        IPA=$(ls "$EXPORT_DIR"/*.ipa | head -1) &&
        asc builds upload --app "$APP_BUNDLE_ID" --ipa "$IPA"'
  else
    warn "TestFlight upload skipped (--skip-upload)"
  fi
fi

log "══ 6. Harness smoke ══"
v "opencode serve starts + health"     bash -c '
  opencode serve --port 41299 >/tmp/fb-verify-opencode.log 2>&1 &
  OC_PID=$!
  for i in $(seq 1 30); do
    curl -sf http://127.0.0.1:41299/global/health >/dev/null 2>&1 && break
    sleep 1
  done
  RES=$(curl -sf http://127.0.0.1:41299/global/health)
  kill $OC_PID 2>/dev/null
  grep -q healthy <<<"$RES"'

echo
log "════════════════════════════════════"
log "verify.sh: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  die "machine NOT ready — fix every failure, then re-run. Any mid-run dialog = add a check here."
fi
log "machine READY. Take an APFS snapshot now: sudo tmutil localsnapshot"
