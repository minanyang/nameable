import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile, spawn } from "node:child_process";
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

  it("answers lines that are not JSON-RPC messages with JSON-RPC errors", async () => {
    const child = spawn(cli, ["mcp"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stdin.end('{bad json\n42\n{"jsonrpc":"2.0","id":7,"method":"ping"}\n');
    await new Promise((resolve) => child.on("exit", resolve));
    const replies = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
      { jsonrpc: "2.0", id: 7, result: {} },
    ]);
  });

  it("reads a message whose multi-byte characters arrive split across chunks", async () => {
    const child = spawn(cli, ["mcp"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    // "名" is three bytes; the first write ends in the middle of it.
    const bytes = Buffer.from('{"jsonrpc":"2.0","id":"名","method":"ping"}\n');
    const cut = bytes.indexOf(Buffer.from("名")) + 1;
    child.stdin.write(bytes.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 50));
    child.stdin.end(bytes.subarray(cut));
    await new Promise((resolve) => child.on("exit", resolve));
    expect(JSON.parse(out.trim())).toEqual({ jsonrpc: "2.0", id: "名", result: {} });
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
