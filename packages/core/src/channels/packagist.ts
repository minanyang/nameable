import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import { levenshtein } from "../levenshtein.js";
import type { Channel, Context } from "../types.js";

const SITE = "https://packagist.org";

// Package::PACKAGE_NAME_REGEX for one part of `vendor/package`; ValidPackageRepositoryValidator also
// refuses uppercase. The vendor column holds 191 characters.
const VALID = /^[a-z0-9]+(?:[_.-]?[a-z0-9]+)*$/i;
const MAX = 191;

// ValidPackageRepositoryValidator and NotReservedWordValidator::RESERVED_WORDS.
const RESERVED_VENDORS = new Set(
  "php packagist api sdk auth openai annotation authentication authorization dependency dependencies kernel namespace namespaces rfc routing standards standard token composer automation unknown admin create".split(
    " ",
  ),
);
const DEVICE_NAMES = /^(?:nul|con|prn|aux|com[1-9]|lpt[1-9])$/;
// New vendors containing these are blocked; existing ones are already held. The spam-word patterns the
// validator also applies change often and are not copied.
const BRANDS = /symfony|packagist|composer/;

// TypoSquattersValidator blocks a package whose vendor is one edit from that of a package with the same
// package name and at least a million downloads.
const MIN_DOWNLOADS = 1_000_000;

const packageNames = async (ctx: Context, query: string) => {
  const res = await get(ctx, `${SITE}/packages/list.json?${query}`);
  if (res.status !== 200) return res;
  const { packageNames: names } = ((await res.json()) ?? {}) as { packageNames?: unknown };
  return Array.isArray(names) && names.every((n) => typeof n === "string")
    ? (names as string[])
    : undefined;
};

// The name is the vendor: Composer packages are `vendor/package`, and a vendor belongs to whoever
// maintains its packages (VendorWritableValidator). The package would be `name/name`.
export const packagist: Channel = defineChannel({
  id: "packagist",
  label: "Packagist",
  category: "package",
  rules: (name) =>
    VALID.test(name) && name.length <= MAX
      ? undefined
      : "Packagist vendors are letters and digits, with single . _ or - between them",
  // Vendors that already hold packages keep them; these apply to new ones.
  refuses: (name) => {
    if (name !== name.toLowerCase()) return "Packagist names must be lowercase";
    if (RESERVED_VENDORS.has(name) || DEVICE_NAMES.test(name))
      return "Packagist reserves this vendor name";
    if (BRANDS.test(name))
      return "Packagist blocks new vendors containing symfony, packagist or composer";
    if (name.endsWith(".json")) return "Packagist names cannot end in .json";
    return undefined;
  },
  async lookup(name, ctx) {
    const owned = await packageNames(ctx, `vendor=${name}`);
    if (owned instanceof Response) return unexpected("Packagist", owned);
    if (!owned) return { status: "unknown", note: "Packagist returned an unexpected list" };
    if (owned.length) {
      return {
        status: "taken",
        url: `${SITE}/packages/${name}/`,
        note:
          owned.length === 1
            ? `vendor of ${owned[0]}`
            : `vendor of ${owned.length} packages, such as ${owned[0]}`,
        meta: { packages: owned.length },
      };
    }

    // The validator matches `name LIKE '%/<package>'`, where `_` stands for any one character; the
    // list filter is a glob, so it asks with `*` and the results are narrowed here.
    const like = new RegExp(
      `^[^/]+/${name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&").replaceAll("_", ".")}$`,
      "i",
    );
    const listed = await packageNames(ctx, `filter=*/${name.replaceAll("_", "*")}`);
    const twins = Array.isArray(listed) ? listed.filter((n) => like.test(n)) : listed;
    if (!Array.isArray(twins)) {
      return {
        status: "available",
        certainty: "probable",
        note: `could not check Packagist's typosquatting rule for ${name}/${name}`,
      };
    }
    for (const twin of twins) {
      const vendor = twin.split("/")[0]!;
      if (levenshtein(vendor, name) > 1) continue;
      const res = await get(ctx, `${SITE}/packages/${twin}/stats.json`);
      const total =
        res.status === 200
          ? ((await res.json()) as { downloads?: { total?: unknown } } | null)?.downloads?.total
          : undefined;
      if (typeof total !== "number") {
        return {
          status: "available",
          certainty: "probable",
          note: `could not check whether ${twin} blocks ${name}/${name} as a typo`,
        };
      }
      if (total >= MIN_DOWNLOADS) {
        return {
          status: "unavailable",
          url: `${SITE}/packages/${twin}`,
          note: `Packagist refuses the package ${name}/${name} as too similar to ${twin}; the vendor itself is free`,
        };
      }
    }
    return {
      status: "available",
      certainty: "probable",
      note: "no packages under this vendor; packages frozen for spam are hidden and still hold it",
    };
  },
});
