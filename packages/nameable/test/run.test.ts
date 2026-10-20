import { describe, expect, it } from "vite-plus/test";
import { fakeFetch } from "../../core/test/fake-fetch.js";
import { run, type Io } from "../src/run.js";

const PYPI = (name: string) => `https://pypi.org/pypi/${name}/json`;
const CRATES = (name: string) => `https://crates.io/api/v1/crates/${name}`;

async function cli(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  io: Partial<Io> = {},
  columns = 100,
) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdout: { write: (s: string) => (stdout += s), columns },
    stderr: { write: (s: string) => (stderr += s) },
    interactive: false,
    color: false,
    fetch: fakeFetch(routes),
    ...io,
  });
  return { code, stdout, stderr };
}

// Strip cursor movement and line clearing, keeping only the final text of each redraw.
const screen = (s: string) =>
  // oxlint-disable-next-line no-control-regex
  s.replace(/\x1b\[\d*[AK]/g, "").replace(/\r/g, "");

describe("usage", () => {
  it("prints help with exit 0", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage");
  });

  it.each([
    [[], "missing <name>"],
    [["foo", "--only", ""], "--only needs at least one value"],
    [["foo", "--tlds", " , "], "--tlds needs at least one value"],
    [["foo", "--only", "nope"], 'unknown channel "nope"'],
    [["foo", "--bogus"], "Unknown option"],
  ])("exits 64 for %j", async (argv, message) => {
    const r = await cli(argv);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain(message);
    expect(r.stdout).toBe("");
  });
});

describe("JSON output", () => {
  it("is the default off a terminal and exits 0 when everything is free", async () => {
    const r = await cli(["zz", "--only", "pypi,crates"], {
      [PYPI("zz")]: 404,
      [CRATES("zz")]: 404,
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.schema).toBe(1);
    expect(out.reports).toHaveLength(1);
    expect(out.reports[0].name).toBe("zz");
    expect(out.reports[0].results.map((x: { status: string }) => x.status)).toEqual([
      "available",
      "available",
    ]);
  });

  it("exits 1 when a name is taken somewhere", async () => {
    const body = { info: { name: "zz" } };
    const r = await cli(["zz", "--only", "pypi,crates"], {
      [PYPI("zz")]: [200, body],
      [CRATES("zz")]: 404,
    });
    expect(r.code).toBe(1);
  });

  it("exits 2 when nothing is taken but a channel could not be checked", async () => {
    const r = await cli(["zz", "--only", "pypi,crates"], {
      [PYPI("zz")]: new TypeError("fetch failed"),
      [CRATES("zz")]: 404,
    });
    expect(r.code).toBe(2);
  });

  it("reports several names once each, in the order given", async () => {
    const r = await cli(["bb", "aa", "bb", "--only", "crates"], {
      [CRATES("aa")]: 404,
      [CRATES("bb")]: 404,
    });
    expect(JSON.parse(r.stdout).reports.map((x: { name: string }) => x.name)).toEqual(["bb", "aa"]);
  });

  it("accepts the check subcommand", async () => {
    const r = await cli(["check", "zz", "--only", "crates"], { [CRATES("zz")]: 404 });
    expect(JSON.parse(r.stdout).reports[0].name).toBe("zz");
  });
});

describe("terminal output", () => {
  it("shows one row per channel and a summary for a single name", async () => {
    const r = await cli(
      ["zz", "--only", "pypi,crates"],
      {
        [PYPI("zz")]: 404,
        [CRATES("zz")]: [200, { crate: { name: "zz", description: "A crate" } }],
      },
      { interactive: true },
    );
    const text = screen(r.stdout);
    expect(text).toContain('Checking "zz" on 2 channels');
    expect(text).toMatch(/✓ PyPI\s+available/);
    expect(text).toMatch(/✗ crates\.io\s+taken\s+A crate/);
    expect(text).toContain("1 available · 1 taken");
    // The full link for every channel that is not free, under the table.
    expect(text).toMatch(/crates\.io\s+https:\/\/crates\.io\/crates\/zz/);
    expect(text).not.toContain("https://pypi.org/project/zz/");
  });

  it("shows a grid with free counts for several names", async () => {
    const r = await cli(
      ["aa", "bb", "--only", "crates"],
      { [CRATES("aa")]: 404, [CRATES("bb")]: [200, { crate: { name: "bb" } }] },
      { interactive: true },
    );
    const text = screen(r.stdout);
    expect(text).toContain("Checking 2 names on 1 channels");
    expect(text).toMatch(/aa\s+bb/);
    expect(text).toMatch(/crates\.io\s+✓\s+✗/);
    expect(text).toMatch(/free\s+1\/1\s+0\/1/);
  });

  it("never prints a row wider than the terminal, so redraws stay aligned", async () => {
    const r = await cli(
      ["zz", "--only", "crates"],
      { [CRATES("zz")]: [200, { crate: { name: "zz", description: "x".repeat(300) } }] },
      { interactive: true },
      60,
    );
    const widest = Math.max(
      ...screen(r.stdout)
        .split("\n")
        .map((l) => l.length),
    );
    expect(widest).toBeLessThanOrEqual(60);
  });
});
