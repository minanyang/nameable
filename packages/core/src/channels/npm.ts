import { builtinModules } from "node:module";
import { get } from "../http.js";
import type { Channel, CheckResult, Context } from "../types.js";

const REGISTRY = "https://registry.npmjs.org";
const RESERVED = new Set(["node_modules", "favicon.ico"]);

function problem(name: string): string | undefined {
  const scoped = /^@([^/]+)\/([^/]+)$/.exec(name);
  const bare = scoped ? scoped[2]! : name;
  if (name.length > 214) return "npm names are at most 214 characters";
  if (name !== name.toLowerCase()) return "npm names must be lowercase";
  if (/^[._]/.test(bare)) return "npm names cannot start with . or _";
  if (encodeURIComponent(bare) !== bare || (scoped && encodeURIComponent(scoped[1]!) !== scoped[1])) {
    return "npm names may only contain URL-safe characters";
  }
  if (!scoped && (RESERVED.has(name) || builtinModules.includes(name))) return "npm reserves this name";
  return undefined;
}

const squash = (s: string) => s.replace(/[-_.]/g, "");

/**
 * npm refuses an unscoped name that equals an existing package once punctuation is removed
 * (`first-one` vs `firstone`). The registry has no lookup for that, so search and compare.
 * Searching `first-one` does not surface `firstone`, so both spellings are searched. Search never surfaces
 * `lodash-es` for `lodashes`, so a name without punctuation also probes every single-hyphen spelling directly;
 * spellings with `_`, `.` or several separators are not probed.
 */
async function similar(ctx: Context, name: string): Promise<string | undefined> {
  const queries = [...new Set([name, squash(name)])];
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
  if (found || name !== squash(name)) return found;

  const hyphenated = Array.from({ length: name.length - 1 }, (_, i) => `${name.slice(0, i + 1)}-${name.slice(i + 1)}`);
  const probes = await Promise.all(
    hyphenated.map(async (variant) => {
      // The abbreviated document is far smaller than the full one for popular packages.
      const res = await get(ctx, `${REGISTRY}/${variant}`, { headers: { accept: "application/vnd.npm.install-v1+json" } });
      if (res.status !== 200 && res.status !== 404) throw new Error(`registry HTTP ${res.status}`);
      return res.status === 200 ? variant : undefined;
    }),
  );
  return probes.find(Boolean);
}

export const npm: Channel = {
  id: "npm",
  label: "npm",
  category: "package",
  async check(name, ctx): Promise<CheckResult> {
    const base = { channel: this.id, label: this.label, url: `https://www.npmjs.com/package/${name}` };
    const invalid = problem(name);
    if (invalid) return { ...base, status: "unavailable", note: invalid, url: undefined };

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
          ...base,
          status: "reclaimable",
          note: `unpublished on ${doc.time.unpublished.time.slice(0, 10)}; anyone can publish it again`,
        };
      }
      return {
        ...base,
        status: "taken",
        note: doc.description,
        meta: { latest: doc["dist-tags"]?.latest, modified: doc.time?.modified },
      };
    }
    if (res.status !== 404) return { ...base, status: "unknown", note: `registry returned HTTP ${res.status}` };

    if (name.startsWith("@")) return { ...base, status: "available", certainty: "confirmed" };
    try {
      const clash = await similar(ctx, name);
      if (clash) {
        return { ...base, status: "unavailable", note: `npm rejects names too similar to "${clash}"`, url: undefined };
      }
      return { ...base, status: "available", certainty: "confirmed" };
    } catch {
      return { ...base, status: "available", certainty: "probable", note: "could not check npm's similar-name rule" };
    }
  },
};
