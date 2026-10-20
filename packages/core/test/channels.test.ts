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
import { fakeFetch, fakeWhois, seq, type Reply } from "./fake-fetch.js";

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
): Promise<CheckResult> {
  const [result] = await check(name, selectChannels({ only: [channel] }), {
    fetch: fakeFetch(routes),
    whois: fakeWhois(whois),
    backoffMs: 0,
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
  it("is available when the registry has no such package and no similar name", async () => {
    const r = await one("npm", "zzname", {
      [`${NPM}/zzname`]: 404,
      [searchUrl("zzname")]: searchHits("zz-other"),
      ...hyphenProbes("zzname"),
    });
    expect(r).toMatchObject({ status: "available", certainty: "confirmed" });
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

  it("is reclaimable when every version was unpublished", async () => {
    const doc = {
      name: "gone",
      time: { unpublished: { time: "2023-07-05T00:47:37.960Z", versions: ["1.0.0"] } },
    };
    const r = await one("npm", "gone", { [`${NPM}/gone`]: [200, doc] });
    expect(r.status).toBe("reclaimable");
    expect(r.note).toContain("2023-07-05");
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
  it("confirms a one-letter name without searching, since it has no other spelling", async () => {
    const r = await one("npm", "q", { [`${NPM}/q`]: 404 });
    expect(r).toMatchObject({ status: "available", certainty: "confirmed" });
  });

  it("searches but does not probe hyphen spellings of a long name", async () => {
    const name = "a".repeat(50);
    const r = await one("npm", name, { [`${NPM}/${name}`]: 404, [searchUrl(name)]: searchHits() });
    expect(r).toMatchObject({ status: "available", certainty: "probable" });
    expect(r.note).toContain("too long");
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
    const r = await one("pypi", "Foo_Bar", { "https://pypi.org/pypi/foo-bar/json": 404 });
    expect(r.status).toBe("available");
  });

  it("is taken with the project's summary", async () => {
    const body = { info: { name: "requests", summary: "HTTP for Humans.", version: "2.0" } };
    const r = await one("pypi", "requests", { "https://pypi.org/pypi/requests/json": [200, body] });
    expect(r).toMatchObject({ status: "taken", note: "HTTP for Humans." });
  });
});

describe("homebrew", () => {
  const api = "https://formulae.brew.sh/api";
  it("is taken by a cask", async () => {
    const r = await one("homebrew", "thing", {
      [`${api}/formula/thing.json`]: 404,
      [`${api}/cask/thing.json`]: [200, { desc: "App" }],
    });
    expect(r).toMatchObject({ status: "taken", meta: { kind: "cask" } });
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

  it("is unknown when rate limited, never available", async () => {
    expect((await one("github", "someone", { [url]: 403 })).status).toBe("unknown");
  });

  it("rejects invalid logins", async () => {
    expect((await one("github", "-bad", {})).status).toBe("unavailable");
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
      "domain:com",
      "domain:dev",
    ]);
  });

  it("rejects unknown channel ids", () => {
    expect(() => selectChannels({ only: ["nope"] })).toThrow(/unknown channel "nope"/);
  });
});
