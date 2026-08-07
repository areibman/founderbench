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
for c in git gh node go jq xcbeautify xcodes asc opencode peekaboo playwriter inkbox; do
  v "cli: $c" command -v "$c"
done
for c in axmcp xcmcp ax xc computer-use-mcp; do
  v "cli: $c" bash -c "command -v $c || command -v \$HOME/go/bin/$c"
done
# Live browser proof. CLI presence is not enough, and neither is the easy
# headless path: `session new --browser headless` runs Chrome for Testing, whose
# binary and user-agent get fingerprinted as a bot, so we refuse it. What has to
# work is stock Google Chrome launched with remote debugging (`browser start`)
# and attached over CDP (`session new --direct`), which needs no extension and
# therefore no human clicking a toolbar icon.
#
# Three things can break independently, so prove all of them: Chrome is the real
# build (not Chrome for Testing), the relay on 127.0.0.1:19988 comes up inside
# this process tree (under launchd there is no Terminal session to inherit), and
# a page actually loads and reports its title back.
v "Google Chrome present (stock build, not Chrome for Testing)" bash -c '
  [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]'
v "no Chrome for Testing on disk (bot-detection tell)" bash -c '
  ! compgen -G "$HOME/.playwriter/browsers/chrome-*" >/dev/null 2>&1'
v "playwriter: real-Chrome CDP session + navigation + relay" bash -c '
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  # Launch stock Chrome with remote debugging OURSELVES. playwriter 0.4.x
  # "browser start" is the extension path (waits for the extension, no
  # --remote-debugging-port option) and does not reliably open 9222; the
  # direct-CDP path documents launching Chrome with the flag as a supported
  # prerequisite. Owning the launch keeps this deterministic: known binary,
  # known port, no extension.
  if ! nc -z 127.0.0.1 9222 >/dev/null 2>&1; then
    "$CHROME" --remote-debugging-port=9222 --user-data-dir="$HOME/.playwriter/fb-profile" \
      --no-first-run --no-default-browser-check >/dev/null 2>&1 &
  fi
  for _ in $(seq 1 20); do nc -z 127.0.0.1 9222 >/dev/null 2>&1 && break; sleep 1; done
  nc -z 127.0.0.1 9222 >/dev/null 2>&1 || {
    echo "Chrome did not expose the CDP port. If Chrome was already running"
    echo "without remote debugging, the new launch delegates to that instance"
    echo "and the flag is ignored — kill it first: pkill -f \"Google Chrome\""
    exit 1
  }
  # Port 9222 must be owned by STOCK CHROME, not just any CDP endpoint.
  # Electron/CEF apps (a leftover runner, cmux, ...) also serve
  # /devtools/browser/ and pass a UA sniff (their UA carries a normal Chrome/
  # token), but they reject Browser.setDownloadBehavior and the Playwright
  # attach dies with "Browser context management is not supported". Checking
  # the listening process path is authoritative.
  CDP_PID=$(lsof -nP -tiTCP:9222 -sTCP:LISTEN 2>/dev/null | head -1)
  CDP_EXE=$(ps -o comm= -p "${CDP_PID:-0}" 2>/dev/null || true)
  if [[ "$CDP_EXE" != "$CHROME" ]]; then
    echo "port 9222 is not stock Google Chrome — another app is squatting the CDP port:"
    echo "  pid ${CDP_PID:-?}: ${CDP_EXE:-unknown}"
    exit 1
  fi
  UA=$(curl -s --max-time 5 http://127.0.0.1:9222/json/version | jq -r ".\"User-Agent\" // empty")
  case "$UA" in
    *HeadlessChrome*|*"Chrome for Testing"*|*Electron*) echo "browser advertises a bot/embedded user-agent: $UA"; exit 1 ;;
  esac
  SID=$(playwriter session new --direct 2>&1 | sed -n "s/^Session \([0-9][0-9]*\) created.*/\1/p" | head -1)
  [[ -n "$SID" ]] || { echo "could not attach to Chrome over CDP (session new --direct)"; exit 1; }
  # domcontentloaded + explicit timeouts: the default goto waits for the full
  # load event and playwriter kills execution at 10s, which false-fails on a
  # cold profile (first-run work) or a slow first fetch.
  JS="const p = await context.newPage(); await p.goto(\"https://example.com\", { waitUntil: \"domcontentloaded\", timeout: 30000 }); console.log(\"FB_TITLE:\" + (await p.title())); await p.close()"
  OUT=$(playwriter -s "$SID" --timeout 45000 -e "$JS" 2>&1)
  playwriter session delete "$SID" >/dev/null 2>&1 || true
  grep -q "FB_TITLE:Example Domain" <<<"$OUT" || { echo "navigation failed:"; echo "$OUT"; exit 1; }
  nc -z 127.0.0.1 19988 >/dev/null 2>&1 || { echo "relay is not listening on 127.0.0.1:19988 after a successful session"; exit 1; }
  echo "UA: $UA"'

v "Xcode selected"                     xcode-select -p
v "xcodebuild works"                   xcodebuild -version
v "iOS simulator runtime present"      bash -c 'xcrun simctl list runtimes | grep -q iOS'
v "a simulator device exists"          bash -c 'xcrun simctl list devices available | grep -qE "iPhone"'

log "══ 3. Permissions (the zero-dialog gates) ══"
v "build keychain exists"              bash -c '[[ -f "$HOME/Library/Keychains/founderbench.keychain-db" ]]'
v "build keychain unlockable"          bash -c '
  security unlock-keychain -p "$FB_KEYCHAIN_PASSWORD" founderbench.keychain-db &&
  security show-keychain-info founderbench.keychain-db 2>&1 | grep -q "no-timeout\|timeout"'
if [[ -n "${APPLE_CERT_P12:-}" ]]; then
  v "codesign identity valid (p12 mode)" bash -c 'security find-identity -v -p codesigning founderbench.keychain-db | grep -qv "0 valid"'
elif [[ -n "${ASC_KEY_ID:-}" || -n "${ASC_ISSUER_ID:-}" || -n "${ASC_PRIVATE_KEY_PATH:-}" ]]; then
  # Team ID is agent-discoverable — only gate on the ASC key material.
  v "cloud signing ready (no p12: ASC key + .p8)" \
    bash -c '[[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" && -f "${ASC_PRIVATE_KEY_PATH/#\~/$HOME}" ]]'
else
  # iOS is an unprovisioned escape hatch (see credentials.env.example / stage 60):
  # no p12 and no ASC key is the expected default — simulator builds only.
  log "  no p12 and no ASC key — iOS unprovisioned; skipping signing check (simulator-only)"
fi
v "screencapture works (Screen Recording TCC)" bash -c 'screencapture -x /tmp/fb-verify-screen.png && [[ -s /tmp/fb-verify-screen.png ]]'
v "AX API reachable (Accessibility TCC)" bash -c 'AXBIN=$(command -v ax || echo $HOME/go/bin/ax); "$AXBIN" apps 2>/dev/null | head -1 | grep -q .'
v "osascript System Events (AppleEvents TCC)" osascript -e 'tell application "System Events" to count processes'
v "peekaboo permissions granted" bash -c 'peekaboo permissions status 2>&1 | grep -qiv denied'
v "passwordless sudo (agent autonomy)" sudo -n true
# GUI run-wrapper apps (cmux, terminals, editors) must already hold Accessibility
# or macOS pops a first-run "…would like to control this computer" dialog the
# instant the agent drives the GUI — and the per-FOLDER grants (Downloads/
# Desktop/Documents), because when SIP blocks the system-db FDA grant, macOS
# falls back to per-folder prompts the moment anything scans ~ (observed: the
# git shadow touched ~/Downloads mid-run → "cmux would like to access files in
# your Downloads folder"). 40-tcc.sh pre-grants all of these; this proves it
# stuck. Any installed wrapper app with a missing row = re-run 40-tcc.sh.
v "run-wrapper apps hold Accessibility + folder TCC (no first-run dialog)" bash -c '
  USER_DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
  SYS_DB="/Library/Application Support/com.apple.TCC/TCC.db"
  # If neither TCC.db is readable here, defer to the run-context preflight.
  if ! sqlite3 "$USER_DB" "SELECT 1;" >/dev/null 2>&1 && ! sudo -n sqlite3 "$SYS_DB" "SELECT 1;" >/dev/null 2>&1; then
    echo "TCC.db not readable from this session; run-context preflight covers it"; exit 0
  fi
  granted_for() {  # $1=service $2=client
    local q="SELECT 1 FROM access WHERE service=\"$1\" AND client=\"$2\" AND auth_value>=2 LIMIT 1;"
    [[ -n "$(sqlite3 "$USER_DB" "$q" 2>/dev/null)" ]] && return 0
    [[ -n "$(sudo -n sqlite3 "$SYS_DB" "$q" 2>/dev/null)" ]] && return 0
    return 1
  }
  SERVICES=(kTCCServiceAccessibility kTCCServiceSystemPolicyDownloadsFolder kTCCServiceSystemPolicyDesktopFolder kTCCServiceSystemPolicyDocumentsFolder)
  missing=""
  check_app() {
    local app="$1" bid svc
    [[ -d "$app" ]] || return 0
    bid="$(defaults read "$app/Contents/Info" CFBundleIdentifier 2>/dev/null)" || bid=""
    [[ -n "$bid" ]] || return 0
    for svc in "${SERVICES[@]}"; do
      granted_for "$svc" "$bid" || missing="$missing ${app##*/}:${svc#kTCCService}"
    done
  }
  apps=(cmux Terminal iTerm Ghostty WezTerm kitty Alacritty Warp "Visual Studio Code" Cursor "Google Chrome")
  for name in "${apps[@]}"; do
    for base in /Applications /Applications/Utilities /System/Applications/Utilities "$HOME/Applications"; do
      check_app "$base/$name.app"
    done
  done
  if [[ -n "${FB_TCC_APPS:-}" ]]; then
    OLDIFS=$IFS; IFS=":"
    for a in $FB_TCC_APPS; do
      IFS=$OLDIFS
      if [[ "$a" == /* ]]; then check_app "$a"; else
        for base in /Applications /Applications/Utilities /System/Applications/Utilities "$HOME/Applications"; do check_app "$base/$a.app"; done
      fi
    done
    IFS=$OLDIFS
  fi
  [[ -z "$missing" ]] || { echo "missing TCC grants:$missing — re-run: sudo ./machine/40-tcc.sh"; exit 1; }
  echo "all installed run-wrapper apps pre-granted"'

# Self-KVM: the machine drives its own console GUI over loopback VNC. This is
# the break-glass path (vncdotool skill) for dialogs/toggles the app-level
# tools can't reach. A single loopback capture proves the whole chain at once:
# vncdo installed, Screen Sharing server up, auth accepted, and a real
# framebuffer rendered (a headless mini with no display captures black).
#
# Auth: macOS Screen Sharing offers both legacy-VNC (type 2) and Apple DH/ARD
# (type 30); vncdo always picks ARD when offered, so we authenticate with the
# console user's account credentials (-u/-p), not the legacy vnc.pw. The vnc.pw
# file is still required — it is what keeps legacy VNC enabled on the server
# and is the fallback for plain-VNC clients.
VNC_PW_FILE="${VNC_PASSWORD_FILE:-$HOME/.config/founderbench/vnc.pw}"
v "vncdo installed"                    bash -c 'command -v vncdo || command -v "$HOME/.local/bin/vncdo"'
v "VNC password file exists (mode 600)" bash -c '[[ -f "'"$VNC_PW_FILE"'" ]] && [[ "$(stat -f "%OLp" "'"$VNC_PW_FILE"'")" == "600" ]]'
v "Screen Sharing server listening (loopback :5900)" bash -c 'nc -z -G 2 127.0.0.1 5900'
v "self-KVM: loopback VNC capture (auth + framebuffer)" bash -c '
  VNCDO=$(command -v vncdo || echo "$HOME/.local/bin/vncdo")
  OUT=/tmp/fb-verify-vnc.png
  rm -f "$OUT"
  "$VNCDO" -t 20 -s 127.0.0.1::5900 -u "$(whoami)" -p "$MACOS_ACCOUNT_PASSWORD" capture "$OUT" 2>/tmp/fb-verify-vnc.err &&
  [[ -s "$OUT" ]] &&
  # Not all-black: a rendered console session, not a headless void. Compare the
  # mean pixel value; 0 means nothing is being drawn (no display attached).
  python3 - "$OUT" <<PY
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("L")
lo, hi = im.getextrema()
sys.exit(0 if hi > lo else 1)  # any variation = a real framebuffer
PY'
v "self-KVM: input round-trip (move+key accepted)" bash -c '
  VNCDO=$(command -v vncdo || echo "$HOME/.local/bin/vncdo")
  "$VNCDO" -t 20 -s 127.0.0.1::5900 -u "$(whoami)" -p "$MACOS_ACCOUNT_PASSWORD" move 20 20 key esc 2>/tmp/fb-verify-vnc-input.err'

log "══ 4. Credentials (live) ══"
# Stream stage 60 inline — its per-credential ✓/✗ lines ARE the diagnostics,
# so hiding them and saying "run it directly" just made everyone run it twice.
if bash ./60-credentials.sh 2>&1; then
  ok "60-credentials.sh passes"; PASS=$((PASS+1))
else
  fail "60-credentials.sh FAILED (see ✗ lines above)"; FAIL=$((FAIL+1))
fi

log "══ 5. iOS build proof (OPTIONAL — no app is provisioned) ══"
# Agents start from scratch, so at provisioning time there is normally no app
# here and this whole section skips. That is the expected outcome, not a
# failure. It still runs when an app does exist — e.g. re-verifying a Mac
# mid-run, or a deliberately re-provisioned iOS lane — because a toolchain that
# cannot actually build is worth catching either way.
SCHEME=""
HAVE_APP=false
REPO_DIR=""
if [[ -d "$HOME/work/app/.git" ]]; then
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
else
  log "  no Xcode checkout under ~/work — skipping (expected: agents start from scratch)"
fi

if $HAVE_APP; then
  CONTAINER=()
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

if $HAVE_APP; then
  if [[ -z "$SCHEME" ]]; then
    SCHEME=$(xcodebuild "${CONTAINER[@]}" -list 2>/dev/null \
      | awk '/^[ \t]*Schemes:/{f=1; next} f && NF{gsub(/^[ \t]+/,""); print; exit}')
    if [[ -n "$SCHEME" ]]; then
      ok "discovered scheme: $SCHEME"; PASS=$((PASS+1))
    else
      fail "could not discover an Xcode scheme in $REPO_DIR"; FAIL=$((FAIL+1))
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

  # Signed archive and TestFlight upload need real Apple credentials. With iOS
  # unprovisioned there are none, and simulator build + test above is the whole
  # proof the toolchain works.
  CAN_SIGN=false
  [[ -n "${APPLE_CERT_P12:-}" || -n "${ASC_KEY_ID:-}" ]] && CAN_SIGN=true

  if ! $CAN_SIGN; then
    log "  no signing credentials — skipping signed archive and TestFlight upload"
  else
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
  fi   # CAN_SIGN
fi

log "══ 6. Harness smoke ══"
# Arm consistency: the workspace opencode.json must have been rendered for THIS
# Mac's model block (stage 70). A stale render silently runs the wrong arm.
v "workspace opencode.json rendered for this arm (founderbench/\$MODEL_ID)" bash -c '
  [[ -n "${MODEL_ID:-}" ]] || { echo "MODEL_ID not set in credentials.env (see configs/arms/)"; exit 1; }
  [[ -f "$HOME/opencode.json" ]] || { echo "~/opencode.json missing — run 70-agent-workspace.sh"; exit 1; }
  GOT=$(jq -r ".model" "$HOME/opencode.json" 2>/dev/null)
  [[ "$GOT" == "founderbench/$MODEL_ID" ]] || {
    echo "~/opencode.json model is \"$GOT\", credentials.env says \"founderbench/$MODEL_ID\""
    echo "re-run machine/70-agent-workspace.sh"; exit 1; }
  jq -e ".provider.founderbench.models[\"$MODEL_ID\"]" "$HOME/opencode.json" >/dev/null || {
    echo "model \"$MODEL_ID\" missing from provider.founderbench.models — re-run 70-agent-workspace.sh"; exit 1; }'
v "opencode serve starts + health"     bash -c '
  # Wrong-binary tripwire first: the archived Go opencode-ai project also
  # installs an `opencode` and shadows the sst build (no serve command).
  opencode serve --help >/dev/null 2>&1 || {
    echo "this opencode ($(command -v opencode)) has no \"serve\" command —"
    echo "it is the archived Go opencode-ai build, not sst/opencode."
    echo "fix: re-run machine/30-toolchain.sh (replaces it with sst/tap/opencode)"
    exit 1; }
  opencode serve --port 41299 >/tmp/fb-verify-opencode.log 2>&1 &
  OC_PID=$!
  for i in $(seq 1 30); do
    curl -sf http://127.0.0.1:41299/global/health >/dev/null 2>&1 && break
    sleep 1
  done
  RES=$(curl -sf http://127.0.0.1:41299/global/health)
  kill $OC_PID 2>/dev/null
  grep -q healthy <<<"$RES" || {
    echo "no healthy response on :41299 — server log:"
    tail -n 15 /tmp/fb-verify-opencode.log
    exit 1; }'

echo
log "════════════════════════════════════"
log "verify.sh: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  die "machine NOT ready — fix every failure, then re-run. Any mid-run dialog = add a check here."
fi
log "machine READY. Take an APFS snapshot now: sudo tmutil localsnapshot"
