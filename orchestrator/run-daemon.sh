#!/usr/bin/env bash
# launchd entrypoint: resume the newest incomplete run for this config, else start new.
# Usage: run-daemon.sh <config.toml>

set -euo pipefail
FB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${1:?usage: run-daemon.sh <config.toml>}"
cd "$FB_ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/go/bin:$PATH"

# Load credentials (credentials.env + Inkbox-vault hydration for operational
# keys not in the file — see lib.sh) so the orchestrator and everything under
# it inherit them, then unlock the build keychain (idempotent).
# shellcheck disable=SC1091
source "$FB_ROOT/machine/lib.sh"
load_credentials
if [[ -n "${FB_KEYCHAIN_PASSWORD:-}" ]]; then
  security unlock-keychain -p "$FB_KEYCHAIN_PASSWORD" founderbench.keychain-db 2>/dev/null || true
fi

# Find the newest run with a checkpoint but no COMPLETED marker → resume it.
RESUME_ID=""
if [[ -d "$FB_ROOT/runs" ]]; then
  for dir in $(ls -1dt "$FB_ROOT/runs"/*/ 2>/dev/null); do
    if [[ -f "$dir/checkpoint.json" && ! -f "$dir/COMPLETED" ]]; then
      RESUME_ID="$(basename "$dir")"
      break
    fi
  done
fi

if [[ -n "$RESUME_ID" ]]; then
  echo "[run-daemon] resuming run $RESUME_ID"
  exec npx tsx orchestrator/src/index.ts --config "$CONFIG" --run-id "$RESUME_ID"
else
  echo "[run-daemon] starting new run"
  exec npx tsx orchestrator/src/index.ts --config "$CONFIG"
fi
