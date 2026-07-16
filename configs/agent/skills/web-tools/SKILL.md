---
name: web-tools
description: Web access tools — the exa MCP (search + page fetch) and the agent-browser CLI (a real authenticated browser).
---

# Web tools

## exa MCP

- `web_search_exa` — web search with content extraction.
- `web_fetch_exa` — full content of a known URL.

## agent-browser CLI

A real browser, drivable from the shell:

```sh
agent-browser open "<url>"
agent-browser snapshot -i          # accessibility tree with @refs
agent-browser click @e12
agent-browser read                 # readable text of current page
agent-browser screenshot
agent-browser close
```

Facts:

- Saved login state was loaded at machine setup; `--allowed-domains` scoping
  applies.
- The installed vendor `agent-browser` skill has the full command reference.
