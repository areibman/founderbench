# /// script
# requires-python = ">=3.12"
# dependencies = ["harbor"]
# ///
"""
Export a FounderBench run into a Harbor ATIF trajectory
(https://www.harborframework.com/docs/agents/trajectory-format).

Reads runs/<run-id>/trace.jsonl plus the verbatim body side files under
bodies/ and produces an ATIF-v1.7 trajectory.json:

  - user steps    <- orchestrator-injected prompts (kickoff/continue/nudge/...)
  - agent steps   <- one per model call, with message text, reasoning_content,
                     tool_calls, and per-call token/cost metrics — all parsed
                     from the RAW streamed SSE (lossless side files)
  - observations  <- tool results, recovered from the tool-role messages the
                     harness sent back in subsequent request bodies
  - final_metrics <- run.end usage totals + token spend

Built on harbor's own Pydantic models and validated with harbor's validator,
so the output is schema-true by construction.

Usage:
  uv run tracing/export_atif.py runs/<run-id> [-o runs/<run-id>/trajectory.json]
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.utils.trajectory_validator import TrajectoryValidator

ATIF_VERSION = "ATIF-v1.7"


def iso(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def read_events(run_dir: Path) -> list[dict[str, Any]]:
    events = []
    with open(run_dir / "trace.jsonl") as f:
        for line in f:
            if line.strip():
                events.append(json.loads(line))
    return events


# ── raw-body parsing ────────────────────────────────────────────────────────

def parse_chat_sse(raw: str) -> dict[str, Any]:
    """Merge a chat-completions SSE stream into one assistant message."""
    content: list[str] = []
    reasoning: list[str] = []
    tool_calls: dict[int, dict[str, Any]] = {}
    usage: dict[str, Any] | None = None
    for line in raw.split("\n"):
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            j = json.loads(payload)
        except json.JSONDecodeError:
            continue
        usage = j.get("usage") or usage
        for choice in j.get("choices") or []:
            delta = choice.get("delta") or choice.get("message") or {}
            if delta.get("content"):
                content.append(delta["content"])
            for key in ("reasoning_content", "reasoning"):
                if delta.get(key):
                    reasoning.append(delta[key])
            for tc in delta.get("tool_calls") or []:
                slot = tool_calls.setdefault(
                    tc.get("index", 0),
                    {"id": None, "name": "", "arguments": ""},
                )
                slot["id"] = tc.get("id") or slot["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]
                if fn.get("arguments"):
                    slot["arguments"] += fn["arguments"]
    return {
        "content": "".join(content) or None,
        "reasoning": "".join(reasoning) or None,
        "tool_calls": [tool_calls[i] for i in sorted(tool_calls)],
        "usage": usage,
    }


def parse_response_body(run_dir: Path, data: dict[str, Any]) -> dict[str, Any] | None:
    """Assistant turn from a model.response event (raw side file preferred)."""
    raw: str | None = None
    if data.get("bodyFile"):
        raw = (run_dir / data["bodyFile"]).read_text()
    if data.get("streaming"):
        if raw is not None:
            return parse_chat_sse(raw)
        body = data.get("body") or {}
        return {"content": body.get("text"), "reasoning": None, "tool_calls": [], "usage": None}
    wire = json.loads(raw) if raw is not None else data.get("body")
    if not isinstance(wire, dict) or "choices" not in wire:
        return None
    msg = (wire.get("choices") or [{}])[0].get("message") or {}
    return {
        "content": msg.get("content"),
        "reasoning": msg.get("reasoning_content"),
        "tool_calls": [
            {
                "id": tc.get("id"),
                "name": (tc.get("function") or {}).get("name", ""),
                "arguments": (tc.get("function") or {}).get("arguments", ""),
            }
            for tc in msg.get("tool_calls") or []
        ],
        "usage": wire.get("usage"),
    }


def tool_results_from_requests(run_dir: Path, request_events: list[dict[str, Any]]) -> dict[str, str]:
    """tool_call_id -> tool result content, mined from later request bodies."""
    results: dict[str, str] = {}
    for req in request_events:
        d = req["data"]
        if not d.get("bodyFile"):
            continue
        try:
            body = json.loads((run_dir / d["bodyFile"]).read_bytes())
        except (OSError, json.JSONDecodeError):
            continue
        for msg in body.get("messages") or []:
            if msg.get("role") != "tool":
                continue
            call_id = msg.get("tool_call_id")
            if not call_id or call_id in results:
                continue
            content = msg.get("content")
            if isinstance(content, list):
                content = "".join(
                    p.get("text", "") for p in content if isinstance(p, dict)
                )
            results[call_id] = content if isinstance(content, str) else json.dumps(content)
    return results


def parse_args_dict(arguments: str | None) -> dict[str, Any]:
    if not arguments:
        return {}
    try:
        parsed = json.loads(arguments)
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    except json.JSONDecodeError:
        return {"_raw": arguments}


# ── main ────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("run_dir", type=Path)
    ap.add_argument("-o", "--output", type=Path, default=None)
    args = ap.parse_args()
    run_dir: Path = args.run_dir
    out: Path = args.output or (run_dir / "trajectory.json")

    events = read_events(run_dir)
    run_start = next((e["data"] for e in events if e["type"] == "run.start"), {})
    run_end = next((e["data"] for e in events if e["type"] == "run.end"), {})
    cfg = run_start.get("config") or {}
    budget = cfg.get("budget") or {}
    in_cost = (budget.get("input_cost_per_mtok") or 0) / 1_000_000
    out_cost = (budget.get("output_cost_per_mtok") or 0) / 1_000_000
    model_name = (cfg.get("model") or {}).get("model_id", "unknown")

    request_events = [
        e for e in events
        if e["type"] == "model.request"
        and (e["data"].get("path") or "").endswith("/chat/completions")
    ]
    response_by_id = {
        e["data"].get("requestId"): e for e in events if e["type"] == "model.response"
    }
    injections = [
        e for e in events
        if e["type"] == "harness.message" and e.get("source") == "orchestrator"
    ]
    tool_results = tool_results_from_requests(run_dir, request_events)

    # Harness version, if opencode reported it on the bus.
    version = "unknown"
    for e in events:
        info = ((e.get("data") or {}).get("properties") or {}).get("info") or {}
        if isinstance(info, dict) and info.get("version"):
            version = str(info["version"])
            break

    # Interleave user (injected prompts) and agent (model responses) steps by time.
    timeline: list[tuple[int, str, Any]] = []
    for e in injections:
        timeline.append((e["ts"], "user", e))
    for req in request_events:
        res = response_by_id.get(req["data"]["requestId"])
        if res is None or res["data"].get("status") != 200:
            continue
        turn = parse_response_body(run_dir, res["data"])
        if turn is None:
            continue
        timeline.append((res["ts"], "agent", (req, res, turn)))
    timeline.sort(key=lambda t: t[0])

    steps: list[Step] = []
    for ts, kind, item in timeline:
        step_id = len(steps) + 1
        if kind == "user":
            steps.append(
                Step(step_id=step_id, timestamp=iso(ts), source="user",
                     message=item["data"].get("text", ""))
            )
            continue
        req, res, turn = item
        usage = turn.get("usage") or {}
        prompt_tokens = usage.get("prompt_tokens")
        completion_tokens = usage.get("completion_tokens")
        cost = (
            (prompt_tokens or 0) * in_cost + (completion_tokens or 0) * out_cost
            if usage else None
        )
        tool_calls = [
            ToolCall(
                tool_call_id=tc["id"] or f"call_{step_id}_{i}",
                function_name=tc["name"],
                arguments=parse_args_dict(tc["arguments"]),
            )
            for i, tc in enumerate(turn["tool_calls"])
        ]
        obs_results = [
            ObservationResult(source_call_id=tc.tool_call_id, content=tool_results[tc.tool_call_id])
            for tc in tool_calls
            if tc.tool_call_id in tool_results
        ]
        step_kwargs: dict[str, Any] = {
            "step_id": step_id,
            "timestamp": iso(ts),
            "source": "agent",
            "model_name": model_name,
            "extra": {"request_id": req["data"]["requestId"]},
        }
        # message is required (str | content parts); tool-calls-only turns get "".
        step_kwargs["message"] = turn["content"] if turn["content"] is not None else ""
        if turn["reasoning"] is not None:
            step_kwargs["reasoning_content"] = turn["reasoning"]
        if tool_calls:
            step_kwargs["tool_calls"] = tool_calls
        if obs_results:
            step_kwargs["observation"] = Observation(results=obs_results)
        if usage:
            step_kwargs["metrics"] = Metrics(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                cost_usd=round(cost, 6) if cost is not None else None,
            )
        steps.append(Step(**step_kwargs))

    totals = run_end.get("usage") or {}
    trajectory = Trajectory(
        schema_version=ATIF_VERSION,
        session_id=run_start.get("runId") or run_dir.name,
        agent=Agent(name="opencode", version=version, model_name=model_name),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=totals.get("inputTokens"),
            total_completion_tokens=totals.get("outputTokens"),
            total_cost_usd=run_end.get("tokenSpendUsd"),
            total_steps=len(steps),
        ),
        extra={
            "source": "founderbench",
            "run_id": run_start.get("runId"),
            "stop_condition": run_end.get("reason"),
            "business_spend_usd": run_end.get("businessSpendUsd"),
        },
    )

    payload = trajectory.to_json_dict()
    validator = TrajectoryValidator()
    if not validator.validate(payload):
        for err in validator.get_errors():
            print(f"  validation error: {err}")
        raise SystemExit("ATIF validation failed — not writing output")

    out.write_text(json.dumps(payload, indent=2))
    agent_steps = sum(1 for s in steps if s.source == "agent")
    with_tools = sum(1 for s in steps if s.tool_calls)
    with_reasoning = sum(1 for s in steps if s.reasoning_content)
    print(
        f"exported {trajectory.session_id}: {len(steps)} steps "
        f"({agent_steps} agent, {len(steps) - agent_steps} user; "
        f"{with_tools} with tool_calls, {with_reasoning} with reasoning_content) "
        f"— ATIF valid → {out}"
    )


if __name__ == "__main__":
    main()
