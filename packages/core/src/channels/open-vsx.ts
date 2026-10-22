import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import { levenshtein } from "../levenshtein.js";
import { asOf, cachedList } from "../lists.js";
import type { Channel, Context } from "../types.js";

const API = "https://open-vsx.org/api";

// openvsx ExtensionValidator: namespaces are word characters and - + $ ~, at most 255, and not "-".
const VALID = /^[\w\-+$~]{1,255}$/;

// open-vsx.org production config: a new namespace is refused when it is within a Levenshtein distance of
// 20% of the longer name from an existing one, ignoring case (SimilarityCheckService).
const SIMILARITY = 0.2;
const similar = (a: string, b: string) =>
  a !== b && levenshtein(a, b) <= SIMILARITY * Math.max(a.length, b.length);

// Search pages stop at 10,000 results, so the extensions are read oldest first and newest first.
const PAGE = 1000;
const WINDOW = 10_000;

/**
 * Every namespace with a public extension, one per line, then a `#coverage\tread\ttotal` line. Built from
 * search pages sorted both ways by date, which together reach 20,000 extensions (about 25 requests).
 */
async function namespaceList(ctx: Context): Promise<string> {
  const page = async (order: string, offset: number) => {
    const query = new URLSearchParams({
      size: String(PAGE),
      offset: String(offset),
      sortBy: "timestamp",
      sortOrder: order,
    });
    const res = await get(ctx, `${API}/-/search?${query}`, { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`Open VSX search returned HTTP ${res.status}`);
    const body = (await res.json()) as { totalSize?: unknown; extensions?: unknown } | null;
    if (typeof body?.totalSize !== "number" || !Array.isArray(body.extensions)) {
      throw new Error("Open VSX search is not in the expected shape");
    }
    return body as { totalSize: number; extensions: { namespace?: unknown; name?: unknown }[] };
  };
  const first = await page("asc", 0);
  const offsets = Array.from({ length: WINDOW / PAGE }, (_, i) => i * PAGE).filter(
    (o) => o < first.totalSize,
  );
  const pages = await Promise.all([
    ...offsets.slice(1).map((o) => page("asc", o)),
    ...offsets.map((o) => page("desc", o)),
  ]);
  const seen = new Set<string>();
  const namespaces = new Set<string>();
  for (const { extensions } of [first, ...pages]) {
    for (const e of extensions) {
      if (typeof e?.namespace !== "string") continue;
      namespaces.add(e.namespace);
      seen.add(`${e.namespace}.${String(e.name)}`);
    }
  }
  if (namespaces.size < 100) throw new Error("Open VSX search returned too few namespaces");
  return `\n${[...namespaces].join("\n")}\n#coverage\t${seen.size}\t${first.totalSize}\n`;
}

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

    // Publishing to an unverified namespace is refused when a VS Code Marketplace publisher has its
    // name (NamespaceOwnershipCheckScanner, enforced on open-vsx.org).
    const publisher = await get(ctx, `https://marketplace.visualstudio.com/publishers/${name}`, {
      redirect: "manual",
    });
    if (publisher.status === 200 || publisher.status === 301) {
      return {
        status: "unavailable",
        url: `https://marketplace.visualstudio.com/publishers/${name}`,
        note: "a VS Code Marketplace publisher has this name; Open VSX lets only its verified owner publish under it",
      };
    }
    if (publisher.status !== 404) return unexpected("the VS Code Marketplace", publisher);

    // Namespace creation compares against every namespace.
    const list = await cachedList(ctx, "openvsx-namespaces", () => namespaceList(ctx));
    const lines = list.text.split("\n");
    const wanted = name.toLowerCase();
    const near = lines.find((n) => n && !n.startsWith("#") && similar(n.toLowerCase(), wanted));
    if (near) {
      return {
        status: "unavailable",
        url: `https://open-vsx.org/namespace/${near}`,
        note: `Open VSX refuses namespaces too similar to "${near}"`,
      };
    }
    const [read, total] = (lines.find((l) => l.startsWith("#coverage\t")) ?? "")
      .split("\t")
      .slice(1)
      .map(Number);
    const partial =
      read! < total! ? `; ${total! - read!} of ${total} extensions were beyond reach` : "";
    return {
      status: "available",
      certainty: "probable",
      note: `no namespace or similar one${list.stale ? ` as of ${asOf(list)}` : ""}; namespaces without public extensions are not listed${partial}`,
    };
  },
});
