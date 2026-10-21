import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

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
  if (platform === "darwin") return join(home, "Library", "Caches", "nameable");
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "nameable", "Cache");
  }
  return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "nameable");
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
      await writeFile(path(key), gzipSync(text));
    },
  };
}

export async function clearStore(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
