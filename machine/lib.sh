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

# Load credentials.env into the environment if present, then fill any
# still-empty operational keys from the agent's Inkbox vault.
load_credentials() {
  if [[ -f "$FB_CREDENTIALS" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$FB_CREDENTIALS"
    set +a
  fi
  hydrate_from_vault
}

# Vault-backed credentials. Any of these vars left empty by credentials.env is
# fetched from the Inkbox vault, matched by secret NAME == env var name (case-
# insensitive). credentials.env always wins over the vault.
#
# This is a fixed ALLOWLIST on purpose: the agent writes to its own vault
# mid-run, so hydrating arbitrary secret names would let it inject environment
# into its own harness at the next resume. Machine plumbing (keychain, macOS
# password) and the per-arm model key stay file-only — they must work with no
# network and no Inkbox.
FB_VAULT_VARS=(STRIPE_API_KEY MEOW_API_TOKEN EXA_API_KEY BROWSERBASE_API_KEY BROWSERBASE_PROJECT_ID)

hydrate_from_vault() {
  [[ -n "${INKBOX_API_KEY:-}" && -n "${INKBOX_VAULT_KEY:-}" ]] || return 0
  local missing=() v
  for v in "${FB_VAULT_VARS[@]}"; do
    [[ -z "${!v:-}" ]] && missing+=("$v")
  done
  [[ ${#missing[@]} -gt 0 ]] || return 0
  command -v inkbox >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || return 0
  local secrets
  if ! secrets=$(inkbox vault secrets --json 2>/dev/null); then
    warn "Inkbox vault unreachable — not hydrating: ${missing[*]}"
    return 0
  fi
  local sid val
  for v in "${missing[@]}"; do
    # Secret list shape is defensive: accept a bare array or a wrapper object,
    # and name/label/title as the display field.
    sid=$(jq -r --arg n "$v" '
      [ (if type == "array" then . else (.secrets // .data // []) end)[]
        | select(((.name // .label // .title // "") | ascii_upcase) == $n) ]
      [0] | (.id // .secret_id // empty)' <<<"$secrets" 2>/dev/null)
    [[ -n "$sid" ]] || continue
    val=$(inkbox vault get "$sid" --json 2>/dev/null \
      | jq -r '.value // .secret // .key // .api_key // .password // .data.value // empty' 2>/dev/null)
    if [[ -n "$val" ]]; then
      export "$v=$val"
    else
      warn "vault secret for $v exists (id $sid) but no value field could be extracted"
    fi
  done
}

# check <label> <command...>  — runs command silently, prints ✓/✗, returns status.
check() {
  local label="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    ok "$label"
    return 0
  else
    fail "$label"
    # Surface the failure reason — a ✗ with no diagnostic is undebuggable.
    # 25 lines, not 8: error messages sit ABOVE their stack traces, and tail -8
    # was serving up nothing but hono stack frames.
    [[ -n "$out" ]] && printf '%s\n' "$out" | tail -n 25 | sed 's/^/      │ /'
    return 1
  fi
}
