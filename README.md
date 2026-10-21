# Nameable

Find out if a name is free everywhere it matters for your project, and whether someone already built the same thing.

Work in progress.

## Usage

```sh
npx nameable <name>                 # every channel, with the evidence behind each answer
npx nameable aa bb cc               # compare candidates in a grid
npx nameable <name> --only npm,github,domain:dev
npx nameable <name> --tlds com,dev,io,sh
npx nameable <name> --json          # also the default when stdout is not a terminal
```

Channels: `npm`, `pypi`, `crates`, `homebrew`, `github` (user or org), and `domain:<tld>` for any TLD
(RDAP, or whois for TLDs without RDAP such as `.io`, `.sh`, `.co`, `.de`, `.jp`). Default TLDs are `.com` and `.dev`.

### What the answers mean

| Status        | Meaning                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `available`   | Nobody holds it and it passes the channel's naming rules                                                                       |
| `reclaimable` | It was held but released (an unpublished npm package); anyone can take it again                                                |
| `taken`       | Someone holds it                                                                                                               |
| `unavailable` | Nobody holds it exactly, but the channel would refuse it (invalid, reserved, too similar, or blocked for now after a deletion) |
| `unknown`     | No trustworthy answer (network error, rate limit, unrecognized reply). Never reported as free                                  |

`"certainty": "confirmed"` means every rule of that registry that can be checked from public data was checked: its
naming rules, reserved names, recently deleted names, aliases and similar-name rules. Two PyPI rules rest on data PyPI
does not publish, so even a confirmed PyPI answer cannot cover them: names its admins prohibited, and names similar to a
quarantined project. `"probable"` (`*` in the grid) means a rule could not be fully checked, and `note` says which: GitHub
hides suspended and reserved accounts, npm's similar-name rule cannot be checked for every spelling and a scope belongs to
its owner, registries can refuse premium or reserved domains, and a registry list could not be downloaded.

PyPI, Homebrew and crates.io checks compare against registry-wide lists: every PyPI project (its similar-name rule),
every Homebrew alias and old name, and the reserved and recently deleted crate names in crates.io's daily database dump
(read by byte range, under 1 MB of a 2 GB archive). The lists are downloaded at most once a day and kept compressed
(about 8.5 MB) in the OS cache directory (`~/Library/Caches/nameable` on macOS, `$XDG_CACHE_HOME/nameable` on Linux,
`%LOCALAPPDATA%\nameable\Cache` on Windows, or `NAMEABLE_CACHE_DIR`). `--refresh` downloads them again;
`--clear-cache` deletes them and nothing else.

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
          "note": "..."
        }
      ]
    }
  ]
}
```

### Exit codes

`0` every channel is available or reclaimable for every name · `1` taken or unavailable somewhere ·
`2` nothing taken, but some channels could not be checked · `64` usage error.

GitHub checks use `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` when available, for a higher rate limit.

### MCP

`nameable mcp` runs the same checks as an MCP server over stdio, with one read-only tool, `check_names`
(`names`, and optionally `channels`, `tlds` and `refresh`). It returns the JSON above as structured content.

```sh
claude mcp add nameable -- npx -y nameable mcp
```

## Development

Built with [Vite+](https://viteplus.dev) (`vp`): Oxfmt, Oxlint with type checks, Vitest and tsdown.

```sh
pnpm install
pnpm nameable <name>          # run the CLI from source
pnpm check                    # format, lint and type-check (vp check; --fix to apply)
pnpm test                     # unit tests with coverage
pnpm test:live                # also hit the real services (live and contract tests)
pnpm test:dist                # build, then run the packed CLI
pnpm verify                   # check + test + test:dist
pnpm build                    # vp pack in every package
```

Before committing, run `pnpm verify` (check, unit tests with coverage thresholds, packed CLI) and
`pnpm test:live`. To add a channel, follow [docs/adding-a-channel.md](docs/adding-a-channel.md).

## License

The code is released under the [MIT License](LICENSE).

The Nameable name is not covered by the MIT License. Forks and derivative works must use a different name;
saying a fork is "based on Nameable" is fine.
