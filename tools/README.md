# Tool Surface

Agent-facing interfaces for operating the business. Policy: **CLI-first** (zero standing
context cost — the agent invokes via shell, guided by skills); MCPs only where auth or
structure demands it.

## MCPs (registered in `configs/agent/opencode.json`)

| Name | URL | Auth | Purpose |
| --- | --- | --- | --- |
| `meta_ads` | local `tools/meta-ads-mcp.sh` | `META_ACCESS_TOKEN` | Direct official Meta campaigns/creatives/budgets/insights |
| `exa` | `https://mcp.exa.ai/mcp` | `EXA_API_KEY` header | web search + fetch |
| `fastmail` | `https://api.fastmail.com/mcp` | OAuth at **send** level (stage 65) | the agent's mailbox: read/reply/send + calendar + contacts |
| `xcmcp` | local binary | — | Xcode builds, tests, simulators, TestFlight (toolset-gated) |
| `axmcp` | local binary | — | macOS AX automation; **gated off for the agent** (watchdog use) |

MCP calls are traced via the OpenCode SSE `/event` stream (`harness.tool` events).
The local Meta Ads MCP sends requests directly to `graph.facebook.com`; no hosted
Meta Ads MCP provider receives credentials or traffic. Call `get_mcp_status` to
verify that provenance and local readiness without revealing credentials. All
writes require a configured ad-account allowlist; creative writes additionally
require a Page allowlist. ACTIVE updates require an explicit opt-in and both daily
and lifetime local budget ceilings.

## CLIs (invoked via shell; load the matching skill first)

| CLI | Install (stage 30) | Skill | Purpose |
| --- | --- | --- | --- |
| `meow` | `npm install -g @joinmeow/cli` | bank | meow banking: entities, accounts, balances, transactions, invoices, **virtual cards** (`--api-key $MEOW_API_TOKEN` on every command; same backend as meow's `/cli` MCP surface) |
| `asc` | `brew install asc` + `asc install-skills` | vendor skills (23) | App Store Connect: publish, TestFlight, metadata, reviews, sales, screenshots, **Apple Ads** |
| `agent-browser` | `brew install agent-browser` | vendor skill | authenticated browser automation (snapshot/ref workflow) |
| `xc` | `go install github.com/tmc/axmcp/cmd/xc@latest` | xcode-cli | CLI twin of xcmcp |
| `tools/revenuecat.sh` | this repo | revenuecat | MRR/churn/offerings/entitlements via REST v2 |
| `tools/fastmail-jmap.sh` | this repo | — (orchestrator-side) | scripted inbox monitoring + credential verification |

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
- Meta ad account: account-level spending cap plus local daily/lifetime ceilings
  set before enabling activation.
- Apple: dedicated developer team; app-scoped ASC API key.
- GitHub: no credentials provisioned — git is local-only; if the agent wants a
  hosted remote it must create its own account.
- Fastmail: dedicated account; masked emails for third-party signups.
