#!/usr/bin/env bash
# Puts the built CLI into the Claude Code plugin, which runs it from there instead of through npx: the plugin
# directory lists a plugin whose code it can read and whose dependencies are locked. Writes the plugin's
# package.json with the CLI's dependencies and an npm lockfile for them, which Claude Code installs when it
# installs the plugin. Needs `pnpm build` first; run it for every release, and release.test.ts and
# dist.test.ts fail until it has been.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
plugin="$root/plugins/nameable"

mkdir -p "$plugin/server"
find "$plugin/server" -mindepth 1 -delete
cp "$root"/packages/nameable/dist/* "$plugin/server/"

# The CLI reads its version from the package.json one level above it.
node -e '
const fs = require("node:fs");
const [src, out] = process.argv.slice(1);
const { version, license, dependencies } = JSON.parse(fs.readFileSync(src, "utf8"));
const pkg = { name: "nameable-plugin", version, private: true, license, dependencies };
fs.writeFileSync(out, JSON.stringify(pkg, null, 2) + "\n");
' "$root/packages/nameable/package.json" "$plugin/package.json"

# Resolved apart from this repository, so no .npmrc or workspace setting here can redirect it.
work="$(mktemp -d)"
cp "$plugin/package.json" "$work/"
(cd "$work" && NPM_CONFIG_USERCONFIG=/dev/null npm install --package-lock-only --ignore-scripts --no-audit \
  --no-fund --registry=https://registry.npmjs.org/ >/dev/null)
cp "$work/package-lock.json" "$plugin/package-lock.json"
