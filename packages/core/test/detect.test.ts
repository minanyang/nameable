import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { detectProject, findProject } from "../src/index.js";

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
      ["npm", "mcp-registry", "smithery", "github", "domain"],
    ],
    // A private package is an app or a monorepo root: nothing to publish on npm.
    [{ "package.json": '{"private":true}' }, ["github", "domain"]],
    [{ "package.json": "not json" }, ["npm", "github", "domain"]],
    [
      { "pyproject.toml": '[project]\nname = "x"\n[build-system]\nrequires = ["hatchling"]' },
      ["pypi", "github", "domain"],
    ],
    [
      {
        "pyproject.toml":
          '[project]\ndependencies = ["mcp>=1.2"]\n[project.scripts]\nx = "x:main"\n[build-system]\nrequires = ["hatchling"]',
      },
      ["pypi", "homebrew", "mcp-registry", "smithery", "github", "domain"],
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
    [{ "compose.yaml": "" }, ["github", "domain"]],
    [{ "Dockerfile.prod": "" }, ["docker", "github", "domain"]],
    // A private workspace root publishes its packages.
    [
      { "package.json": '{"private":true,"workspaces":["packages/*"]}' },
      ["npm", "github", "domain"],
    ],
    [
      { "package.json": '{"private":true}', "pnpm-workspace.yaml": "" },
      ["npm", "github", "domain"],
    ],
    // Python files that configure tools or apps, not packages.
    [{ "pyproject.toml": "[tool.ruff]\nline-length = 100" }, ["github", "domain"]],
    [
      { "pyproject.toml": '[project]\nname = "x"\n[tool.uv]\npackage = false' },
      ["github", "domain"],
    ],
    [{ "pyproject.toml": "[tool.poetry]\npackage-mode = false" }, ["github", "domain"]],
    [{ "setup.cfg": "[flake8]\nmax-line-length = 100" }, ["github", "domain"]],
    [{ "setup.py": 'from setuptools import setup\nsetup(name="x")' }, ["pypi", "github", "domain"]],
    // Keywords and plugin entry points are not an MCP dependency or a command.
    [
      {
        "pyproject.toml":
          '[project]\nname = "x"\nkeywords = ["mcp", "llm"]\ndependencies = ["httpx"]\n[build-system]\nrequires = ["hatchling"]',
      },
      ["pypi", "github", "domain"],
    ],
    [
      {
        "pyproject.toml":
          '[project]\nname = "x"\ndependencies = [\n  "mcp[cli]>=1.2",\n]\n[build-system]\nrequires = ["hatchling"]',
      },
      ["pypi", "mcp-registry", "smithery", "github", "domain"],
    ],
    [
      { "setup.py": 'setup(name="x", entry_points={"pytest11": ["x = x.plugin"]})' },
      ["pypi", "github", "domain"],
    ],
    [{ "Cargo.toml": "[package]\npublish = false" }, ["github", "domain"]],
    [
      { "Cargo.toml": "[package]", "src/bin/tool.rs": "" },
      ["crates", "homebrew", "github", "domain"],
    ],
    [{ Gemfile: "gem 'rails'" }, ["github", "domain"]],
    [{ "go.mod": "module x", "main.go": "package main" }, ["homebrew", "github", "domain"]],
    [{ "go.mod": "module x" }, ["github", "domain"]],
    [{ "Package.swift": "" }, ["github", "domain"]],
    [{ "X.sln": "" }, ["nuget", "github", "domain"]],
    [
      { "composer.json": '{"type":"library","extra":{"x":{"type":"project"}}}' },
      ["packagist", "github", "domain"],
    ],
    [{ "ios/App.xcodeproj/project.pbxproj": "" }, ["app-store", "github", "domain"]],
    [{ "android/app/src/main/AndroidManifest.xml": "" }, ["google-play", "github", "domain"]],
    [
      {
        "app.config.ts": "export default {}",
        "package.json": '{"private":true,"dependencies":{"expo":"~52"}}',
      },
      ["app-store", "google-play", "github", "domain"],
    ],
    // Nuxt names its config app.config.ts too.
    [
      { "app.config.ts": "", "package.json": '{"private":true,"dependencies":{"nuxt":"3"}}' },
      ["github", "domain"],
    ],
    [
      {
        "pyproject.toml":
          '[project]\nname = "x"\n[tool.uv]\ndev-dependencies = [\n  "pytest",\n]\npackage = false',
      },
      ["github", "domain"],
    ],
    // What `uv init` writes for an application: no build backend.
    [{ "pyproject.toml": '[project]\nname = "x"\nversion = "0.1.0"' }, ["github", "domain"]],
    [{ "Cargo.toml": "[package]\npublish = []" }, ["github", "domain"]],
    [{ ".claude-plugin/plugin.json": "{}" }, ["claude-plugins", "github", "domain"]],
    [{ ".cursor-plugin/plugin.json": "{}" }, ["cursor", "github", "domain"]],
    [
      { "package.json": '{"engines":{"vscode":"^1.90.0"}}' },
      ["vscode", "open-vsx", "github", "domain"],
    ],
    [
      { "build.gradle.kts": 'plugins { id("org.jetbrains.intellij.platform") }' },
      ["jetbrains", "github", "domain"],
    ],
    [{ "gemini-extension.json": "{}" }, ["gemini", "github", "domain"]],
    [{ "App.xcodeproj/project.pbxproj": "" }, ["app-store", "github", "domain"]],
    [{ "app/src/main/AndroidManifest.xml": "" }, ["google-play", "github", "domain"]],
    [{ "app.json": '{"expo":{"name":"x"}}' }, ["app-store", "google-play", "github", "domain"]],
    [
      { "pubspec.yaml": "name: x\npublish_to: none\ndependencies:\n  flutter:\n    sdk: flutter" },
      ["app-store", "google-play", "github", "domain"],
    ],
  ])("picks channels from %j", async (files, only) => {
    expect((await detectProject(project(files)))?.only).toEqual(only);
  });

  it("names every file that picked a channel", async () => {
    const detected = await detectProject(project({ "package.json": "{}", Dockerfile: "" }));
    expect(detected?.from).toEqual(["package.json", "Dockerfile"]);
  });

  it("counts a package.json it cannot read as a JavaScript project", async () => {
    const dir = project({ "package.json/": "" });
    expect((await detectProject(dir))?.from).toEqual(["package.json"]);
  });
});

describe("findProject", () => {
  it("finds the project from a subdirectory and names its files from there", async () => {
    const dir = project({ "Cargo.toml": "[package]", "src/lib.rs": "", ".git/": "" });
    expect(await findProject(join(dir, "src"))).toEqual({
      only: ["crates", "github", "domain"],
      from: [join("..", "Cargo.toml")],
    });
  });

  it("does not take a package.json in the home directory for a project", async () => {
    const home = project({ "package.json": '{"dependencies":{"x":"1"}}' });
    mkdirSync(join(home, "projects", "x"), { recursive: true });
    expect(await findProject(join(home, "projects", "x"), home)).toBeUndefined();
  });

  it("stops at the repository root", async () => {
    const outer = project({ "package.json": "{}" });
    const repo = join(outer, "repo");
    mkdirSync(join(repo, ".git", "x"), { recursive: true });
    mkdirSync(join(repo, "docs"));
    expect(await findProject(join(repo, "docs"))).toBeUndefined();
  });
});
