# Changelog

## Unreleased

Sixteen new channels, channels picked from your project, and fixes from three rounds of testing.

**New channels**

- Package registries:
  - `rubygems`: names unique ignoring case, reserved names, yanked gems held for their owners, and the typo rule
    against popular or recent gems.
  - `packagist`: the name as a vendor, reserved vendors, and the typo rule that refuses `name/name` when a
    well-downloaded package one edit away has the same package name.
  - `pub`: Dart reserved words, names kept for the Dart and Flutter teams, and pub.dev's similar-name rule.
  - `nuget`: unlisted packages, and IDs the NuGet team deleted but still holds.
  - `docker`: Docker Hub users and organizations, including accounts only a redirect reveals, and official images.
- AI agent directories:
  - `mcp-registry`: servers in the official MCP Registry whose name part matches, read from a daily community
    mirror because the registry's own search takes 30 seconds or more. Needs Node.js 22.13 or later; older versions
    report it as unknown.
  - `smithery`: Smithery namespaces, which only one owner can hold.
  - `claude-plugins`: Anthropic's official Claude Code marketplace, with the names Claude Code refuses or cannot
    install.
  - `cursor`: Cursor's marketplace. `gemini`: the Gemini CLI extension gallery, where names are not unique.
- Editor marketplaces: `vscode` (extension name, display name and publisher), `open-vsx` (the name as a namespace,
  with Open VSX's similar-namespace and VS Code publisher rules) and `jetbrains` (plugin ID and name, with the words
  JetBrains refuses in new plugin names).
- App stores: `app-store` and `google-play` show whether an app already has the name, in the US store and, for
  Chinese, Japanese or Korean names, in those stores too. A title that only adds its maker ("Google Gemini") is
  noted as similar. A free answer there is always probable.

**Channels picked from your project**

- Without `--only`, Nameable reads the project in the current directory, or its parents up to the repository root:
  npm, PyPI, crates.io, RubyGems, Packagist, pub.dev and NuGet manifests (skipping private apps and unpublished
  packages), Dockerfiles, Claude Code, Cursor, Gemini CLI, VS Code and JetBrains plugins, MCP SDK dependencies, and
  Xcode, Android, Expo and Flutter apps. Outside a project it checks a general set. `--all` checks every channel.

**Changes to existing channels and the CLI**

- A rule a registry applies only to new names (npm core modules and capitals, PyPI standard library names,
  Homebrew formula naming) no longer hides a name published before it: `events`, `JSONStream`, `asyncio` and
  `1password` show as taken, with their links. When a lookup fails, such a name stays unknown rather than refused.
- A response that is not the registry's own answer (a captive portal, a proxy page) is never read as taken.
- A host that stops answering is skipped for the rest of the run instead of being waited on for every name.
  Rate-limited hosts (Google's RDAP for .dev and .app, the App Store) are paced, and a short `Retry-After` is
  honored. Errors name the host that could not be reached.
- The PyPI project list is read as it downloads, with a fraction of the memory. MCP calls running at the same time
  share downloads.
- `--tlds` takes at most 20 valid TLDs and needs `domain` among the channels. `--clear-cache` takes no names,
  supports `--json` and reports errors in one line.
- `nameable mcp` answers lines that are not JSON-RPC messages with a JSON-RPC error instead of ignoring them.
- The table no longer garbles when it is taller or wider than the terminal, or when a name or description holds
  bidirectional control characters. Notes lead with what matters, since the table clips them.
- The package no longer ships source maps.

## 0.1.0 — 2026-10-21

Initial release.

- `nameable <names>` checks names on npm, PyPI, crates.io, Homebrew, GitHub users and organizations, and domains on any TLD (RDAP, or whois where a TLD has none). One name shows each channel with its evidence; several names show a grid to compare them; `--json` prints the same results for scripts, with exit codes.
- Answers apply each registry's own rules, not just "not found": npm's similar-name rule, core modules and the 24-hour block after an unpublish; PyPI's similar names, standard library names and projects without releases or in quarantine; crates.io's reserved and recently deleted names; Homebrew aliases, old names and formula name rules; internationalized domain labels.
- Every free answer says whether it is confirmed or only probable, and why. A failed request is `unknown`, never free.
- Registry-wide name lists (PyPI projects, Homebrew aliases, crates.io's reserved and deleted names) are downloaded when first needed and cached for a day.
- `nameable mcp` serves the checks to AI agents as an MCP server with one read-only tool, `check_names`.
- A Claude Code plugin bundles the MCP server with the `/nameable:check` skill, which picks the channels that matter for the project, looks for prior art and gives a verdict for each candidate.
