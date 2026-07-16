# Runbook

## Run ladder

Each rung gates the next. Gate criteria: **complete trace, zero human interventions,
every blocker fixed AND a check added to `machine/verify.sh`.**

1. **2h smoke** (`configs/smoke-2h.toml`) — no spending; proves every tool works.
2. **24h unattended** (`configs/pilot-24h.toml`) — real operation, $200 cap.
3. **3 days** — copy pilot-24h.toml, `duration_hours = 72`, raise caps deliberately.
4. **1 week** — same pattern.

## Starting a run

```sh
# Pre-flight (every run)
cd machine && ./verify.sh          # must be 100% green
cd .. 

# Foreground (smoke runs, watching):
npm run orchestrator -- --config configs/smoke-2h.toml

# Unattended (launchd KeepAlive; survives crashes and reboots):
./machine/80-install-launchd.sh configs/pilot-24h.toml
```

## Watching a run (without touching the machine!)

Do not log into the GUI session — it disrupts the console session the agent owns.
Use SSH:

```sh
tail -f runs/<run-id>/trace.jsonl | jq -r '[.type, .source] | @tsv'
tail -f runs/orchestrator.launchd.log
```

Or the replay UI from your own machine (SSH tunnel):

```sh
ssh -L 8787:localhost:8787 agent@mac-mini 'cd founderbench && npm run replay'
open http://localhost:8787
```

## Run states (trace `run.state` events)

`starting → running ⇄ idle` is the healthy loop.
`stalled` → orchestrator nudges (max N), then restarts the harness (same session, so
context survives). `blocked-by-dialog` → watchdog captured evidence; this is an
environment bug: fix it, add a verify.sh check. `crashed` → opencode process died;
auto-restart. `wrapping-up → completed` → COMPLETED marker written; launchd stops
restarting.

## Stopping a run early

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.founderbench.orchestrator.plist
# then check the workspace for uncommitted changes / running ads before walking away
```

## After a run

1. Confirm `runs/<run-id>/COMPLETED` exists and `run.end` is in the trace.
2. Read `BUSINESS_LOG.md` in the app repo (the agent's own account of the run).
3. Open the replay UI: walk every `env.dialog`, `env.error`, `run.restart`, and
   `budget.*` event. Each one is either an environment bug (fix + verify.sh check)
   or evidence for the failure taxonomy.
4. Snapshot the machine state if anything drifted: `sudo tmutil localsnapshot`.
5. File the run summary in `docs/` (metrics + failure taxonomy classification).
6. Export researcher-facing trace formats (both schema-validated by construction):

```sh
uv run tracing/export_vf_trace.py runs/<run-id>   # verifiers v1 Trace (message graph, branches)
uv run tracing/export_atif.py runs/<run-id>       # Harbor ATIF-v1.7 trajectory.json (steps, tools, reasoning)
```

## Resume semantics

- launchd `KeepAlive` restarts the orchestrator on any non-zero exit.
- `orchestrator/run-daemon.sh` finds the newest run directory with a checkpoint but no
  COMPLETED marker and resumes it (same run id, same OpenCode session → context intact).
- Wall-clock end time is preserved in the checkpoint, so a crash near the end doesn't
  extend the run.

## Emergency contacts / kill switches

- Business spend: meow dashboard (freeze card) and Meta Ads Manager (account spend cap).
- Machine: `ssh agent@mac-mini 'launchctl bootout gui/501 ~/Library/LaunchAgents/com.founderbench.orchestrator.plist'`.
- Model: revoke MODEL_API_KEY at the provider.
