import { defineChannel } from "../define.js";
import { get, memo } from "../http.js";
import type { Channel, Context } from "../types.js";

// The marketplace Claude Code ships with, `claude-plugins-official`.
const MARKETPLACE =
  "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json";
const MARKETPLACE_PAGE =
  "https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json";

// `claude plugin validate`: a marketplace can list a plugin only under a name of ASCII letters, digits,
// `.`, `_` and `-` (anything else "cannot install"); uppercase, `.` and `_` only draw a kebab-case warning.
const INSTALLABLE = /^[A-Za-z0-9._-]+$/;

// `claude plugin validate` refuses names that pass as Anthropic's own: words are runs of letters and
// digits, compared lowercase and joined without separators. Checked against Claude Code's validator.
const words = (name: string) =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const VENDOR = ["claude", "anthropic", "anthropics"];
const OFFICIAL = /official[^a-z0-9]*(?:anthropic|claude)|(?:anthropic|claude)[^a-z0-9]*official/;
function reserved(name: string): boolean {
  const w = words(name);
  const joined = w.join("");
  if (["claude", "anthropic", "anthropics", "claudecode", "claudemods"].includes(joined))
    return true;
  // Leading words that spell a vendor or "ccplugin", with more after them: claude-x, cc-plugin-x.
  for (let i = 1; i < w.length; i++) {
    if ([...VENDOR, "ccplugin"].includes(w.slice(0, i).join(""))) return true;
  }
  return OFFICIAL.test(name.toLowerCase()) || OFFICIAL.test(joined);
}

type Plugin = { description?: string; homepage?: string };

/** Every plugin in the official marketplace, by lowercased name. */
function pluginList(ctx: Context): Promise<Map<string, Plugin>> {
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
      (plugins as (Plugin & { name: string })[]).map((p) => [p.name.toLowerCase(), p]),
    );
  });
}

export const claudePlugins: Channel = defineChannel({
  id: "claude-plugins",
  label: "Claude plugins",
  category: "agent",
  rules: (name) =>
    INSTALLABLE.test(name)
      ? undefined
      : "Claude Code installs plugins from a marketplace only under names of letters, digits, . _ and -",
  // Anthropic's own plugins carry these names.
  refuses: (name) =>
    reserved(name)
      ? "Claude Code reserves names that pass as one of Anthropic's own plugins"
      : undefined,
  async lookup(name, ctx) {
    const plugins = await pluginList(ctx);
    const plugin = plugins.get(name.toLowerCase());
    if (plugin) {
      // claude.com lists plugins some time after they join the marketplace, so its page can 404.
      const homepage = typeof plugin.homepage === "string" ? plugin.homepage : undefined;
      return {
        status: "taken",
        url: homepage ?? MARKETPLACE_PAGE,
        note: typeof plugin.description === "string" ? plugin.description : undefined,
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
