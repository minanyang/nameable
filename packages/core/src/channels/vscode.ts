import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import type { Channel, Context } from "../types.js";

const SITE = "https://marketplace.visualstudio.com";

// vsce src/validation.ts: publisher and extension names are letters, digits and hyphens, starting with
// a letter or digit.
const VALID = /^[a-z0-9][a-z0-9-]*$/i;

type Extension = {
  extensionName?: unknown;
  displayName?: unknown;
  publisher?: { publisherName?: unknown };
};

/** The extensions a text search finds, from the gallery API the marketplace site uses itself. */
async function search(ctx: Context, name: string): Promise<Extension[] | Response> {
  const res = await get(ctx, `${SITE}/_apis/public/gallery/extensionquery`, {
    headers: {
      accept: "application/json;api-version=7.2-preview.1",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      filters: [
        {
          criteria: [
            { filterType: 8, value: "Microsoft.VisualStudio.Code" },
            { filterType: 10, value: name },
          ],
          pageSize: 1000,
        },
      ],
      flags: 0,
    }),
  });
  if (res.status !== 200) return res;
  const body = (await res.json()) as { results?: { extensions?: unknown }[] } | null;
  const extensions = body?.results?.[0]?.extensions;
  if (!Array.isArray(extensions))
    throw new Error("the VS Code Marketplace returned an unexpected list");
  return extensions as Extension[];
}

// Publishing docs: an extension's `name` and `displayName` must be unique in the Marketplace, a removed
// extension's name stays reserved, and publisher IDs are unique. The name is checked as all three.
export const vscode: Channel = defineChannel({
  id: "vscode",
  label: "VS Code Marketplace",
  category: "editor",
  rules: (name) =>
    VALID.test(name)
      ? undefined
      : "VS Code extension and publisher names are letters, digits and hyphens",
  async lookup(name, ctx) {
    const found = await search(ctx, name);
    if (found instanceof Response) return unexpected("the VS Code Marketplace", found);
    const wanted = name.toLowerCase();
    const same = (v: unknown) => typeof v === "string" && v.toLowerCase() === wanted;
    const hit = found.find((e) => same(e.extensionName) || same(e.displayName));
    if (hit) {
      const id = `${String(hit.publisher?.publisherName)}.${String(hit.extensionName)}`;
      return {
        status: "taken",
        url: `${SITE}/items?itemName=${id}`,
        note: `${id}${typeof hit.displayName === "string" ? ` (${hit.displayName})` : ""}; extension names and display names are unique`,
      };
    }
    // A publisher page answers 200, or 301 to the publisher's display name.
    const publisher = await get(ctx, `${SITE}/publishers/${name}`, { redirect: "manual" });
    if (publisher.status === 200 || publisher.status === 301) {
      return { status: "taken", url: `${SITE}/publishers/${name}`, note: "a publisher" };
    }
    if (publisher.status !== 404) return unexpected("the VS Code Marketplace", publisher);
    return {
      status: "available",
      certainty: "probable",
      note: "no extension or publisher; removed extensions keep their names but are hidden",
    };
  },
});
