import { defineChannel, unexpected, type Finding } from "../define.js";
import { get } from "../http.js";
import { asOf, cachedList, linesFor } from "../lists.js";
import type { Channel, Context } from "../types.js";

const SITE = "https://rubygems.org";

// lib/name_format_validator.rb and lib/patterns.rb (rubygems.org): letters, digits, . - _, at least one
// letter, no . - _ at either end, no common file extension; MAX_FIELD_LENGTH is 255.
const VALID = /^[A-Za-z0-9._-]{1,255}$/;
const EDGE = /^[._-]|[._-]$/;
const EXTENSION = /\.(?:gem|json|html|gemspec)$/i;

/** GemTypo: names are compared uppercased with `-` and `_` dropped (`.` is kept). */
const typoKey = (name: string) => name.toUpperCase().replace(/[_-]/g, "");

// GemTypo: an existing gem blocks names with its key only while it has 10,000 downloads or a release in
// the last five years.
const DOWNLOADS = 10_000;
const FIVE_YEARS_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

/** Every gem with an indexed version, one `key\tname` line each, from /names (about 3 MB). */
async function nameList(ctx: Context): Promise<string> {
  const res = await get(ctx, `${SITE}/names`, { timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`RubyGems /names returned HTTP ${res.status}`);
  const [head, ...names] = (await res.text()).split("\n").filter(Boolean);
  // A list in an unexpected shape must fail the check, not read as "no similar gems".
  if (head !== "---" || names.length < 1000)
    throw new Error("RubyGems /names is not in the expected shape");
  return `\n${names.map((n) => `${typoKey(n)}\t${n}`).join("\n")}\n`;
}

/** The API serves `info` HTML-escaped ("Gender &amp; Ethnicity"). */
const unescape = (text: string) =>
  text.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (e) =>
    e === "&amp;" ? "&" : e === "&lt;" ? "<" : e === "&gt;" ? ">" : e === "&quot;" ? '"' : "'",
  );

type Gem = { name: string; info?: string; downloads?: number; version_created_at?: string };

const fetchGem = (ctx: Context, name: string) => get(ctx, `${SITE}/api/v1/gems/${name}.json`);

/** What the gem page says about a name the API does not list: reserved, held after a yank, or free. */
async function gemPage(ctx: Context, name: string, asked: string): Promise<Finding | undefined> {
  const url = `${SITE}/gems/${name}`;
  const res = await get(ctx, url);
  if (res.status === 404) return undefined;
  if (res.status !== 200) return unexpected("RubyGems", res);
  // Wording from config/locales/en.yml.
  const html = await res.text();
  if (html.includes("reserved by rubygems.org")) {
    return { status: "unavailable", url, note: "RubyGems.org reserves this name" };
  }
  const held = /reserved this gem name for (\d+) more days?/.exec(html);
  if (held) {
    return {
      status: "unavailable",
      url,
      note: `yanked by its owner; RubyGems.org holds the name for ${held[1]} more days`,
    };
  }
  if (html.includes("not currently hosted on RubyGems.org")) {
    return { status: "reclaimable", url, note: "every version was yanked; anyone can push it" };
  }
  // A hosted gem's page: expected for another spelling of the name, not for the one the API denied.
  if (name !== asked) return { status: "taken", url, note: `held as "${name}"` };
  return { status: "unknown", note: "the RubyGems page for this name could not be read" };
}

// The checks Pusher and Rubygem run before creating a gem (app/models/rubygem.rb, gem_typo.rb).
export const rubygems: Channel = defineChannel({
  id: "rubygems",
  label: "RubyGems",
  category: "package",
  rules: (name) => {
    if (!VALID.test(name)) return "gem names are letters, digits, . - and _ (max 255)";
    return undefined;
  },
  // Gems pushed before these rules (`_amon`, `cat_`) keep their names.
  refuses: (name) => {
    if (!/[a-zA-Z]/.test(name)) return "gem names must include a letter";
    if (EDGE.test(name)) return "gem names cannot begin or end with . - or _";
    if (EXTENSION.test(name)) return "gem names cannot end with a file extension such as .gem";
    return undefined;
  },
  async lookup(name, ctx) {
    const res = await fetchGem(ctx, name);
    if (res.status === 200) {
      const gem = (await res.json()) as Gem | null;
      if (typeof gem?.name !== "string")
        return { status: "unknown", note: "RubyGems returned an unexpected gem" };
      return {
        status: "taken",
        url: `${SITE}/gems/${gem.name}`,
        note: typeof gem.info === "string" ? unescape(gem.info) : undefined,
      };
    }
    if (res.status !== 404) return unexpected("RubyGems", res);

    // The API answers 404 for yanked and reserved names too; the gem page tells them apart. Pushes
    // match names ignoring case, but the page does not, so the lowercase spelling is asked as well.
    for (const spelling of new Set([name, name.toLowerCase()])) {
      const page = await gemPage(ctx, spelling, name);
      if (page) return page;
    }

    let list;
    try {
      list = await cachedList(ctx, "rubygems-names", () => nameList(ctx));
    } catch {
      return {
        status: "available",
        certainty: "probable",
        note: "could not download RubyGems' name list to check similar names",
      };
    }
    const matches = linesFor(list.text, typoKey(name)).map(([n]) => n!);
    // Gem names are unique ignoring case; the API looks names up with case.
    const twin = matches.find((n) => n.toLowerCase() === name.toLowerCase());
    if (twin) return { status: "taken", url: `${SITE}/gems/${twin}`, note: `held as "${twin}"` };
    const now = ctx.now?.() ?? Date.now();
    for (const match of matches) {
      const r = await fetchGem(ctx, match);
      const gem = r.status === 200 ? ((await r.json()) as Gem | null) : undefined;
      const released = Date.parse(gem?.version_created_at ?? "");
      if (typeof gem?.downloads !== "number" || Number.isNaN(released)) {
        return {
          status: "available",
          certainty: "probable",
          note: `could not check whether the similar gem "${match}" blocks it`,
        };
      }
      if (gem.downloads >= DOWNLOADS || now - released < FIVE_YEARS_MS) {
        return {
          status: "unavailable",
          url: `${SITE}/gems/${match}`,
          note: `RubyGems rejects names too similar to "${match}"`,
        };
      }
    }
    return list.stale
      ? {
          status: "available",
          certainty: "probable",
          note: `could not refresh RubyGems' name list; used the copy from ${asOf(list)}`,
        }
      : {
          status: "available",
          certainty: "probable",
          note: "no gem with this name; a yanked gem spelled with other capitals is hidden and would still hold it",
        };
  },
});
