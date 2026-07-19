#!/usr/bin/env bash
# List runs, newest first: id, when it started, how long it ran, model,
# whether it completed, and how much the agent actually did.
#
# Usage: tools/runs.sh [n]        # default: 10 newest
set -euo pipefail
FB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N="${1:-10}"

python3 - "$FB_ROOT/runs" "$N" << 'EOF'
import json, os, sys
from datetime import datetime

root, n = sys.argv[1], int(sys.argv[2])
rows = []
run_dirs = sorted(
    (d for d in os.listdir(root) if os.path.isfile(os.path.join(root, d, "trace.jsonl"))),
    key=lambda d: os.path.getmtime(os.path.join(root, d)), reverse=True)[:n]

for rid in run_dirs:
    rdir = os.path.join(root, rid)
    start = end = None
    turns = errors = 0
    with open(os.path.join(rdir, "trace.jsonl")) as f:
        for line in f:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = e.get("type")
            if t == "run.start" and start is None:
                start = e
            elif t == "model.request":
                turns += 1
            elif t == "env.error":
                errors += 1
            elif t == "run.end":
                end = e
    if start is None:
        continue
    cfg = (start.get("data") or {}).get("config") or {}
    model = (cfg.get("model") or {}).get("model_id", "?")
    began = datetime.fromtimestamp(start["ts"] / 1000).strftime("%b %d %H:%M")
    if end:
        mins = (end["ts"] - start["ts"]) / 60000
        dur = f"{mins/60:.1f}h" if mins >= 90 else f"{mins:.0f}m"
    else:
        dur = "?"
    done = "✓ done" if os.path.exists(os.path.join(rdir, "COMPLETED")) else (
        "… incomplete" if end is None else "ended, no marker")
    atif = "atif" if os.path.exists(os.path.join(rdir, "trajectory.json")) else ""
    rows.append((rid, began, dur, model, str(turns), str(errors), done, atif))

if not rows:
    print("no runs found", file=sys.stderr)
    sys.exit(1)
hdr = ("RUN ID", "STARTED", "DUR", "MODEL", "TURNS", "ERRS", "STATUS", "EXPORTS")
widths = [max(len(r[i]) for r in [hdr, *rows]) for i in range(len(hdr))]
for r in [hdr, *rows]:
    print("  ".join(v.ljust(widths[i]) for i, v in enumerate(r)))
EOF
