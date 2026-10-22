import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";
import { sameAppName, titleLength } from "./app-names.js";

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
    // iOS and macOS apps are separate searches; one storefront (US) keeps within the ~20 calls a minute.
    for (const entity of ["software", "macSoftware"]) {
      const query = new URLSearchParams({ term: name, entity, limit: "200", country: "us" });
      const res = await get(ctx, `https://itunes.apple.com/search?${query}`);
      if (res.status !== 200) return unexpected("the App Store", res);
      const { results } = ((await res.json()) ?? {}) as { results?: Result[] };
      if (!Array.isArray(results)) {
        return { status: "unknown", note: "the App Store returned an unexpected list" };
      }
      const hit = results.find(
        (r) => typeof r?.trackName === "string" && sameAppName(r.trackName, name),
      );
      if (hit && typeof hit.trackViewUrl === "string") {
        return {
          status: "taken",
          url: hit.trackViewUrl,
          note: `${String(hit.trackName)} by ${String(hit.sellerName)}`,
        };
      }
    }
    return {
      status: "available",
      certainty: "probable",
      note: "no US app with this name; unreleased apps and other storefronts are not searched",
    };
  },
});
