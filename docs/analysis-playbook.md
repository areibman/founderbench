# Analysis playbook — 72h fleet

How to go from seven run directories to a pile of citable evidence.
The investigator prompt is `docs/investigation-guide.md`. A human
reviews that evidence and writes the public post. This playbook does
not prescribe the post.

Incident codes (`docs/trace-analysis-rubric.md`) are a **later**
researcher pass. Do not send that rubric to the people hunting stories.

---

## 0. You need the runs on disk

`runs/` is gitignored. Copy or mount the seven `pilot72-<arm>-*`
directories so each has `trace.jsonl`. Without that, stop.

Ground-truth pulls: Meow transaction history and Inkbox mailboxes for
the seven arms. Trace still owns timing, tool calls, and continues.

---

## 1. Prep (mechanical, once per run)

From the repo root:

```sh
RID=runs/<run-id>

uv run --project tracing tracing/export_atif.py "$RID"
python3 tracing/prep_analysis.py "$RID"

# search surface — investigators never open trajectory.json whole
jq -c '.steps[]' "$RID/trajectory.json" > "$RID/analysis/steps.jsonl"
```

That writes:

| Path | What |
| --- | --- |
| `trajectory.json` | Harbor ATIF. Huge. Do not load it as a book. |
| `analysis/anchors.jsonl` | Lifecycle, gaps, snapshots. Small. Read it. |
| `analysis/run-stats.json` | Counts, tool histogram, duration. |
| `analysis/steps.jsonl` | One step per line. **Grep this.** |
| `analysis/trajectory-chunk-*.json` | Ignore for this phase. Sequential
  chunk summaries hallucinate themes. |

Optional, same as the runbook:

```sh
uv run --project tracing tracing/export_vf_trace.py "$RID"
```

If `steps.jsonl` is still too big for one `rg`, split it (`split -l 2000`)
and grep the parts. Do not summarize the parts “to be helpful.”

---

## 2. Investigate (N people or agents)

Give each investigator:

- this playbook’s §1 outputs for **one** run
- `docs/investigation-guide.md`
- `configs/agent/AGENTS.md`
- one question or one time-slice from the guide (or the whole guide, if N=1)

They search `steps.jsonl`, read hit windows, follow nouns, append to:

```
runs/<id>/analysis/findings.jsonl
```

Scale N up or down. Overlap is useful.

Do **not**: walk every chunk, stuff the trajectory into a context window,
or start from the words *spam / lie / desperate*.

---

## 3. Merge (one pass per arm)

When findings are in, merge by **plot**, not by clue. Same story from
three investigators → one finding with extra evidence. No quote or no
step id → kill it.

Write the surviving set to:

```
runs/<id>/analysis/findings.jsonl
```

(or a `findings-merged.jsonl` if you want to keep the raw append-only
file). This is the packet a human reads. It is not a draft of the post.

---

## 4. Cohort numbers (mechanical)

Optional but useful next to the findings. One row per arm, wherever you
want to keep it (`analysis/cohort.json` or a scratch dir).

| Number | Where |
| --- | --- |
| Token burn over time | `budget.update` in the trace (~1/min) and `run.end` |
| Continues | ATIF `source: "user"` steps whose text is the continue prompt
  in `configs/pilot-72h.toml` |
| Mean work-bout | interval between consecutive continues |
| Stall nudges | `run.nudge` in anchors |
| Tool-call counts | `run-stats.json` → `trajectory.tool_call_counts` |
| Sleep hours | `sleep N` in bash args; ignore tiny retry sleeps |
| Unread mail curve | `metrics.snapshot` → `unread_support_mail` |
| Stripe balance / collected | same snapshots |
| Bank curve + purchases | Meow transactions API (not in snapshots) |
| Mail sent / read totals | Inkbox now; timing from the trace |
| LOC | `git --git-dir=$RID/shadow.git diff --shortstat` from the
  empty/start tree |
| Web searches | tool names matching `exa` (and kin) in `tool_call_counts` |

Keep cash, Stripe, and token burn as three separate series. Token burn
is provider credits, not cash.

---

## 5. Fact-check

Every number a human might quote has to match Meow, Stripe, Inkbox, or
`run-stats` / snapshots. Every quote has to replay in the UI
(`npm run replay` → `extra.request_id` on the step).

If it is not citable, it does not go in the packet.

---

## Done when

- Each of the seven runs has `steps.jsonl` + `findings.jsonl`
- Findings are merged and fact-checked
- A human can write the post from that packet without opening a gig-file
