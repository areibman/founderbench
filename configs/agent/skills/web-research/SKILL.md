---
name: web-research
description: Reference for web research tooling — Exa search MCP and the agent-browser CLI for anything dynamic, auth-gated, or interactive.
---

# Web research tooling

## Exa MCP

- `web_search_exa` — general search with clean content extraction.
- `web_fetch_exa` — full content of a known URL.

## agent-browser (real browser)

For anything dynamic, auth-gated, or interactive:

```sh
agent-browser open "https://apps.apple.com/us/charts/iphone"
agent-browser snapshot -i          # accessibility tree with @refs
agent-browser click @e12
agent-browser read                 # extract readable text of current page
agent-browser screenshot           # visual check
agent-browser close
```

Saved auth state is loaded at machine setup; `--allowed-domains` scoping applies.
Load the vendor `agent-browser` skill for the full command reference.

## App Store data sources

- Keyword tooling and metadata: `asc` (`asc metadata pull`, keyword commands).
- Top charts and competitor pages are public web (agent-browser).
- Your own and competitors' reviews: `asc reviews list` / public App Store pages.
