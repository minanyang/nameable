// Downloads Taiwan's trademark records from the Taiwan Intellectual Property Office's open data API, for
// the list the trademark-tw channel will read. The API answers 5000 records a page in about a minute, too
// slow to ask while someone waits, so this saves every page to a directory, one gzipped file per page,
// and a later step builds the list from them. A run that stops picks up at the first page it is missing.
//
// Three sets are read: registrations whose term has not ended (TmarkRights), those whose term ended in
// the last six months, which the owner can still renew (Trademark Act, article 34), and applications
// filed in the last three years (TmarkAppl), which include those still under examination. The query date
// is kept in the directory, so a resumed run asks for the same sets.
//
// The data is published under the Open Government Data License, version 1.0 (https://data.gov.tw/license).
// The access code is the one TIPO lists for this API on data.gov.tw (https://data.gov.tw/dataset/41664).
//
// The list keeps what the channel needs to say a mark with the name exists: the words of the mark, its
// classes, whether it is registered or applied for, and its application number, with which anyone can
// look the mark up at TIPO. Owners, agents and addresses stay in the downloaded pages and are not
// published: an owner can be a person, and the channel does not need to say who holds a mark.
//
// The list is split into SHARDS files by a hash of the name, so the channel downloads only the one a name
// is in. They are plain text, so the `data` branch keeps each refresh as a small change.
//
// Usage: node scripts/tw-trademarks.ts fetch <directory>
//        node scripts/tw-trademarks.ts build <directory> <output directory>
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const API = "https://cloud.tipo.gov.tw/S220/opdataapi/api";
const TOKEN = "43b47d07-4795-45d9-819a-9c71c72e4105";
const PAGE = 5000;
const APPLICATION_YEARS = 3;
const RENEWAL_GRACE_MONTHS = 6;
const USER_AGENT = "nameable-data (+https://github.com/minanyang/nameable)";

type Set = {
  /** The directory its pages are saved in. */
  name: string;
  api: "TmarkRights" | "TmarkAppl";
  key: "tmarkrights" | "tmarkappl";
  filter: string;
};
type State = { date: string; totals: Record<string, number> };

const compact = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");

/** The dates (YYYYMMDD) the sets are read by, from the query date. */
function dates(date: string) {
  const day = (change: (d: Date) => void) => {
    const d = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`);
    change(d);
    return compact(d);
  };
  return {
    graceFrom: day((d) => d.setUTCMonth(d.getUTCMonth() - RENEWAL_GRACE_MONTHS)),
    yesterday: day((d) => d.setUTCDate(d.getUTCDate() - 1)),
    filedFrom: day((d) => d.setUTCFullYear(d.getUTCFullYear() - APPLICATION_YEARS)),
  };
}

function sets(date: string): Set[] {
  const { graceFrom, yesterday, filedFrom } = dates(date);
  return [
    {
      name: "TmarkRights",
      api: "TmarkRights",
      key: "tmarkrights",
      filter: `deadlinebdate=${date}`,
    },
    {
      name: "TmarkRightsGrace",
      api: "TmarkRights",
      key: "tmarkrights",
      filter: `deadlinebdate=${graceFrom}&deadlineedate=${yesterday}`,
    },
    { name: "TmarkAppl", api: "TmarkAppl", key: "tmarkappl", filter: `applbdate=${filedFrom}` },
  ];
}

/** A response, retried through network errors, timeouts and server errors. */
async function get(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(300_000),
      });
      if (res.ok) return await res.text();
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= 5) throw err;
      console.error(`  retrying after ${(err as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000 * 2 ** attempt));
  }
}

/** The API's answer, refusing the sample data it returns when the access code is not accepted. */
function checked(text: string): Record<string, any> {
  const body = JSON.parse(text) as Record<string, any>;
  if (body.status !== "ok") throw new Error(`the API answered ${body.status}: ${body.message}`);
  return body;
}

async function count(set: Set, date: string): Promise<number> {
  const text = await get(`${API}/${set.api}?tk=${TOKEN}&format=json&top=1&${set.filter}`);
  const total = checked(text)["total-count"];
  if (typeof total !== "number") throw new Error(`no total count for ${set.name} (${date})`);
  return total;
}

async function fetchAll(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const statePath = join(dir, "state.json");
  let state = await readFile(statePath, "utf8")
    .then((text) => JSON.parse(text) as State)
    .catch(() => undefined);
  state ??= { date: compact(new Date()), totals: {} };
  // A set added since the directory was started is counted on the same date as the others.
  for (const set of sets(state.date)) state.totals[set.name] ??= await count(set, state.date);
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
  for (const set of sets(state.date)) {
    const total = state.totals[set.name]!;
    const pages = Math.ceil(total / PAGE);
    await mkdir(join(dir, set.name), { recursive: true });
    console.log(`${set.name}: ${total} records, ${pages} pages (${set.filter})`);
    for (let page = 0; page < pages; page++) {
      const file = join(dir, set.name, `${String(page).padStart(4, "0")}.json.gz`);
      if (
        await readFile(file).then(
          () => true,
          () => false,
        )
      )
        continue;
      const started = Date.now();
      const text = await get(
        `${API}/${set.api}?tk=${TOKEN}&format=json&top=${PAGE}&skip=${page * PAGE}&orderby=appl-no&${set.filter}`,
      );
      const body = checked(text);
      const records = body[set.key]?.tmarkcontent;
      const expected = Math.min(PAGE, total - page * PAGE);
      if (!Array.isArray(records) || records.length !== expected) {
        throw new Error(
          `page ${page} of ${set.name} has ${records?.length} records, not ${expected}`,
        );
      }
      // Written under another name first, so a run stopped mid-write leaves no page that looks complete.
      await writeFile(`${file}.part`, gzipSync(text));
      await rename(`${file}.part`, file);
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`  ${set.name} ${page + 1}/${pages} (${seconds}s)`);
    }
  }
  console.log("done");
}

export const HEADER = "#nameable-data tw-trademarks v1";
export const SOURCE =
  "Taiwan Intellectual Property Office open data, under the Open Government Data License, version 1.0";
// Taiwan classified goods and services its own way until its rules adopted the classes of the Nice
// Agreement on 1994-07-15, and a mark keeps the classes it was registered under. Classes above 45 exist
// only in the old scheme, which marks filed later still show.
const NICE_SINCE = "1994/07/15";

/** A mark's fields the list is built from, as the API names them. */
export type MarkRecord = {
  "appl-no"?: string | null;
  "appl-date"?: string | null;
  "tmark-name"?: string | null;
  "tmark-draft-c"?: string | null;
  "tmark-draft-e"?: string | null;
  "tmark-draft-j"?: string | null;
  goodsclasses?: { "goodsclass-code"?: string | null }[] | null;
  deadline?: string | null;
  "del-reason"?: string | null;
};
export type Entry = {
  key: string;
  name: string;
  classes: string;
  status: "registered" | "expiring" | "applied";
  applNo: string;
};

// normalize, SHARDS and shardOf must match packages/core/src/channels/trademark-tw.ts, which looks names up
// the same way; this script runs with plain node, so it keeps its own copy, and a test compares the two.

/** The form names are compared in: full-width folded, lower case, letters and digits only. */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// What a mark's name ends with to describe the mark rather than name it: "及圖" (with a device), "設計圖"
// (design), "標章" (emblem), "立體商標" (3D mark) and the like, their English counterparts after a space,
// and a color or numbering in parentheses. A lone "圖" stays: it can be part of the name.
const NAME_SUFFIX =
  /(?:\s*(?:及圖形?|及?(?:設計圖|設計字|圖形|圖樣|圖案|立體商標|聲音商標|商標|標章))|(?<=^|\s)(?:with\s+)?(?:device|design|logo|stylized)|\s*[(（][^()（）]*[)）])+\s*$/iu;

/** The words a mark can be found by: those in its drawing, or else its name without TIPO's suffixes. */
export function keysOf(mark: MarkRecord): string[] {
  const words = [mark["tmark-draft-e"], mark["tmark-draft-c"], mark["tmark-draft-j"]].filter(
    (w): w is string => !!w?.trim(),
  );
  if (words.length === 0 && mark["tmark-name"])
    words.push(mark["tmark-name"].replace(NAME_SUFFIX, ""));
  return [...new Set(words.map(normalize).filter(Boolean))];
}

/** Class numbers without leading zeros, "old:" before those of the scheme used before 1994-07-15. */
export function classesOf(mark: MarkRecord): string {
  const codes = [
    ...new Set(
      (mark.goodsclasses ?? [])
        .map((g) => Number(g["goodsclass-code"]))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ].sort((a, b) => a - b);
  const old = codes.some((n) => n > 45) || (mark["appl-date"] ?? "") < NICE_SINCE;
  return codes.map((n) => (old ? `old:${n}` : String(n))).join(",");
}

/**
 * The list's entries: every registration in force on `date` (YYYY/MM/DD), every one whose term ended on
 * or after `graceFrom` and can still be renewed, and every application not yet among the registrations
 * read, whatever became of the latter.
 */
export function entriesFrom(
  registrations: MarkRecord[],
  applications: MarkRecord[],
  date: string,
  graceFrom: string,
): Entry[] {
  const entries: Entry[] = [];
  const registered = new Set<string>();
  const add = (mark: MarkRecord, status: Entry["status"]) => {
    for (const key of keysOf(mark)) {
      entries.push({
        key,
        name: (mark["tmark-name"] ?? "").replace(/[\t\n\r]+/g, " ").trim(),
        classes: classesOf(mark),
        status,
        applNo: mark["appl-no"] ?? "",
      });
    }
  };
  for (const mark of registrations) {
    if (mark["appl-no"]) registered.add(mark["appl-no"]);
    const deadline = mark.deadline ?? "";
    if (mark["del-reason"] || deadline < graceFrom) continue;
    add(mark, deadline < date ? "expiring" : "registered");
  }
  for (const mark of applications) {
    if (mark["appl-no"] && !registered.has(mark["appl-no"])) add(mark, "applied");
  }
  return entries.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.applNo < b.applNo ? -1 : 1,
  );
}

export const SHARDS = 16;

/** Which file a name is in: FNV-1a of its UTF-8 bytes, as two hex digits. */
export function shardOf(key: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(key)) hash = Math.imul(hash ^ byte, 0x01000193);
  return ((hash >>> 0) % SHARDS).toString(16).padStart(2, "0");
}

export function formatList(entries: Entry[], asOf: string, shard: string): string {
  return [
    HEADER,
    `#source\t${SOURCE}`,
    `#shard\t${shard}/${SHARDS}`,
    `#asof\t${asOf}`,
    ...entries.map((e) => [e.key, e.name, e.classes, e.status, e.applNo].join("\t")),
    `#end\t${entries.length}`,
    "",
  ].join("\n");
}

async function readPages(dir: string, set: Set): Promise<MarkRecord[]> {
  const files = (await readdir(join(dir, set.name))).filter((f) => f.endsWith(".json.gz")).sort();
  const marks: MarkRecord[] = [];
  for (const file of files) {
    const body = JSON.parse(gunzipSync(await readFile(join(dir, set.name, file))).toString("utf8"));
    marks.push(...(body[set.key].tmarkcontent as MarkRecord[]));
  }
  return marks;
}

async function build(dir: string, outDir: string): Promise<void> {
  const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as State;
  const read: Record<string, MarkRecord[]> = {};
  for (const set of sets(state.date)) {
    const marks = await readPages(dir, set);
    // A download that stopped early would publish a list with marks missing.
    if (marks.length !== state.totals[set.name]) {
      throw new Error(
        `${set.name} has ${marks.length} records, not ${state.totals[set.name]}; fetch again`,
      );
    }
    read[set.name] = marks;
  }
  const slashed = (compact: string) =>
    `${compact.slice(0, 4)}/${compact.slice(4, 6)}/${compact.slice(6)}`;
  const date = slashed(state.date);
  const graceFrom = slashed(dates(state.date).graceFrom);
  const entries = entriesFrom(
    [...read.TmarkRights!, ...read.TmarkRightsGrace!],
    read.TmarkAppl!,
    date,
    graceFrom,
  );
  const asOf = `${date.replaceAll("/", "-")}T00:00:00.000Z`;
  const shards = new Map<string, Entry[]>();
  for (let i = 0; i < SHARDS; i++) shards.set(i.toString(16).padStart(2, "0"), []);
  for (const entry of entries) shards.get(shardOf(entry.key))!.push(entry);
  await mkdir(outDir, { recursive: true });
  for (const [shard, list] of shards) {
    await writeFile(join(outDir, `${shard}.tsv`), formatList(list, asOf, shard));
  }
  const marks = new Set(entries.map((e) => e.applNo)).size;
  console.log(`${entries.length} entries for ${marks} marks (as of ${asOf})`);
}

if (import.meta.main) {
  const [command, dir, output] = process.argv.slice(2);
  if (command === "fetch" && dir) await fetchAll(dir);
  else if (command === "build" && dir && output) await build(dir, output);
  else {
    console.error(
      "usage: node scripts/tw-trademarks.ts fetch <directory>\n" +
        "       node scripts/tw-trademarks.ts build <directory> <output directory>",
    );
    process.exit(64);
  }
}
