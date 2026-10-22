import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { detectProject } from "../src/index.js";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nameable-detect-"));
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith("/")) {
      mkdirSync(join(dir, path), { recursive: true });
    } else {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  }
  return dir;
}

describe("detectProject", () => {
  it("finds nothing in a directory without manifests", async () => {
    expect(await detectProject(project({ "README.md": "# hi" }))).toBeUndefined();
    expect(await detectProject(join(tmpdir(), "nameable-no-such-dir"))).toBeUndefined();
  });

  it.each([
    [{ "package.json": "{}" }, ["npm", "github", "domain"]],
    [{ "package.json": '{"bin":"cli.js"}' }, ["npm", "homebrew", "github", "domain"]],
    [
      { "package.json": '{"dependencies":{"@modelcontextprotocol/sdk":"1"}}' },
      ["npm", "smithery", "github", "domain"],
    ],
    // A private package is an app or a monorepo root: nothing to publish on npm.
    [{ "package.json": '{"private":true}' }, ["github", "domain"]],
    [{ "package.json": "not json" }, ["npm", "github", "domain"]],
    [{ "pyproject.toml": '[project]\nname = "x"' }, ["pypi", "github", "domain"]],
    [
      {
        "pyproject.toml": '[project]\ndependencies = ["mcp>=1.2"]\n[project.scripts]\nx = "x:main"',
      },
      ["pypi", "homebrew", "smithery", "github", "domain"],
    ],
    [
      { "Cargo.toml": "[package]", "src/main.rs": "fn main() {}" },
      ["crates", "homebrew", "github", "domain"],
    ],
    [{ "Cargo.toml": "[package]" }, ["crates", "github", "domain"]],
    [{ "x.gemspec": "", "exe/": "" }, ["rubygems", "homebrew", "github", "domain"]],
    [{ "composer.json": '{"type":"library"}' }, ["packagist", "github", "domain"]],
    [{ "composer.json": '{"type":"project"}' }, ["github", "domain"]],
    [{ "pubspec.yaml": "name: x" }, ["pub", "github", "domain"]],
    [{ "pubspec.yaml": "name: x\npublish_to: none" }, ["github", "domain"]],
    [{ "X.csproj": "" }, ["nuget", "github", "domain"]],
    [{ "compose.yaml": "" }, ["docker", "github", "domain"]],
    [{ ".claude-plugin/plugin.json": "{}" }, ["claude-plugins", "github", "domain"]],
  ])("picks channels from %j", async (files, only) => {
    expect((await detectProject(project(files)))?.only).toEqual(only);
  });

  it("names every file that picked a channel", async () => {
    const detected = await detectProject(project({ "package.json": "{}", Dockerfile: "" }));
    expect(detected?.from).toEqual(["package.json", "Dockerfile"]);
  });
});
