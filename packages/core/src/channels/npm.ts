import { builtinModules } from "node:module";
import { get } from "../http.js";
import { defineChannel, unexpected } from "../define.js";
import type { Channel, Context } from "../types.js";

const REGISTRY = "https://registry.npmjs.org";
const EXCLUDED = new Set(["node_modules", "favicon.ico"]);
const SCOPED = /^(?:@([^/]+?)[/])?([^/]+?)$/;

/**
 * validate-npm-package-name (lib/index.js, v7): errors make a name invalid for any package. Returns the
 * first reason, in the validator's order.
 */
function problem(name: string): string | undefined {
  // Errors.
  if (!name.length) return "npm names cannot be empty";
  if (name.startsWith(".")) return "npm names cannot start with a period";
  if (name.startsWith("-")) return "npm names cannot start with a hyphen";
  if (name.startsWith("_")) return "npm names cannot start with an underscore";
  if (name.trim() !== name) return "npm names cannot have leading or trailing spaces";
  if (EXCLUDED.has(name.toLowerCase())) return `${name} is not a valid npm name`;
  if (encodeURIComponent(name) !== name) {
    const match = SCOPED.exec(name);
    const [user, pkg] = [match?.[1], match?.[2]];
    if (match && pkg?.startsWith(".")) return "npm names cannot start with a period";
    const urlSafe = (s?: string) => s !== undefined && encodeURIComponent(s) === s;
    if (!(match && urlSafe(user) && urlSafe(pkg)))
      return "npm names may only contain URL-safe characters";
  }
  return undefined;
}

/**
 * The validator's warnings: names old packages may have (`events`, `JSONStream`) but `validForNewPackages`
 * rules out, so they apply only once nobody holds the name.
 */
function newOnly(name: string): string | undefined {
  if (builtinModules.includes(name.toLowerCase())) return "npm reserves Node.js core module names";
  if (name.length > 214) return "npm names are at most 214 characters";
  if (name.toLowerCase() !== name) return "npm names must be lowercase";
  if (/[~'!()*]/.test(name.split("/").at(-1)!)) return "npm names cannot contain ~ ' ! ( ) *";
  return undefined;
}

const squash = (s: string) => s.replace(/[-_.]/g, "");

/**
 * npm refuses an unscoped name that equals an existing package once punctuation is removed
 * (`first-one` vs `firstone`, `babelpresetenv` vs `babel-preset-env`). The registry has no lookup for
 * that, so this catches the common cases: it searches both spellings (search does not surface
 * `firstone` for `first-one`) and, for a name without punctuation, probes every single-hyphen
 * spelling (search never surfaces `lodash-es` for `lodashes`). Spellings with several separators
 * cannot all be probed, so a name that passes is only probably free.
 */
const SEARCH_LENGTH = { min: 2, max: 64 };
const MAX_PROBED_LENGTH = 40;

async function similar(ctx: Context, name: string): Promise<string | undefined> {
  const queries = [...new Set([name, squash(name)])].filter(
    (q) => q.length >= SEARCH_LENGTH.min && q.length <= SEARCH_LENGTH.max,
  );
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
  if (found || name !== squash(name) || name.length > MAX_PROBED_LENGTH) return found;

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
  return probes.find(Boolean);
}

/** Only the npm user or organization named after a scope can publish under it. */
async function scopeNote(ctx: Context, scope: string): Promise<string> {
  const res = await get(ctx, `${REGISTRY}/-/org/${encodeURIComponent(scope)}/package`).catch(
    () => undefined,
  );
  if (res?.status === 200)
    return `@${scope} is an npm organization; only its members can publish under it`;
  return `only the npm user or organization "${scope}" can publish under @${scope}`;
}

export const npm: Channel = defineChannel({
  id: "npm",
  label: "npm",
  category: "package",
  rules: problem,
  refuses: newOnly,
  async lookup(name, ctx) {
    const url = `https://www.npmjs.com/package/${name}`;
    const res = await get(ctx, `${REGISTRY}/${name.replace("/", "%2f")}`);
    if (res.status === 200) {
      const doc = (await res.json()) as {
        name?: unknown;
        versions?: Record<string, unknown>;
        description?: string;
        "dist-tags"?: { latest?: string };
        time?: { modified?: string; unpublished?: { time: string } };
      };
      // A 200 that is not a package document (a captive portal, a proxy page) proves nothing.
      if (typeof doc?.name !== "string") {
        return { status: "unknown", note: "npm returned something other than a package document" };
      }
      if (!doc.versions && doc.time?.unpublished) {
        const at = doc.time.unpublished.time;
        // npm's unpublish policy: after every version is unpublished, the name is blocked for 24 hours.
        const until = Date.parse(at) + 24 * 60 * 60 * 1000;
        // An unreadable time never reads as free: it fails below and the check reports unknown.
        if (!((ctx.now?.() ?? Date.now()) >= until)) {
          return {
            status: "unavailable",
            url,
            note: `unpublished on ${at.slice(0, 10)}; npm blocks the name until ${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC`,
          };
        }
        return {
          status: "reclaimable",
          url,
          note: `unpublished on ${at.slice(0, 10)}; anyone can publish it again`,
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

    // A missing scoped package may also be a private one, invisible without its owner's login.
    const scope = SCOPED.exec(name)?.[1];
    if (scope)
      return { status: "available", certainty: "probable", note: await scopeNote(ctx, scope) };
    try {
      const clash = await similar(ctx, name);
      if (clash) {
        return { status: "unavailable", note: `npm rejects names too similar to "${clash}"` };
      }
      return {
        status: "available",
        certainty: "probable",
        note: "npm also refuses names equal to an existing one without punctuation; not every spelling can be checked",
      };
    } catch {
      return {
        status: "available",
        certainty: "probable",
        note: "could not check npm's similar-name rule",
      };
    }
  },
});
