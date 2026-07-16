#!/usr/bin/env bash
# Stage 45: passwordless sudo for the agent user.
#
# Full autonomy means system-level actions must never hang on a password
# prompt. Containment on this appliance lives at the account layer (spend caps,
# scoped credentials, dedicated machine), not at the sudo boundary — see
# docs/experiment-design.md. Run as root (sudo).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_macos
require_root

AGENT_USER="${SUDO_USER:-$(stat -f%Su /dev/console)}"
SUDOERS_FILE="/etc/sudoers.d/founderbench"

log "Granting passwordless sudo to $AGENT_USER"
printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$AGENT_USER" > "$SUDOERS_FILE"
chmod 0440 "$SUDOERS_FILE"

# visudo -c validates the whole sudoers tree; back out our file if it breaks.
if visudo -c >/dev/null 2>&1; then
  ok "passwordless sudo configured ($SUDOERS_FILE)"
else
  rm -f "$SUDOERS_FILE"
  die "sudoers validation failed — removed $SUDOERS_FILE (no changes applied)"
fi

log "Verifying (as $AGENT_USER)"
if sudo -u "$AGENT_USER" sudo -n true 2>/dev/null; then
  ok "passwordless sudo works for $AGENT_USER"
else
  warn "sudo -n still prompts — check for later sudoers rules overriding this"
fi

log "Stage 45 complete"
