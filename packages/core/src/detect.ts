import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

/** The channels a project ships on, read from its manifests, and the files that said so. */
export type Detection = { only: string[]; from: string[] };

/** Checked when no manifest says what the project is: the channels most projects meet. */
export const GENERAL_CHANNELS: string[] = ["npm", "pypi", "crates", "homebrew", "github", "domain"];

const MCP_PACKAGES = /"(?:@modelcontextprotocol\/(?:sdk|server)|fastmcp|mcp-framework)"\s*:/;
// A requirement such as "mcp[cli]>=1.2" or "fastmcp", inside a dependency list (not keywords).
const MCP_REQUIREMENT = /["'](?:mcp|fastmcp)(?:\[[^\]]*\])?\s*(?:[<>=~!;]|["'])/;

async function text(dir: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, file), "utf8");
  } catch {
    return undefined;
  }
}

async function json(dir: string, file: string): Promise<Record<string, unknown> | undefined> {
  const raw = await text(dir, file);
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    // A broken manifest still says what kind of project this is.
    return {};
  }
}

function parses(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** The body of one TOML table, up to the next table header. */
function table(toml: string, name: string): string {
  const start = toml.search(new RegExp(`^\\[${name.replaceAll(".", "\\.")}\\]\\s*$`, "m"));
  if (start < 0) return "";
  const rest = toml.slice(start).split("\n").slice(1);
  const end = rest.findIndex((line) => /^\[[^\]]+\]\s*$/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** Whether a Python manifest describes a package to publish, not an app or a tool's settings. */
function pythonPackage(file: string, py: string): boolean {
  if (file === "setup.py") return /\bsetup\s*\(/.test(py);
  if (file === "setup.cfg") return /^\[metadata\]/m.test(py);
  // uv and Poetry both mark applications that are never built as packages.
  if (/^[ \t]*package[ \t]*=[ \t]*false/m.test(table(py, "tool.uv"))) return false;
  if (/^[ \t]*package-mode[ \t]*=[ \t]*false/m.test(py)) return false;
  if (/^\[tool\.poetry\]/m.test(py)) return true;
  // A [project] with no build backend is an application (what `uv init` writes): nothing to upload.
  return /^\[project\]/m.test(py) && /^\[build-system\]/m.test(py);
}

type DotnetProject = "package" | "library" | "app" | "none";

/** MSBuild XML without its comments and CDATA sections, whose text holds no elements. */
function uncommented(xml: string): string {
  return xml.replace(/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, "");
}

// A tag's attributes. A quoted value can hold `>` (`'$(V)' > '16'`) but never `<`, which keeps a tag that
// never closes from being read to the end.
const ATTRIBUTES = `(?:\\s(?:[^<>"']|"[^"<]*"|'[^'<]*')*)?`;

/**
 * MSBuild XML without what it sets only under a condition: elements with a Condition attribute and
 * Choose blocks. Which projects a props file's conditions reach cannot be told without evaluating MSBuild.
 */
function unconditional(xml: string): string {
  let out = "";
  let last = 0;
  // The element being skipped, and how deep inside elements of the same name the scan is.
  let skipping: string | undefined;
  let depth = 0;
  for (const m of xml.matchAll(new RegExp(`<(\\/?)([\\w.-]+)(${ATTRIBUTES})>`, "g"))) {
    const [tag, close, name, attrs] = m as unknown as [string, string, string, string];
    const empty = attrs.endsWith("/");
    if (skipping) {
      if (name === skipping && !empty) depth += close ? -1 : 1;
      if (depth === 0) {
        skipping = undefined;
        last = m.index + tag.length;
      }
      continue;
    }
    if (close || (name !== "Choose" && !/\sCondition\s*=/.test(attrs))) continue;
    out += xml.slice(last, m.index);
    last = m.index + tag.length;
    if (!empty) [skipping, depth] = [name, 1];
  }
  return skipping ? out : out + xml.slice(last);
}

// The test SDK, and the packages only test projects reference (xunit v3, TUnit and MSTest make them
// executables); libraries that extend a framework reference its core package instead.
const TEST_REFERENCE =
  /Include\s*=\s*["'](?:Microsoft\.NET\.Test\.Sdk|xunit\.v3|TUnit|MSTest)["']/i;
const SDK = /\bSdk(?:\s+Name)?\s*=\s*["']([\w.]+)/gi;

/**
 * What a .NET project builds, from its own properties and those of the Directory.Build.props and
 * Directory.Build.targets files it imports. A tool (`PackAsTool`) is a package. Then none: a test project,
 * or one that only groups others. Then an app: a web, worker, WebAssembly, Aspire AppHost, Azure
 * Functions or AWS Lambda project, or an executable; package metadata does not make one a
 * package, since a props file often sets it for every project. Then none: a project marked not
 * packable. Then a package: one that is packable, built as a package or declares package metadata.
 * A plain library is packable by default, so NuGet takes it unless something says otherwise.
 */
function dotnetProject(project: string, props = "", targets = ""): DotnetProject {
  // In MSBuild's order, in which the last value set wins: props, the project, then targets.
  const xml = unconditional(props) + uncommented(project) + unconditional(targets);
  const prop = (name: string) => {
    const values = [...xml.matchAll(new RegExp(`<${name}${ATTRIBUTES}>([^<]*)</${name}>`, "gi"))];
    return values.at(-1)?.[1]?.trim().toLowerCase();
  };
  const sdks = [...xml.matchAll(SDK)].map((m) => m[1]!.toLowerCase());
  if (prop("PackAsTool") === "true") return "package";
  // Before the executable check: test projects on Microsoft.Testing.Platform are executables.
  if (
    prop("IsTestProject") === "true" ||
    prop("EnableMSTestRunner") === "true" ||
    prop("EnableNUnitRunner") === "true" ||
    sdks.includes("mstest.sdk") ||
    // Projects that build nothing of their own: they only group or run others.
    sdks.some((sdk) => /^microsoft\.build\.(?:notargets|traversal)$/.test(sdk)) ||
    TEST_REFERENCE.test(xml)
  ) {
    return "none";
  }
  if (
    sdks.some((sdk) =>
      /^(?:microsoft\.net\.sdk\.(?:web|worker|blazorwebassembly|webassembly)|aspire\.apphost\.sdk)$/.test(
        sdk,
      ),
    ) ||
    /^(?:winexe|exe)$/.test(prop("OutputType") ?? "") ||
    prop("AzureFunctionsVersion") !== undefined ||
    prop("AWSProjectType") !== undefined
  ) {
    return "app";
  }
  if (prop("IsPackable") === "false") return "none";
  if (
    prop("IsPackable") === "true" ||
    prop("GeneratePackageOnBuild") === "true" ||
    /<Package(?:Id|LicenseExpression|LicenseFile|Tags|ProjectUrl|ReadmeFile|Icon)\b/i.test(xml)
  ) {
    return "package";
  }
  return "library";
}

/**
 * The import of the same file further up, in the forms MSBuild documents: `GetPathOfFileAbove` or a `..`
 * path, unconditional or only on the file existing.
 */
function parentImport(xml: string, file: string): RegExpMatchArray | undefined {
  const name = file.replaceAll(".", "\\.");
  const above = new RegExp(`GetPathOfFileAbove\\(\\s*'${name}'|\\.\\.[\\\\/]${name}$`, "i");
  for (const m of xml.matchAll(new RegExp(`<Import(${ATTRIBUTES})>`, "gi"))) {
    const attribute = (key: string) => {
      const value = new RegExp(`\\s${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(m[1]!);
      return value ? (value[1] ?? value[2]) : undefined;
    };
    const condition = attribute("Condition");
    if (
      above.test(attribute("Project") ?? "") &&
      (condition === undefined || /^\s*Exists\(/i.test(condition))
    ) {
      return m;
    }
  }
  return undefined;
}

/**
 * The Directory.Build.props or Directory.Build.targets MSBuild imports for a project in `dir`: the nearest
 * one up the tree, as far as the repository root, with the one above it in place of its import of it.
 */
async function buildFile(dir: string, file: string): Promise<string> {
  for (let at = resolve(dir); at !== homedir(); at = dirname(at)) {
    const entries = await list(at);
    const top = entries.includes(".git") || dirname(at) === at;
    if (entries.includes(file)) {
      const xml = uncommented((await text(at, file)) ?? "");
      const parent = parentImport(xml, file);
      if (!parent || top) return xml;
      const outer = await buildFile(dirname(at), file);
      return xml.slice(0, parent.index) + outer + xml.slice(parent.index! + parent[0].length);
    }
    if (top) break;
  }
  return "";
}

/**
 * Whether a .NET project or solution is published to NuGet. A solution that holds an application
 * keeps its plain libraries to itself; only projects that declare package metadata count there. Test
 * projects take no side, and projects the solution lists but that are missing are skipped.
 */
async function nugetPackage(dir: string, file: string, xml: string): Promise<boolean> {
  const kind = async (project: string, sub: string) =>
    dotnetProject(
      project,
      await buildFile(join(dir, sub), "Directory.Build.props"),
      await buildFile(join(dir, sub), "Directory.Build.targets"),
    );
  if (!/\.slnx?$/i.test(file)) {
    const own = await kind(xml, ".");
    return own === "package" || own === "library";
  }
  const paths = [...xml.matchAll(/"([^"]+\.(?:cs|fs|vb)proj)"/gi)].map((m) =>
    m[1]!.replaceAll("\\", "/"),
  );
  const kinds = await Promise.all(
    paths.map(async (path) => {
      const project = await text(dir, path);
      if (project === undefined) return "none";
      return kind(project, dirname(path));
    }),
  );
  return kinds.includes("package") || (kinds.includes("library") && !kinds.includes("app"));
}

/** Subdirectories that can hold workspace members: not hidden, not installed dependencies. */
async function subdirs(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const e of await list(dir)) {
    if (e.startsWith(".") || e === "node_modules") continue;
    if (
      await stat(join(dir, e)).then(
        (st) => st.isDirectory(),
        () => false,
      )
    )
      found.push(e);
  }
  return found;
}

/** How deep `**` looks for members, which keeps a large tree from being walked whole. */
const MAX_GLOBSTAR_DEPTH = 4;

/** The directories a workspace pattern such as `packages/*` or `components/**` names. */
async function expand(dir: string, pattern: string): Promise<string[]> {
  let found = [""];
  for (const segment of pattern.replace(/^\.\//, "").split("/").filter(Boolean)) {
    if (segment === "**") {
      // Zero or more levels.
      const all = [...found];
      let level = found;
      for (let depth = 0; depth < MAX_GLOBSTAR_DEPTH && level.length; depth++) {
        const next: string[] = [];
        for (const f of level) for (const e of await subdirs(join(dir, f))) next.push(join(f, e));
        all.push(...next);
        level = next;
      }
      found = all;
    } else if (segment.includes("*")) {
      const match = new RegExp(
        `^${segment.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll(/\*+/g, "[^/]*")}$`,
      );
      const next: string[] = [];
      for (const f of found) {
        for (const e of await subdirs(join(dir, f))) if (match.test(e)) next.push(join(f, e));
      }
      found = next;
    } else {
      found = found.map((f) => join(f, segment));
    }
  }
  // "." is the root itself, not a member.
  return found.map((f) => join(f)).filter((f) => f !== "." && f !== "");
}

/**
 * The quoted strings of a TOML array such as `members = [...]`, read past comments and line breaks.
 * A `]` or `"` inside a comment does not end it.
 */
function tomlStrings(toml: string, key: string): string[] {
  const start = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\[`, "m").exec(toml);
  if (!start) return [];
  const found: string[] = [];
  for (let i = start.index + start[0].length; i < toml.length; i++) {
    const c = toml[i]!;
    if (c === "]") break;
    if (c === "#") {
      const end = toml.indexOf("\n", i);
      i = end < 0 ? toml.length : end;
    } else if (c === '"' || c === "'") {
      const end = toml.indexOf(c, i + 1);
      if (end < 0) break;
      found.push(toml.slice(i + 1, end));
      i = end;
    }
  }
  return found;
}

/**
 * The `packages` globs of a pnpm-workspace.yaml, as a block list (`- "glob"` per line, indented or
 * not) or a flow list (`[a, b]`). Undefined when the file has no `packages` key: pnpm 10 keeps its
 * settings there in single-package repositories too.
 */
function pnpmPackages(yaml: string): string[] | undefined {
  const lines = yaml.split(/\r?\n/);
  const at = lines.findIndex((l) => /^packages[ \t]*:/.test(l));
  if (at < 0) return undefined;
  const unquote = (item: string) => item.trim().replace(/^(["'])(.*)\1$/, "$2");
  const rest = lines[at]!.replace(/^packages[ \t]*:/, "")
    .replace(/#.*$/, "")
    .trim();
  if (rest.startsWith("[")) {
    const flow = [rest, ...lines.slice(at + 1)].join("\n");
    const body = flow.slice(1, flow.includes("]") ? flow.indexOf("]") : undefined);
    return body.split(",").map(unquote).filter(Boolean);
  }
  const found: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const content = line.replace(/(^|\s)#.*$/, "").trimEnd();
    if (!content.trim()) continue;
    const item = /^[ \t]*-[ \t]*(.*)$/.exec(content);
    if (!item) break;
    found.push(unquote(item[1]!));
  }
  return found.filter(Boolean);
}

/** The member directories a JavaScript or Cargo workspace root lists, or undefined when it is none. */
async function workspaceMembers(
  dir: string,
  manifest: { workspaces?: unknown } | undefined,
  cargo: string | undefined,
): Promise<{ members: string[]; js: boolean } | undefined> {
  const patterns: string[] = [];
  const add = (value: unknown) => {
    if (Array.isArray(value)) for (const v of value) if (typeof v === "string") patterns.push(v);
  };
  const { workspaces } = manifest ?? {};
  add(Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown })?.packages);
  const pnpm = pnpmPackages((await text(dir, "pnpm-workspace.yaml")) ?? "");
  add(pnpm);
  const lerna = await json(dir, "lerna.json");
  // Lerna's default when lerna.json names no packages.
  add(lerna && (Array.isArray(lerna.packages) ? lerna.packages : ["packages/*"]));
  // A JavaScript workspace that names members; with none found, the root still publishes something.
  const js = patterns.length > 0;
  const cargoWorkspace = cargo !== undefined && /^\[workspace\]/m.test(cargo);
  const excluded = cargoWorkspace ? tomlStrings(table(cargo, "workspace"), "exclude") : [];
  if (cargoWorkspace) patterns.push(...tomlStrings(table(cargo, "workspace"), "members"));
  if (!workspaces && !pnpm && !lerna && !cargoWorkspace) return undefined;
  const expanded = async (globs: string[]) =>
    (await Promise.all(globs.filter((p) => !p.startsWith("!")).map((p) => expand(dir, p)))).flat();
  const skip = new Set([
    ...(await expanded(excluded)),
    ...(await expanded(patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1)))),
  ]);
  return { members: [...new Set(await expanded(patterns))].filter((m) => !skip.has(m)), js };
}

/** Whether a Python manifest depends on an MCP SDK. */
function pythonMcp(py: string): boolean {
  const lists = [...py.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]\s*$/gm)].map((m) => m[1]!);
  const poetry = /^\[tool\.poetry\.dependencies\]([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(py)?.[1] ?? "";
  return (
    lists.some((l) => MCP_REQUIREMENT.test(l)) ||
    /^[ \t]*(?:mcp|fastmcp)[ \t]*=/m.test(poetry) ||
    MCP_REQUIREMENT.test(/install_requires\s*=\s*\[([\s\S]*?)\]/.exec(py)?.[1] ?? "")
  );
}

/**
 * Reads the manifests in `dir` (not its subdirectories) and picks the channels the project would be
 * published on. GitHub and domains always apply. Returns undefined when no manifest is found.
 */
export function detectProject(dir: string): Promise<Detection | undefined> {
  return detect(dir, 0);
}

/** How deep workspaces nest: a root, and a member that is itself a workspace of packages. */
const MAX_WORKSPACE_DEPTH = 2;

async function detect(dir: string, depth: number): Promise<Detection | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  const has = (name: string) => entries.includes(name);
  const only = new Set<string>();
  const from: string[] = [];
  const pick = (file: string, ...ids: string[]) => {
    for (const id of ids) only.add(id);
    if (!from.includes(file)) from.push(file);
  };

  const manifest = has("package.json")
    ? (((await json(dir, "package.json")) ?? {}) as {
        name?: unknown;
        private?: unknown;
        bin?: unknown;
        workspaces?: unknown;
        scripts?: unknown;
        engines?: { vscode?: unknown };
      })
    : undefined;
  const cargo = has("Cargo.toml") ? await text(dir, "Cargo.toml") : undefined;
  // A workspace root publishes through its members, read as projects of their own.
  const workspace =
    depth < MAX_WORKSPACE_DEPTH ? await workspaceMembers(dir, manifest, cargo) : undefined;
  // Whether the root package.json could be published: not an extension, not a server or site.
  let rootPublishes = false;

  if (manifest) {
    // Read even when unreadable: its presence alone says the project is JavaScript.
    const pkg = (await text(dir, "package.json")) ?? "";
    // npm publishes nothing without a name, such as a package.json that only sets "type": "module".
    // A manifest that is not JSON still counts as named: it is broken, not a stub.
    const named = typeof manifest.name === "string" || !parses(pkg);
    // A package says what it publishes. A manifest that says nothing of the kind but starts, serves or
    // deploys itself is a server or a site, even without "private".
    const publishes = [
      "files",
      "exports",
      "publishConfig",
      "bin",
      "types",
      "typings",
      "module",
    ].some((key) => key in manifest);
    const scripts =
      manifest.scripts && typeof manifest.scripts === "object" ? Object.keys(manifest.scripts) : [];
    const runs = !publishes && scripts.some((s) => /^(?:start|serve|deploy)(?::|$)/.test(s));
    rootPublishes = !manifest.engines?.vscode && !runs;
    pick("package.json");
    // A VS Code extension is published to both extension marketplaces, not to npm.
    if (manifest.engines?.vscode) pick("package.json", "vscode", "open-vsx");
    else if (named && manifest.private !== true && !runs) pick("package.json", "npm");
    if (manifest.bin && named) pick("package.json", "homebrew");
    if (MCP_PACKAGES.test(pkg)) pick("package.json", "mcp-registry", "smithery");
  }

  // A Pipfile manages an application's dependencies; Pipenv builds no package.
  if (has("Pipfile")) pick("Pipfile");
  for (const file of ["pyproject.toml", "setup.py", "setup.cfg"]) {
    const py = has(file) ? await text(dir, file) : undefined;
    if (py === undefined) continue;
    // Settings for tools (ruff, flake8) or an application: Python, but nothing to publish on PyPI.
    pick(file);
    if (!pythonPackage(file, py)) continue;
    pick(file, "pypi");
    if (/^\[(?:project\.scripts|tool\.poetry\.scripts)\]|console_scripts/m.test(py)) {
      pick(file, "homebrew");
    }
    if (pythonMcp(py)) pick(file, "mcp-registry", "smithery");
  }

  if (cargo !== undefined) {
    pick("Cargo.toml");
    // `publish = false` and `publish = []` (no registry) both keep a crate off crates.io, and a
    // workspace root without a [package] is no crate at all.
    const crate = /^\[package\]/m.test(cargo) || !/^\[workspace\]/m.test(cargo);
    if (crate && !/^[ \t]*publish[ \t]*=[ \t]*(?:false|\[\s*\])/m.test(cargo))
      pick("Cargo.toml", "crates");
    const binaries =
      /^\[\[bin\]\]/m.test(cargo) ||
      (await text(dir, "src/main.rs")) !== undefined ||
      (await list(join(dir, "src/bin"))).length > 0;
    if (binaries) pick("Cargo.toml", "homebrew");
  }

  const gemspec = entries.find((e) => e.endsWith(".gemspec"));
  if (gemspec) {
    pick(gemspec, "rubygems");
    if (has("exe")) pick(gemspec, "homebrew");
  } else if (has("Gemfile")) {
    // A Gemfile without a gemspec is an application (Rails, Jekyll), not a gem.
    pick("Gemfile");
  }

  if (has("go.mod")) {
    pick("go.mod");
    // A command, as opposed to a library: a main package at the root or under cmd/.
    const main = await text(dir, "main.go");
    if ((main !== undefined && /^package main\b/m.test(main)) || has("cmd"))
      pick("go.mod", "homebrew");
  }
  const swift = has("Package.swift") ? await text(dir, "Package.swift") : undefined;
  if (swift !== undefined) {
    pick("Package.swift");
    if (/\.executable(?:Target)?\s*\(/.test(swift)) pick("Package.swift", "homebrew");
  }

  const composer = await json(dir, "composer.json");
  // An application (type "project", publish_to: none) is not published, as with a private package.json.
  if (composer !== undefined) {
    pick("composer.json");
    if (composer.type !== "project") pick("composer.json", "packagist");
  }

  const pubspec = has("pubspec.yaml") ? await text(dir, "pubspec.yaml") : undefined;
  if (pubspec !== undefined) {
    pick("pubspec.yaml");
    if (!/^publish_to:\s*["']?none/m.test(pubspec)) pick("pubspec.yaml", "pub");
    // A Flutter app (not a package) ships to the app stores.
    else if (/^[ \t]+sdk:[ \t]*flutter/m.test(pubspec))
      pick("pubspec.yaml", "app-store", "google-play");
  }

  const dotnet = entries.find((e) => /\.(?:(?:cs|fs|vb)proj|slnx?)$/i.test(e));
  if (dotnet) {
    pick(dotnet);
    if (await nugetPackage(dir, dotnet, (await text(dir, dotnet)) ?? "")) pick(dotnet, "nuget");
  }

  // An image is built from a Dockerfile. A compose file runs other people's images, and a compose file
  // alone (a docker/ folder in a project) is not a project to stop at.
  const container = entries.find((e) =>
    /^(?:Dockerfile|Containerfile)(?:\..+)?$|\.Dockerfile$/i.test(e),
  );
  if (container) pick(container, "docker");

  if (has(".claude-plugin")) pick(".claude-plugin", "claude-plugins");
  if (has(".cursor-plugin")) pick(".cursor-plugin", "cursor");
  // A JetBrains plugin: its descriptor, or the IntelliJ Platform Gradle plugin.
  const descriptor = "src/main/resources/META-INF/plugin.xml";
  const gradle = ["build.gradle.kts", "build.gradle"].find((f) => has(f));
  if ((await text(dir, descriptor)) !== undefined) pick(descriptor, "jetbrains");
  else if (gradle && /org\.jetbrains\.intellij/.test((await text(dir, gradle)) ?? "")) {
    pick(gradle, "jetbrains");
  }
  if (has("gemini-extension.json")) pick("gemini-extension.json", "gemini");

  // Mobile apps: an Xcode project, an Android app module (also under ios/ and android/, as React Native
  // lays them out), or an Expo app.
  const xcodeIn = async (sub: string) =>
    (await list(join(dir, sub))).find((e) => /\.(?:xcodeproj|xcworkspace)$/.test(e));
  const xcode = (await xcodeIn(".")) ?? (await xcodeIn("ios"));
  if (xcode) pick(xcode, "app-store");
  for (const manifest of [
    "AndroidManifest.xml",
    "app/src/main/AndroidManifest.xml",
    "android/app/src/main/AndroidManifest.xml",
  ]) {
    if ((await text(dir, manifest)) !== undefined) {
      pick(manifest, "google-play");
      break;
    }
  }
  const expo = await json(dir, "app.json");
  if (expo?.expo) pick("app.json", "app-store", "google-play");
  // app.config.ts is Expo's only with Expo installed; Nuxt and SolidStart use the same file name.
  const expoConfig = entries.find((e) => /^app\.config\.(?:js|ts|mjs|cjs)$/.test(e));
  if (expoConfig && /"expo"\s*:/.test((await text(dir, "package.json")) ?? "")) {
    pick(expoConfig, "app-store", "google-play");
  }

  let projects = 0;
  for (const member of workspace?.members ?? []) {
    const found = await detect(join(dir, member), depth + 1);
    if (found) projects++;
    const ids = found?.only.filter((id) => id !== "github" && id !== "domain") ?? [];
    // Only members that ship somewhere are named, not every internal package.
    if (!ids.length) continue;
    for (const id of ids) only.add(id);
    for (const file of found!.from) {
      if (!from.includes(join(member, file))) from.push(join(member, file));
    }
  }
  // A JavaScript workspace whose members cannot be found still publishes something, unless its root
  // says it is an app.
  if (workspace?.js && !projects && rootPublishes) pick("package.json", "npm");

  if (!from.length) return undefined;
  return { only: [...only, "github", "domain"], from };
}

/**
 * Detects the project `start` is in: the directory itself, or the nearest parent with manifests, up to
 * the repository root (a directory with `.git`) or the home directory. Files are named relative to `start`.
 */
export async function findProject(start: string, home?: string): Promise<Detection | undefined> {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    // A package.json in the home directory (left by `npm install` there) is not a project.
    if (home && dir === resolve(home)) return undefined;
    const found = await detectProject(dir);
    if (found) return { ...found, from: found.from.map((f) => relative(start, join(dir, f)) || f) };
    const entries = await list(dir);
    if (entries.includes(".git") || dir === home || dirname(dir) === dir) return undefined;
  }
}
