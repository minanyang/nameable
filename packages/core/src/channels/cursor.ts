import { defineChannel } from "../define.js";
import { get } from "../http.js";
import { asOf, cachedList, linesFor } from "../lists.js";
import type { Channel, Context } from "../types.js";

// cursor.com/docs/reference/plugins: a plugin name is lowercase kebab-case, letters, digits, hyphens and
// periods, starting and ending with a letter or digit. Names are global in the marketplace.
const VALID = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/**
 * Every plugin in Cursor's marketplace, one name per line. There is no API: the marketplace page,
 * asked for its React Server Components payload, lists each plugin's `fullRef` (about 2 MB).
 */
async function pluginList(ctx: Context): Promise<string> {
  const res = await get(ctx, "https://cursor.com/marketplace", {
    headers: { rsc: "1" },
    timeoutMs: 60_000,
  });
  if (!res.ok) throw new Error(`Cursor's marketplace returned HTTP ${res.status}`);
  const names = new Set([...(await res.text()).matchAll(/"fullRef":"([^"]+)"/g)].map((m) => m[1]!));
  // A page in another shape must fail the check, not read as an empty marketplace.
  if (names.size < 50) throw new Error("Cursor's marketplace is not in the expected shape");
  return `\n${[...names].map((n) => `${n}\t`).join("\n")}\n`;
}

export const cursor: Channel = defineChannel({
  id: "cursor",
  label: "Cursor plugins",
  category: "agent",
  rules: (name) =>
    VALID.test(name)
      ? undefined
      : "Cursor plugin names are lowercase letters, digits, - and ., starting and ending with a letter or digit",
  async lookup(name, ctx) {
    const list = await cachedList(ctx, "cursor-plugins", () => pluginList(ctx));
    if (linesFor(list.text, name).length) {
      return { status: "taken", url: `https://cursor.com/marketplace/${name}` };
    }
    return {
      status: "available",
      certainty: "probable",
      note: list.stale
        ? `not among Cursor's listed plugins from ${asOf(list)}`
        : "not among Cursor's listed plugins; plugins in review or in team marketplaces are not visible",
    };
  },
});
