#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { run } from "./run.js";

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

// A closed pipe (`nameable foo | head`) is the reader's choice, not a crash.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw err;
});

process.exitCode = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  interactive: process.stdout.isTTY === true,
  // hasColors() honors NO_COLOR and FORCE_COLOR.
  color: process.stdout.isTTY === true && process.stdout.hasColors(),
  githubToken,
});
