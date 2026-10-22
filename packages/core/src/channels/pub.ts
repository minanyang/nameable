import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import { asOf, cachedList, linesFor } from "../lists.js";
import type { Channel, Context } from "../types.js";

// pkg/pub_package_reader (pub-dev): letters, digits and `_`, starting with a letter or `_`, at most 64.
const VALID = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

/** pub-dev's reducePackageName: `_` is dropped and case ignored when names are compared. */
const reduce = (name: string) => name.replaceAll("_", "").toLowerCase();

// pkg/pub_package_reader/lib/src/names.dart. `async`, `base` and `when` are reserved in Dart but
// allowed, because packages with those names already exist.
const RESERVED_WORDS = new Set(
  "abstract as assert augment await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for get hide if implements import in inline interface is late library mixin new null of on operator part required rethrow return sealed set show static super switch sync this throw true try type typedef var void while with yield".split(
    " ",
  ),
);
// Lowercase spellings of the few packages published before names had to be lowercase (names.dart).
const MIXED_CASE_TWINS = new Set(
  "autolinker dartdemocli filetecouch flutter_nectar google_search_v2 loadingbox polymerintro pong ral transmission_rpc viauthclient".split(
    " ",
  ),
);
// app/lib/package/overrides.dart: names kept for the Dart and Flutter teams, compared reduced, and
// packages that moved into the Flutter SDK.
const TEAM_NAMES = new Set(
  "_macros brick core dart dart2js dart2native dartanalyzer dartaotruntime dartdevc dartfmt flutter_web flutter_web_test flutter_web_ui google_maps_flutter hummingbird in_app_purchase location_background web_socket math mirrors developer pub swift_ui swiftgen versions webview_flutter firebaseui fluttery fluttery_audio fluttery_seekbar data_class hook kotlin ok_http credilio_sbm app_update flutterkit"
    .split(" ")
    .map(reduce),
);
const SDK = new Set(
  "flutter flutter_driver flutter_driver_extension flutter_gpu flutter_localizations flutter_test flutter_web_plugins".split(
    " ",
  ),
);

// app/lib/package/name_tracker.dart, _generateConflictingNames: a new name is refused when any of these
// forms of it equals one of these forms of an existing name.
const HOMOGLYPHS = [
  ["1", "l"],
  ["d", "cl"],
  ["g", "cj"],
  ["m", "rn"],
  ["w", "vv"],
] as const;
function conflictForms(name: string): Set<string> {
  const r = reduce(name);
  const forms = new Set([r]);
  if (!r.endsWith("s") && r.length >= 3) forms.add(`${r}s`);
  if (r.endsWith("s") && r.length >= 4) forms.add(r.slice(0, -1));
  for (const [a, b] of HOMOGLYPHS) {
    if (r.includes(a)) forms.add(r.replaceAll(a, b));
    if (r.includes(b)) forms.add(r.replaceAll(b, a));
  }
  return forms;
}

/**
 * Every package on pub.dev, one `form\tname` line for each conflict form of each name (about 6 MB).
 * Moderated packages are left out of the public list, though they still block similar names.
 */
async function nameList(ctx: Context): Promise<string> {
  const names: unknown[] = [];
  const seen = new Set<string>();
  for (let url: string | null = "https://pub.dev/api/package-names"; url;) {
    // A page that points back to one already read would otherwise never end.
    if (seen.has(url)) throw new Error("pub.dev package-names pages loop");
    seen.add(url);
    const res = await get(ctx, url, { timeoutMs: 120_000 });
    if (!res.ok) throw new Error(`pub.dev package-names returned HTTP ${res.status}`);
    const page = (await res.json()) as { packages?: unknown; nextUrl?: string | null };
    if (!Array.isArray(page?.packages)) throw new Error("pub.dev package-names is not a list");
    names.push(...page.packages);
    url = page.nextUrl ?? null;
  }
  // A list in an unexpected shape must fail the check, not read as "no similar packages".
  if (!names.length || !names.every((n) => typeof n === "string")) {
    throw new Error("pub.dev package-names is not in the expected shape");
  }
  const lines: string[] = [];
  for (const name of names as string[]) {
    for (const form of conflictForms(name)) lines.push(`${form}\t${name}`);
  }
  return `\n${lines.join("\n")}\n`;
}

export const pub: Channel = defineChannel({
  id: "pub",
  label: "pub.dev",
  category: "package",
  rules: (name) => {
    if (!VALID.test(name)) {
      return "pub.dev names are letters, digits and _, start with a letter or _, at most 64 characters";
    }
    return undefined;
  },
  // Packages published before these rules (Pong, google_maps_flutter) keep their names.
  refuses: (name) => {
    if (name !== name.toLowerCase()) return "pub.dev names must be lowercase";
    if (RESERVED_WORDS.has(reduce(name))) return "pub.dev refuses Dart reserved words";
    if (MIXED_CASE_TWINS.has(name))
      return "pub.dev refuses the lowercase twin of an older mixed-case package";
    if (SDK.has(name)) return "this package is part of the Flutter SDK";
    if (TEAM_NAMES.has(reduce(name)))
      return "pub.dev keeps this name for the Dart and Flutter teams";
    return undefined;
  },
  async lookup(name, ctx) {
    const url = `https://pub.dev/packages/${name}`;
    const res = await get(ctx, `https://pub.dev/api/packages/${name}`);
    if (res.status === 200) {
      const doc = (await res.json()) as {
        name?: unknown;
        isDiscontinued?: boolean;
        latest?: { pubspec?: { description?: string } };
      } | null;
      if (typeof doc?.name !== "string") {
        return { status: "unknown", note: "pub.dev returned something other than a package" };
      }
      const { isDiscontinued, latest } = doc;
      return {
        status: "taken",
        url,
        note: isDiscontinued ? "discontinued" : latest?.pubspec?.description,
        meta: { discontinued: isDiscontinued === true },
      };
    }
    if (res.status !== 404) return unexpected("pub.dev", res);

    let list;
    try {
      list = await cachedList(ctx, "pub-names", () => nameList(ctx));
    } catch {
      return {
        status: "available",
        certainty: "probable",
        note: "could not download pub.dev's package list to check similar names",
      };
    }
    for (const form of conflictForms(name)) {
      const clash = linesFor(list.text, form).find(([existing]) => existing !== name);
      if (clash) {
        return {
          status: "unavailable",
          url: `https://pub.dev/packages/${clash[0]}`,
          note: `pub.dev rejects names too similar to "${clash[0]}"`,
        };
      }
    }
    return {
      status: "available",
      certainty: "probable",
      note: list.stale
        ? `could not refresh pub.dev's package list; used the copy from ${asOf(list)}`
        : "no package with this name; moderated packages and reserved names are hidden and can still block it",
    };
  },
});
