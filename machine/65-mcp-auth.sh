#!/usr/bin/env bash
# Stage 65: one-time OAuth for remote MCPs.
#
# Nothing on the current surface needs it: exa authenticates with a header key,
# xcmcp/axmcp are local binaries, and every other service (meow, Inkbox,
# BrowserBase, Stripe) is a REST API keyed from credentials.env. The stage stays
# in the pipeline so an OAuth MCP added later has a home, and so this run still
# proves that opencode can enumerate its MCP config.
#
# Run as the agent user, INTERACTIVELY, on the Mac (an OAuth server would need a
# browser once). After this stage, no run should ever hit a login prompt.
#
# Credentials persist in ~/.local/share/opencode/mcp-auth.json — they must survive
# across runs. Do NOT wipe that file when resetting the workspace.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_macos
require_not_root
require_cmd opencode
load_credentials

# OpenCode discovers MCP servers from the workspace config. Stage 70 installs
# that into $HOME by default (not a directed app path).
WORKSPACE="${1:-$HOME}"
cd "$WORKSPACE" || die "workspace not found: $WORKSPACE (run 70-agent-workspace.sh first)"

log "MCP servers configured:"
opencode mcp list || warn "opencode mcp list failed — is opencode.json present in $WORKSPACE?"

OAUTH_MCPS=()
if [[ ${#OAUTH_MCPS[@]} -eq 0 ]]; then
  ok "no OAuth MCPs on this surface — nothing to authorize"
else
  for server in "${OAUTH_MCPS[@]}"; do
    echo
    log "Authorizing MCP: $server (browser will open — complete the OAuth consent)"
    if opencode mcp auth "$server"; then
      ok "$server authorized"
    else
      warn "$server authorization failed — debug with: opencode mcp debug $server"
    fi
  done

  echo
  log "Verifying auth status:"
  opencode mcp auth list 2>/dev/null || opencode mcp list
fi

log "Stage 65 complete"
