---
name: bank
version: 0.9.2
description: "Handles Meow setup, business formation, authentication, payments, cards, invoicing, document uploads, and configuration via CLI or MCP. Use when the user wants to form a business, get started with Meow, log in, send ACH, wire, or USDC payments, manage cards or spend controls, create invoices, upload documents, or complete Meow configuration."
tags: [fintech, cli, payments, mcp, developer-tools]
metadata:
  openclaw:
    emoji: "🐱"
    homepage: https://www.meow.com
    requires:
      bins: [meow]
    install:
      - kind: node
        package: "@joinmeow/cli"
        bins: [meow]
---

# Meow

Use this skill for Meow tasks through the Meow CLI or Meow MCP server.

Prefer the CLI. Use MCP only when the Meow MCP server is already configured or a CLI install is not practical.

## Network Access

The CLI and MCP server require network access. If network access is restricted, use an agent that has it. See [MCP server docs](https://developer.meow.com/mcp-server) for setup details.

## Default Workflow

Start with `meow start` unless the user explicitly asks for a different Meow command. `start` is the preferred entrypoint for business formation and Meow onboarding because it returns guided next steps from the backend and keeps the flow current.

```bash
# Install and start
npm install -g @joinmeow/cli
meow start
```

If global install is not ideal, use `npx @joinmeow/cli start` instead.

Every CLI response includes `hint` and `next_command` fields. Follow them.

## CLI First

Use the CLI when shell access is available. This includes terminal environments and agent sandboxes where commands can be executed directly.

Use MCP only as a fallback when the remote server is already configured or a CLI install is not practical.

## Authentication

An API key is already provisioned in the `MEOW_API_TOKEN` environment variable.
Every command takes it via `--api-key`:

```bash
meow get-my-entity --api-key "$MEOW_API_TOKEN"
meow list-bank-accounts --api-key "$MEOW_API_TOKEN"
meow get-account-balances --account-id <id> --api-key "$MEOW_API_TOKEN"
```

Keys expire after about 7 days. If the key is rejected (401), issue a new one
yourself via the email flow — the account email is your own mailbox:

```bash
meow login --email <your email>        # sends a 6-digit code to your inbox
meow issue-onboarding-key --email <your email> --verification-code <code>
# export the returned api_key as MEOW_API_TOKEN and update credentials.env
```

No passwords are used — identity is confirmed via email verification codes.

A second credential may be present in `MEOW_REST_API_KEY`: a key for meow's
REST customer API (`https://api.meow.com/v1`, sent as an `x-api-key` header).
Same account, independent auth path.

## Action Rules

Prefer `meow start` for business formation, first-time, ambiguous, or general Meow requests.

Do not guess missing required fields. Ask for them.

Ask for explicit confirmation before running `pay` or `confirm`.

## CLI Tools

| Tool      | Description                                         |
| --------- | --------------------------------------------------- |
| `start`   | Start the Meow CLI and guide through formation or setup |
| `login`   | Send verification code to email                     |
| `verify`  | Verify code and store encrypted credentials locally |
| `logout`  | Clear stored credentials                            |
| `pay`     | Send payments (ACH, wire, USDC)                     |
| `card`    | Manage corporate cards and spend controls           |
| `invoice` | Create and manage invoices                          |
| `upload`  | Upload documents (handles encoding internally)      |
| `confirm` | Submit completed configuration                      |

Run `meow <command> --help` for full usage of any tool.

## MCP Server

```json
{
  "mcpServers": {
    "meow": {
      "type": "http",
      "url": "https://mcp.meow.com/cli"
    }
  }
}
```

Use this only when CLI use is not practical.

## Error Handling

| Error                     | Action                        |
| ------------------------- | ----------------------------- |
| 401 Unauthorized          | Re-run `login` flow and retry |
| 400 Bad Request           | Check error, fix field, retry |
| 500 Server Error          | Retry once after delay        |
| Verification code expired | Run `login` again to resend   |

## Links

- **Website:** https://www.meow.com
- **CLI:** `npm install -g @joinmeow/cli`
- **Documentation:** https://www.meow.com/llms.txt
- **Skills:** https://www.meow.com/skills.md
- **Terms of Service:** https://www.meow.com/legal/terms