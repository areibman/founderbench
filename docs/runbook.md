# Runbook

## Run ladder

Each rung gates the next. Gate criteria: **complete trace, zero human interventions,
every blocker fixed AND a check added to `machine/verify.sh`.**

1. **2h smoke** (`configs/smoke-2h.toml`) — no spending; proves every tool works.
   Before advancing: delete the smoke's `SMOKE_REPORT.md` from the app repo so the
   pilot starts with no pre-existing log artifacts (record-keeping is deliberately
   uninstructed — see docs/experiment-design.md).
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

## Pressure arm (high-pressure task framing)

`configs/pilot-pressure-24h.toml` + the charter in `configs/agent/AGENTS.md`
are a deliberate departure from prompt neutrality (see the config header):
survival stakes, a hard deadline, use-it-or-lose-it capital framing.
Pressure, not permission — the prompts never instruct a tactic or a norm
violation. (History note: the pressure charter originally lived in a separate
`AGENTS-pressure.md`; it was merged into `AGENTS.md` itself before run 1, so
stage 70 needs no charter argument.)

Launching it (on the mini):

```sh
# 1. Stop whatever is running and mark the interruption
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.founderbench.orchestrator.plist 2>/dev/null || true
# safe-state check: pause any live ad campaigns, note uncommitted workspace changes

# 2. Pick up the pressure arm
cd ~/founderbench && git pull

# 3. Install the charter into the agent workspace
./machine/70-agent-workspace.sh "$HOME"

# 4. Launch
./machine/80-install-launchd.sh configs/pilot-pressure-24h.toml
```

### Run 2 (environment-fix rerun)

`configs/pilot-pressure-24h-r2.toml` is the same arm with prompts byte-identical
to run 1; only the run name and the environment differ (see the config header
for the block-2 fixes).
Launch sequence on the mini:

```sh
cd ~/founderbench && git pull

# 0. Credentials must be green BEFORE launch — this probes the meow REST
#    endpoints including card issuance. The meow key is a dashboard-issued
#    REST key (x-api-key).
./machine/verify.sh          # or just: source configs/credentials.env && ./machine/60-credentials.sh

# 1. If the previous run is still resumable, retire it so run-daemon.sh
#    doesn't auto-resume it
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.founderbench.orchestrator.plist 2>/dev/null || true
touch ~/founderbench/runs/<old-run-id>/COMPLETED

# 2. Charter + launch (AGENTS.md is the pressure charter)
./machine/70-agent-workspace.sh "$HOME"
./machine/80-install-launchd.sh configs/pilot-pressure-24h-r2.toml
```

## After a run

1. Confirm `runs/<run-id>/COMPLETED` exists and `run.end` is in the trace.
2. Look for self-created artifacts in the app repo (`git diff --name-status
   <start-sha>..HEAD`, start SHA from the first checkpoint) — notes/logs the
   agent chose to keep are findings in themselves.
3. Open the replay UI: walk every `env.dialog`, `env.error`, `run.restart`, and
   `budget.*` event. Each one is either an environment bug (fix + verify.sh check)
   or evidence for the failure taxonomy.
4. Snapshot the machine state if anything drifted: `sudo tmutil localsnapshot`.
5. **Evidence phase (72h fleet):** `docs/analysis-playbook.md` — prep
   `steps.jsonl`, send investigators with `docs/investigation-guide.md`.
   A human reviews the findings and writes the post. Incident codes
   (`docs/trace-analysis-rubric.md`) are a later researcher pass, not that
   hunt.
6. File the run summary in `docs/` (metrics + failure taxonomy classification).
7. Export researcher-facing trace formats (both schema-validated by construction):

```sh
# deps are pinned in tracing/pyproject.toml + tracing/uv.lock
uv run --project tracing tracing/export_vf_trace.py runs/<run-id>   # verifiers v1 Trace (message graph, branches)
uv run --project tracing tracing/export_atif.py runs/<run-id>       # Harbor ATIF-v1.7 trajectory.json (steps, tools, reasoning)
```

## Resume semantics

- launchd `KeepAlive` restarts the orchestrator on any non-zero exit.
- `orchestrator/run-daemon.sh` finds the newest run directory with a checkpoint but no
  COMPLETED marker and resumes it (same run id, same OpenCode session → context intact).
- Wall-clock end time is preserved in the checkpoint, so a crash near the end doesn't
  extend the run.