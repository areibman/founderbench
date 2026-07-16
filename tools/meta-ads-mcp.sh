#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

exec "$ROOT/node_modules/.bin/tsx" "$SCRIPT_DIR/meta-ads-mcp/src/server.ts"
