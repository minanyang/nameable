import { createRequire } from "node:module";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import type { Transport } from "@modelcontextprotocol/server";
import {
  channelIds,
  checkMany,
  clearStore,
  DEFAULT_TLDS,
  findProject,
  GENERAL_CHANNELS,
  fileStore,
  selectChannels,
  type Channel,
  type Fetch,
  type Report,
  type Whois,
} from "@nameable/core";
import { createRenderer, printable, type Output } from "./render.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** Wraps a comma-separated list onto lines of `width`, continued under the help's option column. */
function wrap(list: string, width: number): string {
  const lines: string[] = [""];
  for (const item of list.split(" ")) {
    const last = lines.length - 1;
    if (lines[last] && lines[last]!.length + item.length + 1 > width) lines.push(item);
    else lines[last] = lines[last] ? `${lines[last]} ${item}` : item;
  }
  return lines.join(`\n${" ".repeat(18)}`);
}

const HELP = `nameable ${version}
Find out if a name is free everywhere it matters for your project.

Usage
  nameable <name>... [options]
  nameable check <name>... [options]
  nameable mcp

  One name shows each channel with its evidence; several names show a comparison grid.
  \`mcp\` serves the same checks to AI agents as an MCP server over stdio.

  Channels are picked from the project files in the current directory, or its parents up to the
  repository root: package.json, pyproject.toml, setup.py, Cargo.toml, a .gemspec, composer.json,
  pubspec.yaml, a .csproj or .sln, a Dockerfile, .claude-plugin, .cursor-plugin,
  gemini-extension.json, a VS Code extension, a JetBrains plugin, an MCP SDK dependency, and an
  Xcode, Android, Expo or Flutter app. Private apps and unpublished packages skip their registry.
  Outside a project, a general set is checked.

Options
  --only <ids>    Comma-separated channels:
                  ${wrap(channelIds().join(", "), 82)}
  --all           Check every channel
  --tlds <list>   Domains to check, at most 20 (default: ${DEFAULT_TLDS.join(",")}); with --only,
                  include domain
  --json          Print JSON (default when stdout is not a terminal)
  --refresh       Download the registry name lists even if the cached copy is fresh
  --clear-cache   Delete the cached name lists and exit
  -h, --help      Show this help
  -v, --version   Show the version

Exit codes
  0  every channel is available or reclaimable for every name
  1  taken or unavailable somewhere
  2  nothing taken, but some channels could not be checked
  64 usage error

GitHub checks use GITHUB_TOKEN, GH_TOKEN or \`gh auth token\` when available.
Several checks download registry-wide name lists (about 40 MB in all) at most once a day and keep
them in the cache directory (NAMEABLE_CACHE_DIR to change it).
`;

export type Io = {
  stdout: Output;
  stderr: { write(text: string): unknown };
  /** A terminal that can show the live table; otherwise JSON is printed. */
  interactive: boolean;
  color: boolean;
  githubToken?: () => Promise<string | undefined>;
  fetch?: Fetch;
  whois?: Whois;
  /** Where name lists are cached; without one they are downloaded on every run. */
  cacheDir?: string;
  /** The project whose manifests pick the channels when neither --only nor --all is given. */
  cwd?: string;
  /** Where `nameable mcp` talks MCP; the process's stdin and stdout by default. */
  mcpTransport?: Transport;
};

class UsageError extends Error {}

function exitCode(reports: Report[]): number {
  const results = reports.flatMap((r) => r.results);
  if (results.some((r) => r.status === "taken" || r.status === "unavailable")) return 1;
  if (results.some((r) => r.status === "unknown")) return 2;
  return 0;
}

const split = (s?: string) =>
  s
    ?.split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function parse(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        only: { type: "string" },
        all: { type: "boolean" },
        tlds: { type: "string" },
        json: { type: "boolean" },
        refresh: { type: "boolean" },
        "clear-cache": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    // Node's own wording ("… place it at the end of the command after '--', as in '-- \"--x\"") is
    // longer than the mistake; name the option instead.
    const option = /'(-[^']*)'/.exec((err as Error).message)?.[1];
    throw new UsageError(option ? `unknown option ${option}` : (err as Error).message);
  }
  const { values, positionals } = parsed;
  // `check` is the subcommand only when names follow it; `nameable check` checks the name "check".
  const names =
    positionals[0] === "check" && positionals.length > 1 ? positionals.slice(1) : positionals;
  // `mcp` alone starts the server; with names after it, as with `check`, it is a name to check.
  const mcp = positionals.length === 1 && positionals[0] === "mcp";
  return { values, names: [...new Set(names)], mcp };
}

export async function run(argv: string[], io: Io): Promise<number> {
  let values;
  let names: string[];
  let mcp: boolean;
  let channels: Channel[];
  let picked: string | undefined;
  try {
    ({ values, names, mcp } = parse(argv));
    if (values.help) return (io.stdout.write(HELP), 0);
    if (values.version) return (io.stdout.write(`${version}\n`), 0);
    if (mcp) {
      // The agent picks channels and TLDs per call, so options here would silently do nothing.
      if (Object.values(values).some((v) => v !== undefined)) {
        throw new UsageError("`mcp` takes no options; the agent chooses them in each call");
      }
      // Loaded only here, so checking names from the terminal does not pay for the MCP SDK.
      const { serveMcp } = await import("./mcp.js");
      const { githubToken, fetch, whois, cacheDir, mcpTransport } = io;
      serveMcp({ version, githubToken, fetch, whois, cacheDir }, mcpTransport);
      return 0;
    }
    if (values["clear-cache"]) {
      // Clearing checks nothing, so names or channel options would silently do nothing.
      const extra =
        names.length ||
        [values.only, values.all, values.tlds, values.refresh].some((v) => v !== undefined);
      if (extra) throw new UsageError("--clear-cache takes no names or other options");
      if (io.cacheDir) {
        try {
          await clearStore(io.cacheDir);
        } catch (err) {
          io.stderr.write(`nameable: could not clear ${io.cacheDir}: ${(err as Error).message}\n`);
          return 1;
        }
      }
      if (values.json) {
        io.stdout.write(`${JSON.stringify({ cleared: io.cacheDir ?? null })}\n`);
        return 0;
      }
      return (io.stdout.write(`Cleared ${io.cacheDir ?? "nothing (no cache directory)"}\n`), 0);
    }
    if (!names.length) throw new UsageError("missing <name>");
    if (names.some((n) => !n.trim())) throw new UsageError("names cannot be empty");
    for (const flag of ["only", "tlds"] as const) {
      if (values[flag] !== undefined && !split(values[flag])?.length) {
        throw new UsageError(`--${flag} needs at least one value`);
      }
    }
    if (values.only !== undefined && values.all) {
      throw new UsageError("--only and --all cannot be combined");
    }
    let only = split(values.only);
    if (!only && !values.all) {
      const detected = io.cwd ? await findProject(io.cwd, homedir()) : undefined;
      only = detected?.only ?? GENERAL_CHANNELS;
      picked = detected
        ? `picked from ${detected.from.join(", ")}`
        : "no project files found: general set";
    }
    try {
      channels = selectChannels({ only, tlds: split(values.tlds) });
    } catch (err) {
      const message = (err as Error).message;
      // The core says "channels"; on the command line they are given with --only.
      throw new UsageError(
        message.startsWith("TLDs apply to domains")
          ? "--tlds needs domain in --only (e.g. --only npm,domain)"
          : message,
      );
    }
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.stderr.write(`nameable: ${err.message}\nRun \`nameable --help\` for usage.\n`);
    return 64;
  }

  const json = values.json || !io.interactive;
  const render = createRenderer(io.stdout, io.color);
  const single = names.length === 1;
  if (!json) {
    const what = single ? `"${printable(names[0]!)}"` : `${names.length} names`;
    const how = picked ? ` (${picked}; --all for every channel)` : "";
    io.stdout.write(`\nChecking ${what} on ${channels.length} channels${how}\n\n`);
  }
  const reports = await checkMany(names, channels, {
    fetch: io.fetch,
    whois: io.whois,
    // Asking `gh` for a token can take a moment, so only when GitHub is checked.
    githubToken: channels.some((c) => c.id === "github") ? await io.githubToken?.() : undefined,
    store: io.cacheDir ? fileStore(io.cacheDir) : undefined,
    refresh: values.refresh,
    onResult: json
      ? undefined
      : single
        ? render.liveTable(channels)
        : render.liveGrid(channels, names),
  });

  if (json) io.stdout.write(`${JSON.stringify({ schema: 1, reports }, null, 2)}\n`);
  else if (single)
    io.stdout.write(
      `${render.evidence(reports[0]!.results)}\n  ${render.summary(reports[0]!.results)}\n\n`,
    );
  else io.stdout.write(`${render.gridFooter(reports, channels)}\n\n`);
  return exitCode(reports);
}
