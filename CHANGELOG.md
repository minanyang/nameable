# Changelog

## Unreleased

- Without `--only`, the channels are picked from the project files in the current directory (`package.json`, `pyproject.toml`, `Cargo.toml`, a `.gemspec`, `composer.json`, `pubspec.yaml`, a `.csproj`, a `Dockerfile`, `.claude-plugin/`); outside a project, a general set is checked. `--all` checks every channel.
- New package registry channels: `rubygems` (case-insensitive uniqueness, reserved names, yanked gems held for 100 days, the typo rule against popular or recent gems), `packagist` (the name as a vendor, reserved vendors, the typo rule against well-downloaded packages), `pub` (Dart reserved words, names kept for the Dart and Flutter teams, pub.dev's similar-name rule), `nuget` (unlisted packages, IDs NuGet deleted but still holds) and `docker` (Docker Hub users and organizations, including accounts only a redirect reveals, and official images).
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
