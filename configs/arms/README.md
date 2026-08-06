# Pilot-72h fleet arms — 7 Macs, 7 models, 1 run config

Every Mac runs the SAME run config (`configs/pilot-72h.toml`). The only thing
that differs per machine is the model block in `credentials.env` — copy exactly
one `<arm>.env.example` from this directory into the Mac's
`<repo-root>/credentials.env` (alongside the Inkbox/Stripe/meow/etc. values)
and fill in the key.

The harness is provider-shape-agnostic on purpose: plain provider keys,
OpenRouter, and Azure all collapse to the same triple. OpenCode talks only to
the local interception proxy (`http://127.0.0.1:41500/v1`); the proxy forwards
to `MODEL_UPSTREAM_URL` with `Authorization: Bearer $MODEL_API_KEY` (plus the
`api-key` header and the `max_tokens → max_completion_tokens` rewrite when the
upstream is Azure). Any OpenAI-compatible endpoint works unmodified.

All endpoints and model ids below were verified against first-party provider
docs (or, for OpenRouter arms, the live `GET /api/v1/models` listing — the
deployment truth for that route) on 2026-08-06; sources are cited in each arm
file. The stage-60 live probe remains the final gate on each Mac.

| Arm (`FB_ARM`) | Model id | Access shape | Upstream | Documented ctx / max output | `limit` in opencode.json | Key source |
|---|---|---|---|---|---|---|
| `sol` | `gpt-5.6-sol` | Azure OpenAI deployment | `https://<resource>.openai.azure.com/openai/v1` | 1,050,000 / 128,000 | defaults | Azure key (`MODEL_API_KEY`) |
| `fable` | `claude-fable-5` | Anthropic, OpenAI-compat surface | `https://api.anthropic.com/v1` | 1,000,000 / 128,000 | defaults | `ANTHROPIC_API_KEY` |
| `qwen` | `qwen3.8-max` | DashScope CN, compatible-mode | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 1,000,000 / 131,072 | defaults | `QWEN_CN_API_KEY` |
| `kimi` | `moonshotai/kimi-k3` | OpenRouter | `https://openrouter.ai/api/v1` | 1,048,576 / undeclared | defaults | OpenRouter key **minted for this arm** |
| `grok` | `x-ai/grok-4.5` | OpenRouter | `https://openrouter.ai/api/v1` | 500,000 / undeclared | defaults | OpenRouter key **minted for this arm** |
| `muse` | `muse-spark-1.2-contributor` | Meta Model API | `https://api.meta.ai/v1` | 1,048,576 / 131,072 | **pinned** | `META_AI_API_KEY` |
| `gemini` | `gemini-3.6-flash` | Google, OpenAI-compat surface | `https://generativelanguage.googleapis.com/v1beta/openai` | 1,048,576 / 65,536 | defaults | `GEMINI_API_KEY` |

`MODEL_NPM` picks the OpenCode provider package: `@ai-sdk/openai` (Responses
API) for `sol` and `muse` — Azure supports it and Meta's docs explicitly
recommend it for agent harnesses (reasoning replay), with Meta's documented
provider options carried in `MODEL_OPTIONS_JSON`. Everything else uses
`@ai-sdk/openai-compatible` (Chat Completions).

Token-limit policy: prefer OpenCode defaults over opinionated windows.
`MODEL_CONTEXT`/`MODEL_OUTPUT` are set **only for `muse`**, because Meta
publishes those exact values as part of its recommended OpenCode provider
config — everywhere else the documented caps live in the arm file's comments
for reference only. The upstream APIs enforce their real caps regardless; the
`limit` pair only tunes OpenCode's compaction threshold. If an arm hits
context errors mid-run (grok's 500K window is the smallest in the fleet, so
it's first in line), pin that arm's limits then and re-run stage 70. Stage 70
omits `limit` whenever the pair isn't set (OpenCode's schema requires both
fields together).

Provider quirks the proxy already absorbs (nothing to configure per arm):
Azure's `max_tokens → max_completion_tokens` rewrite + `api-key` header, and
Anthropic's compat-layer requirement that every request carry `max_tokens`
(injected when the client omits it).

## Per-machine provisioning (each of the 7 Macs)

1. `cp configs/credentials.env.example credentials.env`, fill the shared
   sections (Inkbox, Stripe, meow, Exa, Browserbase — all per-agent, see
   `docs/mac-checklist.md` §4), then replace the model block with this arm's
   `configs/arms/<arm>.env.example` contents and fill the key.
2. `machine/60-credentials.sh` — the model check does a live chat-completion
   round trip against the arm's real upstream. **This is the gate that catches
   a wrong model id, a dead endpoint, or an unfunded key.**
3. `machine/70-agent-workspace.sh` — renders `~/opencode.json` for this arm.
   Re-run it any time `MODEL_*` changes.
4. `machine/verify.sh` — full gate, includes an arm/workspace consistency check.
5. Launch: `npm run orchestrator -- --config configs/pilot-72h.toml`.
   The run id comes out as `pilot72-<arm>-<date>-<uuid>`.

## Isolation rules (will silently ruin the experiment if violated)

- **kimi and grok must NOT share one OpenRouter key.** Mint one key per arm in
  the OpenRouter console, each with its own credit limit — a shared key merges
  their spend, kills per-arm billing caps (checklist 4.14), and one arm can
  drain the other's budget.
- Same per-arm rule as bank/Stripe/Inkbox: no `MODEL_API_KEY` value may appear
  on two Macs.
- Set spend caps at the provider account level for every arm, and screenshot
  them into `docs/` (checklist 4.14).
- Fallback/safety-router contamination is measured, not prevented: the proxy
  records `requestedModel` vs `servedModel` per turn and emits
  `model.fallback` events (see `docs/experiment-design.md`).
