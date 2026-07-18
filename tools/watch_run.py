#!/usr/bin/env python3
"""Trace renderer for tools/watch-run.sh — reads trace.jsonl lines on stdin,
writes a readable conversation stream: injected prompts, assistant text and
reasoning as they arrive (delta or whole-part, whichever the provider path
emits), tool calls with status, state changes, errors.

Stateful on purpose: deduplicates streaming deltas against final part
updates, suppresses the user-message echo (the injected prompt is already
rendered from the orchestrator event), and prints each tool status once.
"""
import json
import sys


def c(code: str, s: str) -> str:
    return f"\x1b[{code}m{s}\x1b[0m"


def w(s: str) -> None:
    sys.stdout.write(s)
    sys.stdout.flush()


printed: dict[str, int] = {}   # partID -> chars already printed
part_type: dict[str, str] = {}  # partID -> "text" | "reasoning" | ...
roles: dict[str, str] = {}     # messageID -> "user" | "assistant"
tool_state: dict[str, str] = {}  # partID -> last printed tool status


def text_out(pid: str, mid: str, full_or_delta: str, *, delta: bool) -> None:
    if roles.get(mid) == "user":
        return
    kind = part_type.get(pid, "text")
    off = printed.get(pid, 0)
    chunk = full_or_delta if delta else full_or_delta[off:]
    if not chunk:
        return
    if off == 0:
        w("\n")
    w(c("2", chunk) if kind == "reasoning" else chunk)
    printed[pid] = off + len(chunk)


def on_part(part: dict) -> None:
    pid = part.get("id") or ""
    ptype = part.get("type") or ""
    if pid:
        part_type[pid] = ptype
    if ptype in ("text", "reasoning"):
        text_out(pid, part.get("messageID") or "", part.get("text") or "", delta=False)
    elif ptype == "tool":
        status = ((part.get("state") or {}).get("status")) or ""
        if tool_state.get(pid) == status:
            return
        tool_state[pid] = status
        state = part.get("state") or {}
        name = part.get("tool") or "tool"
        if status == "running":
            w("\n" + c("36", f"⚙ {name} …") + "\n")
        elif status == "completed":
            title = str(state.get("title") or "")
            w("\n" + c("32", f"✓ {name}") + (c("2", f" {title}") if title else "") + "\n")
        elif status == "error":
            w("\n" + c("31", f"✗ {name}: {state.get('error') or ''}") + "\n")


for line in sys.stdin:
    try:
        e = json.loads(line)
    except json.JSONDecodeError:
        continue
    t = e.get("type")
    d = e.get("data") or {}
    if t == "run.state":
        w("\n" + c("1;35", f"── [{d.get('state')}] ──") + "\n")
    elif t == "run.nudge":
        w("\n" + c("35", f"[nudge] {d.get('reason') or ''}") + "\n")
    elif t == "run.end":
        w("\n\n" + c("1;35", f"══ RUN END: {d.get('reason') or ''} ══") + "\n")
    elif t == "env.error":
        w("\n" + c("1;31", f"[error] {d.get('message') or d}") + "\n")
    elif t in ("harness.message", "harness.tool", "harness.event"):
        if d.get("direction") == "inject":
            w("\n\n" + c("1;33", "╭─ PROMPT INJECTED ─────────────────────────") + "\n"
              + c("33", str(d.get("text") or "")) + "\n"
              + c("1;33", "╰───────────────────────────────────────────") + "\n")
            continue
        bus = d.get("type") or ""
        props = d.get("properties") or {}
        if not isinstance(props, dict):
            continue
        if bus == "message.updated":
            info = props.get("info") or {}
            if info.get("id"):
                roles[info["id"]] = info.get("role") or ""
        elif bus == "message.part.delta" and props.get("field") == "text":
            text_out(props.get("partID") or "", props.get("messageID") or "",
                     str(props.get("delta") or ""), delta=True)
        elif bus == "message.part.updated":
            part = props.get("part")
            if isinstance(part, dict):
                on_part(part)
