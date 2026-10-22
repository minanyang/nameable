import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import { levenshtein } from "../levenshtein.js";
import type { Channel } from "../types.js";

const API = "https://open-vsx.org/api";

// openvsx ExtensionValidator: namespaces are word characters and - + $ ~, at most 255, and not "-".
const VALID = /^[\w\-+$~]{1,255}$/;

// open-vsx.org production config: a new namespace is refused when it is within a Levenshtein distance of
// 20% of the longer name from an existing one, ignoring case (SimilarityCheckService).
const SIMILARITY = 0.2;
const similar = (a: string, b: string) =>
  a !== b && levenshtein(a, b) <= SIMILARITY * Math.max(a.length, b.length);

// The name is checked as a namespace: extensions are `namespace.name`, and a namespace has an owner.
export const openVsx: Channel = defineChannel({
  id: "open-vsx",
  label: "Open VSX",
  category: "editor",
  rules: (name) =>
    VALID.test(name) && name !== "-"
      ? undefined
      : "Open VSX namespaces are letters, digits and _ - + $ ~",
  async lookup(name, ctx) {
    const url = `https://open-vsx.org/namespace/${name}`;
    const res = await get(ctx, `${API}/${name}`);
    // `/api/version` is the server's own version route, so a 200 counts only when it names the namespace.
    if (res.status === 200) {
      const body = (await res.json()) as { name?: unknown } | null;
      if (typeof body?.name === "string" && body.name.toLowerCase() === name.toLowerCase()) {
        return { status: "taken", url, note: "a namespace" };
      }
    } else if (res.status !== 404) {
      return unexpected("Open VSX", res);
    }

    // Namespace creation compares against every namespace; search shows those with matching extensions.
    const found = await get(
      ctx,
      `${API}/-/search?${new URLSearchParams({ query: name, size: "100" })}`,
    );
    const { extensions } = (found.status === 200 ? await found.json() : null) ?? {};
    if (!Array.isArray(extensions)) {
      return { status: "unknown", note: "could not search Open VSX for similar namespaces" };
    }
    const wanted = name.toLowerCase();
    const near = extensions
      .map((e: { namespace?: unknown }) => e?.namespace)
      .find((n): n is string => typeof n === "string" && similar(n.toLowerCase(), wanted));
    if (near) {
      return {
        status: "unavailable",
        url: `https://open-vsx.org/namespace/${near}`,
        note: `Open VSX refuses namespaces too similar to "${near}"`,
      };
    }
    return {
      status: "available",
      certainty: "probable",
      note: "no namespace; similar namespaces without matching extensions cannot be searched",
    };
  },
});
