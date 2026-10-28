#!/usr/bin/env bash
# Installs the Claude Code plugin the way Claude Code does (npm ci from its lockfile, scripts off, in a
# folder of its own) and runs its copy of the CLI, so a plugin that cannot start fails before release.
# Needs scripts/build-plugin.sh to have run.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
cp -R "$root/plugins/nameable/." "$work/"
(cd "$work" && NPM_CONFIG_USERCONFIG=/dev/null npm ci --ignore-scripts --no-audit --no-fund >/dev/null)

version="$(node -p "require('$root/packages/nameable/package.json').version")"
test "$(node "$work/server/cli.mjs" --version)" = "$version"
# A name npm refuses by its own rules, so no request is needed.
out="$(node "$work/server/cli.mjs" café --only npm --json || true)"
grep -q '"status": "unavailable"' <<<"$out"
# The MCP server answers a ping.
reply="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"ping"}' | node "$work/server/cli.mjs" mcp)"
grep -q '"result":{}' <<<"$reply"
