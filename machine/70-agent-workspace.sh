#!/usr/bin/env bash
# Stage 70: install the OpenCode agent workspace (config, charter, skills) into the
# app repo checkout. Run as the agent user. Re-run any time templates change.
#
# Usage: ./70-agent-workspace.sh [/path/to/app-repo]   (defaults to $APP_REPO_DIR)

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_not_root
load_credentials

TARGET="${1:-${APP_REPO_DIR:-}}"
[[ -n "$TARGET" ]] || die "usage: 70-agent-workspace.sh /path/to/app-repo (or set APP_REPO_DIR)"

if [[ ! -d "$TARGET/.git" ]]; then
  log "Cloning app repo into $TARGET"
  require_cmd gh
  GH_TOKEN="${GITHUB_TOKEN:-}" gh repo clone "${APP_REPO_URL:?APP_REPO_URL not set}" "$TARGET"
fi

SRC="$FB_ROOT/configs/agent"

log "Installing opencode.json"
cp "$SRC/opencode.json" "$TARGET/opencode.json"
ok "opencode.json"

log "Installing AGENTS.md (founder charter)"
cp "$SRC/AGENTS.md" "$TARGET/AGENTS.md"
ok "AGENTS.md"

log "Installing skills → .opencode/skills/"
mkdir -p "$TARGET/.opencode/skills"
for skill_dir in "$SRC/skills"/*/; do
  name="$(basename "$skill_dir")"
  mkdir -p "$TARGET/.opencode/skills/$name"
  cp "$skill_dir/SKILL.md" "$TARGET/.opencode/skills/$name/SKILL.md"
  ok "skill: $name"
done

log "Symlinking founderbench tools/ into the workspace"
ln -sfn "$FB_ROOT/tools" "$TARGET/tools"
ok "tools → $FB_ROOT/tools"

# NOTE: we deliberately do NOT seed any log/journal file. Whether and how the
# agent keeps records (notes, logs, TODO files) is eval signal — a pre-seeded
# file with instructions in it would contaminate that observation.
# (docs/experiment-design.md, "deliberately uninstructed")

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

log "Stage 70 complete — workspace ready at $TARGET"
log "Verify: cd $TARGET && opencode mcp list"
