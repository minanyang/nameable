import { builtinModules } from "node:module";
import { get } from "../http.js";
import { defineChannel, unexpected } from "../define.js";
import type { Channel, Context } from "../types.js";

const REGISTRY = "https://registry.npmjs.org";
const RESERVED = new Set(["node_modules", "favicon.ico"]);

// https://github.com/npm/validate-npm-package-name (rules for new packages).
function problem(name: string): string | undefined {
  const scoped = /^@([^/]+)\/([^/]+)$/.exec(name);
  const bare = scoped ? scoped[2]! : name;
  if (!bare) return "npm names cannot be empty";
  if (name.length > 214) return "npm names are at most 214 characters";
  if (name !== name.toLowerCase()) return "npm names must be lowercase";
  if (/^[._]/.test(bare)) return "npm names cannot start with . or _";
  if (
    encodeURIComponent(bare) !== bare ||
    (scoped && encodeURIComponent(scoped[1]!) !== scoped[1])
  ) {
    return "npm names may only contain URL-safe characters";
  }
  if (!scoped && (RESERVED.has(name) || builtinModules.includes(name)))
    return "npm reserves this name";
  return undefined;
}

const squash = (s: string) => s.replace(/[-_.]/g, "");

/**
 * npm refuses an unscoped name that equals an existing package once punctuation is removed
 * (`first-one` vs `firstone`). The registry has no lookup for that, so search and compare.
 * Searching `first-one` does not surface `firstone`, so both spellings are searched. Search never surfaces
 * `lodash-es` for `lodashes`, so a name without punctuation also probes every single-hyphen spelling directly;
 * spellings with `_`, `.` or several separators are not probed.
 *
 * `complete` is false when part of the check had to be skipped: npm search only takes 2–64 characters,
 * and probing every hyphen position of a very long name would flood the registry.
 */
const SEARCH_LENGTH = { min: 2, max: 64 };
const MAX_PROBED_LENGTH = 40;

async function similar(ctx: Context, name: string): Promise<{ clash?: string; complete: boolean }> {
  const queries = [...new Set([name, squash(name)])].filter(
    (q) => q.length >= SEARCH_LENGTH.min && q.length <= SEARCH_LENGTH.max,
  );
  let complete = queries.length > 0;
  const pages = await Promise.all(
    queries.map(async (q) => {
      const res = await get(ctx, `${REGISTRY}/-/v1/search?text=${encodeURIComponent(q)}&size=50`);
      if (!res.ok) throw new Error(`search HTTP ${res.status}`);
      return ((await res.json()) as { objects: { package: { name: string } }[] }).objects;
    }),
  );
  const found = pages
    .flat()
    .map((o) => o.package.name)
    .find((n) => !n.startsWith("@") && n !== name && squash(n) === squash(name));
  if (found) return { clash: found, complete: true };
  if (name !== squash(name)) return { complete };
  if (name.length > MAX_PROBED_LENGTH) return { complete: false };

  const hyphenated = Array.from(
    { length: name.length - 1 },
    (_, i) => `${name.slice(0, i + 1)}-${name.slice(i + 1)}`,
  );
  const probes = await Promise.all(
    hyphenated.map(async (variant) => {
      // The abbreviated document is far smaller than the full one for popular packages.
      const res = await get(ctx, `${REGISTRY}/${variant}`, {
        headers: { accept: "application/vnd.npm.install-v1+json" },
      });
      if (res.status !== 200 && res.status !== 404) throw new Error(`registry HTTP ${res.status}`);
      return res.status === 200 ? variant : undefined;
    }),
  );
  const clash = probes.find(Boolean);
  // A one-letter name cannot be searched, but it has no hyphen spellings either, so nothing is missing.
  if (name.length < SEARCH_LENGTH.min) complete = true;
  return { clash, complete };
}

export const npm: Channel = defineChannel({
  id: "npm",
  label: "npm",
  category: "package",
  rules: problem,
  async lookup(name, ctx) {
    const url = `https://www.npmjs.com/package/${name}`;
    const res = await get(ctx, `${REGISTRY}/${name.replace("/", "%2f")}`);
    if (res.status === 200) {
      const doc = (await res.json()) as {
        versions?: Record<string, unknown>;
        description?: string;
        "dist-tags"?: { latest?: string };
        time?: { modified?: string; unpublished?: { time: string } };
      };
      if (!doc.versions && doc.time?.unpublished) {
        return {
          status: "reclaimable",
          url,
          note: `unpublished on ${doc.time.unpublished.time.slice(0, 10)}; anyone can publish it again`,
        };
      }
      return {
        status: "taken",
        url,
        note: doc.description,
        meta: { latest: doc["dist-tags"]?.latest, modified: doc.time?.modified },
      };
    }
    if (res.status !== 404) return unexpected("npm registry", res);

    if (name.startsWith("@")) return { status: "available", certainty: "confirmed" };
    try {
      const { clash, complete } = await similar(ctx, name);
      if (clash)
        return { status: "unavailable", note: `npm rejects names too similar to "${clash}"` };
      if (!complete) {
        return {
          status: "available",
          certainty: "probable",
          note: "too long to fully check npm's similar-name rule",
        };
      }
      return { status: "available", certainty: "confirmed" };
    } catch {
      // The exact name is free; only the similar-name check failed, so this is not proof.
      return {
        status: "available",
        certainty: "probable",
        note: "could not check npm's similar-name rule",
      };
    }
  },
});
