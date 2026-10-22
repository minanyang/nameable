<div align="center">

# Nameable

Find out if a name is free everywhere your project will ship, and don't take a 404 for a yes.

[![npm](https://img.shields.io/npm/v/nameable)](https://www.npmjs.com/package/nameable) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-D97757)](https://code.claude.com/docs/en/plugins)

**English** · [繁體中文](README.zh-TW.md)

</div>

Nameable checks a name on package registries, GitHub, agent and editor directories, app stores and domains, shows
the evidence behind every answer, and says how sure each answer is. It runs as a CLI, as an MCP server for AI agents, and as a Claude Code plugin that also
looks for prior art and recommends which name to keep.

## Why

Most availability checks ask each registry whether the name exists and read "not found" as free. Not found only
means nobody holds that exact name. The registry may still refuse it:

| Name            | Registry   | Not found? | What the registry does                                |
| --------------- | ---------- | ---------- | ----------------------------------------------------- |
| `f1ask`         | PyPI       | yes        | Refuses it: too similar to `flask`                    |
| `first-one`     | npm        | yes        | Refuses it: same as `firstone` without punctuation    |
| `golang`        | Homebrew   | yes        | Already taken: an alias of `go`                       |
| `rust`          | crates.io  | yes        | Refuses it: reserved by crates.io                     |
| `gh`            | crates.io  | yes        | Refuses it until 2027: the crate was deleted recently |
| `providers`     | pub.dev    | yes        | Refuses it: the plural of `provider`                  |
| `rbconfig`      | RubyGems   | yes        | Refuses it: reserved by RubyGems.org                  |
| `Coinbase.Core` | NuGet      | yes        | Refuses it: deleted by NuGet, the ID still held       |
| `postgres`      | Docker Hub | yes        | Already taken: an official image                      |
| `xn--ls8h.dev`  | domains    | yes        | Cannot be registered: it is an emoji in punycode      |

Nameable applies each registry's own rules, taken from its source code, and checks the lists those rules need:
similar and reserved names, aliases and old names, recently deleted names, unpublished packages. When a rule cannot
be checked, the answer says "probably" and why, instead of "available". A failed request is `unknown`, never free.

## Use it from the terminal

Requires Node.js 22 or later. Run it in your project (or any folder under it, up to the
repository root) and it checks the channels the project ships on, picked from its files:

- `package.json` for npm (unless it has no `name`, is private, or is a server or site: it starts, serves or deploys
  itself and declares nothing to publish), Homebrew when it has a `bin`; with
  `engines.vscode`, VS Code Marketplace and Open VSX instead of npm
- `pyproject.toml`, `setup.py` or `setup.cfg` that describe a package for PyPI, Homebrew when they declare scripts
- `Cargo.toml` for crates.io (unless `publish = false`), Homebrew when it builds a binary
- a `.gemspec` for RubyGems, `composer.json` for Packagist (unless it is a project), `pubspec.yaml` for pub.dev
  (unless `publish_to: none`), a `.csproj` or `.sln` for NuGet (unless it builds a web app, an executable or tests), a
  `Dockerfile` for Docker Hub (unless the `package.json` is private, or CI and deploy files push images only to a private registry or a cloud deploy), a `Package.swift` with an executable for Homebrew
- `.claude-plugin/`, `.cursor-plugin/` and `gemini-extension.json` for those directories, a `plugin.xml` or the
  IntelliJ Gradle plugin for JetBrains Marketplace, an MCP SDK dependency for the MCP Registry and Smithery
- an Xcode project for the App Store, an Android app for Google Play, and an Expo or Flutter app for both
- at an npm, pnpm, Yarn, Lerna or Cargo workspace root, the channels of each member, read the same way

GitHub and domains are always checked; a project that ships on none of these, such as a Rails app or a Go library,
gets only those (and Homebrew for a Go command). Outside a project it checks a general set: npm, PyPI, crates.io,
Homebrew, GitHub and domains.

```sh
npx nameable nameable --all --tlds com,dev,sh
```

```
Checking "nameable" on 23 channels

  ✗ npm                   taken              Find out if a name is free everywhere it matters for …
  ✓ PyPI                  available
  ✓ crates.io             available
  ✓ Homebrew              available          no homebrew-core formula or cask
  ✗ RubyGems              taken              A library that provides parsing and output of person …
  ✓ Packagist             probably available no packages under this vendor; packages frozen for sp…
  ✓ pub.dev               probably available no package with this name; moderated packages and res…
  ✓ NuGet                 probably available no package with this ID; reserved prefixes and the ty…
  ✓ Docker Hub            probably available no user or organization; deactivated or reserved Dock…
  ✓ GitHub user/org       probably available suspended, deleted or reserved accounts also look fre…
  ✓ MCP Registry          probably available no server uses this name in the registry as of 2026-10…
  ✓ Smithery              probably available no public servers; a namespace with none, or with onl…
  ✓ Claude plugins        available          not in the official marketplace
  ✓ Cursor plugins        probably available not among Cursor's listed plugins; plugins in review …
  ✓ Gemini extensions     probably available not in the Gemini CLI gallery; it lists only tagged G…
  ✓ VS Code Marketplace   probably available no extension or publisher; removed extensions keep th…
  ✓ Open VSX              probably available no namespace or similar one; namespaces without publi…
  ✓ JetBrains Marketplace probably available no plugin with this name or ID; unapproved and hidden…
  ✓ App Store             probably available no app with this name in the US store; unreleased app…
  ✓ Google Play           probably available no app with this title in search results of the US st…
  ✗ .com                  taken              registered 1999-02-13, expires 2027-02-13
  ✓ .dev                  probably available not registered; a registry can still refuse premium o…
  ✓ .sh                   probably available not registered (whois); a registry can still refuse p…

  npm       https://www.npmjs.com/package/nameable
  RubyGems  https://rubygems.org/gems/nameable
  .com      https://lookup.icann.org/en/lookup?name=nameable.com

  20 available (16 probably) · 3 taken
```

Several names show a grid to compare them:

```sh
npx nameable twinsy dupefind fclones --only crates,homebrew,github,domain --tlds com,dev,sh
```

```
                   twinsy    dupefind  fclones
  crates.io        ✓         ✓         ✗
  Homebrew         ✓         ✓         ✗
  GitHub user/org  ✗         ✓*        ✓*
  .com             ✗         ✗         ✓*
  .dev             ✓*        ✓*        ✓*
  .sh              ✓*        ✓*        ✓*
  free             4/6       5/6       4/6

  ✓ available  ↺ reclaimable  ✗ taken  ⊘ unavailable  ? unknown  * probably available
  Check one name at a time for the details behind each mark.
```

| Option          |                                                                                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--all`         | Check every channel                                                                                                                                                                                                                                                                                      |
| `--only <ids>`  | Channels to check: `npm`, `pypi`, `crates`, `homebrew`, `rubygems`, `packagist`, `pub`, `nuget`, `docker`, `github`, `mcp-registry`, `smithery`, `claude-plugins`, `cursor`, `gemini`, `vscode`, `open-vsx`, `jetbrains`, `app-store`, `google-play`, `domain` (every TLD in `--tlds`) or `domain:<tld>` |
| `--tlds <list>` | Domains to check, any TLD, at most 20 (default `com,dev`). TLDs without RDAP, such as `.io`, `.sh` and `.de`, go through whois. With `--only`, include `domain`                                                                                                                                          |
| `--json`        | Print JSON; also the default when the output is not a terminal                                                                                                                                                                                                                                           |
| `--refresh`     | Download the registry name lists again                                                                                                                                                                                                                                                                   |
| `--clear-cache` | Delete the cached name lists                                                                                                                                                                                                                                                                             |

GitHub checks use `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` when one is available, for a higher rate limit.

## Use it with AI agents

### Claude Code plugin

```
/plugin marketplace add minanyang/claude-plugins
/plugin install nameable@minanyang
```

Then ask for a name, or run `/nameable:check <names>`. The skill picks the channels that matter for your project,
checks them, looks for projects that already do the same thing, and gives a verdict for each candidate: use it, use it
with changes (a scope, another TLD, another GitHub owner), or drop it.

### MCP server

`npx -y nameable mcp` runs the same checks as an MCP server over stdio. It has one read-only tool, `check_names`
(`names`, and optionally `channels`, `tlds` and `refresh`), which returns the [JSON below](#json) as structured content.

| Client      | Add it with                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `claude mcp add nameable -- npx -y nameable mcp`                                                                                               |
| Codex       | `codex mcp add nameable -- npx -y nameable mcp`                                                                                                |
| Gemini CLI  | Add to `~/.gemini/settings.json`: `{ "mcpServers": { "nameable": { "command": "npx", "args": ["-y", "nameable", "mcp"] } } }`                  |
| VS Code     | `code --add-mcp '{"name":"nameable","type":"stdio","command":"npx","args":["-y","nameable","mcp"]}'`                                           |
| Cursor      | Add to `.cursor/mcp.json` or `~/.cursor/mcp.json`: `{ "mcpServers": { "nameable": { "command": "npx", "args": ["-y", "nameable", "mcp"] } } }` |

## What the answers mean

| Status        | Meaning                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `available`   | Nobody holds it and the registry would accept it                                                                                                                                |
| `reclaimable` | It was held but released (an unpublished npm package, a fully yanked gem); anyone can take it again                                                                             |
| `taken`       | Someone holds it; `url` shows who. Where names are not exclusive (MCP Registry, Google Play, Gemini CLI gallery), another entry uses it and `note` says it does not block yours |
| `unavailable` | Nobody holds it exactly, but the registry would refuse it: invalid, reserved, too similar, or blocked for now after a deletion                                                  |
| `unknown`     | No trustworthy answer: a network error, a rate limit, an unrecognized reply. Never treat it as free                                                                             |

An `available` answer carries a certainty. Only PyPI, crates.io, Homebrew and Claude plugins can answer **confirmed**;
every other channel keeps something out of public view, so its free answer is **probable** at most. **Confirmed** means every rule of that registry that public data allows
was checked. **Probable** (`*` in the grid) means one could not be, and `note` says which: GitHub hides suspended and
reserved accounts, npm's similar-name rule cannot be checked for every spelling, registries can refuse premium or
reserved domains, or a name list could not be downloaded. Two PyPI rules rest on data PyPI does not publish, so even a
confirmed PyPI answer cannot cover them: names its admins prohibited, and names similar to a quarantined project.

| Channel               | Checked beyond "not found"                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| npm                   | npm's name rules and Node.js core modules, names equal without punctuation, unpublished packages and the 24-hour block after an unpublish; similar spellings cannot all be checked, and a missing scoped package may be private, so a free answer is probable                                                                                          |
| PyPI                  | PEP 508 names, standard library names, similar names (`f1ask` = `flask`), projects with no releases or in quarantine                                                                                                                                                                                                                                   |
| crates.io             | Cargo's name rules, reserved names, recently deleted names, `-` and `_` as one                                                                                                                                                                                                                                                                         |
| Homebrew              | Formula name rules, aliases and old names of formulae and casks, names homebrew-core disallows                                                                                                                                                                                                                                                         |
| RubyGems              | Gem name rules, names unique ignoring case, reserved names, yanked gems held for their owners, names equal to a popular or recent gem without `-` and `_`                                                                                                                                                                                              |
| Packagist             | The name as a vendor: vendor rules and reserved vendors, and the typo rule against vendors one edit away; packages frozen for spam are hidden, so a free answer is probable                                                                                                                                                                            |
| pub.dev               | Dart name rules and reserved words, names kept for the Dart and Flutter teams, similar names (`_` dropped, plurals, `rn` for `m`); moderated packages are hidden, so a free answer is probable                                                                                                                                                         |
| NuGet                 | ID rules, unlisted packages, IDs NuGet deleted but still holds; reserved prefixes and the typosquatting check are private, so a free answer is probable                                                                                                                                                                                                |
| Docker Hub            | Docker ID rules, users and organizations (including ones only a redirect reveals), official images; deactivated IDs are hidden, so a free answer is probable                                                                                                                                                                                           |
| GitHub                | Users and organizations; hidden accounts make a free answer probable                                                                                                                                                                                                                                                                                   |
| Domains               | Any TLD through RDAP or whois, internationalized names, labels registries cannot accept                                                                                                                                                                                                                                                                |
| MCP Registry          | Servers whose name part matches, in any namespace, from a list of every server this project rebuilds daily from the registry API (its own search takes 30 seconds or more); nobody owns a bare name there, so a match is a clash and a free answer is probable                                                                                         |
| Smithery              | Namespace rules; a namespace with no public servers also looks free, so a free answer is probable                                                                                                                                                                                                                                                      |
| Cursor plugins        | Cursor's marketplace; plugin name rules. Undocumented data, so a free answer is probable                                                                                                                                                                                                                                                               |
| Gemini extensions     | The Gemini CLI gallery. Names are not unique there, so a match only means users will meet another extension by that name                                                                                                                                                                                                                               |
| VS Code Marketplace   | The name as an extension name, display name and publisher, all unique there; removed extensions keep their names but are hidden, so a free answer is probable                                                                                                                                                                                          |
| Open VSX              | The name as a namespace: Open VSX's rule against namespaces within 20% of an existing one, and its rule that only a verified owner may use a VS Code Marketplace publisher's name; namespaces without public extensions are hidden, so a free answer is probable                                                                                       |
| JetBrains Marketplace | The name as a plugin ID and plugin name: the words JetBrains refuses in new names (`plugin`, `IDEA`, product names), and the unique-name guideline; unapproved plugins are hidden, so a free answer is probable                                                                                                                                        |
| App Store             | An app with exactly this name (ignoring case and punctuation) in iOS and macOS search, in the US store and, for Chinese, Japanese or Korean names, those stores too; a title that adds a subtitle or its maker is reported as a clash, not a block. Names are unique per localization, but unreleased apps are invisible, so a free answer is probable |
| Google Play           | An app with exactly this title in search, in the same stores as the App Store; a title that adds a subtitle or its maker is reported as a clash too. Titles are not unique, so a match is a clash, not a block, and a free answer is probable                                                                                                          |
| Claude plugins        | Anthropic's official marketplace; plugin name rules and the names `claude plugin validate` reserves as Anthropic's own                                                                                                                                                                                                                                 |

### Name lists

Several checks compare against registry-wide lists: every PyPI project, every Homebrew alias and old name, the reserved
and recently deleted names in crates.io's daily database dump (read by byte range, under 1 MB of a 2 GB archive), every
pub.dev package, every gem, every MCP server, every Open VSX namespace, and every plugin and extension in Cursor's
marketplace and the Gemini CLI gallery. Each is downloaded the first time a check needs it, about 40 MB in all, and at most once a day after that. They
are kept compressed (about 13 MB) in `~/Library/Caches/nameable` on macOS,
`$XDG_CACHE_HOME/nameable` on Linux, `%LOCALAPPDATA%\nameable\Cache` on Windows, or `NAMEABLE_CACHE_DIR`.

### JSON

```json
{
  "schema": 1,
  "reports": [
    {
      "name": "nameable",
      "results": [
        {
          "channel": "npm",
          "label": "npm",
          "status": "taken",
          "url": "https://www.npmjs.com/package/nameable",
          "note": "..."
        },
        {
          "channel": "domain:dev",
          "label": ".dev",
          "status": "available",
          "certainty": "probable",
          "url": "https://lookup.icann.org/en/lookup?name=nameable.dev",
          "note": "..."
        }
      ]
    }
  ]
}
```

Exit codes: `0` every channel is available or reclaimable for every name · `1` taken or unavailable somewhere ·
`2` nothing taken, but some channels could not be checked · `64` usage error.

## Planned channels

Nameable checks npm, PyPI, crates.io, Homebrew, RubyGems, Packagist, pub.dev, NuGet, Docker Hub, GitHub users and
organizations, the MCP Registry, Smithery, Claude Code's official plugin marketplace, Cursor's marketplace, the Gemini
CLI gallery, VS Code Marketplace, Open VSX, JetBrains Marketplace, the App Store, Google Play, and domains today. Each
channel below was tested before it was listed: a request about a name gets an answer that tells an existing name apart
from a missing one.

| Group          | Channels           |
| -------------- | ------------------ |
| Social handles | X, YouTube, TikTok |

Not every channel has an official API. Where Nameable reads a public page or an undocumented endpoint, the site can
change it or block requests at any time: a free answer there is probable at most, and a blocked request is `unknown`.
The same goes for registries that keep part of their rules private, such as reserved names and typo checks.

These will only show whether something with the same name exists, never that a name is free:

| Channel                               | Why                                                 |
| ------------------------------------- | --------------------------------------------------- |
| Trademarks: USPTO (US), TIPO (Taiwan) | A matching mark is a risk to weigh, not a yes or no |

When a channel Nameable does not check matters for your project, the Claude Code skill lists it as not checked, so you
can look yourself.

## License

Nameable is released under the [MIT License](LICENSE).

The name Nameable refers to this project; please don't use it as the name of a fork or derivative work — saying a
fork is based on Nameable is fine.
