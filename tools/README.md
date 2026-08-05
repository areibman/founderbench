# Tool Surface

Agent-facing interfaces for operating the business. Policy: **CLI-first** (zero standing
context cost — the agent invokes via shell, guided by skills); MCPs only where auth or
structure demands it.

## MCPs (registered in `configs/agent/opencode.json`)

| Name | URL | Auth | Purpose |
| --- | --- | --- | --- |
| `exa` | `https://mcp.exa.ai/mcp` | `EXA_API_KEY` header | web search + fetch |
| `xcmcp` | local binary | — | Xcode builds, tests, simulators, TestFlight (toolset-gated) |
| `axmcp` | local binary | — | macOS AX automation; **gated off for the agent** (watchdog use) |

MCP calls are traced via the OpenCode SSE `/event` stream (`harness.tool` events).

## CLIs / HTTP APIs (invoked via shell; load the matching skill first)

| Surface | Install / auth | Skill | Purpose |
| --- | --- | --- | --- |
| meow REST API | none (curl + jq) | bank | meow banking: accounts, balances, transactions, transfers, invoices, **virtual cards** — `https://api.meow.com/v1`, header `x-api-key: $MEOW_API_TOKEN` |
| `asc` | `brew install asc` + `asc install-skills` | vendor skills (23) | App Store Connect: publish, TestFlight, metadata, reviews, sales, screenshots, **Apple Ads** |
| `playwriter` | `npm i -g playwriter` + stock Google Chrome cask (never `playwriter browser install`, which pulls bot-flagged Chrome for Testing) | `npx skills add remorses/playwriter` | browser automation driven by Playwright snippets against stock Chrome over CDP |
| `browse` (Browserbase CLI) | `npm i -g browse` | `npx skills add browserbase/skills --skill browser` | cloud Chromium with automatic CAPTCHA solving. Fallback when the local browser is blocked |
| Stripe REST API | none (curl + jq) | `npx skills add https://docs.stripe.com --skill stripe-best-practices` | payments via `api.stripe.com`, authenticated with `$STRIPE_API_KEY` |
| `inkbox` | `npm i -g @inkbox/cli` | `npx skills add https://inkbox.ai --skill inkbox-cli` | agent identity: mailbox, credential vault with TOTP, public HTTPS tunnel — `https://inkbox.ai/api/v1`, header `X-API-Key` |
| `xc` | `go install github.com/tmc/axmcp/cmd/xc@latest` | xcode-cli | CLI twin of xcmcp |

The four `skills add` packages are checked into
`configs/agent/.agents/skills/`; their generated lockfile records provenance
and hashes. Stage 70 copies those directories into `.opencode/skills/`.

## Tracing contract

Every important action must land in the run trace:

- **Shell commands** → OpenCode bus events (`harness.tool`) via the SSE collector.
- **MCP calls** → same bus events.
- **Git commits** → `post-commit` hook (installed by stage 70) appends `git.commit`
  events using `$FB_TRACE_DIR`.
- **Local tool scripts** → append their own `tool.*` events to
  `$FB_TRACE_DIR/trace.jsonl`.
- **Model traffic** → interception proxy (`model.request`/`model.response`/`model.usage`).

`$FB_TRACE_DIR` is exported into the harness environment by the orchestrator.

## Blast-radius rules (account level — the real containment)

Per-agent isolation is enforced here, not in the harness. Each Mac gets its own
credentials and can only reach its own accounts:

- meow: a dedicated checking account per agent; the API key is restricted to
  that single account. Spending limit configured in-dashboard; card limits per
  merchant.
- Stripe: a standalone member account per agent inside one Organization, each
  with its own native keys. Org-level (`sk_org_`) keys are rejected at
  preflight — they would grant one agent the whole fleet.
- Inkbox: one agent-scoped identity per Mac; its key sees only that identity,
  asserted at preflight by `GET /identities` returning exactly one.
- Apple: nothing provisioned this block — iOS is an unprovisioned escape hatch.
- GitHub: no credentials provisioned — git is local-only; if the agent wants a
  hosted remote it must create its own account.
