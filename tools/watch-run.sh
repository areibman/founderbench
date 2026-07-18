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
RID="${1:-$(ls -t "$FB_ROOT/runs" | head -1)}"
TRACE="$FB_ROOT/runs/$RID/trace.jsonl"
[[ -f "$TRACE" ]] || { echo "no trace at $TRACE" >&2; exit 1; }
echo ">>> watching $RID (Ctrl+C stops watching, not the run)" >&2

# -n +1: replay history first, then follow. -F survives file rotation.
tail -n +1 -F "$TRACE" | jq -rj --unbuffered '
  def C(code; s): "\u001b[" + code + "m" + s + "\u001b[0m";
  if .type == "run.state" then
    "\n" + C("1;35"; "── [" + (.data.state // "?") + "] ──") + "\n"
  elif .type == "harness.message" and (.data.direction? == "inject") then
    "\n\n" + C("1;33"; "╭─ PROMPT INJECTED ─────────────────────────") + "\n"
    + C("33"; (.data.text // "")) + "\n"
    + C("1;33"; "╰───────────────────────────────────────────") + "\n"
  elif .type == "harness.message"
       and (.data.type? == "message.part.delta")
       and (.data.properties.field? == "text") then
    (.data.properties.delta // "")
  elif .type == "harness.message"
       and (.data.type? == "message.part.updated")
       and (.data.properties.part.type? == "tool") then
    (.data.properties.part as $p
     | if $p.state.status == "running" then
         "\n" + C("36"; "⚙ " + ($p.tool // "tool") + " …") + "\n"
       elif $p.state.status == "completed" then
         "\n" + C("32"; "✓ " + ($p.tool // "tool"))
         + C("2"; " " + (($p.state.title // "") | tostring)) + "\n"
       elif $p.state.status == "error" then
         "\n" + C("31"; "✗ " + ($p.tool // "tool") + ": "
         + (($p.state.error // "") | tostring)) + "\n"
       else empty end)
  elif .type == "env.error" then
    "\n" + C("1;31"; "[error] " + ((.data.message // .data) | tostring)) + "\n"
  elif .type == "run.nudge" then
    "\n" + C("35"; "[nudge] " + ((.data.reason // "") | tostring)) + "\n"
  elif .type == "run.end" then
    "\n\n" + C("1;35"; "══ RUN END: " + ((.data.reason // "") | tostring) + " ══") + "\n"
  else empty end
'
