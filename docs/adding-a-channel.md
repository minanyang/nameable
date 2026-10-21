# Adding a channel

Every channel is built the same way and passes the same tests. A channel is not done until each step
below is.

## 1. Implement it with `defineChannel`

Create `packages/core/src/channels/<id>.ts`:

```ts
import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";

// Cite the official naming rule here, with a link.
const VALID = /^...$/;

export const example: Channel = defineChannel({
  id: "example",
  label: "Example",
  category: "package",
  rules: (name) => (VALID.test(name) ? undefined : "Example names are ..."),
  async lookup(name, ctx) {
    const res = await get(ctx, `https://api.example.com/packages/${name}`);
    if (res.status === 404) return { status: "available", certainty: "confirmed" };
    if (res.status !== 200) return unexpected("Example", res);
    return { status: "taken", url: `https://example.com/${name}`, note: "..." };
  },
});
```

Then add it to the list in `packages/core/src/channels/index.ts`.

The framework handles what is the same everywhere: `rules` runs before any request and a broken rule
returns `unavailable`; a thrown error becomes `unknown`; `channel` and `label` are filled in.

Rules for `lookup`:

- Use `get()` for HTTP and `whoisQuery()` for whois. They apply timeouts, retries and per-host limits.
- Map only responses you have seen. Anything else returns `unexpected()`, never `available`.
- Validate the shape of any list you download; a list in an unexpected shape must fail the check,
  never read as "nothing matches". Keep it with `cachedList`, adding its key to `LIST_KEYS`, and bump
  `FORMAT` in `lists.ts` when the line format of any list changes.
- Text from the registry is shown as is in JSON; the terminal renderer strips control characters.
- Rules come from the registry's own source (its validator, auditor or database migrations), cited
  next to the code. Do not rely on secondhand descriptions, including reviews: verify each claim
  with a contract test.
- `available` always carries `certainty`. Use `probable` when the service cannot prove it (hidden
  accounts, reserved names, a sub-check that could not run), and say why in `note`.
- `taken` and `reclaimable` always carry a `url` a person can open.

## 2. Add a fixture

In `packages/core/test/fixtures.ts`, add a `Fixture`:

- `free` and `taken`: fake services under which every name is free, or held.
- `accepts`: for **every** standard input class (uppercase, unicode, hyphens, dots, one character,
  empty, …) whether the channel accepts it. There is no default; decide each one from the official rule.
- `maxLength`, when the channel has a limit.
- `freeCertainty`: the certainty a free name reaches when every request succeeds.
- `refused`: names the registry would refuse although it answers 404 for them or they pass the basic
  syntax — reserved names, aliases, similar names. This is the case a "404 means free" fake never
  exercises, so every rule the channel enforces needs at least one entry here.

`conformance.test.ts` then runs the channel through, with no extra code:

- each input class, expecting `available` or `unavailable` (and no request for a rejected name);
- the length limit, at and one over;
- every `refused` name, expecting its status;
- the certainty of a free name, so a change that quietly downgrades every answer fails;
- the taken path;
- every request on the free path faulted in turn (network error, timeout, 500, 503, 429, 403, an
  unreadable body; for whois a dropped connection, a timeout, an unrecognized answer), which must never
  end in a confirmed `available`;
- random names against random persistent faults, checking the same invariants.

Add unit tests in `channels.test.ts` only for logic specific to the channel (npm's similar-name rule,
PyPI's normalization).

## 3. Check every assumption against the real service

Each assumption the channel and its fixture make — the status for a missing name, the response shape,
how names are normalized, any limits — gets a test in `contract.test.ts`. When one fails, the fake no
longer describes the service.

Add the channel to `live.test.ts` with a name that is certainly held, so the real taken and free paths
run end to end.

## 4. Document it

Add the channel to the channel list in the README.

## 5. Verify

```sh
pnpm verify               # format, lint, type check, unit tests with coverage thresholds, packed CLI
pnpm test:live            # live and contract tests against the real services
```

Both must pass. Coverage below the thresholds in `vite.config.ts` fails `pnpm verify`.
