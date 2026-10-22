import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** The channels a project ships on, read from its manifests, and the files that said so. */
export type Detection = { only: string[]; from: string[] };

/** Checked when no manifest says what the project is: the channels most projects meet. */
export const GENERAL_CHANNELS: string[] = ["npm", "pypi", "crates", "homebrew", "github", "domain"];

const MCP_PACKAGES = /"(?:@modelcontextprotocol\/(?:sdk|server)|fastmcp|mcp-framework)"\s*:/;
const MCP_PYTHON = /["'\s](?:mcp|fastmcp)(?:\[[^\]]*\])?\s*(?:[<>=~!]|["'])/;

async function text(dir: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, file), "utf8");
  } catch {
    return undefined;
  }
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

  const pkg = await text(dir, "package.json");
  if (pkg !== undefined) {
    let manifest: { private?: unknown; bin?: unknown } = {};
    try {
      manifest = (JSON.parse(pkg) ?? {}) as typeof manifest;
    } catch {
      // A broken package.json still says the project is JavaScript.
    }
    // A private package (an app, a monorepo root) is not published, but still says what the project is.
    pick("package.json");
    if (manifest.private !== true) pick("package.json", "npm");
    if (manifest.bin) pick("package.json", "homebrew");
    if (MCP_PACKAGES.test(pkg)) pick("package.json", "smithery");
  }

  for (const file of ["pyproject.toml", "setup.py", "setup.cfg"]) {
    const py = has(file) ? await text(dir, file) : undefined;
    if (py === undefined) continue;
    pick(file, "pypi");
    if (/^\[(?:project\.scripts|tool\.poetry\.scripts)\]|entry_points|console_scripts/m.test(py)) {
      pick(file, "homebrew");
    }
    if (MCP_PYTHON.test(py)) pick(file, "smithery");
  }

  const cargo = has("Cargo.toml") ? await text(dir, "Cargo.toml") : undefined;
  if (cargo !== undefined) {
    pick("Cargo.toml", "crates");
    if (/^\[\[bin\]\]/m.test(cargo) || (await text(dir, "src/main.rs")) !== undefined) {
      pick("Cargo.toml", "homebrew");
    }
  }

  const gemspec = entries.find((e) => e.endsWith(".gemspec"));
  if (gemspec) {
    pick(gemspec, "rubygems");
    if (has("exe")) pick(gemspec, "homebrew");
  }

  const composer = has("composer.json") ? await text(dir, "composer.json") : undefined;
  // An application (type "project", publish_to: none) is not published, as with a private package.json.
  if (composer !== undefined) {
    pick("composer.json");
    if (!/"type"\s*:\s*"project"/.test(composer)) pick("composer.json", "packagist");
  }

  const pubspec = has("pubspec.yaml") ? await text(dir, "pubspec.yaml") : undefined;
  if (pubspec !== undefined) {
    pick("pubspec.yaml");
    if (!/^publish_to:\s*["']?none/m.test(pubspec)) pick("pubspec.yaml", "pub");
    // A Flutter app (not a package) ships to the app stores.
    else if (/^\s+sdk:\s*flutter/m.test(pubspec)) pick("pubspec.yaml", "app-store", "google-play");
  }

  const dotnet = entries.find((e) => /\.(?:cs|fs|vb)proj$/.test(e));
  if (dotnet) pick(dotnet, "nuget");

  const container = entries.find((e) =>
    /^(?:Dockerfile|Containerfile|(?:docker-)?compose\.ya?ml)$/.test(e),
  );
  if (container) pick(container, "docker");

  if (has(".claude-plugin")) pick(".claude-plugin", "claude-plugins");
  if (has(".cursor-plugin")) pick(".cursor-plugin", "cursor");
  if (has("gemini-extension.json")) pick("gemini-extension.json", "gemini");

  // Mobile apps: an Xcode project, an Android app module, or an Expo app (app.json with "expo").
  const xcode = entries.find((e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"));
  if (xcode) pick(xcode, "app-store");
  if (
    has("AndroidManifest.xml") ||
    (await text(dir, "app/src/main/AndroidManifest.xml")) !== undefined
  ) {
    pick("AndroidManifest.xml", "google-play");
  }
  const expo = has("app.json") ? await text(dir, "app.json") : undefined;
  if (expo !== undefined && /"expo"\s*:/.test(expo)) pick("app.json", "app-store", "google-play");

  if (!from.length) return undefined;
  return { only: [...only, "github", "domain"], from };
}
