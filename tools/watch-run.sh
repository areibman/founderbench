#!/usr/bin/env bash
# Live "chat view" of a FounderBench run — tails trace.jsonl and renders it
# like a conversation: injected prompts, assistant text/reasoning as it
# streams, tool calls with status, state changes, and errors. Read-only:
# watching does not touch the run. The replay UI remains the full-fidelity
# view; this is the glanceable terminal one.
#
# Usage: tools/watch-run.sh [run-id]     # default: newest run directory
set -euo pipefail

FB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Newest run *directory* that actually has a trace — runs/ also contains
# launchd log files, which must not win the "latest run" pick.
latest_run() {
  for dir in $(ls -1dt "$FB_ROOT/runs"/*/ 2>/dev/null); do
    if [[ -f "$dir/trace.jsonl" ]]; then basename "$dir"; return; fi
  done
}
RID="${1:-$(latest_run)}"
[[ -n "$RID" ]] || { echo "no runs with a trace under $FB_ROOT/runs" >&2; exit 1; }
TRACE="$FB_ROOT/runs/$RID/trace.jsonl"
[[ -f "$TRACE" ]] || { echo "no trace at $TRACE" >&2; exit 1; }
echo ">>> watching $RID (Ctrl+C stops watching, not the run)" >&2

# -n +1: replay history first, then follow. -F survives file rotation.
# Rendering is stateful (delta/part dedupe, role tracking) — see watch_run.py.
tail -n +1 -F "$TRACE" | python3 -u "$FB_ROOT/tools/watch_run.py"
