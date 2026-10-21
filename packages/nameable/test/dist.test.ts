import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";

// Runs the packed CLI the way npx would, so packaging mistakes (bin path, shebang, missing files,
// process wiring in cli.ts) fail here. Needs `pnpm build` first: run with `pnpm test:dist`.
// Only cases that need no network.
const dist = describe.runIf(process.env.NAMEABLE_DIST === "1");
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

async function run(...args: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(cli, args, {
      env: { ...process.env, GITHUB_TOKEN: "" },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

dist("packed CLI", () => {
  it("is the file package.json's bin points at, and is executable", () => {
    expect(pkg.bin.nameable).toBe("./dist/cli.mjs");
    expect(() => accessSync(cli, constants.X_OK)).not.toThrow();
    expect(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("reports the package version", async () => {
    expect(await run("--version")).toMatchObject({ code: 0, stdout: `${pkg.version}\n` });
  });

  it("prints help", async () => {
    const r = await run("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage");
  });

  it("exits 64 on a usage error", async () => {
    const r = await run();
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("missing <name>");
  });

  it("prints JSON when piped and exits 1 for a name the channel refuses", async () => {
    const r = await run("café", "--only", "npm");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).reports[0].results[0].status).toBe("unavailable");
  });

  it("serves MCP over stdio with `mcp`", async () => {
    const transport = new StdioClientTransport({
      command: cli,
      args: ["mcp"],
      env: { ...process.env, GITHUB_TOKEN: "" } as Record<string, string>,
    });
    const client = new Client({ name: "dist-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["check_names"]);
      const r = await client.callTool({
        name: "check_names",
        arguments: { names: ["café"], channels: ["npm"] },
      });
      expect(r.structuredContent).toMatchObject({
        reports: [{ name: "café", results: [{ status: "unavailable" }] }],
      });
    } finally {
      await client.close();
    }
  });
});
