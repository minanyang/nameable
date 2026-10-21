#!/usr/bin/env bash
# Packs the CLI, installs the tarball into an empty project the way a user would, and runs it, so a
# packaging mistake (a missing file, a workspace dependency left unbundled) fails before publishing.
# Prints the tarball path. Needs `pnpm build` first.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
(cd "$root/packages/nameable" && pnpm pack --pack-destination "$work" >/dev/null)
tarball="$(ls "$work"/nameable-*.tgz)"

mkdir "$work/app"
cd "$work/app"
npm init -y >/dev/null
npm install --no-audit --no-fund "$tarball" >/dev/null

version="$(node -p "require('$root/packages/nameable/package.json').version")"
test "$(npx --no-install nameable --version)" = "$version"
# A name npm refuses by its own rules, so no request is needed.
out="$(npx --no-install nameable café --only npm --json || true)"
grep -q '"status": "unavailable"' <<<"$out"

echo "$tarball"
