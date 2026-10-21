---
name: check
description: Check whether a project, package, CLI or brand name is free everywhere it matters, find who already uses it or built the same thing, and recommend which candidates to keep. Use when naming or renaming a project, package, CLI, library, app, plugin or product, when brainstorming names, or when asked whether a name is taken or available.
---

# Nameable

Help the user pick a name they can actually use. Three layers, in order:

1. **Availability**: is the name free on the channels this project will ship on?
2. **Prior art**: has someone already built the same thing under this or a confusable name?
3. **Judgment**: which candidates to keep, change or drop, and why.

## Inputs

- Candidate names. If the user has none, propose 5–10 that say what the project does: real words that fit first,
  combinations next, coined words last.
- What the project is, in one line, and how it will ship (language, package registry, app store, plugin directory).
  Ask only if it cannot be inferred from the conversation or the repository (package.json, pyproject.toml,
  Cargo.toml, README).
- Channels the user names always override your choice.

## 1. Pick channels from the project's nature

Check only what matters, and say which channels you picked and why.

| Project                                          | Channels                                                    |
| ------------------------------------------------ | ----------------------------------------------------------- |
| TypeScript / JavaScript library, CLI, MCP server | `npm`, `github`, `homebrew` (CLIs), `domain` with `com,dev` |
| Python library or CLI                            | `pypi`, `github`, `homebrew` (CLIs), `domain`               |
| Rust crate or CLI                                | `crates`, `github`, `homebrew` (CLIs), `domain`             |
| Agent plugin or skill                            | `npm` if it ships a package, `github`, `domain`             |
| Consumer app or brand                            | `domain` with `com` first, `github`                         |

Add TLDs the project would really use (`io`, `sh`, `app`, `ai`, a country code). Not every channel matters
equally:

- **Hard constraints**: an active project in the same category, a confusable well-known brand, a trademark.
- **Soft constraints** (each has a workaround): an unscoped npm name (a scope such as `@owner/name` works), a GitHub
  user or org (the repo can live under another owner), a `.com` for a developer tool.

Never drop a name on a soft constraint alone.

## 2. Availability

Call the `check_names` tool with all candidates at once and only the channels you picked. Without the tool, run
the CLI instead: `npx -y nameable <names...> --only <channels> --tlds <tlds> --json`.

Read each result exactly:

- `available` + `confirmed`: free; every rule public data allows was checked. PyPI does not publish the names its
  admins prohibited or its quarantined projects, so a confirmed PyPI answer cannot rule those out.
- `available` + `probable`: likely free, but `note` names what could not be checked (GitHub hides suspended
  accounts, npm's similar-name rule, premium domains). Say so; never present it as certain.
- `reclaimable`: released and can be taken again.
- `taken`: held. Open `url` or read `note` to see by whom and whether it is active.
- `unavailable`: nobody holds it exactly, but the registry refuses it; `note` says why (reserved, too similar to an
  existing name, blocked after a recent deletion). Treat it like taken, unless `note` gives a date when the block
  ends (npm after an unpublish, crates.io after a deletion); then say when it frees.
- `unknown`: the check failed. It is not free. Retry once, then report it as not checked.

These channels are not checked by the tool yet: app stores, editor and agent plugin directories, MCP registries,
social handles and trademarks. When one matters for this project, check it with the tools you have (web search,
the directory's own search) or list it under "not checked".

## 3. Prior art

For every candidate still standing, look for someone who already built the same thing:

- **Taken entries**: read the description behind each `taken` result. A package in the same category is the
  strongest signal.
- **GitHub**: search repositories for the exact name; filter to exact repository names, because search matches
  loosely.
- **Web**: search the exact name in quotes with a word for the category. Ignore results the engine rewrote to a
  similar spelling.
- **The category itself**: search what the project does (for example "name availability checker CLI") to find
  competitors whatever they are called.
- **Brands and trademarks**: check whether the name, or something that sounds like it, is a known brand or a
  registered mark in the project's field.

For each hit, note the category, whether it is active (recent release, commits, downloads) and a link.

## 4. Judgment

Per candidate:

- Same category and active: **drop**.
- Same category but dormant for years: **caution**. The name may still confuse users; registries have dispute
  processes (npm's dispute policy, PyPI's PEP 541) but they are slow and not guaranteed.
- Unrelated use, or dormant: **acceptable**, with the soft-constraint workaround it needs.
- Confusable with a well-known brand, or a registered mark in the same field: **drop**. Call it a trademark risk
  only when you found the registration; otherwise call it brand confusion.
- Meaning: does the word fit what the product does, or work against it?

## 5. Report

Lead with a verdict per candidate: **Use**, **Use with changes** (say which: a scope, another TLD, a GitHub owner) or
**Drop**, with the one reason that decided it. Then a table per candidate of the channels checked with status and
evidence link, then the prior art found, then what was not checked or came back `unknown`. Recommend one name.
