import { memo } from "./http.js";
import type { Context } from "./types.js";

/** Lists change slowly; a day keeps them close to the registry without downloading on every run. */
export const LIST_TTL_MS: number = 24 * 60 * 60 * 1000;

/** Every list kept in the store, so clearing the cache removes exactly these files and nothing else. */
export const LIST_KEYS = ["pypi-projects", "homebrew-names", "crates-names"] as const;
export type ListKey = (typeof LIST_KEYS)[number];

// Bump when the line format of a list changes: a copy saved by another version, or a file this tool did
// not write, must read as missing, never as a list in which nothing matches.
const FORMAT = 1;
/** The first line of a stored list, naming the list and its format. */
export const listHeader = (key: ListKey): string => `#nameable ${key} v${FORMAT}\n`;

export type List = {
  text: string;
  savedAt: number;
  /** True when the download failed and an older copy is being used. */
  stale: boolean;
};

/**
 * A registry-wide list (every PyPI project, every Homebrew alias), from the store when fresh enough,
 * downloaded otherwise. A failed download falls back to an older copy; with no copy at all it throws,
 * and the channel reports that it could not run the check.
 */
export function cachedList(
  ctx: Context,
  key: ListKey,
  download: () => Promise<string>,
): Promise<List> {
  return memo(ctx, `list:${key}`, async () => {
    const now = ctx.now?.() ?? Date.now();
    const stored = await ctx.store?.read(key);
    const saved = stored?.text.startsWith(listHeader(key))
      ? { ...stored, text: stored.text.slice(listHeader(key).length) }
      : undefined;
    // A copy dated in the future (a skewed clock, a restored file) is not trusted to be fresh.
    const age = saved ? now - saved.savedAt : -1;
    if (saved && !ctx.refresh && age >= 0 && age < LIST_TTL_MS) return { ...saved, stale: false };
    try {
      const text = await download();
      await ctx.store?.write(key, listHeader(key) + text).catch(() => undefined);
      return { text, savedAt: now, stale: false };
    } catch (err) {
      if (saved) return { ...saved, stale: true };
      throw err;
    }
  });
}

/** The values on every line of `text` whose first tab-separated field is `key`. */
export function linesFor(text: string, key: string): string[][] {
  const found: string[][] = [];
  const needle = `\n${key}\t`;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const end = text.indexOf("\n", at + 1);
    found.push(text.slice(at + needle.length, end < 0 ? undefined : end).split("\t"));
  }
  return found;
}

/** How old a stale list is, for notes. */
export const asOf = (list: List): string => new Date(list.savedAt).toISOString().slice(0, 10);
