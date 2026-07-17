#!/usr/bin/env bash
# Stage 50: dedicated build keychain — non-interactive codesigning, zero keychain dialogs.
# Run as the agent user (NOT root).
#
# Kills the two classic CI blockers:
#   - "User interaction is not allowed"  → keychain locked / lock timeout
#   - errSecInternalComponent (-34018)   → missing set-key-partition-list
#
# Inputs (credentials.env):
#   FB_KEYCHAIN_PASSWORD   password for the build keychain (required)
#   APPLE_CERT_P12         path to distribution certificate .p12 (optional here, required for signing)
#   APPLE_CERT_P12_PASSWORD  password for the .p12
#   PROVISIONING_PROFILES_DIR  dir of .mobileprovision files to install (optional)

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_macos
require_not_root
load_credentials

KEYCHAIN="founderbench.keychain-db"
KEYCHAIN_PATH="$HOME/Library/Keychains/$KEYCHAIN"
PW="${FB_KEYCHAIN_PASSWORD:-}"

[[ -n "$PW" ]] || die "FB_KEYCHAIN_PASSWORD not set in credentials.env"

log "Creating dedicated build keychain"
if [[ -f "$KEYCHAIN_PATH" ]]; then
  ok "keychain exists: $KEYCHAIN"
else
  security create-keychain -p "$PW" "$KEYCHAIN"
  ok "created $KEYCHAIN"
fi

log "Unlocking and extending lock timeout (6h, re-unlocked by orchestrator on each run)"
security unlock-keychain -p "$PW" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
ok "unlocked, timeout 21600s"

log "Adding to keychain search list and setting default"
# Preserve login keychain in the search list.
EXISTING="$(security list-keychains -d user | sed 's/[" ]//g')"
if ! grep -q "$KEYCHAIN" <<<"$EXISTING"; then
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$KEYCHAIN" $EXISTING
fi
security default-keychain -s "$KEYCHAIN"
ok "default keychain: $KEYCHAIN"

if [[ -n "${APPLE_CERT_P12:-}" && -f "${APPLE_CERT_P12:-}" ]]; then
  log "Importing signing certificate"
  security import "$APPLE_CERT_P12" -k "$KEYCHAIN" \
    -P "${APPLE_CERT_P12_PASSWORD:-}" \
    -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productbuild
  ok "imported $(basename "$APPLE_CERT_P12")"

  log "Setting key partition list (prevents errSecInternalComponent)"
  security set-key-partition-list -S apple-tool:,apple: -k "$PW" "$KEYCHAIN" >/dev/null
  ok "partition list set: apple-tool:,apple:"

  log "Verifying signing identity"
  security find-identity -v -p codesigning "$KEYCHAIN" || warn "no valid codesigning identity found"
else
  warn "APPLE_CERT_P12 not set/found — cloud signing mode: xcodebuild will sign via the ASC API key (-allowProvisioningUpdates; requires Admin-role key). To use a local identity instead, set APPLE_CERT_P12 and re-run this stage."
fi

if [[ -n "${PROVISIONING_PROFILES_DIR:-}" && -d "${PROVISIONING_PROFILES_DIR:-}" ]]; then
  log "Installing provisioning profiles"
  PROFILE_DIR="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
  mkdir -p "$PROFILE_DIR"
  count=0
  for prof in "$PROVISIONING_PROFILES_DIR"/*.mobileprovision; do
    [[ -e "$prof" ]] || continue
    # Name by UUID so re-runs don't duplicate.
    uuid="$(security cms -D -i "$prof" 2>/dev/null | plutil -extract UUID raw -o - - 2>/dev/null || true)"
    if [[ -n "$uuid" ]]; then
      cp "$prof" "$PROFILE_DIR/$uuid.mobileprovision"
      count=$((count+1))
    fi
  done
  ok "$count provisioning profiles installed"
else
  warn "PROVISIONING_PROFILES_DIR not set — profiles can also come from ASC API at build time"
fi

log "Git auth hygiene: keep credentials out of the login keychain"
if git config --global credential.helper 2>/dev/null | grep -q osxkeychain; then
  git config --global --unset-all credential.helper || true
  ok "removed git-credential-osxkeychain"
fi
git config --global credential.helper "" 2>/dev/null || true
ok "git: no credential helper — local-only by default, nothing stored in keychain"

log "Stage 50 complete"
