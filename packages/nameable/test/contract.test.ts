import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { channelIds } from "@nameable/core";
import { describe, expect, it } from "vite-plus/test";
import { fakeFetch } from "../../core/test/fake-fetch.js";
import { CRATES_DUMP, cratesDump } from "../../core/test/fixtures.js";
import { run, type Io } from "../src/run.js";

// What scripts and agents build on, which semver covers (README, "JSON"): changing any of it is a major
// release. A test that fails here means the change needs one, or the test was wrong about the contract.
// `note`, `meta`, `label` and the channels picked from a project are outside it.

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
    }),
    ...io,
  });
  return { code, stdout };
}

describe("public contract", () => {
  it("keeps its channel IDs", () => {
    expect(channelIds()).toEqual([
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
    ]);
  });

  it("keeps its commands, options and exit codes", async () => {
    const { stdout: help } = await cli(["--help"]);
    expect(help).toContain("nameable <name>... [options]");
    expect(help).toContain("nameable check <name>... [options]");
    expect(help).toContain("nameable mcp");
    const options = [...help.matchAll(/^ {2}(?:-\w, )?(--[\w-]+)/gm)].map((m) => m[1]);
    expect(options).toEqual([
      "--only",
      "--all",
      "--tlds",
      "--json",
      "--refresh",
      "--clear-cache",
      "--help",
      "--version",
    ]);
    const codes = [...help.matchAll(/^ {2}(\d+) +\S/gm)].map((m) => m[1]);
    expect(codes).toEqual(["0", "1", "2", "64"]);
    expect((await cli(["zz", "--bogus"])).code).toBe(64);
  });

  it("keeps the shape of its JSON", async () => {
    const { code, stdout } = await cli(["zz", "--only", "crates", "--json"]);
    const out = JSON.parse(stdout);
    expect(code).toBe(0);
    expect(Object.keys(out)).toEqual(["schema", "reports"]);
    expect(out.schema).toBe(1);
    expect(Object.keys(out.reports[0])).toEqual(["name", "results"]);
    for (const key of Object.keys(out.reports[0].results[0])) {
      expect(["channel", "label", "status", "certainty", "url", "note", "meta"]).toContain(key);
    }
  });

  it("keeps its MCP tool, its inputs and its statuses", async () => {
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await cli(["mcp"], { mcpTransport: serverEnd });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientEnd);
    const [tool] = (await client.listTools()).tools;
    expect(tool!.name).toBe("check_names");
    expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual([
      "names",
      "channels",
      "tlds",
      "refresh",
    ]);
    expect(tool!.inputSchema.required).toEqual(["names"]);
    // New statuses may come in a minor release (README); these may not change or go.
    const result = JSON.stringify(tool!.outputSchema);
    expect(result).toContain('"enum":["available","reclaimable","taken","unavailable","unknown"]');
    expect(result).toContain('"enum":["confirmed","probable"]');
  });
});
