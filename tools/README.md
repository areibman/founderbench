# Tool Surface

Agent-facing interfaces for operating the business. Policy: **CLI-first** (zero standing
context cost — the agent invokes via shell, guided by skills); MCPs only where auth or
structure demands it.

## MCPs (registered in `configs/agent/opencode.json`)

| Name | URL | Auth | Purpose |
| --- | --- | --- | --- |
| `bank` | meow.com remote MCP | OAuth (`opencode mcp auth bank`, stage 65) | balances, transactions, payments. Setup doc: https://www.meow.com/skills.md |
| `meta_ads` | `https://meta-ads.mcp.pipeboard.co/` | OAuth (stage 65) | Meta campaigns/creatives/budgets/insights (42 tools) |
| `exa` | `https://mcp.exa.ai/mcp` | `EXA_API_KEY` header | web search + fetch |
| `fastmail` | `https://api.fastmail.com/mcp` | OAuth at **send** level (stage 65) | the agent's mailbox: read/reply/send + calendar + contacts |
| `xcmcp` | local binary | — | Xcode builds, tests, simulators, TestFlight (toolset-gated) |
| `axmcp` | local binary | — | macOS AX automation; **gated off for the agent** (watchdog use) |

Remote MCP calls are traced via the OpenCode SSE `/event` stream (`harness.tool` events)
since we can't wrap hosted servers locally.

## CLIs (invoked via shell; load the matching skill first)

| CLI | Install (stage 30) | Skill | Purpose |
| --- | --- | --- | --- |
| `asc` | `brew install asc` + `asc install-skills` | vendor skills (23) | App Store Connect: publish, TestFlight, metadata, reviews, sales, screenshots, **Apple Ads** |
| `agent-browser` | `brew install agent-browser` | vendor skill | authenticated browser automation (snapshot/ref workflow) |
| `xc` | `go install github.com/tmc/axmcp/cmd/xc@latest` | xcode-cli | CLI twin of xcmcp |
| `tools/revenuecat.sh` | this repo | revenuecat | MRR/churn/offerings/entitlements via REST v2 |
| `tools/fastmail-jmap.sh` | this repo | — (orchestrator-side) | scripted inbox monitoring + credential verification |
| `gh` | brew | — | issues, PRs, repo ops (fine-grained PAT, app repo only) |

## Tracing contract

Every important action must land in the run trace:

- **Shell commands** → OpenCode bus events (`harness.tool`) via the SSE collector.
- **MCP calls** → same bus events.
- **Git commits** → `post-commit` hook (installed by stage 70) appends `git.commit`
  events using `$FB_TRACE_DIR`.
- **Local tool scripts** (`revenuecat.sh`) → append their own `tool.*` events to
  `$FB_TRACE_DIR/trace.jsonl`.
- **Model traffic** → interception proxy (`model.request`/`model.response`/`model.usage`).

`$FB_TRACE_DIR` is exported into the harness environment by the orchestrator.

## Blast-radius rules (account level — the real containment)

- meow account: spending limit configured in-dashboard; card limits per merchant.
- Meta ad account: account-level spending cap set BEFORE stage 65 OAuth.
- Apple: dedicated developer team; app-scoped ASC API key.
- GitHub: fine-grained PAT scoped to the single app repo.
- Fastmail: dedicated account; masked emails for third-party signups.
