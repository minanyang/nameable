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
    [{ "package.json": '{"name":"x"}' }, ["npm", "github", "domain"]],
    [{ "package.json": '{"name":"x","bin":"cli.js"}' }, ["npm", "homebrew", "github", "domain"]],
    // Without a name there is nothing to publish: a stub that only sets the module type.
    [{ "package.json": '{"type":"module","bin":"cli.js"}' }, ["github", "domain"]],
    [
      { "package.json": '{"name":"x","dependencies":{"@modelcontextprotocol/sdk":"1"}}' },
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
    // Web apps, executables and test projects are not packages; a dotnet tool is.
    [{ "X.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web">' }, ["github", "domain"]],
    [{ "X.csproj": "<OutputType>Exe</OutputType>" }, ["github", "domain"]],
    [
      { "X.csproj": "<OutputType>Exe</OutputType><PackAsTool>true</PackAsTool>" },
      ["nuget", "github", "domain"],
    ],
    [{ "X.csproj": "<IsPackable>false</IsPackable>" }, ["github", "domain"]],
    [{ "X.csproj": "<IsTestProject>true</IsTestProject>" }, ["github", "domain"]],
    [{ "X.csproj": '<Project Sdk="Microsoft.NET.Sdk.Worker">' }, ["github", "domain"]],
    [{ "X.csproj": '<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">' }, ["github", "domain"]],
    [{ "X.csproj": '<IsPackable Condition="x">false</IsPackable>' }, ["github", "domain"]],
    [
      { "X.csproj": "<Project />", "Directory.Build.props": "<OutputType>Exe</OutputType>" },
      ["github", "domain"],
    ],
    // A library's tests take no side; a solution whose only project is missing publishes nothing.
    [
      {
        "X.sln":
          'Project("{G}") = "Lib", "src\\Lib\\Lib.csproj", "{H}"\nProject("{G}") = "T", "tests\\T\\T.csproj", "{I}"',
        "src/Lib/Lib.csproj": "<PackageLicenseExpression>MIT</PackageLicenseExpression>",
        "tests/T/T.csproj": "<IsPackable>false</IsPackable><IsTestProject>true</IsTestProject>",
      },
      ["nuget", "github", "domain"],
    ],
    [{ "X.sln": 'Project("{G}") = "App", "App\\App.csproj", "{H}"' }, ["github", "domain"]],
    // pnpm 10 keeps settings in pnpm-workspace.yaml without making the repository a workspace.
    [
      {
        "package.json": '{"name":"app","private":true}',
        "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - esbuild\n",
        Dockerfile: "",
      },
      ["github", "domain"],
    ],
    [{ Pipfile: "[packages]" }, ["github", "domain"]],
    // A server or site: it starts or deploys itself and says nothing of what it would publish.
    [{ "package.json": '{"name":"api","scripts":{"start":"node app.js"}}' }, ["github", "domain"]],
    [
      { "package.json": '{"name":"api","scripts":{"deploy:prod":"cdk deploy"}}' },
      ["github", "domain"],
    ],
    [
      { "package.json": '{"name":"x","files":["dist"],"scripts":{"start":"vite"}}' },
      ["npm", "github", "domain"],
    ],
    // A private app's image is deployed, not published; a package's image may be.
    [{ "package.json": '{"name":"web","private":true}', Dockerfile: "" }, ["github", "domain"]],
    // A Cargo workspace root without a [package] is no crate.
    [{ "Cargo.toml": '[workspace]\nmembers = ["crates/*"]' }, ["github", "domain"]],
    [{ "Dockerfile.prod": "" }, ["docker", "github", "domain"]],
    // A private workspace root publishes its packages.
    [
      { "package.json": '{"private":true,"workspaces":["packages/*"]}' },
      ["npm", "github", "domain"],
    ],
    [
      { "package.json": '{"private":true}', "pnpm-workspace.yaml": "packages:\n  - packages/*\n" },
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
    [
      { "Package.swift": 'products: [.executable(name: "x", targets: ["x"])]' },
      ["homebrew", "github", "domain"],
    ],
    [{ "Package.swift": '.executableTarget(name: "x")' }, ["homebrew", "github", "domain"]],
    // A solution of libraries is published; one that holds an app keeps plain libraries to itself.
    [
      {
        "X.sln": 'Project("{G}") = "Lib", "Lib\\Lib.csproj", "{H}"',
        "Lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
      },
      ["nuget", "github", "domain"],
    ],
    [
      {
        "X.sln":
          'Project("{G}") = "Api", "Api\\Api.csproj", "{H}"\nProject("{G}") = "Lib", "Lib\\Lib.csproj", "{I}"',
        "Api/Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web">',
        "Lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
      },
      ["github", "domain"],
    ],
    [
      {
        "X.slnx": '<Project Path="Api/Api.csproj" /><Project Path="Sdk/Sdk.csproj" />',
        "Api/Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web">',
        "Sdk/Sdk.csproj": "<PackageId>X.Sdk</PackageId>",
      },
      ["nuget", "github", "domain"],
    ],
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
    const detected = await detectProject(
      project({ "package.json": '{"name":"x"}', Dockerfile: "" }),
    );
    expect(detected?.from).toEqual(["package.json", "Dockerfile"]);
  });

  it("picks the channels of a workspace's members at its root", async () => {
    const detected = await detectProject(
      project({
        "package.json": '{"private":true}',
        "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - \"tools/cli\" # the command\n",
        "packages/core/package.json": '{"name":"core","private":true}',
        "packages/server/package.json": '{"name":"server","dependencies":{"fastmcp":"1"}}',
        "tools/cli/package.json": '{"name":"cli","bin":"cli.js"}',
        "packages/notes.md": "",
      }),
    );
    expect(detected).toEqual({
      only: ["npm", "mcp-registry", "smithery", "homebrew", "github", "domain"],
      from: [
        "package.json",
        join("packages", "server", "package.json"),
        join("tools", "cli", "package.json"),
      ],
    });
  });

  it.each([
    ["a flow list", "packages: ['apps/*', \"packages/*\"]\n"],
    ["an unindented list", "packages:\n- 'packages/*'\n"],
    ["a commented key", "packages: # members\n  - packages/*\nonlyBuiltDependencies:\n  - x\n"],
    ["CRLF line endings", "packages:\r\n  - packages/*\r\n"],
  ])("reads pnpm workspace members from %s", async (_, yaml) => {
    const dir = project({
      "package.json": '{"private":true}',
      "pnpm-workspace.yaml": yaml,
      "packages/cli/package.json": '{"name":"cli","bin":"x.js"}',
    });
    expect((await detectProject(dir))?.only).toEqual(["npm", "homebrew", "github", "domain"]);
  });

  it("finds members at any depth under **, and the root listed as a member only once", async () => {
    const dir = project({
      "package.json": '{"name":"root","private":true}',
      "pnpm-workspace.yaml": "packages:\n  - '.'\n  - 'packages/**'\n",
      "packages/group/deep/package.json": '{"name":"deep","bin":"x.js"}',
    });
    expect(await detectProject(dir)).toEqual({
      only: ["npm", "homebrew", "github", "domain"],
      from: ["package.json", join("packages", "group", "deep", "package.json")],
    });
  });

  it("reads a member that is itself a workspace", async () => {
    const dir = project({
      "package.json": '{"private":true,"workspaces":["apps/*"]}',
      "apps/tools/package.json": '{"private":true,"workspaces":["cli"]}',
      "apps/tools/cli/package.json": '{"name":"cli","bin":"x.js"}',
    });
    expect((await detectProject(dir))?.only).toEqual(["npm", "homebrew", "github", "domain"]);
  });

  it("reads Lerna's default packages and Cargo's members past comments and exclusions", async () => {
    const lerna = project({
      "package.json": '{"private":true}',
      "lerna.json": "{}",
      "packages/a/package.json": '{"name":"a","bin":"x.js"}',
    });
    expect((await detectProject(lerna))?.only).toEqual(["npm", "homebrew", "github", "domain"]);
    const cargo = project({
      "Cargo.toml":
        '[workspace]\nmembers = [\n  "crates/*", # the "main" ones ]\n  "tools/cli",\n]\nexclude = ["crates/x"]',
      "crates/lib/Cargo.toml": "[package]",
      "crates/x/Cargo.toml": "[package]",
      "crates/x/src/main.rs": "",
      "tools/cli/Cargo.toml": "[package]\npublish = false",
      "tools/cli/src/main.rs": "",
    });
    expect(await detectProject(cargo)).toEqual({
      only: ["crates", "homebrew", "github", "domain"],
      from: ["Cargo.toml", join("crates", "lib", "Cargo.toml"), join("tools", "cli", "Cargo.toml")],
    });
  });

  it("reads large manifests in linear time", async () => {
    const padding = " ".repeat(50_000);
    const dir = project({
      "package.json": '{"private":true}',
      "pnpm-workspace.yaml": `packages:\n  - x${padding}y\n`,
      "Cargo.toml": `[workspace]${"\n".repeat(50_000)}members = []`,
      "X.csproj": `<OutputType>x${padding}`,
      "pyproject.toml": `[project]\ndependencies = [${padding}`,
    });
    const started = Date.now();
    await detectProject(dir);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("reads npm and Cargo workspace members", async () => {
    const npm = project({
      "package.json": '{"private":true,"workspaces":{"packages":["libs/**"]}}',
      "libs/a/package.json": '{"name":"a"}',
    });
    expect((await detectProject(npm))?.only).toEqual(["npm", "github", "domain"]);
    const cargo = project({
      "Cargo.toml": '[workspace]\nmembers = [\n  "tool",\n]',
      "tool/Cargo.toml": "[package]",
      "tool/src/main.rs": "",
    });
    expect((await detectProject(cargo))?.only).toEqual(["crates", "homebrew", "github", "domain"]);
  });

  it.each([
    [
      "ECR in a workflow",
      { ".github/workflows/deploy.yml": "uses: aws-actions/amazon-ecr-login@v2" },
      [],
    ],
    ["a CDK deploy script", { "deploy.sh": "npx cdk deploy --all" }, []],
    ["GHCR in a GitLab pipeline", { ".gitlab-ci.yml": "docker push ghcr.io/me/app" }, []],
    [
      "Docker Hub beside a private registry",
      {
        ".github/workflows/release.yml":
          "registry: ghcr.io\nusername: ${{ secrets.DOCKERHUB_USERNAME }}",
      },
      ["docker"],
    ],
    ["no CI at all", {}, ["docker"]],
  ])("reads where images go from %s", async (_, files, docker) => {
    const dir = project({ ".git/": "", Dockerfile: "", ...files });
    expect((await detectProject(dir))?.only).toEqual([...docker, "github", "domain"]);
  });

  it("reads the CI of the repository a service lives in", async () => {
    const dir = project({
      ".git/": "",
      ".github/workflows/deploy.yml": "run: dotnet lambda deploy-function",
      "services/api/Dockerfile": "",
    });
    expect((await detectProject(join(dir, "services", "api")))?.only).toEqual(["github", "domain"]);
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

  it("walks past a folder that holds only a compose file", async () => {
    const dir = project({ "package.json": '{"name":"x"}', "docker/compose.yaml": "" });
    expect((await findProject(join(dir, "docker")))?.only).toEqual(["npm", "github", "domain"]);
  });

  it("stops at the repository root", async () => {
    const outer = project({ "package.json": '{"name":"x"}' });
    const repo = join(outer, "repo");
    mkdirSync(join(repo, ".git", "x"), { recursive: true });
    mkdirSync(join(repo, "docs"));
    expect(await findProject(join(repo, "docs"))).toBeUndefined();
  });
});
