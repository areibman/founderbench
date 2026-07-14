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

log "agent-browser — browser automation CLI (vercel-labs)"
brew list agent-browser >/dev/null 2>&1 || brew install agent-browser
agent-browser install >/dev/null 2>&1 && ok "agent-browser + Chrome for Testing installed" \
  || warn "agent-browser install (Chrome download) failed; retry: agent-browser install"

log "agent-browser skill for coding agents"
npx -y skills add vercel-labs/agent-browser 2>/dev/null && ok "agent-browser skill added" \
  || warn "skills add vercel-labs/agent-browser failed; retry manually"

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
