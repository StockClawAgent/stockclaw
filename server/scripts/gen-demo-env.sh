#!/usr/bin/env bash
# Generate strong random demo tokens into server/.env.demo (gitignored, chmod 600). Prints nothing secret.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
{
  echo "# StockClaw demo tokens (generated $(date -u +%FT%TZ)). Do not commit. Owner token = presenter only."
  echo "OWNER_API_TOKEN=own_$(openssl rand -hex 32)"
  echo "MCP_API_TOKEN=mcp_$(openssl rand -hex 32)"
} > .env.demo
chmod 600 .env.demo
echo "wrote $(pwd)/.env.demo (mode $(stat -c %a .env.demo))"
