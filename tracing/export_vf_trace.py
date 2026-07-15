# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "verifiers @ git+https://github.com/PrimeIntellect-ai/verifiers",
# ]
# ///
"""
Export a FounderBench run into a verifiers v1 `Trace` ("PI trace").

Reads runs/<run-id>/trace.jsonl (+ verbatim body side files under bodies/) and
reconstructs the vf message graph exactly as verifiers' interception server
would have recorded it in eval mode: each model call's prompt is prefix-matched
against the graph (prepare_turn), only new suffix nodes are appended (commit),
and compaction/subagent calls become branches automatically.

Eval-mode parity notes:
  - token_ids/logprobs are empty — true of verifiers' EvalClient too.
  - rewards/metrics are scoring outputs, left empty here (Phase 7 fills them).
  - environment-layer events (screenshots, dialogs, spend) go into trace.info.

Usage:
  uv run tracing/export_vf_trace.py runs/<run-id> [-o runs/<run-id>/vf-trace.json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import verifiers.v1.types as vft
from verifiers.v1.dialects.chat import ChatStreamParser
from verifiers.v1.dialects import parse_message, parse_tools
from verifiers.v1.graph import prepare_turn
from verifiers.v1.trace import Trace, TraceTask


def read_events(run_dir: Path) -> list[dict[str, Any]]:
    events = []
    with open(run_dir / "trace.jsonl") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                print(f"warning: unparseable trace line skipped", file=sys.stderr)
    return events


def load_request_body(run_dir: Path, data: dict[str, Any]) -> dict[str, Any] | None:
    """Full request body: side file (new traces) or inline (old traces)."""
    if data.get("bodyFile"):
        return json.loads((run_dir / data["bodyFile"]).read_bytes())
    body = data.get("body")
    if isinstance(body, dict):
        if body.get("__clipped"):
            raise SystemExit(
                f"request {data.get('requestId')} was recorded with a clipped body — "
                "this run predates lossless tracing and cannot be exported faithfully"
            )
        return body
    return None


def response_to_vf(run_dir: Path, data: dict[str, Any]) -> vft.Response | None:
    """Rebuild a vf Response from the recorded response (raw side file preferred)."""
    raw: bytes | None = None
    if data.get("bodyFile"):
        raw = (run_dir / data["bodyFile"]).read_bytes()

    if data.get("streaming"):
        parser = ChatStreamParser()
        if raw is not None:
            for event in raw.split(b"\n\n"):
                if event.strip():
                    parser.feed(event)
        else:
            # Old lossy traces: only collapsed text survives. Best-effort message.
            body = data.get("body") or {}
            parser.message_parts["content"].append(body.get("text", ""))
            parser.usage = usage_from_event(data)
        return parser.finish()

    # Non-streaming JSON completion.
    if raw is not None:
        wire = json.loads(raw)
    else:
        wire = data.get("body")
    if not isinstance(wire, dict) or "choices" not in wire:
        return None
    choice = (wire.get("choices") or [{}])[0]
    message = choice.get("message") or {"role": "assistant", "content": ""}
    usage = wire.get("usage") or {}
    return vft.Response(
        id=wire.get("id", ""),
        created=wire.get("created", 0),
        model=wire.get("model", ""),
        message=parse_message(message),
        finish_reason=normalize_finish(choice.get("finish_reason")),
        usage=vft.Usage(
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
        ),
        raw=wire,
    )


def usage_from_event(data: dict[str, Any]) -> dict[str, int] | None:
    u = data.get("usage")
    if not u:
        return None
    return {"prompt_tokens": u.get("inputTokens", 0), "completion_tokens": u.get("outputTokens", 0)}


def normalize_finish(reason: str | None) -> str:
    return reason if reason in ("stop", "length", "tool_calls") else "stop"


def is_completion_request(data: dict[str, Any]) -> bool:
    return (data.get("path") or "").endswith("/chat/completions") and data.get("method") == "POST"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("run_dir", type=Path, help="runs/<run-id> directory")
    ap.add_argument("-o", "--output", type=Path, default=None)
    args = ap.parse_args()
    run_dir: Path = args.run_dir
    out: Path = args.output or (run_dir / "vf-trace.json")

    events = read_events(run_dir)
    requests: dict[str, dict[str, Any]] = {}
    responses: dict[str, dict[str, Any]] = {}
    run_start: dict[str, Any] | None = None
    run_end: dict[str, Any] | None = None
    env_summary = {"screenshots": 0, "dialogs": 0, "errors": 0, "restarts": 0, "nudges": 0}

    for e in events:
        t, d = e.get("type"), e.get("data") or {}
        if t == "model.request" and is_completion_request(d):
            requests[d["requestId"]] = d
        elif t == "model.response":
            responses[d.get("requestId", "")] = d
        elif t == "run.start":
            run_start = d
        elif t == "run.end":
            run_end = d
        elif t == "env.screenshot":
            env_summary["screenshots"] += 1
        elif t == "env.dialog":
            env_summary["dialogs"] += 1
        elif t == "env.error":
            env_summary["errors"] += 1
        elif t == "run.restart":
            env_summary["restarts"] += 1
        elif t == "run.nudge":
            env_summary["nudges"] += 1

    run_id = (run_start or {}).get("runId") or run_dir.name
    trace = Trace(
        id=run_id,
        task=TraceTask(type="founderbench", data={"runId": run_id}),
    )

    turns = skipped = 0
    all_tools: list[vft.Tool] | None = None
    for request_id, req in requests.items():
        res = responses.get(request_id)
        if res is None or res.get("status") != 200:
            skipped += 1
            continue
        body = load_request_body(run_dir, req)
        if body is None:
            skipped += 1
            continue
        messages = [parse_message(m) for m in body.get("messages", [])]
        tools = parse_tools(body.get("tools")) if body.get("tools") else None
        if tools:
            all_tools = tools  # last-seen toolset (they're stable within a run)
        response = response_to_vf(run_dir, res)
        if response is None:
            skipped += 1
            continue
        pending = prepare_turn(trace, messages)
        pending.commit(response)
        turns += 1

    trace.tools = all_tools
    trace.is_completed = (run_dir / "COMPLETED").exists()
    trace.stop_condition = (run_end or {}).get("reason")
    trace.info = {
        "source": "founderbench",
        "config": (run_start or {}).get("config"),
        "usage_totals": (run_end or {}).get("usage"),
        "token_spend_usd": (run_end or {}).get("tokenSpendUsd"),
        "business_spend_usd": (run_end or {}).get("businessSpendUsd"),
        "duration_ms": (run_end or {}).get("durationMs"),
        "environment": env_summary,
        "skipped_model_calls": skipped,
    }

    out.write_text(trace.model_dump_json(indent=2))
    print(
        f"exported {run_id}: {turns} turns, {len(trace.nodes)} nodes, "
        f"{trace.num_branches} branch(es), {trace.total_tokens} tokens "
        f"({skipped} non-completion/failed calls skipped) → {out}"
    )


if __name__ == "__main__":
    main()
