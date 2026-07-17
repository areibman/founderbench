# FounderBench

A live, autonomous app-business eval. An agent (OpenCode, running headless on a dedicated
Mac mini) controls a real iOS app: real codebase, real App Store operations, real growth
channels, real money — with full observability and zero human intervention during a run.

The run substrate mirrors the [Prime Intellect verifiers v1](https://www.primeintellect.ai/blog/verifiers-v1)
architecture (interception proxy, structured trace, taskset/harness/runtime separation) so it
can later be packaged as a verifiers-compatible eval taskset.

## Layout

```
founderbench/
  machine/            # Mac mini appliance scripts (bash, idempotent, numbered)
  orchestrator/       # TypeScript daemon: run lifecycle, heartbeat, OpenCode client
  tracing/            # LLM interception proxy + event collectors + JSONL trace store
  tools/              # CLI tool wrappers (RevenueCat, Fastmail JMAP) + tool surface docs
  configs/            # run configs (TOML), credentials template, agent workspace template
  runs/               # (gitignored) per-run artifacts: traces, screenshots, logs
  replay/             # minimal web UI to browse a run's trace
  docs/               # mac checklist, runbook, failure taxonomy
```

## Quick start

1. **Provision the Mac mini** (one time, on the dedicated machine):

   ```sh
   cd machine
   sudo ./setup.sh            # runs 10-power ... 65-mcp-auth in order
   ./verify.sh                # must pass 100% before any run
   ```

   Walk through `docs/mac-checklist.md` — every item has a verification command.

2. **Install the agent workspace** into the app repo checkout:

   ```sh
   ./machine/70-agent-workspace.sh /path/to/app-repo
   ```

3. **Run a pilot**:

   ```sh
   npm install
   npm run orchestrator -- --config configs/smoke-2h.toml
   ```

   Or install the launchd daemon for unattended multi-day runs:

   ```sh
   ./machine/80-install-launchd.sh configs/pilot-24h.toml
   ```

4. **Replay a run**:

   ```sh
   npm run replay             # serves replay UI + runs/ at http://localhost:8787
   ```

## Architecture

```
orchestrator (launchd, KeepAlive)
  ├── spawns `opencode serve` (headless harness)
  ├── LLM interception proxy  → Azure OpenAI upstream (every request/response traced)
  ├── SSE /event collector    → JSONL trace store (runs/<run-id>/trace.jsonl)
  ├── heartbeat state machine → nudge / restart / resume on stall or crash
  ├── dialog watchdog         → AX inspection + screenshots, evidence on any dialog
  ├── budget enforcement      → token cap, business spend, wall-clock end time
  └── metrics snapshots       → revenue/MRR/installs/balance on an interval
```

## Tool surface (agent-facing)

| Surface | Transport | Notes |
| --- | --- | --- |
| meow.com banking | `meow` CLI (`--api-key $MEOW_API_TOKEN`) | entities, balances, transactions, virtual cards |
| Meta Ads | local stdio MCP calling `graph.facebook.com` directly, with account/Page allowlists | Meta only |
| Exa web search | remote MCP (`https://mcp.exa.ai/mcp`) | research |
| Fastmail | remote MCP (`https://api.fastmail.com/mcp`) | agent's own mailbox, send scope |
| xcmcp (Xcode/simulators) | local MCP | build/test/sim, toolset-gated |
| App Store Connect + Apple Ads | `asc` CLI + skills | CLI-first, zero standing context |
| Browser | `agent-browser` CLI | authenticated web automation |
| RevenueCat | `tools/revenuecat.sh` | MRR, churn, offerings |

See `tools/README.md` for details and `configs/agent/` for the OpenCode workspace template.
