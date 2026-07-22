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
from datetime import datetime


def c(code: str, s: str) -> str:
    return f"\x1b[{code}m{s}\x1b[0m"


def w(s: str) -> None:
    sys.stdout.write(s)
    sys.stdout.flush()


printed: dict[str, int] = {}   # partID -> chars already printed
part_type: dict[str, str] = {}  # partID -> "text" | "reasoning" | ...
roles: dict[str, str] = {}     # messageID -> "user" | "assistant"
tool_state: dict[str, str] = {}  # partID -> last printed tool status
# Parts that have sent a cumulative message.part.updated. Some provider paths
# (e.g. detailed reasoning summaries) emit BOTH per-token deltas AND cumulative
# part.updated events for the same text; rendering both double-prints every
# chunk. Once a part is seen via part.updated, that channel is authoritative and
# we ignore its deltas. Parts that only ever stream deltas still render.
seen_updated: set[str] = set()

cur_dt = None  # datetime of the event being rendered (None until first event)
last_day = ""


def stamp() -> str:
    """Dim [HH:MM:SS] prefix from the current event's trace timestamp."""
    return c("2", f"[{cur_dt.strftime('%H:%M:%S')}] ") if cur_dt else ""


def text_out(pid: str, mid: str, full_or_delta: str, *, delta: bool) -> None:
    if roles.get(mid) == "user":
        return
    kind = part_type.get(pid, "text")
    off = printed.get(pid, 0)
    chunk = full_or_delta if delta else full_or_delta[off:]
    if not chunk:
        return
    if off == 0:
        w("\n" + stamp())
    w(c("2", chunk) if kind == "reasoning" else chunk)
    printed[pid] = off + len(chunk)


def on_part(part: dict) -> None:
    pid = part.get("id") or ""
    ptype = part.get("type") or ""
    if pid:
        part_type[pid] = ptype
    if ptype in ("text", "reasoning"):
        # Cumulative update seen → this is the authoritative channel for pid;
        # any concurrent per-token deltas for the same part are now suppressed.
        if pid:
            seen_updated.add(pid)
        text_out(pid, part.get("messageID") or "", part.get("text") or "", delta=False)
    elif ptype == "tool":
        status = ((part.get("state") or {}).get("status")) or ""
        if tool_state.get(pid) == status:
            return
        tool_state[pid] = status
        state = part.get("state") or {}
        name = part.get("tool") or "tool"
        if status == "running":
            w("\n" + stamp() + c("36", f"⚙ {name} …") + "\n")
        elif status == "completed":
            title = str(state.get("title") or "")
            w("\n" + stamp() + c("32", f"✓ {name}") + (c("2", f" {title}") if title else "") + "\n")
        elif status == "error":
            w("\n" + stamp() + c("31", f"✗ {name}: {state.get('error') or ''}") + "\n")


for line in sys.stdin:
    try:
        e = json.loads(line)
    except json.JSONDecodeError:
        continue
    t = e.get("type")
    d = e.get("data") or {}
    ts = e.get("ts")
    if isinstance(ts, (int, float)) and ts > 0:
        cur_dt = datetime.fromtimestamp(ts / 1000)
        day = cur_dt.strftime("%Y-%m-%d")
        if day != last_day:
            last_day = day
            w("\n" + c("1;2", f"──────── {day} ────────") + "\n")
    if t == "run.state":
        w("\n" + stamp() + c("1;35", f"── [{d.get('state')}] ──") + "\n")
    elif t == "run.nudge":
        w("\n" + stamp() + c("35", f"[nudge] {d.get('reason') or ''}") + "\n")
    elif t == "run.end":
        w("\n\n" + stamp() + c("1;35", f"══ RUN END: {d.get('reason') or ''} ══") + "\n")
    elif t == "env.error":
        w("\n" + stamp() + c("1;31", f"[error] {d.get('message') or d}") + "\n")
    elif t in ("harness.message", "harness.tool", "harness.event"):
        if d.get("direction") == "inject":
            w("\n\n" + stamp() + c("1;33", "╭─ PROMPT INJECTED ─────────────────────────") + "\n"
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
            pid = props.get("partID") or ""
            if pid in seen_updated:
                continue  # dual-channel part — cumulative updates own the render
            text_out(pid, props.get("messageID") or "",
                     str(props.get("delta") or ""), delta=True)
        elif bus == "message.part.updated":
            part = props.get("part")
            if isinstance(part, dict):
                on_part(part)
