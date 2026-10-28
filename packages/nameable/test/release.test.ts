import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

// The plugin is pinned to a git tag and starts the MCP server from npm, so the skill and the tool it
// calls only match when every place names the same version. A release bumps them together.
const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const root = "../../../";

describe("release versions", () => {
  const { version } = json("../package.json");

  it("names the package version in the plugin manifest", () => {
    expect(json(`${root}plugins/nameable/.claude-plugin/plugin.json`).version).toBe(version);
  });

  it("starts the plugin's own copy of the CLI as its MCP server", () => {
    const server = json(`${root}plugins/nameable/.mcp.json`).mcpServers.nameable;
    expect(server).toEqual({
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/server/cli.mjs", "mcp"],
    });
  });

  // Claude Code installs a plugin's dependencies only from an npm lockfile that pins registry packages
  // to exact versions and sets no overrides; the plugin directory wants https sources and hashes too.
  it("locks the plugin's dependencies to the package's, from the npm registry", () => {
    const pkg = json("../package.json");
    const plugin = json(`${root}plugins/nameable/package.json`);
    const lock = json(`${root}plugins/nameable/package-lock.json`);
    expect(plugin).toEqual({
      name: "nameable-plugin",
      version,
      private: true,
      license: pkg.license,
      dependencies: pkg.dependencies,
    });
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""]).toMatchObject({ version, dependencies: pkg.dependencies });
    const installed = Object.entries(lock.packages).filter(([path]) => path !== "");
    expect(installed.length).toBeGreaterThan(0);
    for (const [path, entry] of installed as [string, Record<string, unknown>][]) {
      expect(entry, path).toMatchObject({
        version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        resolved: expect.stringMatching(/^https:\/\/registry\.npmjs\.org\//),
        integrity: expect.stringMatching(/^sha512-/),
      });
      expect(entry.link, path).toBeUndefined();
      expect(entry.hasInstallScript, path).toBeUndefined();
    }
    for (const [name, range] of Object.entries(pkg.dependencies as Record<string, string>)) {
      expect(lock.packages[`node_modules/${name}`].version).toBe(range);
    }
  });

  it("lists that package version on the MCP Registry, under the package's mcpName", () => {
    const server = json(`${root}server.json`);
    expect(server.name).toBe(json("../package.json").mcpName);
    expect(server.version).toBe(version);
    expect(server.packages).toEqual([expect.objectContaining({ identifier: "nameable", version })]);
  });

  it("has release notes for it, in English and Traditional Chinese", () => {
    const notes = readFileSync(
      new URL(`${root}docs/releases/v${version}.md`, import.meta.url),
      "utf8",
    );
    expect(notes).toContain("## Install");
    expect(notes).toContain("## 繁體中文");
  });

  it("has a changelog entry for it", () => {
    const changelog = readFileSync(new URL(`${root}CHANGELOG.md`, import.meta.url), "utf8");
    expect(changelog).toMatch(new RegExp(`^## ${version.replaceAll(".", "\\.")} `, "m"));
  });
});
