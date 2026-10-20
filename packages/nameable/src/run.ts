import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import {
  channelIds,
  checkMany,
  DEFAULT_TLDS,
  selectChannels,
  type Channel,
  type Fetch,
  type Report,
  type Whois,
} from "@nameable/core";
import { createRenderer, type Output } from "./render.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `nameable ${version}
Find out if a name is free everywhere it matters for your project.

Usage
  nameable <name>... [options]
  nameable check <name>... [options]

  One name shows each channel with its evidence; several names show a comparison grid.

Options
  --only <ids>    Comma-separated channels: ${channelIds().join(", ")}
  --tlds <list>   Domains to check (default: ${DEFAULT_TLDS.join(",")})
  --json          Print JSON (default when stdout is not a terminal)
  -h, --help      Show this help
  -v, --version   Show the version

Exit codes
  0  every channel is available or reclaimable for every name
  1  taken or unavailable somewhere
  2  nothing taken, but some channels could not be checked
  64 usage error

GitHub checks use GITHUB_TOKEN, GH_TOKEN or \`gh auth token\` when available.
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
        tlds: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  const names = positionals[0] === "check" ? positionals.slice(1) : positionals;
  return { values, names: [...new Set(names)] };
}

export async function run(argv: string[], io: Io): Promise<number> {
  let values;
  let names: string[];
  let channels: Channel[];
  try {
    ({ values, names } = parse(argv));
    if (values.help) return (io.stdout.write(HELP), 0);
    if (values.version) return (io.stdout.write(`${version}\n`), 0);
    if (!names.length) throw new UsageError("missing <name>");
    for (const flag of ["only", "tlds"] as const) {
      if (values[flag] !== undefined && !split(values[flag])?.length) {
        throw new UsageError(`--${flag} needs at least one value`);
      }
    }
    try {
      channels = selectChannels({ only: split(values.only), tlds: split(values.tlds) });
    } catch (err) {
      throw new UsageError((err as Error).message);
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
    const what = single ? `"${names[0]}"` : `${names.length} names`;
    io.stdout.write(`\nChecking ${what} on ${channels.length} channels\n\n`);
  }
  const reports = await checkMany(names, channels, {
    fetch: io.fetch,
    whois: io.whois,
    githubToken: await io.githubToken?.(),
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
