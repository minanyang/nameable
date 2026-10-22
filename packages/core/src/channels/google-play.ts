import { defineChannel, unexpected, type Finding } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";
import { appNameMatch, comparable, storefronts, storeNames, titleLength } from "./app-names.js";

type App = { id: string; title: string; developer: unknown };

// The search page embeds its results as JSON in an AF_initDataCallback call. The paths below are
// undocumented and will change; when they no longer read, the check is unknown, never free.
const DATA = /AF_initDataCallback\(\{key: 'ds:4',.*?data:(.*?), sideChannel: \{\}\}\);<\/script>/s;

/** Whether a section is the one Play shows for no results; its token decodes to "zero_results_cluster". */
const zeroResults = (section: any) =>
  typeof section?.[3]?.[0] === "string" &&
  Buffer.from(section[3][0], "base64").toString("latin1").includes("zero_results_cluster");

/** The apps a search page lists, an empty list when it says there are none, undefined when unreadable. */
function apps(html: string): App[] | undefined {
  const m = DATA.exec(html);
  if (!m) return undefined;
  let data: any;
  try {
    data = JSON.parse(m[1]!);
  } catch {
    return undefined;
  }
  const found: App[] = [];
  const sections: any[] = Array.isArray(data?.[0]?.[1]) ? data[0][1] : [];
  for (const section of sections) {
    // The top card, shown for a strong match.
    const top = section?.[23]?.[16];
    const topId = top?.[3]?.["12"]?.[0]?.[0];
    if (typeof topId === "string" && typeof top[2]?.[0]?.[0] === "string") {
      found.push({ id: topId, title: top[2][0][0], developer: top[2]?.[68]?.[0] });
    }
    for (const item of Array.isArray(section?.[22]?.[0]) ? section[22][0] : []) {
      const app = item?.[0];
      if (typeof app?.[0]?.[0] === "string" && typeof app[3] === "string") {
        found.push({ id: app[0][0], title: app[3], developer: app[14] });
      }
    }
  }
  // No apps read and no sign that there were none: the page changed shape.
  if (!found.length && !sections.some(zeroResults)) return undefined;
  return found;
}

// Play Console: a title is at most 30 characters. Titles are not unique; only package names are.
export const googlePlay: Channel = defineChannel({
  id: "google-play",
  label: "Google Play",
  category: "app",
  rules: (name) =>
    titleLength(name) < 1 || titleLength(name) > 30
      ? "Google Play titles are 1 to 30 characters"
      : undefined,
  async lookup(name, ctx): Promise<Finding> {
    if (!comparable(name)) {
      return {
        status: "unknown",
        note: "a name without letters or digits cannot be matched to app titles",
      };
    }
    // Play is not available in mainland China, so a Chinese name is searched in Taiwan.
    const stores = storefronts(name).filter((s) => s.country !== "cn");
    let similar: string | undefined;
    for (const { country, language } of stores) {
      const query = new URLSearchParams({
        q: name,
        c: "apps",
        hl: language,
        gl: country.toUpperCase(),
      });
      const res = await get(ctx, `https://play.google.com/store/search?${query}`);
      if (res.status !== 200) return unexpected("Google Play", res);
      const found = apps(await res.text());
      if (!found)
        return { status: "unknown", note: "the Google Play search page could not be read" };
      const by = (a: App) => (typeof a.developer === "string" ? ` by ${a.developer}` : "");
      const same = found.find((a) => appNameMatch(a.title, name) === "same");
      if (same) {
        return {
          status: "taken",
          url: `https://play.google.com/store/apps/details?id=${same.id}`,
          // Clipped in the table, so what matters comes first.
          note: `clash, not a block: "${same.title}"${by(same)} uses this title; Play titles are not unique`,
        };
      }
      const near = found.find((a) => appNameMatch(a.title, name, a.developer) === "similar");
      similar ??= near && `"${near.title}"${by(near)}`;
    }
    const free = `no app with this title in search results of ${storeNames(stores)}; unreleased apps are not listed`;
    if (!similar) return { status: "available", certainty: "probable", note: free };
    // As on the App Store: not this title, but one users will take for it.
    return {
      status: "available",
      certainty: "probable",
      note: `clash, not a block: ${similar} goes by this name; ${free}`,
    };
  },
});
