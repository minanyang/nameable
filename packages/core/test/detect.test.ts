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
    [{ "package.json": '{"name":"x"}' }, ["npm", "github", "github-repo", "domain"]],
    [
      { "package.json": '{"name":"x","bin":"cli.js"}' },
      ["npm", "homebrew", "github", "github-repo", "domain"],
    ],
    // Without a name there is nothing to publish: a stub that only sets the module type.
    [{ "package.json": '{"type":"module","bin":"cli.js"}' }, ["github", "github-repo", "domain"]],
    [
      { "package.json": '{"name":"x","dependencies":{"@modelcontextprotocol/sdk":"1"}}' },
      ["npm", "mcp-registry", "smithery", "github", "github-repo", "domain"],
    ],
    // A private package is an app or a monorepo root: nothing to publish on npm.
    [{ "package.json": '{"private":true}' }, ["github", "github-repo", "domain"]],
    [{ "package.json": "not json" }, ["npm", "github", "github-repo", "domain"]],
    [
      { "pyproject.toml": '[project]\nname = "x"\n[build-system]\nrequires = ["hatchling"]' },
      ["pypi", "github", "github-repo", "domain"],
    ],
    [
      {
        "pyproject.toml":
          '[project]\ndependencies = ["mcp>=1.2"]\n[project.scripts]\nx = "x:main"\n[build-system]\nrequires = ["hatchling"]',
      },
      ["pypi", "homebrew", "mcp-registry", "smithery", "github", "github-repo", "domain"],
    ],
    [
      { "Cargo.toml": "[package]", "src/main.rs": "fn main() {}" },
      ["crates", "homebrew", "github", "github-repo", "domain"],
    ],
    [{ "Cargo.toml": "[package]" }, ["crates", "github", "github-repo", "domain"]],
    [{ "x.gemspec": "", "exe/": "" }, ["rubygems", "homebrew", "github", "github-repo", "domain"]],
    [{ "composer.json": '{"type":"library"}' }, ["packagist", "github", "github-repo", "domain"]],
    [{ "composer.json": '{"type":"project"}' }, ["github", "github-repo", "domain"]],
    [{ "pubspec.yaml": "name: x" }, ["pub", "github", "github-repo", "domain"]],
    [{ "pubspec.yaml": "name: x\npublish_to: none" }, ["github", "github-repo", "domain"]],
    [{ "X.csproj": "" }, ["nuget", "github", "github-repo", "domain"]],
    // Web apps, executables and test projects are not packages; a dotnet tool is.
    [{ "X.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web">' }, ["github", "github-repo", "domain"]],
    [{ "X.csproj": "<OutputType>Exe</OutputType>" }, ["github", "github-repo", "domain"]],
    [
      { "X.csproj": "<OutputType>Exe</OutputType><PackAsTool>true</PackAsTool>" },
      ["nuget", "github", "github-repo", "domain"],
    ],
    [{ "X.csproj": "<IsPackable>false</IsPackable>" }, ["github", "github-repo", "domain"]],
    [{ "X.csproj": "<IsTestProject>true</IsTestProject>" }, ["github", "github-repo", "domain"]],
    // xunit v3 test projects are executables; they still take no side in a solution.
    [
      {
        "X.sln":
          'Project("{G}") = "Lib", "Lib\\Lib.csproj", "{H}"\nProject("{G}") = "T", "T\\T.csproj", "{I}"',
        "Lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "T/T.csproj":
          '<OutputType>Exe</OutputType><PackageReference Include="xunit.v3" Version="1.0.0" />',
      },
      ["nuget", "github", "github-repo", "domain"],
    ],
    // An app that is marked not packable is still an app in its solution.
    [
      {
        "X.sln":
          'Project("{G}") = "Api", "Api\\Api.csproj", "{H}"\nProject("{G}") = "Lib", "Lib\\Lib.csproj", "{I}"',
        "Api/Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"><IsPackable>false</IsPackable>',
        "Lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
      },
      ["github", "github-repo", "domain"],
    ],
    // What a props file sets only under a condition, such as test references, reaches no project here.
    [
      {
        "Lib.csproj": "<PackageId>Lib</PackageId>",
        "Directory.Build.props":
          '<ItemGroup Condition="$(MSBuildProjectName.EndsWith(\'Tests\'))"><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup>',
      },
      ["nuget", "github", "github-repo", "domain"],
    ],
    // MSBuild imports the nearest Directory.Build.props up the tree.
    [
      {
        "X.sln": 'Project("{G}") = "Tool", "src\\Tool\\Tool.csproj", "{H}"',
        "src/Tool/Tool.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "src/Directory.Build.props": "<IsPackable>false</IsPackable>",
      },
      ["github", "github-repo", "domain"],
    ],
    // A self-closing conditional element hides nothing after it.
    [
      {
        "Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "Directory.Build.props":
          '<ItemGroup><None Include="icon.png" Pack="true" Condition="Exists(\'icon.png\')" /></ItemGroup><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup><ItemGroup><None Include="README.md"><Pack>true</Pack></None></ItemGroup>',
      },
      ["github", "github-repo", "domain"],
    ],
    // A Choose block is as conditional as a Condition attribute, nested or not.
    [
      {
        "Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "Directory.Build.props":
          '<Choose><When Condition="a"><Choose><When Condition="b"></When></Choose><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup></When><Otherwise><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup></Otherwise></Choose>',
      },
      ["nuget", "github", "github-repo", "domain"],
    ],
    // Comments are not read.
    [
      { "X.csproj": "<!-- <OutputType>Exe</OutputType> -->" },
      ["nuget", "github", "github-repo", "domain"],
    ],
    [
      { "X.csproj": "<!--<IsPackable>false</IsPackable>-->" },
      ["nuget", "github", "github-repo", "domain"],
    ],
    // As in MSBuild, the last value wins, and the project's own over its props.
    [
      {
        "X.csproj":
          "<PropertyGroup><IsPackable>false</IsPackable></PropertyGroup><PropertyGroup><IsPackable>true</IsPackable></PropertyGroup>",
      },
      ["nuget", "github", "github-repo", "domain"],
    ],
    [
      {
        "X.csproj": "<IsPackable>true</IsPackable>",
        "Directory.Build.props": "<IsPackable>false</IsPackable>",
      },
      ["nuget", "github", "github-repo", "domain"],
    ],
    // A props file that imports the one above it.
    [
      {
        "src/Lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "X.sln": 'Project("{G}") = "Lib", "src\\Lib\\Lib.csproj", "{H}"',
        "Directory.Build.props": "<IsPackable>false</IsPackable>",
        "src/Directory.Build.props":
          "<Import Project=\"$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))\" /><LangVersion>latest</LangVersion>",
      },
      ["github", "github-repo", "domain"],
    ],
    // Test projects that are executables, by framework, SDK, runner or a props file's references.
    ...[
      '<OutputType>Exe</OutputType><PackageReference Include="TUnit" Version="0.6" />',
      '<OutputType>Exe</OutputType><EnableMSTestRunner>true</EnableMSTestRunner><PackageReference Include="MSTest" />',
      '<Project Sdk="MSTest.Sdk/3.6.4">',
    ].map((test): [Record<string, string>, string[]] => [
      {
        "X.slnx":
          '<Solution><Project Path="Lib/Lib.csproj" /><Project Path="T/T.csproj" /></Solution>',
        "Lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "T/T.csproj": test,
      },
      ["nuget", "github", "github-repo", "domain"],
    ]),
    [
      {
        "X.sln":
          'Project("{G}") = "Lib", "Lib\\Lib.csproj", "{H}"\nProject("{G}") = "T", "tests\\T\\T.csproj", "{I}"',
        "Lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "tests/T/T.csproj": "<OutputType>Exe</OutputType>",
        "tests/Directory.Build.props":
          '<ItemGroup><PackageReference Include="xunit.v3" /></ItemGroup>',
      },
      ["nuget", "github", "github-repo", "domain"],
    ],
    // A library that extends a test framework is still a package.
    [
      { "X.csproj": '<PackageReference Include="xunit.v3.extensibility.core" />' },
      ["nuget", "github", "github-repo", "domain"],
    ],
    // Apps by SDK version, element, quotes or Azure Functions.
    ...[
      '<Project Sdk="Microsoft.NET.Sdk.Web/8.0.0">',
      '<Project><Sdk Name="Microsoft.NET.Sdk.Web" />',
      "<Project Sdk='Microsoft.NET.Sdk.Web'>",
      '<Project Sdk="Microsoft.NET.Sdk.WebAssembly">',
      '<Project Sdk="Microsoft.NET.Sdk"><AzureFunctionsVersion>v4</AzureFunctionsVersion>',
      '<Project Sdk="Microsoft.NET.Sdk"><AWSProjectType>Lambda</AWSProjectType>',
    ].map((app): [Record<string, string>, string[]] => [
      { "X.csproj": app },
      ["github", "github-repo", "domain"],
    ]),
    [
      {
        "X.sln": 'Project("{G}") = "Lib", "Lib\\Lib.CSPROJ", "{H}"',
        "Lib/Lib.CSPROJ": "<PackageId>Lib</PackageId>",
      },
      ["nuget", "github", "github-repo", "domain"],
    ],
    // A quoted `>` inside a conditional element, before and after what is read.
    [
      {
        "Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "Directory.Build.props":
          "<Project><Import Project=\"a.props\" Condition=\"'$(VisualStudioVersion)' > '16.0'\" /><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup></Project>",
      },
      ["github", "github-repo", "domain"],
    ],
    [
      {
        "Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "Directory.Build.props":
          '<PropertyGroup Label="a>b" Condition="x"><IsPackable>false</IsPackable></PropertyGroup>',
      },
      ["nuget", "github", "github-repo", "domain"],
    ],
    // CDATA holds text, not elements.
    [
      {
        "Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "Directory.Build.props":
          '<Script><![CDATA[ <Foo Condition="x"> <!-- ]]></Script><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup>',
      },
      ["github", "github-repo", "domain"],
    ],
    // The props above are read where the import stands, so what comes after it wins.
    [
      {
        "X.sln": 'Project("{G}") = "Lib", "src\\Lib\\Lib.csproj", "{H}"',
        "src/Lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "Directory.Build.props": "<IsPackable>false</IsPackable>",
        "src/Directory.Build.props":
          "<IsPackable>true</IsPackable><Import Project=\"$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))\" />",
      },
      ["github", "github-repo", "domain"],
    ],
    // Only an import of the props above splices them in: not another file, itself, or one under a condition.
    ...(
      [
        [
          '<Import Project="$(MSBuildThisFileDirectory)Directory.Build.props.user" Condition="Exists(\'x\')" />',
        ],
        ['<Import Project="$(MSBuildThisFileDirectory)eng/Directory.Build.props" />'],
        ['<Import Project="$(MSBuildThisFileDirectory)Directory.Build.props" />'],
        [
          "<Import Project=\"$(MSBuildThisFileDirectory)../Directory.Build.props\" Condition=\"'$(Official)' == 'true'\" />",
        ],
      ] as const
    ).map(([props]): [Record<string, string>, string[]] => [
      {
        "X.sln": 'Project("{G}") = "A", "src\\A\\A.csproj", "{H}"',
        "src/A/A.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "Directory.Build.props": "<IsPackable>false</IsPackable>",
        "src/Directory.Build.props": props,
      },
      ["nuget", "github", "github-repo", "domain"],
    ]),
    // A quoted `>` in the project's own element.
    [
      { "X.csproj": "<OutputType Condition=\"'$(V)' > '1'\">Exe</OutputType>" },
      ["github", "github-repo", "domain"],
    ],
    // MSBuild looks up the whole tree, however deep the project.
    [
      {
        "X.sln": 'Project("{G}") = "A", "src\\a\\b\\c\\d\\A\\A.csproj", "{H}"',
        "src/a/b/c/d/A/A.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
        "Directory.Build.props": "<IsPackable>false</IsPackable>",
      },
      ["github", "github-repo", "domain"],
    ],
    // Directory.Build.targets comes after the project.
    [
      {
        "X.csproj": "<IsPackable>true</IsPackable>",
        "Directory.Build.targets": "<IsPackable>false</IsPackable>",
      },
      ["github", "github-repo", "domain"],
    ],
    [
      { "X.csproj": '<Project Sdk="Aspire.AppHost.Sdk/13.0.0">' },
      ["github", "github-repo", "domain"],
    ],
    [
      { "X.csproj": '<Project Sdk="Microsoft.Build.NoTargets/3.7.0">' },
      ["github", "github-repo", "domain"],
    ],
    [
      { "X.csproj": '<Project Sdk="Microsoft.Build.Traversal/4.1.0">' },
      ["github", "github-repo", "domain"],
    ],
    [
      { "Foo.CSPROJ": '<Project Sdk="Microsoft.NET.Sdk">' },
      ["nuget", "github", "github-repo", "domain"],
    ],
    [
      { "X.csproj": '<Project Sdk="Microsoft.NET.Sdk.Worker">' },
      ["github", "github-repo", "domain"],
    ],
    [
      { "X.csproj": '<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">' },
      ["github", "github-repo", "domain"],
    ],
    [
      { "X.csproj": '<IsPackable Condition="x">false</IsPackable>' },
      ["github", "github-repo", "domain"],
    ],
    [
      { "X.csproj": "<Project />", "Directory.Build.props": "<OutputType>Exe</OutputType>" },
      ["github", "github-repo", "domain"],
    ],
    // A library's tests take no side; a solution whose only project is missing publishes nothing.
    [
      {
        "X.sln":
          'Project("{G}") = "Lib", "src\\Lib\\Lib.csproj", "{H}"\nProject("{G}") = "T", "tests\\T\\T.csproj", "{I}"',
        "src/Lib/Lib.csproj": "<PackageLicenseExpression>MIT</PackageLicenseExpression>",
        "tests/T/T.csproj": "<IsPackable>false</IsPackable><IsTestProject>true</IsTestProject>",
      },
      ["nuget", "github", "github-repo", "domain"],
    ],
    [
      { "X.sln": 'Project("{G}") = "App", "App\\App.csproj", "{H}"' },
      ["github", "github-repo", "domain"],
    ],
    // pnpm 10 keeps settings in pnpm-workspace.yaml without making the repository a workspace.
    [
      {
        "package.json": '{"name":"app","private":true,"dependencies":{"x":"1"}}',
        "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - esbuild\n",
      },
      ["github", "github-repo", "domain"],
    ],
    [{ Pipfile: "[packages]" }, ["github", "github-repo", "domain"]],
    // A server or site: it starts or deploys itself and says nothing of what it would publish.
    [
      { "package.json": '{"name":"api","scripts":{"start":"node app.js"}}' },
      ["github", "github-repo", "domain"],
    ],
    [
      { "package.json": '{"name":"api","scripts":{"deploy:prod":"cdk deploy"}}' },
      ["github", "github-repo", "domain"],
    ],
    [
      { "package.json": '{"name":"x","files":["dist"],"scripts":{"start":"vite"}}' },
      ["npm", "github", "github-repo", "domain"],
    ],
    // Any Dockerfile checks Docker Hub, a private app's too: where its images go cannot be read reliably.
    [
      { "package.json": '{"name":"web","private":true,"dependencies":{"x":"1"}}', Dockerfile: "" },
      ["docker", "github", "github-repo", "domain"],
    ],
    // Only a JavaScript workspace with members it cannot find falls back to npm, and not for an app.
    [
      {
        "Cargo.toml": '[workspace]\nmembers = ["crates/*"]',
        "package.json": '{"private":true,"devDependencies":{"x":"1"}}',
      },
      ["github", "github-repo", "domain"],
    ],
    [
      {
        "package.json": '{"name":"app","private":true,"scripts":{"start":"node ."}}',
        "pnpm-workspace.yaml": "packages: []\n",
      },
      ["github", "github-repo", "domain"],
    ],
    // A Cargo workspace root without a [package] is no crate.
    [{ "Cargo.toml": '[workspace]\nmembers = ["crates/*"]' }, ["github", "github-repo", "domain"]],
    [{ "Dockerfile.prod": "" }, ["docker", "github", "github-repo", "domain"]],
    [{ Containerfile: "" }, ["docker", "github", "github-repo", "domain"]],
    [{ "api.Dockerfile": "" }, ["docker", "github", "github-repo", "domain"]],
    [{ dockerfile: "" }, ["docker", "github", "github-repo", "domain"]],
    // Where CI pushes the image is not read: a push elsewhere does not rule Docker Hub out.
    [
      {
        Dockerfile: "",
        ".github/workflows/ci.yml":
          "- uses: aws-actions/amazon-ecr-login@v2\n- run: docker push ghcr.io/me/app",
      },
      ["docker", "github", "github-repo", "domain"],
    ],
    // A private workspace root publishes its packages.
    [
      { "package.json": '{"private":true,"workspaces":["packages/*"]}' },
      ["npm", "github", "github-repo", "domain"],
    ],
    [
      { "package.json": '{"private":true}', "pnpm-workspace.yaml": "packages:\n  - packages/*\n" },
      ["npm", "github", "github-repo", "domain"],
    ],
    // Python files that configure tools or apps, not packages.
    [{ "pyproject.toml": "[tool.ruff]\nline-length = 100" }, ["github", "github-repo", "domain"]],
    [
      { "pyproject.toml": '[project]\nname = "x"\n[tool.uv]\npackage = false' },
      ["github", "github-repo", "domain"],
    ],
    [
      { "pyproject.toml": "[tool.poetry]\npackage-mode = false" },
      ["github", "github-repo", "domain"],
    ],
    [{ "setup.cfg": "[flake8]\nmax-line-length = 100" }, ["github", "github-repo", "domain"]],
    [
      { "setup.py": 'from setuptools import setup\nsetup(name="x")' },
      ["pypi", "github", "github-repo", "domain"],
    ],
    // Keywords and plugin entry points are not an MCP dependency or a command.
    [
      {
        "pyproject.toml":
          '[project]\nname = "x"\nkeywords = ["mcp", "llm"]\ndependencies = ["httpx"]\n[build-system]\nrequires = ["hatchling"]',
      },
      ["pypi", "github", "github-repo", "domain"],
    ],
    [
      {
        "pyproject.toml":
          '[project]\nname = "x"\ndependencies = [\n  "mcp[cli]>=1.2",\n]\n[build-system]\nrequires = ["hatchling"]',
      },
      ["pypi", "mcp-registry", "smithery", "github", "github-repo", "domain"],
    ],
    [
      { "setup.py": 'setup(name="x", entry_points={"pytest11": ["x = x.plugin"]})' },
      ["pypi", "github", "github-repo", "domain"],
    ],
    [{ "Cargo.toml": "[package]\npublish = false" }, ["github", "github-repo", "domain"]],
    [
      { "Cargo.toml": "[package]", "src/bin/tool.rs": "" },
      ["crates", "homebrew", "github", "github-repo", "domain"],
    ],
    [{ Gemfile: "gem 'rails'" }, ["github", "github-repo", "domain"]],
    [
      { "go.mod": "module x", "main.go": "package main" },
      ["homebrew", "github", "github-repo", "domain"],
    ],
    [{ "go.mod": "module x" }, ["github", "github-repo", "domain"]],
    [{ "Package.swift": "" }, ["github", "github-repo", "domain"]],
    [
      { "Package.swift": 'products: [.executable(name: "x", targets: ["x"])]' },
      ["homebrew", "github", "github-repo", "domain"],
    ],
    [
      { "Package.swift": '.executableTarget(name: "x")' },
      ["homebrew", "github", "github-repo", "domain"],
    ],
    // A solution of libraries is published; one that holds an app keeps plain libraries to itself.
    [
      {
        "X.sln": 'Project("{G}") = "Lib", "Lib\\Lib.csproj", "{H}"',
        "Lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
      },
      ["nuget", "github", "github-repo", "domain"],
    ],
    [
      {
        "X.sln":
          'Project("{G}") = "Api", "Api\\Api.csproj", "{H}"\nProject("{G}") = "Lib", "Lib\\Lib.csproj", "{I}"',
        "Api/Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web">',
        "Lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">',
      },
      ["github", "github-repo", "domain"],
    ],
    [
      {
        "X.slnx": '<Project Path="Api/Api.csproj" /><Project Path="Sdk/Sdk.csproj" />',
        "Api/Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web">',
        "Sdk/Sdk.csproj": "<PackageId>X.Sdk</PackageId>",
      },
      ["nuget", "github", "github-repo", "domain"],
    ],
    [
      { "composer.json": '{"type":"library","extra":{"x":{"type":"project"}}}' },
      ["packagist", "github", "github-repo", "domain"],
    ],
    [{ "ios/App.xcodeproj/project.pbxproj": "" }, ["app-store", "github", "github-repo", "domain"]],
    [
      { "android/app/src/main/AndroidManifest.xml": "" },
      ["google-play", "github", "github-repo", "domain"],
    ],
    [
      {
        "app.config.ts": "export default {}",
        "package.json": '{"private":true,"dependencies":{"expo":"~52"}}',
      },
      ["app-store", "google-play", "github", "github-repo", "domain"],
    ],
    // Nuxt names its config app.config.ts too.
    [
      { "app.config.ts": "", "package.json": '{"private":true,"dependencies":{"nuxt":"3"}}' },
      ["github", "github-repo", "domain"],
    ],
    [
      {
        "pyproject.toml":
          '[project]\nname = "x"\n[tool.uv]\ndev-dependencies = [\n  "pytest",\n]\npackage = false',
      },
      ["github", "github-repo", "domain"],
    ],
    // What `uv init` writes for an application: no build backend.
    [
      { "pyproject.toml": '[project]\nname = "x"\nversion = "0.1.0"' },
      ["github", "github-repo", "domain"],
    ],
    [{ "Cargo.toml": "[package]\npublish = []" }, ["github", "github-repo", "domain"]],
    [{ ".claude-plugin/plugin.json": "{}" }, ["claude-plugins", "github", "github-repo", "domain"]],
    [{ ".cursor-plugin/plugin.json": "{}" }, ["cursor", "github", "github-repo", "domain"]],
    [
      { "package.json": '{"engines":{"vscode":"^1.90.0"}}' },
      ["vscode", "open-vsx", "github", "github-repo", "domain"],
    ],
    [
      { "build.gradle.kts": 'plugins { id("org.jetbrains.intellij.platform") }' },
      ["jetbrains", "github", "github-repo", "domain"],
    ],
    [{ "gemini-extension.json": "{}" }, ["gemini", "github", "github-repo", "domain"]],
    [{ "App.xcodeproj/project.pbxproj": "" }, ["app-store", "github", "github-repo", "domain"]],
    [
      { "app/src/main/AndroidManifest.xml": "" },
      ["google-play", "github", "github-repo", "domain"],
    ],
    [
      { "app.json": '{"expo":{"name":"x"}}' },
      ["app-store", "google-play", "github", "github-repo", "domain"],
    ],
    [
      { "pubspec.yaml": "name: x\npublish_to: none\ndependencies:\n  flutter:\n    sdk: flutter" },
      ["app-store", "google-play", "github", "github-repo", "domain"],
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
      only: ["npm", "mcp-registry", "smithery", "homebrew", "github", "github-repo", "domain"],
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
    expect((await detectProject(dir))?.only).toEqual([
      "npm",
      "homebrew",
      "github",
      "github-repo",
      "domain",
    ]);
  });

  it("finds members at any depth under **, and the root listed as a member only once", async () => {
    const dir = project({
      "package.json": '{"name":"root","private":true}',
      "pnpm-workspace.yaml": "packages:\n  - '.'\n  - 'packages/**'\n",
      "packages/group/deep/package.json": '{"name":"deep","bin":"x.js"}',
    });
    expect(await detectProject(dir)).toEqual({
      only: ["npm", "homebrew", "github", "github-repo", "domain"],
      from: ["package.json", join("packages", "group", "deep", "package.json")],
    });
  });

  it("reads a member that is itself a workspace", async () => {
    const dir = project({
      "package.json": '{"private":true,"workspaces":["apps/*"]}',
      "apps/tools/package.json": '{"private":true,"workspaces":["cli"]}',
      "apps/tools/cli/package.json": '{"name":"cli","bin":"x.js"}',
    });
    expect((await detectProject(dir))?.only).toEqual([
      "npm",
      "homebrew",
      "github",
      "github-repo",
      "domain",
    ]);
  });

  it("reads Lerna's default packages and Cargo's members past comments and exclusions", async () => {
    const lerna = project({
      "package.json": '{"private":true}',
      "lerna.json": "{}",
      "packages/a/package.json": '{"name":"a","bin":"x.js"}',
    });
    expect((await detectProject(lerna))?.only).toEqual([
      "npm",
      "homebrew",
      "github",
      "github-repo",
      "domain",
    ]);
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
      only: ["crates", "homebrew", "github", "github-repo", "domain"],
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
    expect((await detectProject(npm))?.only).toEqual(["npm", "github", "github-repo", "domain"]);
    const cargo = project({
      "Cargo.toml": '[workspace]\nmembers = [\n  "tool",\n]',
      "tool/Cargo.toml": "[package]",
      "tool/src/main.rs": "",
    });
    expect((await detectProject(cargo))?.only).toEqual([
      "crates",
      "homebrew",
      "github",
      "github-repo",
      "domain",
    ]);
  });

  it.each([
    ["Directory.Build.props", "<a ".repeat(50_000)],
    ["Directory.Build.props", `<Project><${"a".repeat(80_000)}`],
    ["Directory.Build.props", "<IsPackable ".repeat(20_000)],
    ["Directory.Build.props", "<Import ".repeat(20_000)],
  ])("reads a large %s in linear time", async (file, content) => {
    const dir = project({ "X.csproj": "<Project />", [file]: content });
    const started = Date.now();
    await detectProject(dir);
    expect(Date.now() - started).toBeLessThan(500);
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
      only: ["crates", "github", "github-repo", "domain"],
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
    expect((await findProject(join(dir, "docker")))?.only).toEqual([
      "npm",
      "github",
      "github-repo",
      "domain",
    ]);
  });

  it("stops at the repository root", async () => {
    const outer = project({ "package.json": '{"name":"x"}' });
    const repo = join(outer, "repo");
    mkdirSync(join(repo, ".git", "x"), { recursive: true });
    mkdirSync(join(repo, "docs"));
    expect(await findProject(join(repo, "docs"))).toBeUndefined();
  });
});
