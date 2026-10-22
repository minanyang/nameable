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

live("RubyGems", () => {
  it("answers 404 for a missing gem and looks names up with case", async () => {
    expect(await status(`https://rubygems.org/api/v1/gems/${fresh}.json`)).toBe(404);
    expect(await status("https://rubygems.org/api/v1/gems/rails.json")).toBe(200);
    expect(await status("https://rubygems.org/api/v1/gems/Rails.json")).toBe(404);
  });
  it("lists every indexed gem in /names, one per line after ---", async () => {
    const text = await (await fetch("https://rubygems.org/names", { headers: UA })).text();
    const [head, ...names] = text.split("\n");
    expect(head).toBe("---");
    expect(names).toContain("rails");
  });
  it("says on the gem page that a name is reserved, though the API answers 404", async () => {
    expect(await status("https://rubygems.org/api/v1/gems/rbconfig.json")).toBe(404);
    const page = await (await fetch("https://rubygems.org/gems/rbconfig", { headers: UA })).text();
    expect(page).toContain("reserved by rubygems.org");
    expect(await status(`https://rubygems.org/gems/${fresh}`)).toBe(404);
  });
  it("reports downloads and the latest release date", async () => {
    const gem = await json("https://rubygems.org/api/v1/gems/rails.json");
    expect(typeof gem.downloads).toBe("number");
    expect(Number.isNaN(Date.parse(gem.version_created_at))).toBe(false);
  });
});

live("Packagist", () => {
  const list = (q: string) => json(`https://packagist.org/packages/list.json?${q}`);
  it("lists a vendor's packages, ignoring case, and an empty list for a free vendor", async () => {
    expect((await list("vendor=SYMFONY")).packageNames).toContain("symfony/console");
    expect((await list(`vendor=${fresh}`)).packageNames).toEqual([]);
  });
  it("lists packages with one package name under every vendor", async () => {
    const { packageNames } = await list("filter=*/console");
    expect(packageNames).toContain("symfony/console");
    expect(packageNames.every((n: string) => n.endsWith("/console"))).toBe(true);
  });
  it("reports total downloads", async () => {
    const stats = await json("https://packagist.org/packages/symfony/console/stats.json");
    expect(stats.downloads.total).toBeGreaterThan(1_000_000);
  });
});

live("pub.dev", () => {
  it("answers 404 for a missing package, even a reserved name", async () => {
    expect(await status(`https://pub.dev/api/packages/${fresh}`)).toBe(404);
    expect(await status("https://pub.dev/api/packages/dart")).toBe(404);
    expect(await status("https://pub.dev/api/packages/http")).toBe(200);
  });
  it("lists every package name in one page", async () => {
    const body = await json("https://pub.dev/api/package-names");
    expect(body.packages.length).toBeGreaterThan(50_000);
    expect(body.packages).toContain("http");
    expect(body.nextUrl ?? null).toBeNull();
  });
});

live("NuGet", () => {
  const reg = (id: string) =>
    status(`https://api.nuget.org/v3/registration5-gz-semver2/${id}/index.json`);
  it("keeps unlisted packages in registration and 404s missing ones", async () => {
    expect(await reg("newtonsoft.json")).toBe(200);
    expect(await reg("entityframework.commands")).toBe(200);
    expect(await reg(fresh)).toBe(404);
  });
  it("still shows a package the NuGet team deleted on the gallery", async () => {
    expect(await reg("coinbase.core")).toBe(404);
    const page = await (
      await fetch("https://www.nuget.org/packages/Coinbase.Core", { headers: UA })
    ).text();
    expect(page).toContain("This package has been deleted from the gallery");
    expect(await status(`https://www.nuget.org/packages/${fresh}`)).toBe(404);
  });
});

live("Docker Hub", () => {
  const H = "https://hub.docker.com/v2";
  const raw = (url: string) =>
    fetch(url, { headers: UA, redirect: "manual" }).then((r) => r.status);
  it("answers users and organizations on their own endpoint and redirects from the other", async () => {
    expect([await raw(`${H}/users/jwilder/`), await raw(`${H}/orgs/jwilder/`)]).toEqual([200, 308]);
    expect([await raw(`${H}/users/bitnami/`), await raw(`${H}/orgs/bitnami/`)]).toEqual([308, 200]);
    expect([await raw(`${H}/users/${fresh}/`), await raw(`${H}/orgs/${fresh}/`)]).toEqual([
      404, 404,
    ]);
  });
  it("counts a namespace's public repositories, 0 for a missing one", async () => {
    expect((await json(`${H}/namespaces/bitnami/repositories/?page_size=1`)).count).toBeGreaterThan(
      0,
    );
    expect((await json(`${H}/namespaces/${fresh}/repositories/?page_size=1`)).count).toBe(0);
  });
  it("serves official images under library", async () => {
    expect(await status(`${H}/repositories/library/postgres/`)).toBe(200);
    expect(await status(`${H}/repositories/library/${fresh}/`)).toBe(404);
  });
});

live("Cursor marketplace", () => {
  it("lists every plugin's name as fullRef in the page's RSC payload", async () => {
    const res = await fetch("https://cursor.com/marketplace", { headers: { ...UA, rsc: "1" } });
    const names = [...(await res.text()).matchAll(/"fullRef":"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(names).size).toBeGreaterThan(100);
    expect(names).toContain("github");
  });
});

live("Gemini CLI gallery", () => {
  it("lists extensions with their name and repository", async () => {
    const entries = (await json("https://geminicli.com/extensions.json")) as unknown as {
      extensionName: string;
      url: string;
    }[];
    expect(entries.length).toBeGreaterThan(100);
    expect(entries.some((e) => e.extensionName === "superpowers")).toBe(true);
    expect(entries.every((e) => typeof e.url === "string")).toBe(true);
  });
});

live("App Store search", () => {
  it("finds apps by title, iOS and macOS separately", async () => {
    const search = (entity: string) =>
      json(`https://itunes.apple.com/search?term=calculator&entity=${entity}&limit=200&country=us`);
    const ios = await search("software");
    expect(ios.results.some((r: any) => r.trackName === "Calculator" && r.trackViewUrl)).toBe(true);
    const mac = await search("macSoftware");
    // The macOS search also returns iPad apps that run on a Mac.
    expect(mac.results.some((r: any) => r.kind === "mac-software")).toBe(true);
  });
});

live("Google Play search", () => {
  it("embeds results in the ds:4 callback, with a title and package per app", async () => {
    const html = await (
      await fetch("https://play.google.com/store/search?q=slack&c=apps&hl=en&gl=US", {
        headers: UA,
      })
    ).text();
    expect(html).toMatch(/AF_initDataCallback\(\{key: 'ds:4'/);
    expect(html).toContain("com.Slack");
  });
});

live("VS Code Marketplace", () => {
  const query = (criteria: { filterType: number; value: string }[]) =>
    fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
      method: "POST",
      headers: {
        ...UA,
        accept: "application/json;api-version=7.2-preview.1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ filters: [{ criteria, pageSize: 1000 }], flags: 0 }),
    }).then((r) => r.json() as Promise<any>);
  it("finds extensions by text, with their name, display name and publisher", async () => {
    const body = await query([
      { filterType: 8, value: "Microsoft.VisualStudio.Code" },
      { filterType: 10, value: "prettier" },
    ]);
    const hit = body.results[0].extensions.find((e: any) => e.extensionName === "prettier-vscode");
    expect(hit).toMatchObject({
      displayName: expect.any(String),
      publisher: { publisherName: "esbenp" },
    });
  });
  it("answers a publisher page 200, 301 to a renamed one, and 404", async () => {
    const page = (id: string) =>
      fetch(`https://marketplace.visualstudio.com/publishers/${id}`, {
        headers: UA,
        redirect: "manual",
      }).then((r) => r.status);
    expect(await page("esbenp")).toBe(200);
    expect(await page("ms-python")).toBe(301);
    expect(await page(fresh)).toBe(404);
  });
});

live("Open VSX", () => {
  it("answers 200 for a namespace and 404 for a missing one", async () => {
    expect(await status("https://open-vsx.org/api/redhat")).toBe(200);
    expect(await status(`https://open-vsx.org/api/${fresh}`)).toBe(404);
  });
  it("lists search results with their namespace", async () => {
    const body = await json("https://open-vsx.org/api/-/search?query=yaml&size=100");
    expect(body.extensions.some((e: any) => e.namespace === "redhat")).toBe(true);
  });
});

live("JetBrains Marketplace", () => {
  it("answers a plugin ID 200 or 404, and searches by name", async () => {
    expect(await status("https://plugins.jetbrains.com/api/plugins/intellij/org.rust.lang")).toBe(
      200,
    );
    expect(await status(`https://plugins.jetbrains.com/api/plugins/intellij/${fresh}`)).toBe(404);
    const body = await json("https://plugins.jetbrains.com/api/searchPlugins?search=rust&max=20");
    expect(body.plugins.some((p: any) => p.name === "Rust" && typeof p.link === "string")).toBe(
      true,
    );
  });
});

live("MCP Registry", () => {
  const LIST = "https://raw.githubusercontent.com/minanyang/nameable/data/mcp-servers.tsv";
  it("has the list the daily workflow publishes, read within the last few days", async () => {
    const text = await (await fetch(LIST, { headers: UA })).text();
    const lines = text.split("\n");
    expect(lines[0]).toBe("#nameable-data mcp-servers v1");
    expect(lines.length).toBeGreaterThan(10_000);
    expect(lines).toContain("com.pulsemcp/remote-filesystem\tactive");
    const asOf = Date.parse(lines.find((l) => l.startsWith("#asof\t"))!.slice(6));
    expect(Date.now() - asOf).toBeLessThan(3 * 24 * 60 * 60 * 1000);
  });

  it("lists the servers updated since a time, deleted ones included", async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const page = await json(
      `https://registry.modelcontextprotocol.io/v0.1/servers?limit=100&version=latest&updated_since=${since}`,
    );
    const meta = (s: any) => s._meta["io.modelcontextprotocol.registry/official"];
    expect(page.servers.length).toBeGreaterThan(0);
    for (const s of page.servers) {
      expect(typeof s.server.name).toBe("string");
      expect(meta(s).updatedAt >= since).toBe(true);
    }
    expect(
      await status("https://registry.modelcontextprotocol.io/v0.1/servers?updated_since=x"),
    ).toBe(400);
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
    it("labels a registered domain's record as a domain", async () => {
      const doc = await json("https://rdap.verisign.com/com/v1/domain/google.com", {
        accept: "application/rdap+json",
      });
      expect(doc.objectClassName).toBe("domain");
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
