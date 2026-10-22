import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";

const API = "https://plugins.jetbrains.com/api";

// intellij-plugin-verifier: a new plugin's name may not contain these words, ignoring case
// (PluginBeanValidator), and uses these characters, at most 64 (structure-base Validator.kt).
const RESTRICTED =
  /plugin|jetbrains|idea|pycharm|clion|appcode|datagrip|fleet|goland|phpstorm|webstorm|rider|resharper|teamcity|youtrack|rubymine|intellij/i;
const NAME_CHARS = /^[a-zA-Z0-9 .,+_\-/:()#'&[\]|]{1,64}$/;
const TEMPLATE_NAMES = new Set([
  "template",
  "demo",
  "my framework support",
  "plugin display name here",
]);

type Plugin = { xmlId?: unknown; name?: unknown; link?: unknown };

// The name is checked as a plugin name and as a plugin ID. The approval guidelines ask for "an original
// and unique name"; moderators enforce it, so an existing plugin with the name is a clash.
export const jetbrains: Channel = defineChannel({
  id: "jetbrains",
  label: "JetBrains Marketplace",
  category: "editor",
  rules: (name) => {
    if (!NAME_CHARS.test(name.trim())) {
      return "JetBrains plugin names are letters, digits, spaces and . , + _ - / : ( ) # ' & [ ] |, at most 64";
    }
    return undefined;
  },
  // Plugins published before these checks keep their names (PluginBeanValidator flags only new plugins).
  refuses: (name) => {
    const word = RESTRICTED.exec(name)?.[0];
    if (word) return `JetBrains refuses new plugin names containing "${word}"`;
    if (TEMPLATE_NAMES.has(name.trim().toLowerCase()))
      return "JetBrains refuses template plugin names";
    return undefined;
  },
  async lookup(name, ctx) {
    // Only a name that could be a plugin ID is looked up as one; the API answers 400 for `/`, `.` and `..`.
    const asId = /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name);
    const byId = asId ? await get(ctx, `${API}/plugins/intellij/${name}`) : undefined;
    if (byId?.status === 200) {
      const plugin = (await byId.json()) as Plugin | null;
      if (typeof plugin?.xmlId !== "string") {
        return {
          status: "unknown",
          note: "JetBrains Marketplace returned something other than a plugin",
        };
      }
      return {
        status: "taken",
        url: `https://plugins.jetbrains.com${typeof plugin?.link === "string" ? plugin.link : ""}`,
        note: typeof plugin?.name === "string" ? `the plugin ID of ${plugin.name}` : "a plugin ID",
      };
    }
    if (byId && byId.status !== 404) return unexpected("JetBrains Marketplace", byId);

    const query = new URLSearchParams({ search: name, max: "20" });
    const res = await get(ctx, `${API}/searchPlugins?${query}`);
    if (res.status !== 200) return unexpected("JetBrains Marketplace", res);
    const { plugins } = ((await res.json()) ?? {}) as { plugins?: Plugin[] };
    if (!Array.isArray(plugins)) {
      return { status: "unknown", note: "JetBrains Marketplace returned an unexpected list" };
    }
    const wanted = name.trim().toLowerCase();
    const hit = plugins.find((p) => typeof p?.name === "string" && p.name.toLowerCase() === wanted);
    if (hit) {
      return {
        status: "taken",
        url:
          typeof hit.link === "string"
            ? `https://plugins.jetbrains.com${hit.link}`
            : `https://plugins.jetbrains.com/search?search=${encodeURIComponent(name)}`,
        note: "a plugin with this name; plugin names must be unique",
      };
    }
    return {
      status: "available",
      certainty: "probable",
      note: "no plugin with this name or ID; unapproved and hidden plugins are not listed",
    };
  },
});
