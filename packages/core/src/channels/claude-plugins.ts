import { defineChannel } from "../define.js";
import { get, memo } from "../http.js";
import type { Channel, Context } from "../types.js";

// The marketplace Claude Code ships with, `claude-plugins-official`.
const MARKETPLACE =
  "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json";

// Plugin `name` (code.claude.com/docs/en/plugins-reference): non-empty, with no spaces, `@`, `:`, path
// separators, control characters or bidirectional-formatting characters.
const FORBIDDEN = /[\s@:/\\\p{Cc}\p{Bidi_Control}]/u;

// `claude plugin validate` refuses names that pass as Anthropic's own, ignoring case and treating any
// run of separators as one; a whole-word `claude` or `anthropic` elsewhere only draws a warning.
const words = (name: string) =>
  name
    .toLowerCase()
    .split(/[-_.]+/)
    .filter(Boolean);
const VENDOR = ["claude", "anthropic", "anthropics"];
function reserved(name: string): boolean {
  const w = words(name);
  const joined = w.join("-");
  if (["claude", "anthropic", "anthropics", "claude-code", "claude-mods"].includes(joined))
    return true;
  if (["claude-", "anthropic-", "anthropics-", "cc-plugin-"].some((p) => joined.startsWith(p))) {
    return true;
  }
  return w.some(
    (word, i) =>
      word === "official" && [w[i - 1], w[i + 1]].some((n) => n === "claude" || n === "anthropic"),
  );
}

/** Every plugin name in the official marketplace, lowercased, with its description. */
function pluginList(ctx: Context): Promise<Map<string, string>> {
  return memo(ctx, "claude-plugins", async () => {
    const res = await get(ctx, MARKETPLACE);
    if (!res.ok) throw new Error(`the official marketplace returned HTTP ${res.status}`);
    const { plugins } = ((await res.json()) ?? {}) as { plugins?: unknown };
    // An unexpected shape must fail the check, not read as an empty marketplace.
    if (
      !Array.isArray(plugins) ||
      !plugins.length ||
      !plugins.every((p) => typeof p?.name === "string")
    ) {
      throw new Error("the official marketplace is not in the expected shape");
    }
    return new Map(
      (plugins as { name: string; description?: string }[]).map((p) => [
        p.name.toLowerCase(),
        p.description ?? "",
      ]),
    );
  });
}

export const claudePlugins: Channel = defineChannel({
  id: "claude-plugins",
  label: "Claude plugins",
  category: "agent",
  rules: (name) => {
    if (!name) return "Claude Code plugin names cannot be empty";
    if (FORBIDDEN.test(name)) {
      return "Claude Code plugin names cannot contain spaces, @, :, slashes, control or bidirectional characters";
    }
    if (reserved(name))
      return "Claude Code reserves names that pass as one of Anthropic's own plugins";
    return undefined;
  },
  async lookup(name, ctx) {
    const plugins = await pluginList(ctx);
    const description = plugins.get(name.toLowerCase());
    if (description !== undefined) {
      return {
        status: "taken",
        url: `https://claude.com/plugins/${name.toLowerCase()}`,
        note: description,
      };
    }
    return {
      status: "available",
      certainty: "confirmed",
      note: words(name).some((w) => VENDOR.includes(w))
        ? "not in the official marketplace; Claude Code warns that the name reads as one of Anthropic's own"
        : "not in the official marketplace",
    };
  },
});
