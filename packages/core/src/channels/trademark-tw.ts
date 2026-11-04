import { defineChannel } from "../define.js";
import { get } from "../http.js";
import { cachedList, linesFor, type ListKey } from "../lists.js";
import type { Channel, Context } from "../types.js";

// TIPO's open data API answers 5000 marks a page in about half a minute and searches by name only as a
// substring, so scripts/tw-trademarks.ts reads every mark in force, or still renewable, or applied for in
// the last three years, and publishes the words each can be found by on this repository's `data` branch,
// split into SHARDS files by a hash of the words (about 6 MB each, 1.8 MB as sent). A check downloads only
// the file its name is in. Owners are not published.
const LIST = "https://raw.githubusercontent.com/minanyang/nameable/data/tw-trademarks";
const RECORD = "https://cloud.tipo.gov.tw/S220/opdataapi/api";
// The access code TIPO lists for its trademark API on data.gov.tw (https://data.gov.tw/dataset/41664).
const TOKEN = "43b47d07-4795-45d9-819a-9c71c72e4105";
const HEADER = "#nameable-data tw-trademarks v1";
// The list is rebuilt twice a month, after TIPO's own updates on the 1st and 16th.
const STALE_AFTER_MS = 45 * 24 * 60 * 60 * 1000;

export const SHARDS = 16;

/** The form marks are compared in: full-width folded, lower case, letters and digits only. */
export function normalizeMark(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Which file a mark's words are in: FNV-1a of their UTF-8 bytes, as two hex digits. */
export function shardOf(key: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(key)) hash = Math.imul(hash ^ byte, 0x01000193);
  return ((hash >>> 0) % SHARDS).toString(16).padStart(2, "0");
}

/** One shard as `key\tname\tclasses\tstatus\tapplication` lines, then `#asof\t<time>`. */
async function shard(ctx: Context, id: string): Promise<string> {
  const res = await get(ctx, `${LIST}/${id}.tsv`, { timeoutMs: 60_000 });
  if (!res.ok) throw new Error(`the Taiwan trademark list returned HTTP ${res.status}`);
  const lines = (await res.text()).split("\n");
  // A file in another shape must fail the check, not read as a register with no marks.
  const field = (name: string) =>
    lines.find((l) => l.startsWith(`#${name}\t`))?.slice(name.length + 2);
  const asOf = field("asof") ?? "";
  const marks = lines.slice(1).filter((l) => l && !l.startsWith("#"));
  // The last line counts the marks, so a list cut short is never read as complete.
  if (
    lines[0] !== HEADER ||
    field("shard") !== `${id}/${SHARDS}` ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(asOf) ||
    marks.length < 1000 ||
    Number(field("end")) !== marks.length
  ) {
    throw new Error("the Taiwan trademark list is not in the expected shape");
  }
  return `\n${marks.join("\n")}\n#asof\t${asOf}\n`;
}

const ORDER = ["registered", "expiring", "applied"];
const STATUS: Record<string, string> = {
  registered: "registered",
  expiring: "expired, still renewable",
  applied: "applied for",
};

/** "classes 9, 42" or "class 5 of the scheme before 1994". */
function classes(list: string): string {
  if (!list) return "no class given";
  const codes = list.split(",");
  const old = codes[0]!.startsWith("old:");
  const numbers = codes.map((c) => c.replace(/^old:/, "")).join(", ");
  return `${codes.length > 1 ? "classes" : "class"} ${numbers}${old ? " of the scheme before 1994" : ""}`;
}

export const trademarkTw: Channel = defineChannel({
  id: "trademark-tw",
  label: "Trademarks (TW)",
  category: "trademark",
  rules: (name) =>
    normalizeMark(name) ? undefined : "trademarks are compared by their letters and digits",
  async lookup(name, ctx) {
    const key = normalizeMark(name);
    const id = shardOf(key);
    const list = await cachedList(ctx, `tw-trademarks-${id}` as ListKey, () => shard(ctx, id));
    // A mark in force leads, then one in today's classes over the old scheme, then the latest filed.
    const old = (m: string[]) => Number(m[1]!.startsWith("old:"));
    const marks = linesFor(list.text, key).sort(
      (a, b) =>
        ORDER.indexOf(a[2]!) - ORDER.indexOf(b[2]!) ||
        old(a) - old(b) ||
        (b[3]! > a[3]! ? 1 : b[3]! < a[3]! ? -1 : 0),
    );
    if (marks.length) {
      const [mark, classList, status, application] = marks[0]!;
      const lead = `${mark} (${classes(classList!)}, ${STATUS[status!] ?? status})`;
      const more = marks.length > 1 ? ` and ${marks.length - 1} more` : "";
      const api = status === "applied" ? "TmarkAppl" : "TmarkRights";
      return {
        status: "taken",
        url: `${RECORD}/${api}?tk=${TOKEN}&format=json&applno=${application}`,
        note: `clash, not a block: ${lead}${more}; a mark limits the name only for goods and services like its own`,
        meta: {
          marks: marks.length,
          examples: marks.slice(0, 10).map(([m, c, s, a]) => ({
            name: m,
            classes: c,
            status: s,
            application: a,
          })),
        },
      };
    }
    const time = linesFor(list.text, "#asof")[0]?.[0] ?? "";
    const behind = (ctx.now?.() ?? Date.now()) - Date.parse(time) > STALE_AFTER_MS;
    return {
      status: "available",
      certainty: "probable",
      note: `no Taiwan trademark uses exactly this name as of ${time.slice(0, 10)}${behind ? ", and the list has not been updated since" : ""}; marks that look or sound alike are not checked`,
    };
  },
});
