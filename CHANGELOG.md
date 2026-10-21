# Changelog

## 0.1.0 — unreleased

Initial release.

- `nameable <names>` checks names on npm, PyPI, crates.io, Homebrew, GitHub users and organizations, and domains on any TLD (RDAP, or whois where a TLD has none). One name shows each channel with its evidence; several names show a grid to compare them; `--json` prints the same results for scripts, with exit codes.
- Answers apply each registry's own rules, not just "not found": npm's similar-name rule, core modules and the 24-hour block after an unpublish; PyPI's similar names, standard library names and projects without releases or in quarantine; crates.io's reserved and recently deleted names; Homebrew aliases, old names and formula name rules; internationalized domain labels.
- Every free answer says whether it is confirmed or only probable, and why. A failed request is `unknown`, never free.
- Registry-wide name lists (PyPI projects, Homebrew aliases, crates.io's reserved and deleted names) are downloaded when first needed and cached for a day.
- `nameable mcp` serves the checks to AI agents as an MCP server with one read-only tool, `check_names`.
- A Claude Code plugin bundles the MCP server with the `/nameable:check` skill, which picks the channels that matter for the project, looks for prior art and gives a verdict for each candidate.
