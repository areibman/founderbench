#!/usr/bin/env bash
# FounderBench Mac mini appliance setup.
# Runs every numbered setup script in order. Idempotent.
#
# Usage:
#   sudo ./setup.sh              # full setup (scripts that need root will run as root,
#                                # scripts that must NOT run as root are re-run as $SUDO_USER)
#   ./setup.sh --only 30         # run a single stage as the current user

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_macos

ONLY=""
if [[ "${1:-}" == "--only" ]]; then
  ONLY="${2:?usage: setup.sh --only <stage-number>}"
fi

# stage:runas  (root = needs sudo, user = must run as the agent user)
STAGES=(
  "10-power.sh:root"
  "20-updates.sh:root"
  "30-toolchain.sh:user"
  "40-tcc.sh:root"
  "45-sudo.sh:root"
  "50-keychain.sh:user"
  "60-credentials.sh:user"
  "65-mcp-auth.sh:user"
)

run_stage() {
  local script="$1" runas="$2"
  log "=== $script (as $runas) ==="
  if [[ "$runas" == "root" ]]; then
    if [[ $EUID -eq 0 ]]; then
      bash "./$script"
    else
      sudo bash "./$script"
    fi
  else
    if [[ $EUID -eq 0 ]]; then
      [[ -n "${SUDO_USER:-}" ]] || die "cannot determine non-root user; run $script directly"
      sudo -u "$SUDO_USER" -H bash "./$script"
    else
      bash "./$script"
    fi
  fi
}

for entry in "${STAGES[@]}"; do
  script="${entry%%:*}"
  runas="${entry##*:}"
  if [[ -n "$ONLY" && "$script" != "$ONLY"* ]]; then
    continue
  fi
  run_stage "$script" "$runas"
done

log "Setup complete. Next steps:"
log "  1. Walk through docs/mac-checklist.md"
log "  2. Run ./verify.sh (must pass 100% before any run)"
log "  3. Take an APFS snapshot as the reset baseline:"
log "     sudo tmutil localsnapshot"
