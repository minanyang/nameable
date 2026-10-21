import { mkdtemp, readdir } from "node:fs/promises";
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
import { fetchFrom } from "./fake-fetch.js";

const INDEX = "https://pypi.org/simple/";
const NOW = Date.parse("2026-10-21T12:00:00Z");
// The stored list format: one `ultranormalized\tname` line per project.
const index = (...names: string[]) =>
  `\n${names.map((n) => `${ultranormalizePypi(n)}\t${n}`).join("\n")}\n`;

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
    await store.write("list", "\nabc\tAbc\n");
    const saved = await store.read("list");
    expect(saved?.text).toBe("\nabc\tAbc\n");
    expect(Date.now() - saved!.savedAt).toBeLessThan(60_000);
    expect(await readdir(join(dir, "nested"))).toEqual(["list.gz"]);
    await clearStore(join(dir, "nested"));
    expect(await store.read("list")).toBeUndefined();
  });
});

describe("defaultCacheDir", () => {
  it.each([
    [{}, "darwin", "/Users/u/Library/Caches/nameable"],
    [{}, "linux", "/Users/u/.cache/nameable"],
    [{ XDG_CACHE_HOME: "/x" }, "linux", "/x/nameable"],
    [{ LOCALAPPDATA: "C:/L" }, "win32", "C:/L/nameable/Cache"],
    [{ NAMEABLE_CACHE_DIR: "/custom" }, "darwin", "/custom"],
  ] as const)("%j on %s → %s", (env, platform, expected) => {
    expect(defaultCacheDir(env, platform, "/Users/u").replaceAll("\\", "/")).toBe(expected);
  });
});
