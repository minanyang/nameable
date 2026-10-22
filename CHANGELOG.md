# Changelog

## Unreleased

- Without `--only`, the channels are picked from the project files in the current directory: npm, PyPI, crates.io, RubyGems, Packagist, pub.dev and NuGet manifests (skipping private apps and unpublished packages), Dockerfiles, Claude Code, Cursor, Gemini CLI, VS Code and JetBrains plugins, MCP SDK dependencies, and Xcode, Android, Expo and Flutter apps. Outside a project, a general set is checked. `--all` checks every channel; `--tlds` without a domain channel is a usage error.
- A rule a registry applies only to new names (reserved words, names kept for its owners, newer formats) no longer hides a name published before it: such a name shows as taken, with its link.
- RubyGems free answers are now probable: a yanked gem spelled with other capitals still holds the name and cannot be seen.
- A table taller than the terminal is printed once instead of redrawn.
- npm, PyPI, crates.io and Homebrew also apply their new-package-only rules after the lookup: `events`, `JSONStream`, `asyncio`, `1password` and `firefox@developer-edition` show as taken, not refused. A rule a registry would refuse a name by also applies when the lookup cannot tell.
- App stores: a title that leads with its maker's name ("Google Gemini") or names it after "by" matches; names in Chinese, Japanese or Korean are also searched in those storefronts.
- Open VSX: checks every namespace for the similar-name rule, and refuses a name a VS Code Marketplace publisher already has.
- A host that stops answering is skipped for the rest of the run instead of being waited on for each name; requests to rate-limited hosts (Google's RDAP, the App Store) are paced, and a short `Retry-After` is honored.
- The PyPI index is read as it streams in, using a fraction of the memory. MCP calls running at the same time share downloads.
- `--tlds` takes at most 20 TLDs, and a TLD must be a valid DNS label. `--clear-cache` takes no names, reports errors in one line and supports `--json`.
- `nameable mcp` answers lines that are not JSON-RPC messages with a JSON-RPC error instead of ignoring them.
- Rows wider than the terminal, and bidirectional control characters in names or descriptions, no longer garble the table.
- The published package no longer ships source maps.
- New package registry channels: `rubygems` (case-insensitive uniqueness, reserved names, yanked gems held for 100 days, the typo rule against popular or recent gems), `packagist` (the name as a vendor, reserved vendors, the typo rule against well-downloaded packages), `pub` (Dart reserved words, names kept for the Dart and Flutter teams, pub.dev's similar-name rule), `nuget` (unlisted packages, IDs NuGet deleted but still holds) and `docker` (Docker Hub users and organizations, including accounts only a redirect reveals, and official images).
- `mcp-registry`: servers in the official MCP Registry whose name part matches, read from a daily community mirror (rosmur/official-mcp-registry-database), because the registry's own search takes 30 seconds or more. Needs Node.js 22.13 or later; older versions report it as unknown.
- Editor extension channels: `vscode` (extension name, display name and publisher, all unique in the VS Code Marketplace), `open-vsx` (the name as a namespace, with Open VSX's similar-namespace rule) and `jetbrains` (plugin ID and name, with the words JetBrains refuses in new plugin names).
- New channels: `cursor` (Cursor's marketplace), `gemini` (the Gemini CLI extension gallery), `app-store` (US iOS and macOS search) and `google-play` (US search). App store matches ignore case, punctuation and a subtitle; a free answer there is always probable.
- New channels for agent tools: `smithery` (the Smithery namespace, which only one owner can hold) and `claude-plugins` (Anthropic's official Claude Code marketplace, including the names `claude plugin validate` reserves).

## 0.1.0 — 2026-10-21

Initial release.

- `nameable <names>` checks names on npm, PyPI, crates.io, Homebrew, GitHub users and organizations, and domains on any TLD (RDAP, or whois where a TLD has none). One name shows each channel with its evidence; several names show a grid to compare them; `--json` prints the same results for scripts, with exit codes.
- Answers apply each registry's own rules, not just "not found": npm's similar-name rule, core modules and the 24-hour block after an unpublish; PyPI's similar names, standard library names and projects without releases or in quarantine; crates.io's reserved and recently deleted names; Homebrew aliases, old names and formula name rules; internationalized domain labels.
- Every free answer says whether it is confirmed or only probable, and why. A failed request is `unknown`, never free.
- Registry-wide name lists (PyPI projects, Homebrew aliases, crates.io's reserved and deleted names) are downloaded when first needed and cached for a day.
- `nameable mcp` serves the checks to AI agents as an MCP server with one read-only tool, `check_names`.
- A Claude Code plugin bundles the MCP server with the `/nameable:check` skill, which picks the channels that matter for the project, looks for prior art and gives a verdict for each candidate.
