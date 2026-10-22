import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";

// NuGetGallery.Core/Packaging/PackageIdValidator.cs: ASCII letters, digits and _, joined by single
// . or -; NuGet's client caps IDs at 100 characters. IDs are compared ignoring case.
const VALID = /^[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*$/;
const MAX = 100;

type Registration = {
  items?: { items?: { catalogEntry?: { id?: string; description?: string } }[] }[];
};

export const nuget: Channel = defineChannel({
  id: "nuget",
  label: "NuGet",
  category: "package",
  rules: (name) => {
    if (!VALID.test(name)) return "NuGet IDs are letters, digits and _, joined by single . or -";
    if (name.length > MAX) return `NuGet IDs are at most ${MAX} characters`;
    return undefined;
  },
  async lookup(name, ctx) {
    const id = name.toLowerCase();
    const url = `https://www.nuget.org/packages/${name}`;
    // Registration lists unlisted packages too; search does not.
    const reg = await get(
      ctx,
      `https://api.nuget.org/v3/registration5-gz-semver2/${id}/index.json`,
    );
    if (reg.status === 200) {
      const body = (await reg.json()) as Registration | null;
      // Small packages inline their versions; larger ones page them, without a description here.
      const entry = body?.items?.at(-1)?.items?.at(-1)?.catalogEntry;
      return { status: "taken", url, note: entry?.description };
    }
    if (reg.status !== 404) return unexpected("NuGet", reg);

    // Packages the NuGet team deleted are gone from the API, but their IDs stay held; only the
    // gallery page says so.
    const page = await get(ctx, url);
    if (page.status === 200) {
      const deleted = (await page.text()).includes(
        "This package has been deleted from the gallery",
      );
      return deleted
        ? { status: "unavailable", url, note: "deleted by the NuGet team; the ID stays held" }
        : { status: "taken", url, note: "listed on the gallery but not yet in the API" };
    }
    if (page.status !== 404) {
      return {
        status: "available",
        certainty: "probable",
        note: `could not check for a deleted package with this ID (HTTP ${page.status})`,
      };
    }
    return {
      status: "available",
      certainty: "probable",
      note: "reserved ID prefixes and NuGet's typosquatting check are not public and can still refuse it",
    };
  },
});
