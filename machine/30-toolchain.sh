#!/usr/bin/env bash
# Stage 30: developer toolchain + agent tool CLIs.
# Run as the agent user (NOT root). Homebrew refuses to run as root anyway.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_macos
require_not_root

export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
export NONINTERACTIVE=1

log "Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Apple Silicon default prefix
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi
ok "brew $(brew --version | head -1)"

log "Core toolchain"
BREW_FORMULAE=(
  git gh node python ruby go
  xcbeautify xcodes
  jq curl
)
for f in "${BREW_FORMULAE[@]}"; do
  brew list "$f" >/dev/null 2>&1 || brew install "$f"
done
ok "core formulae installed: ${BREW_FORMULAE[*]}"

log "asc — App Store Connect CLI (asccli.sh)"
brew list asc >/dev/null 2>&1 || brew install asc
ok "asc $(asc --version 2>/dev/null | head -1 || echo installed)"

log "asc agent skills (23 skills for ASC/Apple Ads/release flows)"
asc install-skills 2>/dev/null && ok "asc skills installed" \
  || warn "asc install-skills failed — retry manually; skills land in ~/.claude/skills (OpenCode discovers them)"

log "playwriter — browser automation CLI (remorses/playwriter)"
npm install -g playwriter@latest && ok "playwriter $(playwriter --version 2>/dev/null | head -1 || echo installed)" \
  || warn "npm i -g playwriter failed; the agent can fall back to npx playwriter@latest"
# Deliberately NOT running `playwriter browser install`. That downloads Chrome
# for Testing, which is a bot-detection tell: it ships a distinct binary and
# user-agent that anti-bot vendors fingerprint on sight, so a signup flow that a
# real Chrome walks through will get flagged. We want stock Google Chrome — the
# same build a human on this Mac would run — driven over CDP.
#
# The chain is: `playwriter browser start <real chrome>` (launches it with remote
# debugging already enabled) then `playwriter session new --direct` (attaches over
# CDP, bypassing the extension, so nothing waits on a human clicking the toolbar
# icon). Headed works here because the box autologins into a real GUI console
# session; see machine/verify.sh for the live proof of that whole chain.
log "Google Chrome — stock build for playwriter (never Chrome for Testing)"
if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  ok "Google Chrome already installed"
else
  brew install --cask google-chrome >/dev/null 2>&1 && ok "Google Chrome installed" \
    || warn "brew install --cask google-chrome failed; playwriter has no stealthy browser until this lands"
fi

log "browse — Browserbase CLI"
npm install -g browse && ok "browse $(browse --version 2>/dev/null | head -1 || echo installed)" \
  || warn "npm i -g browse failed; the browserbase skill card cannot run without it"

log "inkbox — agent identity CLI (@inkbox/cli)"
npm install -g @inkbox/cli && ok "inkbox $(inkbox --version 2>/dev/null | head -1 || echo installed)" \
  || warn "npm i -g @inkbox/cli failed; retry manually"

log "axmcp binaries — macOS AX automation + Xcode MCP (tmc/axmcp)"
export GOPATH="${GOPATH:-$HOME/go}"
export PATH="$GOPATH/bin:$PATH"
AXMCP_CMDS=(axmcp xcmcp computer-use-mcp ax xc)
for c in "${AXMCP_CMDS[@]}"; do
  if command -v "$c" >/dev/null 2>&1; then
    ok "$c already installed"
  else
    go install "github.com/tmc/axmcp/cmd/$c@latest" && ok "$c installed" || warn "go install $c failed"
  fi
done
if ! grep -q 'go/bin' "$HOME/.zshrc" 2>/dev/null; then
  echo 'export PATH="$HOME/go/bin:$PATH"' >> "$HOME/.zshrc"
  ok "added ~/go/bin to PATH in ~/.zshrc"
fi

# meow banking: no CLI to install — the bank skill drives the REST API
# directly (curl + jq, both already required by this stage).

log "Peekaboo — full macOS GUI automation (computer use)"
brew list peekaboo >/dev/null 2>&1 || brew install steipete/tap/peekaboo \
  || warn "peekaboo install failed; retry: brew install steipete/tap/peekaboo"
command -v peekaboo >/dev/null 2>&1 && ok "peekaboo $(peekaboo --version 2>/dev/null | head -1 || echo installed)"

log "OpenCode — agent harness"
if ! command -v opencode >/dev/null 2>&1; then
  brew install sst/tap/opencode 2>/dev/null || npm install -g opencode-ai \
    || warn "opencode install failed; see https://opencode.ai/docs"
fi
command -v opencode >/dev/null 2>&1 && ok "opencode $(opencode --version 2>/dev/null || echo installed)"

log "Fastlane (fallback only — asc is primary)"
brew list fastlane >/dev/null 2>&1 || brew install fastlane || warn "fastlane install failed (optional)"

log "Node deps for orchestrator"
(cd "$FB_ROOT" && npm install --no-fund --no-audit) && ok "npm install complete"

log "Stage 30 complete"
