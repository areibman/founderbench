"""
Prepare a run for LLM trace analysis (docs/trace-analysis-rubric.md).

Reads runs/<run-id>/trace.jsonl (and trajectory.json if present — produce it
first with export_atif.py) and writes runs/<run-id>/analysis/:

  anchors.jsonl            rare, high-signal events the ATIF trajectory omits:
                           run lifecycle, env dialogs/errors/preflight,
                           git commits, metrics snapshots, budget events,
                           permissions, failed (non-2xx) model calls, plus
                           synthetic analysis.gap markers for silences
  run-stats.json           precomputed numbers the rubric's B3/B4 checks use
  trajectory-chunk-NN.json trajectory steps split for context-window-sized
                           analysis passes (only when trajectory.json exists)

Stdlib only — run with plain python3:

  python3 tracing/prep_analysis.py runs/<run-id> [--gap-minutes 10] [--chunk-steps 200]
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

# Anchor selection: exact types and prefixes. Periodic/noisy types
# (run.checkpoint, env.screenshot, env.fs, model traffic, harness bus chatter)
# are deliberately excluded — the trajectory and raw trace cover those.
ANCHOR_TYPES = {
    "run.start", "run.state", "run.nudge", "run.restart", "run.end",
    "env.dialog", "env.error", "env.preflight",
    "git.commit", "metrics.snapshot",
    "budget.update", "budget.breach",
    "harness.permission",
}


def read_events(trace_path: Path) -> list[dict[str, Any]]:
    events = []
    with open(trace_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def is_anchor(event: dict[str, Any]) -> bool:
    etype = event.get("type", "")
    if etype in ANCHOR_TYPES:
        return True
    # Failed model calls are invisible in the ATIF export (it skips non-200s).
    if etype == "model.response":
        status = (event.get("data") or {}).get("status")
        return not (isinstance(status, int) and 200 <= status < 300)
    return False


def gap_markers(events: list[dict[str, Any]], gap_ms: int) -> list[dict[str, Any]]:
    """Synthetic analysis.gap events for unexplained silences (rubric E4)."""
    markers = []
    for prev, cur in zip(events, events[1:]):
        delta = cur["ts"] - prev["ts"]
        if delta >= gap_ms:
            markers.append({
                "id": f"gap-{prev['id']}",
                "ts": prev["ts"],
                "type": "analysis.gap",
                "source": "prep_analysis",
                "data": {
                    "gapMinutes": round(delta / 60000, 1),
                    "afterEventId": prev["id"],
                    "afterEventType": prev["type"],
                    "beforeEventId": cur["id"],
                    "beforeEventType": cur["type"],
                },
            })
    return markers


def percentile(sorted_values: list[float], p: float) -> float | None:
    if not sorted_values:
        return None
    idx = min(len(sorted_values) - 1, int(p * len(sorted_values)))
    return sorted_values[idx]


def build_stats(
    events: list[dict[str, Any]],
    trajectory: dict[str, Any] | None,
    anchors: list[dict[str, Any]],
) -> dict[str, Any]:
    type_counts = Counter(e.get("type", "?") for e in events)
    sessions = {e["sessionId"] for e in events if e.get("sessionId")}
    # A session whose events carry a parentId pointing outside itself is a
    # subagent branch (trace.ts models subagents as branches via parent links).
    child_sessions = {
        e["sessionId"]
        for e in events
        if e.get("sessionId") and e.get("parentId")
        and e.get("type", "").startswith("harness.")
    }

    run_start = next((e for e in events if e.get("type") == "run.start"), None)
    run_end = next((e for e in events if e.get("type") == "run.end"), None)
    duration_ms = (
        run_end["ts"] - run_start["ts"] if run_start and run_end
        else (events[-1]["ts"] - events[0]["ts"] if events else 0)
    )

    stats: dict[str, Any] = {
        "run_id": (run_start or {}).get("data", {}).get("runId"),
        "duration_hours": round(duration_ms / 3_600_000, 2),
        "ended": run_end is not None,
        "end_reason": (run_end or {}).get("data", {}).get("reason"),
        "event_counts": dict(type_counts),
        "nudges": type_counts.get("run.nudge", 0),
        "restarts": type_counts.get("run.restart", 0),
        "dialogs": type_counts.get("env.dialog", 0),
        "env_errors": type_counts.get("env.error", 0),
        "budget_breaches": type_counts.get("budget.breach", 0),
        "failed_model_calls": sum(
            1 for a in anchors if a.get("type") == "model.response"
        ),
        "gaps": sum(1 for a in anchors if a.get("type") == "analysis.gap"),
        "sessions": len(sessions),
        "subagent_sessions": len(child_sessions),
        "token_spend_usd": (run_end or {}).get("data", {}).get("tokenSpendUsd"),
        "business_spend_usd": (run_end or {}).get("data", {}).get("businessSpendUsd"),
    }

    if trajectory:
        steps = trajectory.get("steps", [])
        agent_steps = [s for s in steps if s.get("source") == "agent"]
        tool_counts: Counter[str] = Counter()
        for s in agent_steps:
            for tc in s.get("tool_calls") or []:
                tool_counts[tc.get("function_name", "?")] += 1
        # Inter-step gaps expose where wall-clock time went (rubric B3).
        from datetime import datetime

        def ts(s: dict[str, Any]) -> float:
            return datetime.fromisoformat(
                s["timestamp"].replace("Z", "+00:00")
            ).timestamp()

        gaps_s = sorted(
            ts(b) - ts(a) for a, b in zip(steps, steps[1:])
        ) if len(steps) > 1 else []
        top_gaps = [
            {
                "after_step": steps[i]["step_id"],
                "before_step": steps[i + 1]["step_id"],
                "minutes": round((ts(steps[i + 1]) - ts(steps[i])) / 60, 1),
            }
            for i in sorted(
                range(len(steps) - 1),
                key=lambda i: ts(steps[i + 1]) - ts(steps[i]),
                reverse=True,
            )[:10]
        ] if len(steps) > 1 else []

        stats["trajectory"] = {
            "total_steps": len(steps),
            "agent_steps": len(agent_steps),
            "user_steps": len(steps) - len(agent_steps),
            "steps_with_reasoning": sum(
                1 for s in agent_steps if s.get("reasoning_content")
            ),
            "tool_call_counts": dict(tool_counts.most_common()),
            "step_gap_seconds": {
                "p50": percentile(gaps_s, 0.5),
                "p90": percentile(gaps_s, 0.9),
                "max": gaps_s[-1] if gaps_s else None,
            },
            "largest_step_gaps": top_gaps,
        }
    return stats


def write_chunks(
    trajectory: dict[str, Any], out_dir: Path, chunk_steps: int
) -> int:
    steps = trajectory.get("steps", [])
    if not steps:
        return 0
    header = {k: v for k, v in trajectory.items() if k != "steps"}
    n_chunks = 0
    for start in range(0, len(steps), chunk_steps):
        chunk = dict(header)
        chunk["chunk"] = {
            "index": n_chunks,
            "step_range": [
                steps[start]["step_id"],
                steps[min(start + chunk_steps, len(steps)) - 1]["step_id"],
            ],
            "total_steps": len(steps),
        }
        chunk["steps"] = steps[start:start + chunk_steps]
        path = out_dir / f"trajectory-chunk-{n_chunks:02d}.json"
        path.write_text(json.dumps(chunk, indent=2))
        n_chunks += 1
    return n_chunks


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("run_dir", type=Path)
    ap.add_argument("--gap-minutes", type=float, default=10.0,
                    help="silence threshold for analysis.gap markers")
    ap.add_argument("--chunk-steps", type=int, default=200,
                    help="trajectory steps per chunk file")
    args = ap.parse_args()

    run_dir: Path = args.run_dir
    trace_path = run_dir / "trace.jsonl"
    if not trace_path.exists():
        raise SystemExit(f"no trace.jsonl in {run_dir}")

    events = read_events(trace_path)
    events.sort(key=lambda e: e["ts"])

    anchors = [e for e in events if is_anchor(e)]
    anchors.extend(gap_markers(events, int(args.gap_minutes * 60_000)))
    anchors.sort(key=lambda e: e["ts"])

    trajectory = None
    traj_path = run_dir / "trajectory.json"
    if traj_path.exists():
        trajectory = json.loads(traj_path.read_text())

    out_dir = run_dir / "analysis"
    out_dir.mkdir(exist_ok=True)

    anchors_path = out_dir / "anchors.jsonl"
    anchors_path.write_text(
        "".join(json.dumps(a) + "\n" for a in anchors)
    )

    stats = build_stats(events, trajectory, anchors)
    (out_dir / "run-stats.json").write_text(json.dumps(stats, indent=2))

    n_chunks = write_chunks(trajectory, out_dir, args.chunk_steps) if trajectory else 0

    print(
        f"{run_dir.name}: {len(events)} events -> {len(anchors)} anchors, "
        f"run-stats.json"
        + (f", {n_chunks} trajectory chunk(s)" if n_chunks else
           " (no trajectory.json — run export_atif.py first for chunks)")
    )


if __name__ == "__main__":
    main()
