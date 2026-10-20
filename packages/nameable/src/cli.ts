#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { parseArgs, promisify } from "node:util";
import { channelIds, check, DEFAULT_TLDS, selectChannels, type CheckResult } from "@nameable/core";
import { liveTable, summary } from "./render.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `nameable ${version}
Find out if a name is free everywhere it matters for your project.

Usage
  nameable <name> [options]
  nameable check <name> [options]

Options
  --only <ids>    Comma-separated channels: ${channelIds().join(", ")}
  --tlds <list>   Domains to check (default: ${DEFAULT_TLDS.join(",")})
  --json          Print JSON (default when stdout is not a terminal)
  -h, --help      Show this help
  -v, --version   Show the version

Exit codes
  0  every channel is available or reclaimable
  1  taken or unavailable somewhere
  2  nothing taken, but some channels could not be checked
  64 usage error

GitHub checks use GITHUB_TOKEN, GH_TOKEN or \`gh auth token\` when available.
`;

/** Token for the GitHub API's higher rate limit; checks still run without one. */
async function githubToken(): Promise<string | undefined> {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    const { stdout } = await promisify(execFile)("gh", ["auth", "token"], { timeout: 3000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function exitCode(results: CheckResult[]): number {
  if (results.some((r) => r.status === "taken" || r.status === "unavailable")) return 1;
  if (results.some((r) => r.status === "unknown")) return 2;
  return 0;
}

function usage(message: string): never {
  process.stderr.write(`nameable: ${message}\nRun \`nameable --help\` for usage.\n`);
  process.exit(64);
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
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
    usage((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return (process.stdout.write(HELP), 0);
  if (values.version) return (process.stdout.write(`${version}\n`), 0);

  const args = positionals[0] === "check" ? positionals.slice(1) : positionals;
  if (args.length !== 1) usage(args.length ? "check one name at a time" : "missing <name>");
  const name = args[0]!;

  const split = (s?: string) =>
    s
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  let channels;
  try {
    channels = selectChannels({ only: split(values.only), tlds: split(values.tlds) });
  } catch (err) {
    usage((err as Error).message);
  }

  const json = values.json || !process.stdout.isTTY;
  if (!json) process.stdout.write(`\nChecking "${name}" on ${channels.length} channels\n\n`);
  const results = await check(name, channels, {
    githubToken: await githubToken(),
    onResult: json ? undefined : liveTable(channels),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify({ schema: 1, name, results }, null, 2)}\n`);
  } else {
    process.stdout.write(`\n  ${summary(results)}\n\n`);
  }
  return exitCode(results);
}

// A closed pipe (`nameable foo | head`) is the reader's choice, not a crash.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw err;
});

process.exitCode = await main();
