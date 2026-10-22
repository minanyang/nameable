import { describe, expect, it } from "vite-plus/test";
import { tcpWhois } from "../src/tcp-whois.js";
import { remoteZipFiles } from "../src/zip.js";

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
    it("keeps a document without versions, with time.unpublished, for an unpublished package", async () => {
      const doc = await json("https://registry.npmjs.org/test-unpublish");
      expect(doc.versions).toBeUndefined();
      expect(Date.parse(doc.time.unpublished.time)).toBeGreaterThan(0);
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
  it("answers a single project's simple page with 404 when missing, 200 and its status otherwise", async () => {
    const accept = { accept: "application/vnd.pypi.simple.v1+json" };
    expect(await status(`https://pypi.org/simple/${fresh}/`, accept)).toBe(404);
    const body = await json("https://pypi.org/simple/requests/", accept);
    expect(body.name).toBe("requests");
    expect(body["project-status"].status).toBe("active");
  });
  it("accepts the PEP 503 normalized name", async () => {
    const body = await json("https://pypi.org/pypi/zope-interface/json");
    expect(body.info.name).toBe("zope.interface");
  });
});

live("crates.io", () => {
  it("answers 404 for a missing crate", async () => {
    expect(await status(`https://crates.io/api/v1/crates/${fresh}`)).toBe(404);
  });
  it("publishes reserved and deleted names in its database dump, readable by range", async () => {
    const ctx = { fetch, whois: tcpWhois, cache: new Map(), gates: new Map() };
    const files = await remoteZipFiles(ctx, "https://static.crates.io/db-dump.zip", [
      "reserved_crate_names.csv",
      "deleted_crates.csv",
    ]);
    const reserved = files.get("reserved_crate_names.csv")!.toString("utf8").split("\n");
    expect(reserved[0]).toBe("name");
    expect(reserved).toEqual(expect.arrayContaining(["std", "rust", "nightly"]));
    const deleted = files.get("deleted_crates.csv")!.toString("utf8");
    expect(deleted.slice(0, deleted.indexOf("\n")).split(",")).toEqual(
      expect.arrayContaining(["available_at", "name"]),
    );
    expect(deleted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?\+00,/m);
  }, 60_000);
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
    expect(formulae.every((f) => Array.isArray(f.aliases) && Array.isArray(f.oldnames))).toBe(true);
    expect(formulae.find((f) => f.name === "go")?.aliases).toContain("golang");
    expect(formulae.find((f) => f.oldnames.includes("atk"))?.name).toBe("at-spi2-core");
  });
  it("serves casks with old_tokens in cask.json", async () => {
    const casks = (await json("https://formulae.brew.sh/api/cask.json")) as unknown as {
      token: string;
      old_tokens?: string[];
    }[];
    expect(casks.length).toBeGreaterThan(1000);
    expect(casks.every((c) => Array.isArray(c.old_tokens))).toBe(true);
    expect(casks.some((c) => c.old_tokens!.length > 0)).toBe(true);
  });
  it("spells out a leading digit in formula names, keeping the digits as an alias", async () => {
    const formulae = (await json("https://formulae.brew.sh/api/formula.json")) as unknown as {
      name: string;
      aliases: string[];
    }[];
    expect(formulae.some((f) => /^\d/.test(f.name))).toBe(false);
    expect(formulae.find((f) => f.name === "twoping")?.aliases).toContain("2ping");
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

live("Smithery", () => {
  const list = (ns: string) => json(`https://api.smithery.ai/servers?namespace=${ns}&pageSize=1`);
  it("filters servers by whole namespace, ignoring case, without a key", async () => {
    const exa = await list("EXA");
    expect(exa.servers[0].qualifiedName).toBe("exa");
    expect(exa.pagination.totalCount).toBeGreaterThan(0);
    expect((await list("ex")).pagination.totalCount).toBe(0);
  });
  it("serves a server page at the link the channel gives", async () => {
    expect(await status("https://smithery.ai/servers/exa")).toBe(200);
  });
});

live("Claude Code official marketplace", () => {
  it("lists every plugin by name, and claude.com has a page for each", async () => {
    const body = await json(
      "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json",
    );
    const names: string[] = body.plugins.map((p: { name: string }) => p.name);
    expect(names.length).toBeGreaterThan(100);
    expect(names).toContain("github");
    expect(await status("https://claude.com/plugins/github")).toBe(200);
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
