import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

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
  if (/^\s*package\s*=\s*false/m.test(table(py, "tool.uv"))) return false;
  if (/^\s*package-mode\s*=\s*false/m.test(py)) return false;
  if (/^\[tool\.poetry\]/m.test(py)) return true;
  // A [project] with no build backend is an application (what `uv init` writes): nothing to upload.
  return /^\[project\]/m.test(py) && /^\[build-system\]/m.test(py);
}

/** Whether a Python manifest depends on an MCP SDK. */
function pythonMcp(py: string): boolean {
  const lists = [...py.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]\s*$/gm)].map((m) => m[1]!);
  const poetry = /^\[tool\.poetry\.dependencies\]([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(py)?.[1] ?? "";
  return (
    lists.some((l) => MCP_REQUIREMENT.test(l)) ||
    /^\s*(?:mcp|fastmcp)\s*=/m.test(poetry) ||
    MCP_REQUIREMENT.test(/install_requires\s*=\s*\[([\s\S]*?)\]/.exec(py)?.[1] ?? "")
  );
}

/**
 * Reads the manifests in `dir` (not its subdirectories) and picks the channels the project would be
 * published on. GitHub and domains always apply. Returns undefined when no manifest is found.
 */
export async function detectProject(dir: string): Promise<Detection | undefined> {
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

  if (has("package.json")) {
    // Read even when unreadable: its presence alone says the project is JavaScript.
    const pkg = (await text(dir, "package.json")) ?? "";
    const manifest = ((await json(dir, "package.json")) ?? {}) as {
      private?: unknown;
      bin?: unknown;
      workspaces?: unknown;
      engines?: { vscode?: unknown };
    };
    // A private package (an app) is not published, but still says what the project is. A private
    // workspace root is the exception: its packages are what gets published.
    const workspaceRoot =
      Boolean(manifest.workspaces) || has("pnpm-workspace.yaml") || has("lerna.json");
    pick("package.json");
    // A VS Code extension is published to both extension marketplaces, not to npm.
    if (manifest.engines?.vscode) pick("package.json", "vscode", "open-vsx");
    else if (manifest.private !== true || workspaceRoot) pick("package.json", "npm");
    if (manifest.bin) pick("package.json", "homebrew");
    if (MCP_PACKAGES.test(pkg)) pick("package.json", "mcp-registry", "smithery");
  }

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

  const cargo = has("Cargo.toml") ? await text(dir, "Cargo.toml") : undefined;
  if (cargo !== undefined) {
    pick("Cargo.toml");
    // `publish = false` and `publish = []` (no registry) both keep a crate off crates.io.
    if (!/^\s*publish\s*=\s*(?:false|\[\s*\])/m.test(cargo)) pick("Cargo.toml", "crates");
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
  if (has("Package.swift")) pick("Package.swift");

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
    else if (/^\s+sdk:\s*flutter/m.test(pubspec)) pick("pubspec.yaml", "app-store", "google-play");
  }

  const dotnet = entries.find((e) => /\.(?:(?:cs|fs|vb)proj|slnx?)$/.test(e));
  if (dotnet) pick(dotnet, "nuget");

  // An image is built from a Dockerfile; a compose file alone usually runs other people's images.
  const container = entries.find((e) =>
    /^(?:Dockerfile|Containerfile)(?:\..+)?$|\.Dockerfile$/.test(e),
  );
  if (container) pick(container, "docker");
  const compose = entries.find((e) => /^(?:docker-)?compose\.ya?ml$/.test(e));
  if (compose) pick(compose);

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

  if (!from.length) return undefined;
  return { only: [...only, "github", "domain"], from };
}

/**
 * Detects the project `start` is in: the directory itself, or the nearest parent with manifests, up to
 * the repository root (a directory with `.git`) or the home directory. Files are named relative to `start`.
 */
export async function findProject(start: string, home?: string): Promise<Detection | undefined> {
  for (let dir = start; ; dir = dirname(dir)) {
    // A package.json in the home directory (left by `npm install` there) is not a project.
    if (dir === home) return undefined;
    const found = await detectProject(dir);
    if (found) return { ...found, from: found.from.map((f) => relative(start, join(dir, f)) || f) };
    const entries = await list(dir);
    if (entries.includes(".git") || dir === home || dirname(dir) === dir) return undefined;
  }
}
