import { defineChannel } from "../define.js";
import { get } from "../http.js";
import { asOf, cachedList, linesFor } from "../lists.js";
import type { Channel, Context } from "../types.js";

/**
 * Every extension in the Gemini CLI gallery, one `name\trepository` line each, from the gallery's own
 * data file (about 2 MB). The gallery is crawled from GitHub repositories tagged `gemini-cli-extension`.
 */
async function extensionList(ctx: Context): Promise<string> {
  const res = await get(ctx, "https://geminicli.com/extensions.json", { timeoutMs: 60_000 });
  if (!res.ok) throw new Error(`the Gemini CLI gallery returned HTTP ${res.status}`);
  const entries = (await res.json()) as unknown;
  // A file in another shape must fail the check, not read as an empty gallery.
  if (
    !Array.isArray(entries) ||
    entries.length < 50 ||
    !entries.every((e) => typeof e?.extensionName === "string" && typeof e?.url === "string")
  ) {
    throw new Error("the Gemini CLI gallery is not in the expected shape");
  }
  const lines = (entries as { extensionName: string; url: string }[])
    .filter((e) => e.extensionName.trim())
    .map((e) => `${e.extensionName.trim().toLowerCase()}\t${e.url}`);
  return `\n${lines.join("\n")}\n`;
}

// Extension names are the `name` in gemini-extension.json: Gemini CLI loads only letters, digits and dashes
// (validateName in packages/cli/src/config/extension-manager.ts). Nothing makes them unique: any tagged
// repository is listed.
export const gemini: Channel = defineChannel({
  id: "gemini",
  label: "Gemini extensions",
  category: "agent",
  // Gallery entries with other names exist (agent_manager_jp, Call Me), so they are looked up; Gemini CLI loads
  // only the valid ones, so that rule applies once nobody holds the name.
  rules: (name) =>
    // The list is tab- and line-separated; anything else, spaces and slashes included, is looked up.
    name.trim() && !/[\t\r\n]/.test(name)
      ? undefined
      : "Gemini CLI extension names cannot be empty",
  refuses: (name) =>
    /^[a-zA-Z0-9-]+$/.test(name)
      ? undefined
      : "Gemini CLI extension names are letters, digits and dashes",
  async lookup(name, ctx) {
    const list = await cachedList(ctx, "gemini-extensions", () => extensionList(ctx));
    const repos = linesFor(list.text, name.toLowerCase()).map(([url]) => url!);
    if (repos.length) {
      return {
        status: "taken",
        url: repos[0],
        note:
          repos.length === 1
            ? "clash, not a block: a gallery extension uses this name; two installed extensions cannot share one"
            : `clash, not a block: ${repos.length} gallery extensions use this name`,
        meta: { repositories: repos },
      };
    }
    return {
      status: "available",
      certainty: "probable",
      note: list.stale
        ? `could not refresh the Gemini CLI gallery; not in the copy from ${asOf(list)}`
        : "not in the Gemini CLI gallery; it lists only tagged GitHub repositories",
    };
  },
});
