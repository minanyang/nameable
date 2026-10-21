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

  it("starts that exact package version as the plugin's MCP server", () => {
    const server = json(`${root}plugins/nameable/.mcp.json`).mcpServers.nameable;
    expect(server).toEqual({ command: "npx", args: ["-y", `nameable@${version}`, "mcp"] });
  });

  it("has a changelog entry for it", () => {
    const changelog = readFileSync(new URL(`${root}CHANGELOG.md`, import.meta.url), "utf8");
    expect(changelog).toMatch(new RegExp(`^## ${version.replaceAll(".", "\\.")} `, "m"));
  });
});
