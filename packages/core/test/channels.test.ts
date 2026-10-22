import { describe, expect, it } from "vite-plus/test";
import {
  check,
  checkMany,
  normalizePypi,
  readWhois,
  selectChannels,
  type CheckResult,
} from "../src/index.js";
import { Gate } from "../src/gate.js";
import { fakeFetch, fakeWhois, seq, zipArchive, rangeReply, type Reply } from "./fake-fetch.js";
import { CRATES_DUMP, cratesDump } from "./fixtures.js";

const NPM = "https://registry.npmjs.org";
const searchUrl = (name: string) => `${NPM}/-/v1/search?text=${name}&size=50`;
const searchHits = (...names: string[]): Reply => [
  200,
  { objects: names.map((name) => ({ package: { name } })) },
];
const BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
const bootstrap: Reply = [200, { services: [[["dev", "app"], ["https://rdap.example/v1/"]]] }];

async function one(
  channel: string,
  name: string,
  routes: Parameters<typeof fakeFetch>[0],
  whois: Parameters<typeof fakeWhois>[0] = {},
  now?: number,
): Promise<CheckResult> {
  const [result] = await check(name, selectChannels({ only: [channel] }), {
    fetch: fakeFetch(routes),
    whois: fakeWhois(whois),
    backoffMs: 0,
    now: now === undefined ? undefined : () => now,
  });
  return result!;
}

/** 404 routes for every single-hyphen spelling the npm channel probes. */
const hyphenProbes = (name: string, override: Record<string, Reply> = {}) =>
  Object.fromEntries(
    Array.from(
      { length: name.length - 1 },
      (_, i) => `${name.slice(0, i + 1)}-${name.slice(i + 1)}`,
    ).map((v) => [`${NPM}/${v}`, override[v] ?? 404]),
  );

describe("npm", () => {
  // npm's similar-name rule cannot be checked for every spelling (babel-preset-env vs babelpresetenv),
  // so a free unscoped name is never more than probable.
  it("is probably available when no checked spelling exists", async () => {
    const r = await one("npm", "zzname", {
      [`${NPM}/zzname`]: 404,
      [searchUrl("zzname")]: searchHits("zz-other"),
      ...hyphenProbes("zzname"),
    });
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
    expect(r.note).toContain("not every spelling can be checked");
  });

  it("says who can publish under a scope", async () => {
    const org = await one("npm", "@babel/zz", {
      [`${NPM}/@babel%2fzz`]: 404,
      [`${NPM}/-/org/babel/package`]: [200, {}],
    });
    expect(org).toMatchObject({ status: "available", certainty: "probable" });
    expect(org.note).toContain("@babel is an npm organization");
    const user = await one("npm", "@zq/zz", {
      [`${NPM}/@zq%2fzz`]: 404,
      [`${NPM}/-/org/zq/package`]: 404,
    });
    expect(user.note).toContain('only the npm user or organization "zq"');
  });

  it("is unavailable when a hyphenated spelling exists that search does not surface", async () => {
    const r = await one("npm", "lodashes", {
      [`${NPM}/lodashes`]: 404,
      [searchUrl("lodashes")]: searchHits(),
      ...hyphenProbes("lodashes", { "lodash-es": 200 }),
    });
    expect(r).toMatchObject({
      status: "unavailable",
      note: 'npm rejects names too similar to "lodash-es"',
    });
  });

  it("is unavailable when only punctuation separates it from an existing package", async () => {
    const r = await one("npm", "first-one", {
      [`${NPM}/first-one`]: 404,
      [searchUrl("first-one")]: searchHits(),
      [searchUrl("firstone")]: searchHits("firstone"),
    });
    expect(r.status).toBe("unavailable");
    expect(r.note).toContain('"firstone"');
  });

  it("is unavailable for 24 hours after every version was unpublished", async () => {
    const doc = { name: "gone", time: { unpublished: { time: "2026-10-21T12:00:00.000Z" } } };
    const at = (iso: string) =>
      one("npm", "gone", { [`${NPM}/gone`]: [200, doc] }, {}, Date.parse(iso));
    expect(await at("2026-10-22T11:59:00Z")).toMatchObject({
      status: "unavailable",
      note: "unpublished on 2026-10-21; npm blocks the name until 2026-10-22 12:00 UTC",
    });
    expect((await at("2026-10-22T12:00:00Z")).status).toBe("reclaimable");
  });

  it("is unknown, never reclaimable, when the unpublish time cannot be read", async () => {
    const doc = { name: "gone", time: { unpublished: { time: "yesterday" } } };
    expect((await one("npm", "gone", { [`${NPM}/gone`]: [200, doc] })).status).toBe("unknown");
  });

  it("is reclaimable when every version was unpublished", async () => {
    const doc = {
      name: "gone",
      time: { unpublished: { time: "2023-07-05T00:47:37.960Z", versions: ["1.0.0"] } },
    };
    const r = await one("npm", "gone", { [`${NPM}/gone`]: [200, doc] });
    expect(r.status).toBe("reclaimable");
    expect(r.note).toContain("2023-07-05");
  });

  it("leaves out an empty description", async () => {
    const doc = { versions: { "1.0.0": {} }, description: null };
    const r = await one("npm", "thing", { [`${NPM}/thing`]: [200, doc] });
    expect(r.status).toBe("taken");
    expect("note" in r).toBe(false);
  });

  it("is taken when the package has versions", async () => {
    const doc = {
      versions: { "1.0.0": {} },
      description: "A thing",
      "dist-tags": { latest: "1.0.0" },
    };
    expect(await one("npm", "thing", { [`${NPM}/thing`]: [200, doc] })).toMatchObject({
      status: "taken",
      note: "A thing",
    });
  });

  it("rejects names npm would refuse without asking the registry", async () => {
    for (const name of ["Upper", "_lead", "fs", "has space"]) {
      expect((await one("npm", name, {})).status).toBe("unavailable");
    }
  });

  it("downgrades to probable when the similar-name search fails", async () => {
    const r = await one("npm", "zzname", { [`${NPM}/zzname`]: 404, [searchUrl("zzname")]: 500 });
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
  });

  // npm search rejects text outside 2–64 characters with HTTP 400.
  // Only the routes given exist; any other request fails, which would show as "could not check".
  it("does not search a one-letter name, since npm search rejects it", async () => {
    const r = await one("npm", "q", { [`${NPM}/q`]: 404 });
    expect(r.note).not.toContain("could not check");
  });

  it("searches but does not probe hyphen spellings of a long name", async () => {
    const name = "a".repeat(50);
    const r = await one("npm", name, { [`${NPM}/${name}`]: 404, [searchUrl(name)]: searchHits() });
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
    expect(r.note).not.toContain("could not check");
  });

  it("does not search a name longer than npm search accepts", async () => {
    const name = "a".repeat(70);
    const r = await one("npm", name, { [`${NPM}/${name}`]: 404 });
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
  });
});

describe("pypi", () => {
  it("normalizes names the way PyPI compares them", () => {
    expect(normalizePypi("Foo_Bar..baz")).toBe("foo-bar-baz");
  });

  it("queries the normalized name", async () => {
    const r = await one("pypi", "Foo_Bar", {
      "https://pypi.org/pypi/foo-bar/json": 404,
      "https://pypi.org/simple/foo-bar/": 404,
      "https://pypi.org/simple/": [200, { projects: [{ name: "requests" }] }],
    });
    expect(r.status).toBe("available");
  });

  it("is unknown when the project's simple page fails, never available", async () => {
    const r = await one("pypi", "zz", {
      "https://pypi.org/pypi/zz/json": 404,
      "https://pypi.org/simple/zz/": 503,
    });
    expect(r.status).toBe("unknown");
  });

  it("is taken with the project's summary", async () => {
    const body = { info: { name: "requests", summary: "HTTP for Humans.", version: "2.0" } };
    const r = await one("pypi", "requests", { "https://pypi.org/pypi/requests/json": [200, body] });
    expect(r).toMatchObject({ status: "taken", note: "HTTP for Humans." });
  });
});

describe("crates", () => {
  const free = (dump: Reply | ((h: Record<string, string>) => Reply)) => ({
    "https://crates.io/api/v1/crates/zz": 404,
    [CRATES_DUMP]: dump,
  });

  it("frees a deleted name once its available_at has passed", async () => {
    const dump = cratesDump(["std"], [["zz", "2026-10-22 12:00:00+00"]]);
    const before = await one("crates", "zz", free(dump), {}, Date.parse("2026-10-22T11:00:00Z"));
    expect(before).toMatchObject({
      status: "unavailable",
      note: "recently deleted; crates.io frees the name after 2026-10-22 12:00 UTC",
    });
    const after = await one("crates", "zz", free(dump), {}, Date.parse("2026-10-22T13:00:00Z"));
    expect(after).toMatchObject({ status: "available", certainty: "confirmed" });
  });

  it.each([
    ["a server that ignores ranges", () => rangeReply(zipArchive({}), {})],
    [
      "something that is not a zip",
      (h: Record<string, string>) => rangeReply(Buffer.from("nope"), h),
    ],
    [
      "a dump without the deleted table",
      (h: Record<string, string>) =>
        rangeReply(zipArchive({ "data/reserved_crate_names.csv": "name\nstd\n" }), h),
    ],
    [
      "a deleted table in another shape",
      (h: Record<string, string>) =>
        rangeReply(
          zipArchive({
            "data/reserved_crate_names.csv": "name\nstd\n",
            "data/deleted_crates.csv": "name,until\nzz,soon\n",
          }),
          h,
        ),
    ],
  ])("is only probable with %s", async (_, dump) => {
    const r = await one("crates", "zz", free(dump));
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
    expect(r.note).toContain("database dump");
  });
});

describe("homebrew", () => {
  const api = "https://formulae.brew.sh/api";
  it("accepts versioned and + names, which become valid class names", async () => {
    for (const name of ["python@3.12", "c++"]) {
      const r = await one("homebrew", name, {
        [`${api}/formula/${name}.json`]: [200, { desc: "x" }],
        [`${api}/cask/${name}.json`]: 404,
      });
      expect(r.status).toBe("taken");
    }
  });

  it("is only probable when formula.json entries lack the alias arrays", async () => {
    const r = await one("homebrew", "thing", {
      [`${api}/formula/thing.json`]: 404,
      [`${api}/cask/thing.json`]: 404,
      [`${api}/formula.json`]: [200, [{ name: "go" }]],
      [`${api}/cask.json`]: [200, [{ token: "firefox", old_tokens: [] }]],
    });
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
  });

  it("is taken by a cask", async () => {
    const r = await one("homebrew", "thing", {
      [`${api}/formula/thing.json`]: 404,
      [`${api}/cask/thing.json`]: [200, { desc: "App" }],
    });
    expect(r).toMatchObject({ status: "taken", meta: { kind: "cask" } });
  });

  it("leaves out a description the registry sends as null", async () => {
    const r = await one("homebrew", "backlog", {
      [`${api}/formula/backlog.json`]: 404,
      [`${api}/cask/backlog.json`]: [200, { token: "backlog", desc: null }],
    });
    expect(r.status).toBe("taken");
    expect("note" in r).toBe(false);
  });

  it("is unknown when one side fails", async () => {
    const r = await one("homebrew", "thing", {
      [`${api}/formula/thing.json`]: 404,
      [`${api}/cask/thing.json`]: 503,
    });
    expect(r.status).toBe("unknown");
  });
});

describe("github", () => {
  const url = "https://api.github.com/users/someone";
  it("treats a 404 as only probably free, because hidden accounts also 404", async () => {
    expect(await one("github", "someone", { [url]: 404 })).toMatchObject({
      status: "available",
      certainty: "probable",
    });
  });

  it("says the token was rejected on a 401", async () => {
    const r = await one("github", "someone", { [url]: 401 });
    expect(r).toMatchObject({
      status: "unknown",
      note: expect.stringContaining("rejected the token"),
    });
  });

  it("is unknown when rate limited, never available", async () => {
    expect((await one("github", "someone", { [url]: 403 })).status).toBe("unknown");
  });

  it("rejects invalid logins", async () => {
    expect((await one("github", "-bad", {})).status).toBe("unavailable");
  });
});

describe("smithery", () => {
  const url = (ns: string) => `https://api.smithery.ai/servers?namespace=${ns}&pageSize=1`;

  it("says how many servers the namespace holds", async () => {
    const r = await one("smithery", "acme", {
      [url("acme")]: [
        200,
        {
          servers: [{ qualifiedName: "acme/weather", displayName: "Weather" }],
          pagination: { totalCount: 3 },
        },
      ],
    });
    expect(r).toMatchObject({
      status: "taken",
      url: "https://smithery.ai/servers/acme/weather",
      note: "3 servers in this namespace, such as Weather",
    });
  });

  it("is unknown when Smithery asks for a key", async () => {
    expect((await one("smithery", "acme", { [url("acme")]: 401 })).status).toBe("unknown");
  });
});

describe("claude-plugins", () => {
  const MARKETPLACE =
    "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json";

  it("passes on the warning for a name with claude as a whole word", async () => {
    const r = await one("claude-plugins", "mcp-for-claude", {
      [MARKETPLACE]: [200, { plugins: [{ name: "github" }] }],
    });
    expect(r).toMatchObject({
      status: "available",
      certainty: "confirmed",
      note: expect.stringContaining("reads as one of Anthropic's own"),
    });
  });

  it("is unknown when the marketplace is empty or unreadable", async () => {
    for (const reply of [[200, { plugins: [] }], [200, {}], 404] as Reply[]) {
      expect((await one("claude-plugins", "thing", { [MARKETPLACE]: reply })).status).toBe(
        "unknown",
      );
    }
  });
});

describe("domain", () => {
  it("looks up the TLD's RDAP server from the IANA bootstrap", async () => {
    const r = await one("domain:dev", "zz", {
      [BOOTSTRAP]: bootstrap,
      "https://rdap.example/v1/domain/zz.dev": 404,
    });
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
  });

  it("reports registration dates when taken", async () => {
    const doc = { events: [{ eventAction: "registration", eventDate: "1999-02-13T00:00:00Z" }] };
    const r = await one("domain:dev", "zz", {
      [BOOTSTRAP]: bootstrap,
      "https://rdap.example/v1/domain/zz.dev": [200, doc],
    });
    expect(r).toMatchObject({ status: "taken", meta: { registered: "1999-02-13" } });
  });

  describe("whois fallback for TLDs without RDAP", () => {
    const iana = { "whois.iana.org sh": "refer: whois.nic.sh\nwhois:        whois.nic.sh\n" };

    it("is probably available when the registry says not found", async () => {
      const r = await one(
        "domain:sh",
        "zz",
        { [BOOTSTRAP]: bootstrap },
        { ...iana, "whois.nic.sh zz.sh": "Domain not found.\n>>> Last update of WHOIS database" },
      );
      expect(r).toMatchObject({ status: "available", certainty: "probable" });
    });

    it("is taken with the creation date when registered", async () => {
      const text = "Domain Name: zz.sh\nCreation Date: 2001-04-02T00:00:00Z\n";
      const r = await one(
        "domain:sh",
        "zz",
        { [BOOTSTRAP]: bootstrap },
        { ...iana, "whois.nic.sh zz.sh": text },
      );
      expect(r).toMatchObject({ status: "taken", meta: { registered: "2001-04-02" } });
    });

    it("is unknown when the answer is not recognized", async () => {
      const r = await one(
        "domain:sh",
        "zz",
        { [BOOTSTRAP]: bootstrap },
        { ...iana, "whois.nic.sh zz.sh": "Rate limit exceeded\n" },
      );
      expect(r.status).toBe("unknown");
    });

    it("is unknown when IANA lists no whois server", async () => {
      const r = await one(
        "domain:sh",
        "zz",
        { [BOOTSTRAP]: bootstrap },
        { "whois.iana.org sh": "" },
      );
      expect(r.status).toBe("unknown");
    });

    it("also covers a failed RDAP bootstrap", async () => {
      const r = await one(
        "domain:sh",
        "zz",
        { [BOOTSTRAP]: 503 },
        { ...iana, "whois.nic.sh zz.sh": "Domain not found." },
      );
      expect(r.status).toBe("available");
    });
  });

  it("checks an internationalized name in its punycode form", async () => {
    const r = await one("domain:dev", "Café", {
      [BOOTSTRAP]: bootstrap,
      "https://rdap.example/v1/domain/xn--caf-dma.dev": 404,
    });
    expect(r).toMatchObject({
      status: "available",
      url: expect.stringContaining("xn--caf-dma.dev"),
    });
  });

  it("fetches the bootstrap once for several TLDs", async () => {
    const fetch = fakeFetch({
      [BOOTSTRAP]: bootstrap,
      "https://rdap.example/v1/domain/zz.dev": 404,
      "https://rdap.example/v1/domain/zz.app": 404,
    });
    await check("zz", selectChannels({ only: ["domain"], tlds: ["dev", "app"] }), {
      fetch,
      backoffMs: 0,
    });
    expect(fetch.calls.filter((u) => u === BOOTSTRAP)).toHaveLength(1);
  });
});

describe("check", () => {
  it("retries a 429 and uses the answer that follows", async () => {
    const r = await one("crates", "serde", {
      "https://crates.io/api/v1/crates/serde": seq(429, [200, { crate: { name: "serde" } }]),
    });
    expect(r.status).toBe("taken");
  });

  it("turns repeated network failures into unknown, never available", async () => {
    const r = await one("crates", "serde", {
      "https://crates.io/api/v1/crates/serde": new TypeError("fetch failed"),
    });
    expect(r).toMatchObject({ status: "unknown", note: "request failed: fetch failed" });
  });

  it("does not retry a timeout and reports it as unknown", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const fetch = fakeFetch({ "https://crates.io/api/v1/crates/serde": timeout });
    const [r] = await check("serde", selectChannels({ only: ["crates"] }), { fetch, backoffMs: 0 });
    expect(r).toMatchObject({ status: "unknown", note: "timed out" });
    expect(fetch.calls).toHaveLength(1);
  });

  it("streams each result as it finishes", async () => {
    const seen: string[] = [];
    await check("zz", selectChannels({ only: ["pypi", "crates"] }), {
      fetch: fakeFetch({
        "https://pypi.org/pypi/zz/json": 404,
        "https://crates.io/api/v1/crates/zz": 404,
      }),
      onResult: (_name, r) => seen.push(r.channel),
    });
    expect(seen.sort()).toEqual(["crates", "pypi"]);
  });

  it("checks several names and shares lookups between them", async () => {
    const fetch = fakeFetch({
      [BOOTSTRAP]: bootstrap,
      "https://rdap.example/v1/domain/aa.dev": 404,
      "https://rdap.example/v1/domain/bb.dev": [200, {}],
    });
    const reports = await checkMany(["aa", "bb"], selectChannels({ only: ["domain:dev"] }), {
      fetch,
      backoffMs: 0,
    });
    expect(reports.map((r) => [r.name, r.results[0]!.status])).toEqual([
      ["aa", "available"],
      ["bb", "taken"],
    ]);
    expect(fetch.calls.filter((u) => u === BOOTSTRAP)).toHaveLength(1);
  });

  it("keeps requests to one host within its concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const fetch = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response("{}", { status: 404 });
    };
    // A 12-letter name makes the npm channel probe 11 hyphenated spellings at once.
    await check("abcdefghijkl", selectChannels({ only: ["npm"] }), {
      fetch: async (url) =>
        url.includes("/-/v1/search")
          ? new Response(JSON.stringify({ objects: [] }), { status: 200 })
          : fetch(),
      backoffMs: 0,
    });
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("Gate", () => {
  it("never runs more than its limit and runs every task", async () => {
    const gate = new Gate(2);
    let active = 0;
    let peak = 0;
    const done = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        gate.run(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 2));
          active--;
          return i;
        }),
      ),
    );
    expect(done).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("frees the slot when a task throws", async () => {
    const gate = new Gate(1);
    await expect(gate.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await gate.run(async () => "next")).toBe("next");
  });
});

describe("readWhois", () => {
  // Shapes captured from real registries on 2026-10-21.
  it.each([
    ["io free", "Domain not found.\n>>> Last update of WHOIS database: 2026-10-21 <<<", "free"],
    ["co free", "The queried object does not exist: DOMAIN NOT FOUND", "free"],
    [
      "so free echoes the name",
      "Domain Name: zz.so\nThe queried object does not exist: No Object Found",
      "free",
    ],
    ["de free", "Domain: zz.de\nStatus: free", "free"],
    [
      "jp free",
      "[ JPRS database provides information on network administration. ]\nNo match!!",
      "free",
    ],
    ["gg free", "NOT FOUND", "free"],
    [
      "io registered",
      "Domain Name: google.io\nDomain Status: clientDeleteProhibited",
      "registered",
    ],
    ["de registered", "Domain: google.de\nStatus: connect", "registered"],
    ["jp registered", "[Domain Name]                   GOOGLE.JP", "registered"],
    ["rate limited", "Your connection limit exceeded.", "unrecognized"],
  ])("%s", (_label, text, expected) => {
    expect(readWhois(text)).toBe(expected);
  });

  it("ignores 'not found' inside notices of a registered domain", () => {
    const text = "% If the domain is not found, contact the registrar\nDomain Name: google.io";
    expect(readWhois(text)).toBe("registered");
  });
});

describe("selectChannels", () => {
  it("defaults to every channel with .com and .dev", () => {
    expect(selectChannels().map((c) => c.id)).toEqual([
      "npm",
      "pypi",
      "crates",
      "homebrew",
      "github",
      "smithery",
      "claude-plugins",
      "domain:com",
      "domain:dev",
    ]);
  });

  it("normalizes and dedupes TLDs", () => {
    expect(
      selectChannels({ tlds: [".COM", "com", "Dev"] })
        .map((c) => c.id)
        .slice(-2),
    ).toEqual(["domain:com", "domain:dev"]);
  });

  it("converts an internationalized TLD to punycode but shows it as typed", () => {
    const [c] = selectChannels({ only: ["domain:рф"] });
    expect(c).toMatchObject({ id: "domain:xn--p1ai", label: ".рф" });
  });

  it.each([
    [["domain:"], "needs a TLD"],
    [["domain:co.uk"], "several labels"],
  ])("rejects %j", (only, message) => {
    expect(() => selectChannels({ only })).toThrow(message);
  });

  it("rejects unknown channel ids", () => {
    expect(() => selectChannels({ only: ["nope"] })).toThrow(/unknown channel "nope"/);
  });
});
