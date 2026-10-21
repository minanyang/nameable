import { describe, expect, it } from "vite-plus/test";
import { tcpWhois } from "../src/tcp-whois.js";

// Each assumption the channels and their fixtures make about a real service, checked against that
// service. When one of these fails, the fake in fixtures.ts no longer describes reality.
// Run with `pnpm test:live`.
const live = describe.runIf(process.env.NAMEABLE_LIVE === "1");
const fresh = `zq${Date.now().toString(36)}x`;
const UA = { "user-agent": "nameable-contract-tests" };
const status = async (url: string, headers: Record<string, string> = {}) =>
  (await fetch(url, { headers: { ...UA, ...headers } })).status;
const json = async (url: string, headers: Record<string, string> = {}) =>
  (await fetch(url, { headers: { ...UA, ...headers } })).json() as Promise<Record<string, any>>;

live(
  "npm registry",
  () => {
    it("answers 404 for a missing package", async () => {
      expect(await status(`https://registry.npmjs.org/${fresh}`)).toBe(404);
    });
    it("answers the org endpoint with 200 for an org and 404 otherwise", async () => {
      expect(await status("https://registry.npmjs.org/-/org/babel/package")).toBe(200);
      expect(await status(`https://registry.npmjs.org/-/org/${fresh}/package`)).toBe(404);
    });
    it("serves the abbreviated document the similar-name probes ask for", async () => {
      const accept = { accept: "application/vnd.npm.install-v1+json" };
      expect(await status("https://registry.npmjs.org/lodash-es", accept)).toBe(200);
    });
    it("only searches text of 2 to 64 characters", async () => {
      const search = (text: string) =>
        status(`https://registry.npmjs.org/-/v1/search?text=${text}&size=1`);
      expect(await search("a")).toBe(400);
      expect(await search("ab")).toBe(200);
      expect(await search("a".repeat(64))).toBe(200);
      expect(await search("a".repeat(65))).toBe(400);
    });
    it("lists search hits under objects[].package.name", async () => {
      const body = await json("https://registry.npmjs.org/-/v1/search?text=firstone&size=5");
      expect(body.objects.map((o: any) => o.package.name)).toContain("firstone");
    });
  },
  60_000,
);

live("PyPI", () => {
  it("answers 404 for a missing project", async () => {
    expect(await status(`https://pypi.org/pypi/${fresh}/json`)).toBe(404);
  });
  it("lists every project in the JSON simple index", async () => {
    const body = await json("https://pypi.org/simple/", {
      accept: "application/vnd.pypi.simple.v1+json",
    });
    expect(body.projects.length).toBeGreaterThan(500_000);
    expect(body.projects.some((p: { name: string }) => p.name === "Flask")).toBe(true);
  }, 180_000);
  it("accepts the PEP 503 normalized name", async () => {
    const body = await json("https://pypi.org/pypi/zope-interface/json");
    expect(body.info.name).toBe("zope.interface");
  });
});

live("crates.io", () => {
  it("answers 404 for a missing crate", async () => {
    expect(await status(`https://crates.io/api/v1/crates/${fresh}`)).toBe(404);
  });
  it("resolves - and _ to the same crate", async () => {
    expect((await json("https://crates.io/api/v1/crates/serde-json")).crate.name).toBe(
      "serde_json",
    );
  });
});

live("Homebrew API", () => {
  it("answers 404 for a missing formula and cask", async () => {
    expect(await status(`https://formulae.brew.sh/api/formula/${fresh}.json`)).toBe(404);
    expect(await status(`https://formulae.brew.sh/api/cask/${fresh}.json`)).toBe(404);
  });
  it("lists aliases and old names (renames) on each formula in formula.json", async () => {
    const formulae = (await json("https://formulae.brew.sh/api/formula.json")) as unknown as {
      name: string;
      aliases: string[];
      oldnames: string[];
    }[];
    expect(formulae.find((f) => f.name === "go")?.aliases).toContain("golang");
    expect(formulae.find((f) => f.oldnames.includes("atk"))?.name).toBe("at-spi2-core");
  });
  it("serves casks with old_tokens in cask.json", async () => {
    const casks = (await json("https://formulae.brew.sh/api/cask.json")) as unknown as {
      token: string;
      old_tokens?: string[];
    }[];
    expect(casks.length).toBeGreaterThan(1000);
    expect(casks.some((c) => (c.old_tokens ?? []).length > 0)).toBe(true);
  });
  it("has formulae whose names use @ and +", async () => {
    expect(await status("https://formulae.brew.sh/api/formula/openssl@3.json")).toBe(200);
  });
});

live("GitHub API", () => {
  const auth: Record<string, string> = process.env.GITHUB_TOKEN
    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {};
  it("answers 404 for a missing account", async () => {
    expect(await status(`https://api.github.com/users/${fresh}`, auth)).toBe(404);
  });
  it("serves users and organizations from the same endpoint, with type", async () => {
    expect((await json("https://api.github.com/users/torvalds", auth)).type).toBe("User");
    expect((await json("https://api.github.com/users/github", auth)).type).toBe("Organization");
  });
});

live(
  "RDAP and whois",
  () => {
    it("bootstrap lists RDAP for .com and .dev but not .io", async () => {
      const boot = await json("https://data.iana.org/rdap/dns.json");
      const tlds = new Set(boot.services.flatMap((s: [string[]]) => s[0]));
      expect(tlds.has("com") && tlds.has("dev")).toBe(true);
      expect(tlds.has("io")).toBe(false);
    });
    it("looks up internationalized names in punycode", async () => {
      expect(await status("https://rdap.verisign.com/com/v1/domain/xn--caf-dma.com")).toBe(200);
    });
    it("IANA refers each TLD to its whois server", async () => {
      expect(await tcpWhois("whois.iana.org", "io")).toMatch(/^whois:\s*whois\.nic\.io/m);
    });
  },
  60_000,
);
