# Nameable

Find out if a name is free everywhere it matters for your project, and whether someone already built the same thing.

Work in progress.

## Development

Built with [Vite+](https://viteplus.dev) (`vp`): Oxfmt, Oxlint with type checks, Vitest and tsdown.

```sh
pnpm install
pnpm nameable <name>          # run the CLI from source
pnpm check                    # format, lint and type-check (vp check; --fix to apply)
pnpm test                     # unit tests
pnpm test:live                # also hit the real registries
pnpm build                    # vp pack in every package
```

## License

The code is released under the [MIT License](LICENSE).

The Nameable name is not covered by the MIT License. Forks and derivative works must use a different name;
saying a fork is "based on Nameable" is fine.
