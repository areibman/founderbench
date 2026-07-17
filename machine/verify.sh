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
if [[ -n "${APPLE_CERT_P12:-}" ]]; then
  v "codesign identity valid (p12 mode)" bash -c 'security find-identity -v -p codesigning founderbench.keychain-db | grep -qv "0 valid"'
else
  # Team ID is agent-discoverable — only gate on the ASC key material.
  v "cloud signing ready (no p12: ASC key + .p8)" \
    bash -c '[[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" && -f "${ASC_PRIVATE_KEY_PATH/#\~/$HOME}" ]]'
fi
v "screencapture works (Screen Recording TCC)" bash -c 'screencapture -x /tmp/fb-verify-screen.png && [[ -s /tmp/fb-verify-screen.png ]]'
v "AX API reachable (Accessibility TCC)" bash -c 'AXBIN=$(command -v ax || echo $HOME/go/bin/ax); "$AXBIN" apps 2>/dev/null | head -1 | grep -q .'
v "osascript System Events (AppleEvents TCC)" osascript -e 'tell application "System Events" to count processes'
v "peekaboo permissions granted" bash -c 'peekaboo permissions status 2>&1 | grep -qiv denied'
v "passwordless sudo (agent autonomy)" sudo -n true

log "══ 4. Credentials (live) ══"
bash ./60-credentials.sh >/dev/null 2>&1 && { ok "60-credentials.sh passes"; PASS=$((PASS+1)); } \
  || { fail "60-credentials.sh FAILED — run it directly for details"; FAIL=$((FAIL+1)); }

log "══ 5. End-to-end app build proof ══"
# App location / scheme / team / bundle id are all agent-discoverable. We do not
# require APP_REPO_DIR. If a checkout is obvious (credentials or a common path),
# prove the build; otherwise skip — finding/using the app is eval signal.
SCHEME="${APP_XCODE_SCHEME:-}"
HAVE_APP=false
REPO_DIR=""
if [[ -n "${APP_REPO_DIR:-}" && -d "${APP_REPO_DIR}/.git" ]]; then
  REPO_DIR="$APP_REPO_DIR"
elif [[ -d "$HOME/work/app/.git" ]]; then
  REPO_DIR="$HOME/work/app"
else
  # First git repo under ~/work that looks like an Xcode app.
  CAND=$(find "$HOME/work" -maxdepth 3 -type d -name .git 2>/dev/null | while read -r g; do
    root="$(dirname "$g")"
    if find "$root" -maxdepth 3 \( -name '*.xcodeproj' -o -name '*.xcworkspace' \) 2>/dev/null | grep -q .; then
      echo "$root"
      break
    fi
  done)
  [[ -n "$CAND" ]] && REPO_DIR="$CAND"
fi

if [[ -n "$REPO_DIR" ]]; then
  ok "app repo: $REPO_DIR"; PASS=$((PASS+1))
  HAVE_APP=true
elif [[ -n "${APP_REPO_URL:-}" ]]; then
  REPO_DIR="${APP_REPO_DIR:-$HOME/work/app}"
  # Optional bootstrap only — never hang on an interactive GitHub prompt.
  v "app repo: clone" env GIT_TERMINAL_PROMPT=0 git clone "$APP_REPO_URL" "$REPO_DIR"
  HAVE_APP=true
else
  warn "no app checkout found — skipping build proof (agent will locate/use the app)"
fi

if $HAVE_APP; then
  # Container: prefer credentials, else discover workspace/project in the repo.
  CONTAINER=()
  if [[ -n "${APP_XCODE_WORKSPACE:-}" ]]; then
    CONTAINER=(-workspace "$REPO_DIR/${APP_XCODE_WORKSPACE}")
  elif [[ -n "${APP_XCODE_PROJECT:-}" ]]; then
    CONTAINER=(-project "$REPO_DIR/${APP_XCODE_PROJECT}")
  else
    WS=$(find "$REPO_DIR" -maxdepth 3 -name '*.xcworkspace' ! -path '*/Pods/*' ! -path '*/.swiftpm/*' | head -1)
    if [[ -n "$WS" ]]; then
      CONTAINER=(-workspace "$WS")
      ok "discovered workspace: ${WS#"$REPO_DIR"/}"; PASS=$((PASS+1))
    else
      PROJ=$(find "$REPO_DIR" -maxdepth 3 -name '*.xcodeproj' ! -path '*/Pods/*' | head -1)
      if [[ -n "$PROJ" ]]; then
        CONTAINER=(-project "$PROJ")
        ok "discovered project: ${PROJ#"$REPO_DIR"/}"; PASS=$((PASS+1))
      else
        fail "no .xcworkspace/.xcodeproj under $REPO_DIR"; FAIL=$((FAIL+1))
        HAVE_APP=false
      fi
    fi
  fi
fi

if $HAVE_APP; then
  if [[ -z "$SCHEME" ]]; then
    SCHEME=$(xcodebuild "${CONTAINER[@]}" -list 2>/dev/null \
      | awk '/^[ \t]*Schemes:/{f=1; next} f && NF{gsub(/^[ \t]+/,""); print; exit}')
    if [[ -n "$SCHEME" ]]; then
      ok "discovered scheme: $SCHEME"; PASS=$((PASS+1))
    else
      fail "could not discover an Xcode scheme (set APP_XCODE_SCHEME or fix the project)"; FAIL=$((FAIL+1))
      HAVE_APP=false
    fi
  fi
fi

if $HAVE_APP; then
  # Team ID: credentials → DEVELOPMENT_TEAM baked into the project → leave empty
  # (cloud signing + project settings often suffice).
  TEAM="${APPLE_TEAM_ID:-}"
  if [[ -z "$TEAM" ]]; then
    TEAM=$(find "$REPO_DIR" \( -name '*.pbxproj' -o -name '*.xcconfig' \) -print0 2>/dev/null \
      | xargs -0 grep -h -m1 -E 'DEVELOPMENT_TEAM[[:space:]]*=[[:space:]]*[A-Z0-9]+' 2>/dev/null \
      | head -1 | grep -oE '[A-Z0-9]{10}' | head -1 || true)
    [[ -n "$TEAM" ]] && { ok "discovered DEVELOPMENT_TEAM: $TEAM"; PASS=$((PASS+1)); }
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

  # Signing args: cloud mode (no p12) signs through the ASC API key — profiles
  # and the cloud-managed distribution cert are created/fetched by xcodebuild.
  # NOTE: spliced unquoted into bash -c strings below — safe because the p8
  # path and key ids contain no spaces (enforced shape, see credentials.env).
  ASC_P8="${ASC_PRIVATE_KEY_PATH/#\~/$HOME}"
  SIGN_ARGS=""
  if [[ -z "${APPLE_CERT_P12:-}" ]]; then
    SIGN_ARGS="-allowProvisioningUpdates -authenticationKeyPath $ASC_P8 -authenticationKeyID ${ASC_KEY_ID:-} -authenticationKeyIssuerID ${ASC_ISSUER_ID:-}"
  fi
  TEAM_ARG=""
  [[ -n "$TEAM" ]] && TEAM_ARG="DEVELOPMENT_TEAM=$TEAM"

  ARCHIVE="$HOME/work/verify.xcarchive"
  v "xcodebuild: archive (signed)" \
    bash -c "security unlock-keychain -p \"\$FB_KEYCHAIN_PASSWORD\" founderbench.keychain-db && \
      xcodebuild ${CONTAINER[*]} -scheme '$SCHEME' -destination 'generic/platform=iOS' \
        -archivePath '$ARCHIVE' archive $TEAM_ARG $SIGN_ARGS"

  if ! $SKIP_UPLOAD; then
    BUNDLE="${APP_BUNDLE_ID:-}"
    if [[ -z "$BUNDLE" ]]; then
      BUNDLE=$(asc apps list --limit 1 --output json 2>/dev/null \
        | jq -r '.[0].attributes.bundleId // .data[0].attributes.bundleId // empty' 2>/dev/null || true)
      [[ -n "$BUNDLE" ]] && { ok "discovered bundle id: $BUNDLE"; PASS=$((PASS+1)); }
    fi
    if [[ -z "$BUNDLE" ]]; then
      warn "APP_BUNDLE_ID unset and asc apps list empty — skipping TestFlight upload"
    else
      TEAM_PLIST_KEY=""
      [[ -n "$TEAM" ]] && TEAM_PLIST_KEY="
  <key>teamID</key><string>$TEAM</string>"
      v "asc: TestFlight upload (throwaway build)" \
        bash -c '
          EXPORT_DIR="$HOME/work/verify-export"
          rm -rf "$EXPORT_DIR" && mkdir -p "$EXPORT_DIR"
          cat > /tmp/fb-export-options.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>'"$TEAM_PLIST_KEY"'
</dict></plist>
PLIST
          xcodebuild -exportArchive -archivePath "$HOME/work/verify.xcarchive" \
            -exportOptionsPath /tmp/fb-export-options.plist -exportPath "$EXPORT_DIR" '"$SIGN_ARGS"' &&
          IPA=$(ls "$EXPORT_DIR"/*.ipa | head -1) &&
          asc builds upload --app "'"$BUNDLE"'" --ipa "$IPA"'
    fi
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
