<div align="center">

# Nameable

Find out if a name is free everywhere your project will ship, and don't take a 404 for a yes.

[![npm](https://img.shields.io/npm/v/nameable)](https://www.npmjs.com/package/nameable) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-D97757)](https://code.claude.com/docs/en/plugins)

**English** · [繁體中文](README.zh-TW.md)

</div>

Nameable checks a name on package registries, GitHub, agent directories and domains, shows the evidence behind every answer, and
says how sure each answer is. It runs as a CLI, as an MCP server for AI agents, and as a Claude Code plugin that also
looks for prior art and recommends which name to keep.

## Why

Most availability checks ask each registry whether the name exists and read "not found" as free. Not found only
means nobody holds that exact name. The registry may still refuse it:

| Name           | Registry  | Not found? | What the registry does                                |
| -------------- | --------- | ---------- | ----------------------------------------------------- |
| `f1ask`        | PyPI      | yes        | Refuses it: too similar to `flask`                    |
| `first-one`    | npm       | yes        | Refuses it: same as `firstone` without punctuation    |
| `golang`       | Homebrew  | yes        | Already taken: an alias of `go`                       |
| `rust`         | crates.io | yes        | Refuses it: reserved by crates.io                     |
| `gh`           | crates.io | yes        | Refuses it until 2027: the crate was deleted recently |
| `xn--ls8h.dev` | domains   | yes        | Cannot be registered: it is an emoji in punycode      |

Nameable applies each registry's own rules, taken from its source code, and checks the lists those rules need:
similar and reserved names, aliases and old names, recently deleted names, unpublished packages. When a rule cannot
be checked, the answer says "probably" and why, instead of "available". A failed request is `unknown`, never free.

## Use it from the terminal

Requires Node.js 22 or later.

```sh
npx nameable nameable --tlds com,dev,sh
```

```
Checking "nameable" on 10 channels

  ✗ npm             taken              Find out if a name is free everywhere it matters for your p…
  ✓ PyPI            available
  ✓ crates.io       available
  ✓ Homebrew        available          no homebrew-core formula or cask
  ✓ GitHub user/org probably available suspended, deleted or reserved accounts also look free; con…
  ✓ Smithery        probably available no public servers; a namespace with none, or with only unli…
  ✓ Claude plugins  available          not in the official marketplace
  ✗ .com            taken              registered 1999-02-13, expires 2027-02-13
  ✓ .dev            probably available not registered; premium or reserved names can still be refu…
  ✓ .sh             probably available not registered (whois); premium or reserved names can still…

  npm   https://www.npmjs.com/package/nameable
  .com  https://lookup.icann.org/en/lookup?name=nameable.com

  8 available · 2 taken
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
```

| Option          |                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--only <ids>`  | Channels to check: `npm`, `pypi`, `crates`, `homebrew`, `github`, `smithery`, `claude-plugins`, `domain` (every TLD in `--tlds`) or `domain:<tld>` |
| `--tlds <list>` | Domains to check, any TLD (default `com,dev`). TLDs without RDAP, such as `.io`, `.sh` and `.de`, go through whois                                 |
| `--json`        | Print JSON; also the default when the output is not a terminal                                                                                     |
| `--refresh`     | Download the registry name lists again                                                                                                             |
| `--clear-cache` | Delete the cached name lists                                                                                                                       |

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

| Status        | Meaning                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `available`   | Nobody holds it and the registry would accept it                                                                               |
| `reclaimable` | It was held but released (an unpublished npm package); anyone can take it again                                                |
| `taken`       | Someone holds it; `url` shows who                                                                                              |
| `unavailable` | Nobody holds it exactly, but the registry would refuse it: invalid, reserved, too similar, or blocked for now after a deletion |
| `unknown`     | No trustworthy answer: a network error, a rate limit, an unrecognized reply. Never treat it as free                            |

An `available` answer carries a certainty. **Confirmed** means every rule of that registry that public data allows
was checked. **Probable** (`*` in the grid) means one could not be, and `note` says which: GitHub hides suspended and
reserved accounts, npm's similar-name rule cannot be checked for every spelling, registries can refuse premium or
reserved domains, or a name list could not be downloaded. Two PyPI rules rest on data PyPI does not publish, so even a
confirmed PyPI answer cannot cover them: names its admins prohibited, and names similar to a quarantined project.

| Channel        | Checked beyond "not found"                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm            | npm's name rules and Node.js core modules, names equal without punctuation, unpublished packages and the 24-hour block after an unpublish; a missing scoped package may be private, so it is probable |
| PyPI           | PEP 508 names, standard library names, similar names (`f1ask` = `flask`), projects with no releases or in quarantine                                                                                  |
| crates.io      | Cargo's name rules, reserved names, recently deleted names, `-` and `_` as one                                                                                                                        |
| Homebrew       | Formula name rules, aliases and old names of formulae and casks, names homebrew-core disallows                                                                                                        |
| GitHub         | Users and organizations; hidden accounts make a free answer probable                                                                                                                                  |
| Domains        | Any TLD through RDAP or whois, internationalized names, labels registries cannot accept                                                                                                               |
| Smithery       | Namespace rules; a namespace with no public servers also looks free, so a free answer is probable                                                                                                     |
| Claude plugins | Anthropic's official marketplace; plugin name rules and the names `claude plugin validate` reserves as Anthropic's own                                                                                |

### Name lists

PyPI, Homebrew and crates.io checks compare against registry-wide lists: every PyPI project, every Homebrew alias and
old name, and the reserved and recently deleted names in crates.io's daily database dump (read by byte range, under
1 MB of a 2 GB archive). They are downloaded the first time a check needs them, about 10 MB in all, and at most once a
day after that. They are kept compressed (about 8.5 MB) in `~/Library/Caches/nameable` on macOS,
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

Nameable checks npm, PyPI, crates.io, Homebrew, GitHub users and organizations, Smithery, Claude Code's official plugin
marketplace, and domains today. Each channel below
was tested before it was listed: a request about a name gets an answer that tells an existing name apart from a missing
one.

| Group              | Channels                                             |
| ------------------ | ---------------------------------------------------- |
| AI agents          | MCP Registry, Cursor, Gemini CLI extensions          |
| Package registries | Packagist, RubyGems, pub.dev, NuGet, Docker Hub      |
| Editor extensions  | VS Code Marketplace, Open VSX, JetBrains Marketplace |
| Social handles     | X, YouTube, TikTok                                   |

Not every channel has an official API. Where Nameable reads a public page or an undocumented endpoint, the site can
change it or block requests at any time: a free answer there is probable at most, and a blocked request is `unknown`.
The same goes for registries that keep part of their rules private, such as reserved names and typo checks.

These will only show whether something with the same name exists, never that a name is free:

| Channel                               | Why                                                            |
| ------------------------------------- | -------------------------------------------------------------- |
| Apple App Store, Google Play          | App names are not unique, and an unreleased app cannot be seen |
| Trademarks: USPTO (US), TIPO (Taiwan) | A matching mark is a risk to weigh, not a yes or no            |

When a channel Nameable does not check matters for your project, the Claude Code skill lists it as not checked, so you
can look yourself.

## License

Nameable is released under the [MIT License](LICENSE).

The name Nameable refers to this project; please don't use it as the name of a fork or derivative work — saying a
fork is based on Nameable is fine.
