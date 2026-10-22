import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  check,
  clearStore,
  defaultCacheDir,
  fileStore,
  LIST_TTL_MS,
  selectChannels,
  type Store,
  ultranormalizePypi,
} from "../src/index.js";
import { listHeader } from "../src/lists.js";
import { fetchFrom } from "./fake-fetch.js";

const INDEX = "https://pypi.org/simple/";
const NOW = Date.parse("2026-10-21T12:00:00Z");
// The stored list format: a header line, then one `ultranormalized\tname` line per project.
const index = (...names: string[]) =>
  `${listHeader("pypi-projects")}\n${names.map((n) => `${ultranormalizePypi(n)}\t${n}`).join("\n")}\n`;

/** A store holding one copy of the PyPI project list, saved `ageMs` before NOW. */
function storeWith(text: string, ageMs: number): Store & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    read: async (key) => (key === "pypi-projects" ? { text, savedAt: NOW - ageMs } : undefined),
    write: async (key) => void writes.push(key),
  };
}

async function pypi(
  name: string,
  store: Store | undefined,
  indexReply: () => unknown,
  refresh = false,
) {
  const fetch = fetchFrom((u) => (u === INDEX ? (indexReply() as never) : 404));
  const [r] = await check(name, selectChannels({ only: ["pypi"] }), {
    fetch,
    store,
    refresh,
    now: () => NOW,
    backoffMs: 0,
  });
  return { result: r!, downloaded: fetch.calls.includes(INDEX) };
}

const freshIndex = () => [200, { projects: [{ name: "requests" }] }];

describe("cached name lists", () => {
  it("uses a copy younger than a day without downloading", async () => {
    const { result, downloaded } = await pypi(
      "zz",
      storeWith(index("requests"), 60_000),
      freshIndex,
    );
    expect(downloaded).toBe(false);
    expect(result).toMatchObject({ status: "available", certainty: "confirmed" });
  });

  it("downloads and saves when the copy is older than a day", async () => {
    const store = storeWith(index("requests"), LIST_TTL_MS + 1);
    const { downloaded } = await pypi("zz", store, freshIndex);
    expect(downloaded).toBe(true);
    expect(store.writes).toEqual(["pypi-projects"]);
  });

  it("downloads a fresh copy anyway with refresh", async () => {
    const { downloaded } = await pypi("zz", storeWith(index("requests"), 60_000), freshIndex, true);
    expect(downloaded).toBe(true);
  });

  it("falls back to an old copy when the download fails, and says how old it is", async () => {
    const { result } = await pypi("zz", storeWith(index("requests"), 3 * LIST_TTL_MS), () => 503);
    expect(result).toMatchObject({ status: "available", certainty: "probable" });
    expect(result.note).toContain("2026-10-18");
  });

  it("still finds a similar name in an old copy", async () => {
    const { result } = await pypi("f1ask", storeWith(index("flask"), 3 * LIST_TTL_MS), () => 503);
    expect(result.status).toBe("unavailable");
  });

  it("ignores a copy without this version's header, as if there were none", async () => {
    const foreign = `\n${ultranormalizePypi("flask")}\tflask\n`;
    const { result, downloaded } = await pypi("f1ask", storeWith(foreign, 60_000), freshIndex);
    expect(downloaded).toBe(true);
    // Not "similar to flask": the unrecognized copy was not read at all.
    expect(result).toMatchObject({ status: "available", certainty: "confirmed" });
    const offline = await pypi("f1ask", storeWith(foreign, 60_000), () => 503);
    expect(offline.result).toMatchObject({ status: "available", certainty: "probable" });
    expect(offline.result.note).toContain("could not download");
  });

  it("downloads again when the copy is dated in the future", async () => {
    const { downloaded } = await pypi("zz", storeWith(index("requests"), -60_000), freshIndex);
    expect(downloaded).toBe(true);
  });

  // File times have sub-millisecond precision; a copy written a moment ago can read just after `now`.
  it("uses a copy written a fraction of a millisecond 'after' now", async () => {
    const { downloaded } = await pypi("zz", storeWith(index("requests"), -0.5), freshIndex);
    expect(downloaded).toBe(false);
  });

  it("is only probable with no copy and a failed download", async () => {
    const { result } = await pypi("zz", undefined, () => 503);
    expect(result).toMatchObject({ status: "available", certainty: "probable" });
    expect(result.note).toContain("could not download");
  });
});

describe("fileStore", () => {
  it("round-trips text and reports when it was saved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nameable-"));
    const store = fileStore(join(dir, "nested"));
    expect(await store.read("missing")).toBeUndefined();
    await store.write("pypi-projects", "\nabc\tAbc\n");
    const saved = await store.read("pypi-projects");
    expect(saved?.text).toBe("\nabc\tAbc\n");
    expect(Date.now() - saved!.savedAt).toBeLessThan(60_000);
    // Written to a temporary file and renamed, so nothing partial is left behind.
    expect(await readdir(join(dir, "nested"))).toEqual(["pypi-projects.gz"]);
    await clearStore(join(dir, "nested"));
    expect(await store.read("pypi-projects")).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it("reads a file that is not gzip as missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nameable-"));
    await writeFile(join(dir, "pypi-projects.gz"), "flask");
    expect(await fileStore(dir).read("pypi-projects")).toBeUndefined();
  });

  it("reports a file's modification time as when it was saved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nameable-"));
    await fileStore(dir).write("pypi-projects", "x");
    const future = new Date(Date.now() + 86_400_000);
    await utimes(join(dir, "pypi-projects.gz"), future, future);
    // Filesystems store mtimes with their own precision (ext4 reads back 1792706662703.999 for …704).
    expect((await fileStore(dir).read("pypi-projects"))?.savedAt).toBeCloseTo(future.getTime(), -1);
  });
});

describe("clearStore", () => {
  it("deletes only the lists it saves, and keeps a directory that holds anything else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nameable-"));
    await fileStore(dir).write("pypi-projects", "x");
    await fileStore(dir).write("homebrew-names", "x");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "notes.txt"), "keep");
    await writeFile(join(dir, "other.gz"), "keep");
    // Left by an interrupted write.
    await writeFile(join(dir, "pypi-projects.gz.4242.partial"), "x");
    await writeFile(join(dir, "other.gz.4242.partial"), "keep");
    await clearStore(dir);
    expect((await readdir(dir)).sort()).toEqual(["other.gz", "other.gz.4242.partial", "sub"]);
  });

  it("does nothing to a directory that does not exist", async () => {
    await expect(clearStore(join(tmpdir(), "nameable-missing-dir"))).resolves.toBeUndefined();
  });
});

describe("defaultCacheDir", () => {
  it.each([
    [{}, "darwin", "/Users/u/Library/Caches/nameable"],
    [{}, "linux", "/Users/u/.cache/nameable"],
    [{ XDG_CACHE_HOME: "/x" }, "linux", "/x/nameable"],
    [{ LOCALAPPDATA: "C:/L" }, "win32", "C:/L/nameable/Cache"],
    [{ NAMEABLE_CACHE_DIR: "/custom" }, "darwin", "/custom"],
    // An empty or relative base would put the cache, and --clear-cache, in the current directory.
    [{ XDG_CACHE_HOME: "" }, "linux", "/Users/u/.cache/nameable"],
    [{ XDG_CACHE_HOME: "relative" }, "linux", "/Users/u/.cache/nameable"],
    [{ LOCALAPPDATA: "" }, "win32", "/Users/u/AppData/Local/nameable/Cache"],
  ] as const)("%j on %s → %s", (env, platform, expected) => {
    expect(defaultCacheDir(env, platform, "/Users/u").replaceAll("\\", "/")).toBe(expected);
  });
});
