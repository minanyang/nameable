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

| Status        | Meaning                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `available`   | Nobody holds it and it passes the channel's naming rules                                      |
| `reclaimable` | It was held but released (an unpublished npm package); anyone can take it again               |
| `taken`       | Someone holds it                                                                              |
| `unavailable` | Nobody holds it exactly, but the channel would refuse it (invalid, or too similar on npm)     |
| `unknown`     | No trustworthy answer (network error, rate limit, unrecognized reply). Never reported as free |

An `available` with `"certainty": "probable"` (`*` in the grid) is one the channel cannot fully prove: GitHub hides
suspended and reserved accounts, and registries can refuse premium or reserved domains.

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
