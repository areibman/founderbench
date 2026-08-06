#!/usr/bin/env bash
# Stage 70: install the OpenCode agent workspace (config, charter, skills).
# Default target is $HOME — not a directed app-repo path. Finding the product
# is eval signal; we only drop the charter + tool config where the agent starts.
#
# Usage: ./70-agent-workspace.sh [target-dir] [charter.md]
#   target-dir  defaults to $HOME
#   charter.md  optional charter variant (absolute or repo-relative), installed
#               as AGENTS.md; defaults to configs/agent/AGENTS.md. Used for
#               treatment arms (e.g. configs/agent/AGENTS-pressure.md).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_not_root
load_credentials

TARGET="${1:-${HOME}}"
[[ -d "$TARGET" ]] || die "target directory does not exist: $TARGET"

SRC="$FB_ROOT/configs/agent"

CHARTER="${2:-$SRC/AGENTS.md}"
[[ -f "$CHARTER" ]] || CHARTER="$FB_ROOT/${2:-}"
[[ -f "$CHARTER" ]] || die "charter not found: ${2:-$SRC/AGENTS.md}"

# opencode.json is a template: the model block is rendered per arm from
# credentials.env (see configs/arms/). MODEL_NPM picks the provider package —
# @ai-sdk/openai (Responses API; OpenAI/Azure only, keeps reasoningSummary) or
# @ai-sdk/openai-compatible (Chat Completions; every other upstream).
[[ -n "${MODEL_ID:-}" ]] || die "MODEL_ID not set — fill the model block in credentials.env (see configs/arms/)"
MODEL_NPM="${MODEL_NPM:-@ai-sdk/openai}"
require_cmd jq

# Optional per-arm knobs (all from the arm's env block, see configs/arms/):
#   MODEL_OPTIONS_JSON — model options exactly as the provider's docs specify
#     (overrides the @ai-sdk/openai reasoningSummary default). Invalid JSON
#     fails the render loudly.
#   MODEL_CONTEXT / MODEL_OUTPUT — documented token limits; OpenCode uses
#     limit.context for compaction thresholds, which matters over 72 hours.
log "Rendering opencode.json → $TARGET (arm: ${FB_ARM:-?}, model: $MODEL_ID, npm: $MODEL_NPM)"
jq --arg mid "$MODEL_ID" --arg npm "$MODEL_NPM" \
   --argjson opts "${MODEL_OPTIONS_JSON:-null}" \
   --argjson ctx "${MODEL_CONTEXT:-null}" \
   --argjson out "${MODEL_OUTPUT:-null}" '
  .model = "founderbench/\($mid)"
  | .provider.founderbench.npm = $npm
  | .provider.founderbench.models = {
      ($mid): (
        { name: "\($mid) (via interception proxy)" }
        + (if $opts != null then { options: $opts }
           elif $npm == "@ai-sdk/openai" then { options: { reasoningSummary: "detailed" } }
           else {} end)
        + (if $ctx != null and $out != null
           then { limit: { context: $ctx, output: $out } }
           else {} end)
      )
    }
' "$SRC/opencode.json" > "$TARGET/opencode.json"
ok "opencode.json (founderbench/$MODEL_ID)"

log "Installing founder charter → AGENTS.md ($(basename "$CHARTER"))"
cp "$CHARTER" "$TARGET/AGENTS.md"
ok "AGENTS.md ← $CHARTER"

log "Installing skills → .opencode/skills/"
mkdir -p "$TARGET/.opencode/skills"
for skill_dir in "$SRC/.agents/skills"/*/; do
  [[ -f "$skill_dir/SKILL.md" ]] || continue
  name="$(basename "$skill_dir")"
  mkdir -p "$TARGET/.opencode/skills/$name"
  cp -R "$skill_dir/." "$TARGET/.opencode/skills/$name/"
  ok "skill: $name"
done

log "Symlinking founderbench tools/ into the workspace"
ln -sfn "$FB_ROOT/tools" "$TARGET/tools"
ok "tools → $FB_ROOT/tools"

# NOTE: we deliberately do NOT seed any log/journal file. Whether and how the
# agent keeps records (notes, logs, TODO files) is eval signal — a pre-seeded
# file with instructions in it would contaminate that observation.
# (docs/experiment-design.md, "deliberately uninstructed")

if [[ -d "$TARGET/.git" ]]; then
  log "Installing git hooks for trace collection"
  HOOK="$TARGET/.git/hooks/post-commit"
  cat > "$HOOK" <<EOF
#!/usr/bin/env bash
# FounderBench trace hook: record every commit as a trace event.
FB_TRACE_DIR="\${FB_TRACE_DIR:-}"
[[ -n "\$FB_TRACE_DIR" && -d "\$FB_TRACE_DIR" ]] || exit 0
sha=\$(git rev-parse HEAD)
msg=\$(git log -1 --pretty=%s | head -c 500)
stat=\$(git show --stat --format= HEAD | tail -1)
printf '{"ts":%s,"type":"git.commit","source":"git-hook","data":{"sha":"%s","message":%s,"stat":%s}}\n' \
  "\$(date +%s)000" "\$sha" "\$(printf '%s' "\$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
  "\$(printf '%s' "\$stat" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
  >> "\$FB_TRACE_DIR/trace.jsonl" 2>/dev/null || true
EOF
  chmod +x "$HOOK"
  ok "post-commit hook installed"
else
  warn "no .git at $TARGET — skipping post-commit hook (shadow git still covers the run)"
fi

log "Stage 70 complete — workspace ready at $TARGET"
log "Verify: cd $TARGET && opencode mcp list"
