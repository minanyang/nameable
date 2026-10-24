import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { channelIds } from "@nameable/core";
import { describe, expect, it } from "vite-plus/test";
import { fakeFetch } from "../../core/test/fake-fetch.js";
import { CRATES_DUMP, cratesDump } from "../../core/test/fixtures.js";
import { run, type Io } from "../src/run.js";

// What scripts and agents build on, which semver covers (README, "JSON"): changing or removing any of it is a
// major release, while additions (a channel, an option, a status) are not, so these tests allow them. A test
// that fails here means the change needs a major release, or the test was wrong about the contract.
// The wording of `label` and `note`, what `meta` holds and the channels picked from a project are outside it.

async function cli(argv: string[], io: Partial<Io> = {}) {
  let stdout = "";
  const code = await run(argv, {
    stdout: { write: (s: string) => (stdout += s), columns: 100 },
    stderr: { write: () => undefined },
    interactive: false,
    color: false,
    fetch: fakeFetch({
      [CRATES_DUMP]: cratesDump(),
      "https://crates.io/api/v1/crates/zz": 404,
      "https://crates.io/api/v1/crates/serde": [200, { crate: { name: "serde" } }],
    }),
    ...io,
  });
  return { code, stdout };
}

describe("public contract", () => {
  it("keeps its channel IDs", () => {
    expect(channelIds()).toEqual(
      expect.arrayContaining([
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
        "domain",
        "domain:<tld>",
      ]),
    );
  });

  it("keeps its commands, options and exit codes", async () => {
    const { stdout: help } = await cli(["--help"]);
    expect(help).toContain("nameable <name>... [options]");
    expect(help).toContain("nameable check <name>... [options]");
    expect(help).toContain("nameable mcp");
    const options = [...help.matchAll(/^ {2}(?:-\w, )?(--[\w-]+)/gm)].map((m) => m[1]);
    expect(options).toEqual(
      expect.arrayContaining([
        "--only",
        "--all",
        "--tlds",
        "--json",
        "--refresh",
        "--clear-cache",
        "--help",
        "--version",
      ]),
    );
    const codes = [...help.matchAll(/^ {2}(\d+) +\S/gm)].map((m) => m[1]);
    expect(codes).toEqual(expect.arrayContaining(["0", "1", "2", "64"]));
    expect((await cli(["zz", "--bogus"])).code).toBe(64);
  });

  it("keeps the shape of its JSON", async () => {
    const { code, stdout } = await cli(["zz", "serde", "--only", "crates", "--json"]);
    const out = JSON.parse(stdout);
    expect(code).toBe(1);
    expect(out).toMatchObject({ schema: 1 });
    expect(out.reports.map((r: { name: string }) => r.name)).toEqual(["zz", "serde"]);
    const results = out.reports.flatMap((r: { results: unknown[] }) => r.results);
    expect(results.map((r: { status: string }) => r.status)).toEqual(["available", "taken"]);
    for (const result of results) {
      expect(result).toMatchObject({
        channel: expect.any(String),
        label: expect.any(String),
        status: expect.any(String),
      });
      for (const key of Object.keys(result)) {
        expect(["channel", "label", "status", "certainty", "url", "note", "meta"]).toContain(key);
      }
    }
    expect(results[0]).toMatchObject({ certainty: "confirmed" });
    expect(results[1]).toMatchObject({ url: expect.any(String) });
  });

  it("keeps its MCP tool, its inputs and its statuses", async () => {
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await cli(["mcp"], { mcpTransport: serverEnd });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientEnd);
    const [tool] = (await client.listTools()).tools;
    expect(tool!.name).toBe("check_names");
    expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["names", "channels", "tlds", "refresh"]),
    );
    expect(tool!.inputSchema.required).toEqual(["names"]);
    // New statuses may come in a minor release (README); these may not change or go.
    const enums = [...JSON.stringify(tool!.outputSchema).matchAll(/"enum":(\[[^\]]*\])/g)].map(
      (m) => JSON.parse(m[1]!) as string[],
    );
    const has = (values: string[]) => enums.some((e) => values.every((v) => e.includes(v)));
    expect(has(["available", "reclaimable", "taken", "unavailable", "unknown"])).toBe(true);
    expect(has(["confirmed", "probable"])).toBe(true);
  });
});
