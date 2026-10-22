import { describe, expect, it } from "vite-plus/test";
import { fakeFetch } from "../../core/test/fake-fetch.js";
import { CRATES_DUMP, cratesDump } from "../../core/test/fixtures.js";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayWidth } from "../src/render.js";
import { run, type Io } from "../src/run.js";

const PYPI = (name: string) => `https://pypi.org/pypi/${name}/json`;
const CRATES = (name: string) => `https://crates.io/api/v1/crates/${name}`;
// PyPI checks a free name against its full project index and crates.io against its database dump;
// every test gets small ones, and no name used here has a PyPI simple page.
const LISTS: Parameters<typeof fakeFetch>[0] = {
  "https://pypi.org/simple/": [200, { projects: [{ name: "requests" }] }],
  "https://pypi.org/simple/zz/": 404,
  [CRATES_DUMP]: cratesDump(),
};

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
    fetch: fakeFetch({ ...LISTS, ...routes }),
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
    [["foo", " "], "names cannot be empty"],
    [["foo", "--tlds", "co.uk"], "several labels"],
    [["foo", "--tlds", " , "], "--tlds needs at least one value"],
    [["foo", "--only", "nope"], 'unknown channel "nope"'],
    [["foo", "--bogus"], "Unknown option"],
    [["mcp", "--only", "npm"], "`mcp` takes no options"],
    [["foo", "--only", "npm", "--all"], "--only and --all cannot be combined"],
  ])("exits 64 for %j", async (argv, message) => {
    const r = await cli(argv);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain(message);
    expect(r.stdout).toBe("");
  });
});

describe("cache", () => {
  it("clears the cache directory with --clear-cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nameable-"));
    await writeFile(join(dir, "pypi-projects.gz"), "x");
    const r = await cli(["--clear-cache"], {}, { cacheDir: dir });
    expect(r).toMatchObject({ code: 0, stdout: `Cleared ${dir}\n` });
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves anything it did not save when the cache directory points somewhere shared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nameable-"));
    await writeFile(join(dir, "pypi-projects.gz"), "x");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "notes.txt"), "keep");
    await cli(["--clear-cache"], {}, { cacheDir: dir });
    expect(await readdir(dir)).toEqual(["sub"]);
  });

  it("saves the PyPI list in the cache directory and reuses it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nameable-"));
    const first = await cli(["zz", "--only", "pypi"], { [PYPI("zz")]: 404 }, { cacheDir: dir });
    expect(first.code).toBe(0);
    expect(await readdir(dir)).toEqual(["pypi-projects.gz"]);
    // The index route is gone: a second run must answer from the saved copy.
    const second = await cli(
      ["zz", "--only", "pypi"],
      { [PYPI("zz")]: 404, "https://pypi.org/simple/": 503 },
      { cacheDir: dir },
    );
    expect(JSON.parse(second.stdout).reports[0].results[0]).toMatchObject({
      certainty: "confirmed",
    });
    // --refresh downloads again, so the broken index now shows.
    const refreshed = await cli(
      ["zz", "--only", "pypi", "--refresh"],
      { [PYPI("zz")]: 404, "https://pypi.org/simple/": 503 },
      { cacheDir: dir },
    );
    expect(JSON.parse(refreshed.stdout).reports[0].results[0]).toMatchObject({
      certainty: "probable",
    });
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

  it('checks the name "check" when nothing follows it', async () => {
    const r = await cli(["check", "--only", "crates"], { [CRATES("check")]: 404 });
    expect(JSON.parse(r.stdout).reports[0].name).toBe("check");
  });

  it("accepts the check subcommand", async () => {
    const r = await cli(["check", "zz", "--only", "crates"], { [CRATES("zz")]: 404 });
    expect(JSON.parse(r.stdout).reports[0].name).toBe("zz");
  });
});

describe("channel selection", () => {
  const header = async (files: Record<string, string>, argv: string[] = []) => {
    const dir = await mkdtemp(join(tmpdir(), "nameable-cwd-"));
    for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content);
    let stdout = "";
    await run(["zz", ...argv], {
      stdout: { write: (s: string) => (stdout += s), columns: 120 },
      stderr: { write: () => undefined },
      interactive: true,
      color: false,
      cwd: dir,
      // Every request answers 200, so whatever channels the run picks complete; only the header matters.
      fetch: async () => Response.json({}),
      whois: async () => "Domain Name: zz\n",
    });
    return screen(stdout)
      .split("\n")
      .find((l) => l.startsWith("Checking"))!;
  };

  it("picks channels from the project files in the current directory", async () => {
    expect(await header({ "Cargo.toml": "[package]" })).toBe(
      'Checking "zz" on 4 channels (picked from Cargo.toml; --all for every channel)',
    );
  });

  it("checks a general set outside a project", async () => {
    expect(await header({})).toBe(
      'Checking "zz" on 7 channels (no project files here; the general set; --all for every channel)',
    );
  });

  it("checks every channel with --all, and only the named ones with --only", async () => {
    expect(await header({ "Cargo.toml": "" }, ["--all"])).toMatch(
      /^Checking "zz" on \d{2} channels$/,
    );
    expect(await header({ "Cargo.toml": "" }, ["--only", "npm"])).toBe(
      'Checking "zz" on 1 channels',
    );
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

  it("says how many names did not fit across the terminal", async () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const r = await cli(
      [...names, "--only", "crates"],
      Object.fromEntries(names.map((n) => [CRATES(n), 404])),
      { interactive: true },
      40,
    );
    const text = screen(r.stdout);
    expect(text).toMatch(/\d+ more did not fit; use --json/);
    // The redrawn grid must fit; the legend below is printed once, after the last redraw, and may wrap.
    const lines = text.split("\n");
    const grid = lines.slice(0, lines.findIndex((l) => l.startsWith("  free")) + 1);
    expect(Math.max(...grid.map((l) => l.length))).toBeLessThanOrEqual(40);
  });

  it("prints registry text without its control characters, so it cannot rewrite the screen", async () => {
    const description =
      "held\x1b[2K\r  ✓ crates.io  available\x1b]8;;https://evil.example\x07\nnext";
    const r = await cli(
      ["zz", "--only", "crates"],
      { [CRATES("zz")]: [200, { crate: { name: "zz", description } }] },
      { interactive: true },
    );
    // The only control characters left are the renderer's own cursor moves, line clears and returns.
    // oxlint-disable-next-line no-control-regex
    expect(r.stdout.replace(/\x1b\[\d*[AK]|\r/g, "")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
    expect(screen(r.stdout)).toMatch(/✗ crates\.io\s+taken\s+held \[2K/);
  });

  it("clips long names in the grid so no row is wider than the terminal", async () => {
    const long = "a".repeat(100);
    const r = await cli(
      [long, "bb", "--only", "crates"],
      { [CRATES(long)]: 404, [CRATES("bb")]: 404 },
      { interactive: true },
      80,
    );
    const lines = screen(r.stdout).split("\n");
    const grid = lines.slice(0, lines.findIndex((l) => l.startsWith("  free")) + 1);
    expect(Math.max(...grid.map((l) => displayWidth(l)))).toBeLessThanOrEqual(80);
    expect(screen(r.stdout)).toContain("…");
  });

  it("measures wide characters by the columns they take", async () => {
    const note = "名".repeat(60);
    const r = await cli(
      ["zz", "--only", "crates"],
      { [CRATES("zz")]: [200, { crate: { name: "zz", description: note } }] },
      { interactive: true },
      80,
    );
    // The output holds every redraw; the last table row for crates.io is the final one.
    const row = screen(r.stdout)
      .split("\n")
      .findLast((l) => l.includes("crates.io") && l.includes("taken"))!;
    expect(displayWidth(row)).toBeLessThanOrEqual(80);
    expect(row).toContain("名");
  });

  it("colors marks only when color is on", async () => {
    const routes = { [CRATES("zz")]: 404 };
    const plain = await cli(["zz", "--only", "crates"], routes, { interactive: true });
    const colored = await cli(["zz", "--only", "crates"], routes, {
      interactive: true,
      color: true,
    });
    // oxlint-disable-next-line no-control-regex
    const sgr = /\x1b\[\d+m/;
    expect(plain.stdout).not.toMatch(sgr);
    expect(colored.stdout).toMatch(sgr);
  });
});
