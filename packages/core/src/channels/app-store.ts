import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";
import { appNameMatch, comparable, storefronts, storeNames, titleLength } from "./app-names.js";

type Result = { trackName?: unknown; sellerName?: unknown; trackViewUrl?: unknown };

// App Store Connect: an app name is 2 to 30 characters and can be used "for one app per localization",
// so a released app with the name holds it. Search (performance-partners.apple.com/search-api) is fuzzy
// and misses apps, and unreleased app records are invisible, so a miss never proves the name free.
export const appStore: Channel = defineChannel({
  id: "app-store",
  label: "App Store",
  category: "app",
  rules: (name) =>
    titleLength(name) < 2 || titleLength(name) > 30
      ? "App Store names are 2 to 30 characters"
      : undefined,
  async lookup(name, ctx) {
    if (!comparable(name)) {
      return {
        status: "unknown",
        note: "a name without letters or digits cannot be matched to app titles",
      };
    }
    // iOS and macOS apps are separate searches, in each storefront the name's script points to.
    const stores = storefronts(name);
    let similar: Result | undefined;
    for (const { country } of stores) {
      for (const entity of ["software", "macSoftware"]) {
        const query = new URLSearchParams({ term: name, entity, limit: "200", country });
        const res = await get(ctx, `https://itunes.apple.com/search?${query}`);
        if (res.status !== 200) return unexpected("the App Store", res);
        // Over its limit of about 20 calls a minute, the API answers in plain text.
        const text = await res.text();
        if (/rate limit/i.test(text.slice(0, 200))) {
          return {
            status: "unknown",
            note: "the App Store rate limited the search; try again in a minute",
          };
        }
        const { results } = (JSON.parse(text) ?? {}) as { results?: Result[] };
        if (!Array.isArray(results)) {
          return { status: "unknown", note: "the App Store returned an unexpected list" };
        }
        const titled = (r: Result) =>
          typeof r?.trackName === "string" && typeof r.trackViewUrl === "string";
        const same = results.find(
          (r) => titled(r) && appNameMatch(String(r.trackName), name) === "same",
        );
        if (same) {
          return {
            status: "taken",
            url: String(same.trackViewUrl),
            note:
              typeof same.sellerName === "string"
                ? `"${String(same.trackName)}" by ${same.sellerName}`
                : `"${String(same.trackName)}"`,
          };
        }
        similar ??= results.find(
          (r) => titled(r) && appNameMatch(String(r.trackName), name, r.sellerName) === "similar",
        );
      }
    }
    // A title that only adds its maker's name does not hold this one, but users will confuse them.
    const clash = similar
      ? `; "${String(similar.trackName)}"${typeof similar.sellerName === "string" ? ` by ${similar.sellerName}` : ""} is a similar title`
      : "";
    return {
      status: "available",
      certainty: "probable",
      note: `no app with this name in ${storeNames(stores)}${clash}; unreleased apps are not listed`,
    };
  },
});
