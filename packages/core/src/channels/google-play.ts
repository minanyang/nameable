import { defineChannel, unexpected, type Finding } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";
import { comparable, sameAppName, titleLength } from "./app-names.js";

type App = { id: string; title: string; developer: unknown };

// The search page embeds its results as JSON in an AF_initDataCallback call. The paths below are
// undocumented and will change; when they no longer read, the check is unknown, never free.
const DATA = /AF_initDataCallback\(\{key: 'ds:4',.*?data:(.*?), sideChannel: \{\}\}\);<\/script>/s;

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
  for (const section of Array.isArray(data?.[0]?.[1]) ? data[0][1] : []) {
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
    const query = new URLSearchParams({ q: name, c: "apps", hl: "en", gl: "US" });
    const res = await get(ctx, `https://play.google.com/store/search?${query}`);
    if (res.status !== 200) return unexpected("Google Play", res);
    const html = await res.text();
    const found = apps(html);
    if (!found || (!found.length && !html.includes("No results for"))) {
      return { status: "unknown", note: "the Google Play search page could not be read" };
    }
    const hit = found.find((a) => sameAppName(a.title, name));
    if (hit) {
      return {
        status: "taken",
        url: `https://play.google.com/store/apps/details?id=${hit.id}`,
        note: `"${hit.title}"${typeof hit.developer === "string" ? ` by ${hit.developer}` : ""} uses this title; Play titles are not unique, so this is a clash, not a block`,
      };
    }
    return {
      status: "available",
      certainty: "probable",
      note: "no app with this title in US search results; unreleased apps are not listed",
    };
  },
});
