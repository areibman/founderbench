#!/usr/bin/env bash
# Shared helpers for FounderBench machine scripts.
# All scripts are idempotent: safe to re-run at any time.

set -euo pipefail

FB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FB_CREDENTIALS="${FB_CREDENTIALS:-$FB_ROOT/credentials.env}"

log()  { printf '\033[1;34m[founderbench]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m  ✗\033[0m %s\n' "$*"; }
die()  { fail "$*"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 (run 30-toolchain.sh)"
}

require_macos() {
  [[ "$(uname)" == "Darwin" ]] || die "this script must run on macOS"
}

require_root() {
  [[ $EUID -eq 0 ]] || die "this script must run with sudo"
}

require_not_root() {
  [[ $EUID -ne 0 ]] || die "run this script as the agent user, not root"
}

# Load credentials.env into the environment if present.
load_credentials() {
  if [[ -f "$FB_CREDENTIALS" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$FB_CREDENTIALS"
    set +a
  fi
}

# check <label> <command...>  — runs command silently, prints ✓/✗, returns status.
check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    ok "$label"
    return 0
  else
    fail "$label"
    return 1
  fi
}
