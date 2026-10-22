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
import { appNameMatch, storefronts } from "../src/channels/app-names.js";
import { fakeFetch, fakeWhois, seq, zipArchive, rangeReply, type Reply } from "./fake-fetch.js";
import { CRATES_DUMP, cratesDump, mcpDatabase, sqlite } from "./fixtures.js";

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
    expect(r.note).toContain("not every punctuation variant can be checked");
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
      note: 'npm refuses it: the same as "lodash-es" without punctuation',
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
    const doc = { name: "zzname", versions: { "1.0.0": {} }, description: null };
    const r = await one("npm", "thing", { [`${NPM}/thing`]: [200, doc] });
    expect(r.status).toBe("taken");
    expect("note" in r).toBe(false);
  });

  it("is taken when the package has versions", async () => {
    const doc = {
      name: "thing",
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
    for (const name of ["_lead", "has space", "node_modules"]) {
      expect((await one("npm", name, {})).status).toBe("unavailable");
    }
  });

  // validate-npm-package-name's warnings rule out new packages only: `events` and `JSONStream` exist.
  it("reports an old package with a name new packages cannot have as taken", async () => {
    for (const name of ["events", "JSONStream"]) {
      const r = await one("npm", name, {
        [`${NPM}/${name}`]: [200, { name, versions: { "1.0.0": {} } }],
      });
      expect(r, name).toMatchObject({ status: "taken" });
    }
  });

  it("refuses a free core-module or uppercase name for a new package", async () => {
    const r = await one("npm", "Upper", {
      [`${NPM}/Upper`]: 404,
      [searchUrl("Upper")]: searchHits(),
      ...hyphenProbes("Upper"),
    });
    expect(r).toMatchObject({ status: "unavailable", note: "npm names must be lowercase" });
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
        [`${api}/formula/${name}.json`]: [200, { name, desc: "x" }],
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
      [`${api}/cask/thing.json`]: [200, { token: "thing", desc: "App" }],
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

  it("looks up a login the sign-up form would refuse, then refuses it if nobody has it", async () => {
    expect(
      (await one("github", "-bad", { [`https://api.github.com/users/-bad`]: 404 })).status,
    ).toBe("unavailable");
    const old = await one("github", "Soaa-", {
      [`https://api.github.com/users/Soaa-`]: [
        200,
        { login: "Soaa-", type: "User", public_repos: 1, updated_at: "2014-01-01T00:00:00Z" },
      ],
    });
    expect(old.status).toBe("taken");
  });
});

describe("rubygems", () => {
  const GEMS = "https://rubygems.org";
  const names = (...extra: string[]) =>
    new Response(
      ["---", ...Array.from({ length: 1000 }, (_, i) => `gem${i}`), ...extra].join("\n"),
    );
  const routes = (gem: Reply) => ({
    [`${GEMS}/api/v1/gems/rail_s.json`]: 404,
    [`${GEMS}/gems/rail_s`]: 404,
    [`${GEMS}/names`]: () => names("rails"),
    [`${GEMS}/api/v1/gems/rails.json`]: gem,
  });

  it("unescapes the HTML entities the API puts in descriptions", async () => {
    const r = await one("rubygems", "people", {
      [`${GEMS}/api/v1/gems/people.json`]: [
        200,
        { name: "people", info: "Gender &amp; Ethnicity &lt;3" },
      ],
    });
    expect(r.note).toBe("Gender & Ethnicity <3");
  });

  it("allows a name similar only to an old gem with few downloads", async () => {
    const r = await one(
      "rubygems",
      "rail_s",
      routes([200, { downloads: 9_999, version_created_at: "2015-01-01T00:00:00Z" }]),
      {},
      Date.parse("2026-10-22"),
    );
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
  });

  it("is blocked by a similar gem released in the last five years", async () => {
    const r = await one(
      "rubygems",
      "rail_s",
      routes([200, { downloads: 10, version_created_at: "2024-01-01T00:00:00Z" }]),
      {},
      Date.parse("2026-10-22"),
    );
    expect(r).toMatchObject({ status: "unavailable", note: expect.stringContaining('"rails"') });
  });
});

describe("packagist", () => {
  const P = "https://packagist.org/packages";
  it("lets a typo of a package with under a million downloads through", async () => {
    const r = await one("packagist", "illuminat", {
      [`${P}/list.json?vendor=illuminat`]: [200, { packageNames: [] }],
      [`${P}/list.json?filter=*/illuminat`]: [
        200,
        { packageNames: ["illuminate/illuminat", "far-away/illuminat"] },
      ],
      [`${P}/illuminate/illuminat/stats.json`]: [200, { downloads: { total: 999_999 } }],
    });
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
  });
});

describe("docker", () => {
  it("names the kind of account and its public repositories", async () => {
    const H = "https://hub.docker.com/v2";
    const r = await one("docker", "jwilder", {
      [`${H}/users/jwilder/`]: [200, { username: "jwilder" }],
      [`${H}/orgs/jwilder/`]: 308,
      [`${H}/namespaces/jwilder/repositories/?page_size=1`]: [200, { count: 11 }],
      [`${H}/repositories/library/jwilder/`]: 404,
    });
    expect(r).toMatchObject({
      status: "taken",
      url: "https://hub.docker.com/u/jwilder",
      note: "Docker user, 11 public repositories",
    });
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
    const doc = {
      objectClassName: "domain",
      events: [{ eventAction: "registration", eventDate: "1999-02-13T00:00:00Z" }],
    };
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

  it("gives up at once when Retry-After asks for longer than a check should take", async () => {
    const limited = () => new Response("{}", { status: 429, headers: { "retry-after": "3600" } });
    const fetch = fakeFetch({ "https://crates.io/api/v1/crates/serde": limited });
    const [r] = await check("serde", selectChannels({ only: ["crates"] }), { fetch, backoffMs: 0 });
    expect(r).toMatchObject({ status: "unknown", note: "crates.io returned HTTP 429" });
    expect(fetch.calls).toHaveLength(1);
  });

  it("turns repeated network failures into unknown, never available", async () => {
    const r = await one("crates", "serde", {
      "https://crates.io/api/v1/crates/serde": new TypeError("fetch failed"),
    });
    expect(r).toMatchObject({
      status: "unknown",
      note: "could not reach crates.io (fetch failed)",
    });
  });

  it("stops asking a host that timed out, instead of waiting on it once per name", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const names = Array.from({ length: 8 }, (_, i) => `zz${i}`);
    const fetch = fakeFetch(
      Object.fromEntries(names.map((n) => [`https://crates.io/api/v1/crates/${n}`, timeout])),
    );
    const reports = await checkMany(names, selectChannels({ only: ["crates"] }), {
      fetch,
      backoffMs: 0,
    });
    expect(reports.every((r) => r.results[0]!.status === "unknown")).toBe(true);
    // crates.io takes 4 requests at once; the 4 names queued behind them are never sent.
    expect(fetch.calls).toHaveLength(4);
  });

  it("stops querying a whois server that timed out", async () => {
    const timeout = Object.assign(new Error("whois timed out"), { name: "TimeoutError" });
    const names = ["aa", "bb", "cc"];
    const whois = fakeWhois({
      "whois.iana.org sh": "whois:        whois.nic.sh\n",
      ...Object.fromEntries(names.map((n) => [`whois.nic.sh ${n}.sh`, timeout])),
    });
    const fetch = fakeFetch({ [BOOTSTRAP]: bootstrap });
    const reports = await checkMany(names, selectChannels({ only: ["domain:sh"] }), {
      fetch,
      whois,
      backoffMs: 0,
    });
    expect(reports.every((r) => r.results[0]!.status === "unknown")).toBe(true);
    expect(whois.calls.filter((c) => c.startsWith("whois.nic.sh"))).toHaveLength(1);
  });

  it("slows down after a 429 that names no Retry-After", async () => {
    const fetch = fakeFetch({
      "https://crates.io/api/v1/crates/serde": seq(429, [200, { crate: { name: "serde" } }]),
    });
    const started = Date.now();
    const [r] = await check("serde", selectChannels({ only: ["crates"] }), { fetch, backoffMs: 1 });
    expect(r!.status).toBe("taken");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  });

  it("keeps a failed lookup unknown when the name breaks a new-name rule, since it may be held", async () => {
    const r = await one("npm", "events", { [`${NPM}/events`]: 503 });
    expect(r).toMatchObject({
      status: "unknown",
      note: "npm registry returned HTTP 503; if nobody holds it, npm reserves Node.js core module names",
    });
  });

  it("does not trust a PyPI index that ends early", async () => {
    const full = JSON.stringify({ projects: [{ name: "requests" }, { name: "flask" }] });
    const r = await one("pypi", "f1ask", {
      "https://pypi.org/pypi/f1ask/json": 404,
      "https://pypi.org/simple/f1ask/": 404,
      "https://pypi.org/simple/": new Response(full.slice(0, full.indexOf("flask") + 7)),
    });
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
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
      "https://rdap.example/v1/domain/bb.dev": [200, { objectClassName: "domain" }],
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
  it("spaces task starts by its interval", async () => {
    const gate = new Gate(4, 40);
    const starts: number[] = [];
    await Promise.all([1, 2, 3].map(() => gate.run(async () => void starts.push(Date.now()))));
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(35);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(35);
  });

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

describe.runIf(sqlite())("mcp-registry", () => {
  const MIRROR =
    "https://raw.githubusercontent.com/rosmur/official-mcp-registry-database/main/official_mcp_registry.db";
  it("puts the original emitWarning back, even with checks running at once", async () => {
    // oxlint-disable-next-line typescript/unbound-method -- compared by identity, never called
    const original = process.emitWarning;
    const db = mcpDatabase(["io.github.a/thing"]);
    const run = (name: string) =>
      check(name, selectChannels({ only: ["mcp-registry"] }), {
        fetch: fakeFetch({ [MIRROR]: () => new Response(new Uint8Array(db)) }),
        whois: fakeWhois(),
        backoffMs: 0,
      });
    await Promise.all([run("thing"), run("other")]);
    // oxlint-disable-next-line typescript/unbound-method -- compared by identity, never called
    expect(process.emitWarning).toBe(original);
  });

  it("leads with an active server and counts the rest", async () => {
    const db = mcpDatabase(["ai.old/check", "ai.new/check", "ai.third/check"]);
    const [r] = await check("check", selectChannels({ only: ["mcp-registry"] }), {
      fetch: fakeFetch({ [MIRROR]: () => new Response(new Uint8Array(db)) }),
      whois: fakeWhois(),
      backoffMs: 0,
    });
    expect(r!.note).toMatch(/^clash, not a block: ai\.old\/check and 2 more use this name/);
    expect(r!.meta).toMatchObject({ servers: 3 });
  });

  it("dates a free answer by the newest update in the mirror, not by the download", async () => {
    const db = mcpDatabase(["ai.new/check"]);
    const [r] = await check("other", selectChannels({ only: ["mcp-registry"] }), {
      fetch: fakeFetch({ [MIRROR]: () => new Response(new Uint8Array(db)) }),
      whois: fakeWhois(),
      backoffMs: 0,
    });
    expect(r!.note).toContain("mirror of the registry from 2026-10-21");
  });
});

describe("open-vsx", () => {
  it("does not read the server's /api/version route as a namespace called version", async () => {
    const r = await one("open-vsx", "version", {
      "https://open-vsx.org/api/version": [200, { version: "v1.2.0", maxExtensionSize: 1 }],
      "https://marketplace.visualstudio.com/publishers/version": 404,
      ...Object.fromEntries(
        ["asc", "desc"].map((order) => [
          `https://open-vsx.org/api/-/search?size=1000&offset=0&sortBy=timestamp&sortOrder=${order}`,
          [
            200,
            {
              totalSize: 100,
              extensions: Array.from({ length: 100 }, (_, i) => ({
                namespace: `ns${i}`,
                name: "x",
              })),
            },
          ],
        ]),
      ),
    });
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
  });
});

describe("jetbrains", () => {
  it("does not look up a name with a slash as a plugin ID, which the API refuses", async () => {
    const r = await one("jetbrains", "CI/CD", {
      "https://plugins.jetbrains.com/api/searchPlugins?search=CI%2FCD&max=20": [
        200,
        { plugins: [] },
      ],
    });
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
  });
});

describe("app titles", () => {
  it("tells a title that is the name from one that only adds its maker", () => {
    expect(appNameMatch("Slack", "slack")).toBe("same");
    expect(appNameMatch("Todoist: To Do List", "todoist")).toBe("same");
    // Store names are unique by exact title, so these are clashes, not holders.
    expect(appNameMatch("Google Gemini", "Gemini", "Google LLC")).toBe("similar");
    expect(appNameMatch("Microsoft Translator", "translator", "Microsoft Corporation")).toBe(
      "similar",
    );
    expect(appNameMatch("Claude by Anthropic", "Claude", "Anthropic PBC")).toBe("similar");
    // A leading word or "by" that is not the developer belongs to the title.
    expect(appNameMatch("Google Gemini", "Gemini", "Someone Else")).toBeUndefined();
    for (const [title, name] of [
      ["Stand by Me", "Stand"],
      ["Side by Side", "Side"],
      ["Step by Step: Habit Tracker", "Step"],
    ]) {
      expect(appNameMatch(title!, name!, "Indie Dev"), title).toBeUndefined();
    }
  });

  it("searches the stores a Chinese, Japanese or Korean name would be released in", () => {
    expect(storefronts("微信").map((s) => s.country)).toEqual(["us", "cn", "tw", "jp"]);
    expect(storefronts("ポケモン").map((s) => s.country)).toEqual(["us", "jp"]);
    expect(storefronts("카카오톡").map((s) => s.country)).toEqual(["us", "kr"]);
    expect(storefronts("nameable").map((s) => s.country)).toEqual(["us"]);
  });

  it("reports the App Store's plain-text rate limit as unknown", async () => {
    const r = await one("app-store", "thing", {
      "https://itunes.apple.com/search?term=thing&entity=software&limit=200&country=us":
        new Response("Rate limit has been exceeded for: itunes-apple-com|general|192.0.2.1"),
    });
    expect(r).toMatchObject({ status: "unknown", note: expect.stringContaining("rate limited") });
  });
});

describe("names that exist despite a registry's rules for new names", () => {
  it("finds an npm package whose separators differ, which search does not return", async () => {
    const r = await one("npm", "react_dom", {
      [`${NPM}/react_dom`]: 404,
      [searchUrl("react_dom")]: searchHits(),
      [searchUrl("reactdom")]: searchHits(),
      [`${NPM}/react-dom`]: [200, { name: "react-dom" }],
      [`${NPM}/react.dom`]: 404,
      [`${NPM}/reactdom`]: 404,
    });
    expect(r).toMatchObject({
      status: "unavailable",
      note: expect.stringContaining('"react-dom"'),
    });
  });

  it("finds a NuGet ID in another script", async () => {
    const id = "Felsökning.Utilities.Json";
    const r = await one("nuget", id, {
      [`https://api.nuget.org/v3/registration5-gz-semver2/${encodeURIComponent(id.toLowerCase())}/index.json`]:
        [200, { items: [] }],
    });
    expect(r.status).toBe("taken");
  });

  it("finds a Docker official image that breaks the Docker ID rule", async () => {
    const H = "https://hub.docker.com/v2";
    const r = await one("docker", "hello-world", {
      [`${H}/users/hello-world/`]: 404,
      [`${H}/orgs/hello-world/`]: 404,
      [`${H}/namespaces/hello-world/repositories/?page_size=1`]: [200, { count: 0 }],
      [`${H}/repositories/library/hello-world/`]: [200, { namespace: "library" }],
    });
    expect(r.status).toBe("taken");
  });

  it("finds a Homebrew formula typed with capitals", async () => {
    const api = "https://formulae.brew.sh/api";
    const r = await one("homebrew", "Git", {
      [`${api}/formula/git.json`]: [200, { name: "git", desc: "Distributed revision control" }],
      [`${api}/cask/git.json`]: 404,
    });
    expect(r.status).toBe("taken");
  });

  it("finds a JetBrains plugin whose name breaks the character rule", async () => {
    const r = await one("jetbrains", "Sketch It!", {
      "https://plugins.jetbrains.com/api/searchPlugins?search=Sketch+It%21&max=20": [
        200,
        { plugins: [{ name: "Sketch It!", xmlId: "sketch", link: "/plugin/1-sketch-it" }] },
      ],
    });
    expect(r.status).toBe("taken");
  });
});

describe("defineChannel", () => {
  it("flattens registry text into one line without control characters", async () => {
    const r = await one("crates", "zz", {
      "https://crates.io/api/v1/crates/zz": [
        200,
        { crate: { name: "zz", description: "First line.\n\n      Second\u0085 line.\t" } },
      ],
    });
    expect(r.note).toBe("First line. Second line.");
  });
});

describe("packagist typo rule", () => {
  it("reads _ as one character, as SQL LIKE does, and nothing wider", async () => {
    const P = "https://packagist.org/packages";
    const r = await one("packagist", "php_amqplib", {
      [`${P}/list.json?vendor=php_amqplib`]: [200, { packageNames: [] }],
      // The list filter is a glob, so it also returns names the LIKE pattern would not match.
      [`${P}/list.json?filter=*/php*amqplib`]: [
        200,
        { packageNames: ["php-amqplibs/php-x-amqplib"] },
      ],
    });
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
  });
});

describe("selectChannels", () => {
  it("defaults to every channel with .com and .dev", () => {
    expect(selectChannels().map((c) => c.id)).toEqual([
      "npm",
      "pypi",
      "crates",
      "homebrew",
      "rubygems",
      "packagist",
      "pub",
      "nuget",
      "docker",
      "github",
      "mcp-registry",
      "smithery",
      "claude-plugins",
      "cursor",
      "gemini",
      "vscode",
      "open-vsx",
      "jetbrains",
      "app-store",
      "google-play",
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
