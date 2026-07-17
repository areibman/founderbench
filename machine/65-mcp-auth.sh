#!/usr/bin/env bash
# Stage 65: one-time OAuth for remote MCPs (Fastmail).
# Banking does NOT use MCP OAuth: the agent uses the meow CLI with MEOW_API_TOKEN.
# Run as the agent user, INTERACTIVELY, on the Mac (needs a browser once).
# After this stage, no run should ever hit a login prompt.
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

for server in fastmail; do
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

log "Stage 65 complete. Reminder: for Fastmail choose the 'send' access level."
log "Meta Ads is shell → Graph API (META_ACCESS_TOKEN); no MCP OAuth."
