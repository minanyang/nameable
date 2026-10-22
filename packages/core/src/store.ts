import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { LIST_KEYS } from "./lists.js";

/** Where downloaded name lists are kept between runs. */
export type Store = {
  read(key: string): Promise<{ text: string; savedAt: number } | undefined>;
  write(key: string, text: string): Promise<void>;
};

/** The OS cache directory: ~/Library/Caches on macOS, XDG on Linux, LOCALAPPDATA on Windows. */
export function defaultCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.NAMEABLE_CACHE_DIR) return env.NAMEABLE_CACHE_DIR;
  const path = platform === "win32" ? win32 : posix;
  // An empty or relative base is ignored, as the XDG spec requires; it would put the cache in the
  // current directory.
  const base = (value: string | undefined) => (value && path.isAbsolute(value) ? value : undefined);
  if (platform === "darwin") return path.join(home, "Library", "Caches", "nameable");
  if (platform === "win32") {
    return path.join(
      base(env.LOCALAPPDATA) ?? path.join(home, "AppData", "Local"),
      "nameable",
      "Cache",
    );
  }
  return path.join(base(env.XDG_CACHE_HOME) ?? path.join(home, ".cache"), "nameable");
}

/** Gzipped files in `dir`, one per key; a file's modification time is when it was saved. */
export function fileStore(dir: string): Store {
  const path = (key: string) => join(dir, `${key}.gz`);
  return {
    async read(key) {
      try {
        const [data, info] = await Promise.all([readFile(path(key)), stat(path(key))]);
        return { text: gunzipSync(data).toString("utf8"), savedAt: info.mtimeMs };
      } catch {
        return undefined;
      }
    },
    async write(key, text) {
      await mkdir(dir, { recursive: true });
      // Written whole and then renamed, so another run never reads a half-written file.
      const partial = `${path(key)}.${process.pid}.partial`;
      await writeFile(partial, gzipSync(text));
      await rename(partial, path(key));
    },
  };
}

/** Deletes the lists this tool saves in `dir`, and `dir` itself only when nothing else is left in it. */
export async function clearStore(dir: string): Promise<void> {
  // Interrupted writes leave `<key>.gz.<pid>.partial` files behind; they are this tool's too.
  const partials = (await readdir(dir).catch(() => [] as string[])).filter((f) =>
    LIST_KEYS.some((key) => f.startsWith(`${key}.gz.`) && f.endsWith(".partial")),
  );
  await Promise.all([
    ...LIST_KEYS.map((key) => rm(join(dir, `${key}.gz`), { force: true })),
    ...partials.map((f) => rm(join(dir, f), { force: true })),
  ]);
  await rmdir(dir).catch(() => undefined);
}
