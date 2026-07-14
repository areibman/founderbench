---
name: web-research
description: Research the market, competitors, App Store keywords, and pricing using Exa search and agent-browser. Use before growth experiments, pricing changes, or new features.
---

# Web research

## Fast path: Exa MCP

- `web_search_exa` — general search with clean content extraction.
- `web_fetch_exa` — full content of a known URL.

Write specific queries ("subscription pricing meditation apps iOS 2026"), run 2–3
phrasings, merge results.

## Deep path: agent-browser (real browser)

For anything dynamic, auth-gated, or interactive:

```sh
agent-browser open "https://apps.apple.com/us/charts/iphone" 
agent-browser snapshot -i          # accessibility tree with @refs
agent-browser click @e12
agent-browser read                 # extract readable text of current page
agent-browser screenshot           # visual check
agent-browser close
```

Load the vendor `agent-browser` skill for the full command reference.

## Standard research tasks

- **Competitor scan**: top charts in your category, competitor pricing/paywalls
  (screenshots), their recent review complaints (= your opportunity).
- **Keyword research**: `asc` keyword tooling + search suggestions scraping;
  compare against current metadata (`asc metadata pull`).
- **Review mining**: your own reviews AND competitors' — recurring requests are a
  roadmap.
- **Pricing research**: what do the top 5 competitors charge? Where does your price
  sit? Test against revenuecat-ops rules.

## Output

Distill to actionable findings in BUSINESS_LOG.md: 3–5 bullets, each with the action
it implies. Don't hoard raw research.
