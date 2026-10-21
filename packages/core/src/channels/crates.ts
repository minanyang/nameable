import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import { asOf, cachedList, linesFor } from "../lists.js";
import type { Channel, Context } from "../types.js";
import { remoteZipFiles } from "../zip.js";

// https://doc.rust-lang.org/cargo/reference/manifest.html#the-name-field and crates.io's 64-character limit.
const VALID = /^[a-z][a-z0-9_-]{0,63}$/i;

// crates.io's `canon_crate_name`: case-insensitive, `-` and `_` the same.
const canon = (name: string) => name.toLowerCase().replace(/-/g, "_");

// reserved_crate_names as first seeded by crates.io migrations 20170305095748, 20170430202433 and 2021-02-10-141019.
const RESERVED = new Set(
  [
    "alloc",
    "arena",
    "ast",
    "builtins",
    "collections",
    "compiler-builtins",
    "compiler-rt",
    "compiletest",
    "core",
    "coretest",
    "debug",
    "driver",
    "flate",
    "fmt_macros",
    "grammar",
    "graphviz",
    "macro",
    "macros",
    "proc_macro",
    "rbml",
    "rust-installer",
    "rustbook",
    "rustc",
    "rustc_back",
    "rustc_borrowck",
    "rustc_driver",
    "rustc_llvm",
    "rustc_resolve",
    "rustc_trans",
    "rustc_typeck",
    "rustdoc",
    "rustllvm",
    "rustuv",
    "serialize",
    "std",
    "syntax",
    "test",
    "unicode",
    // Windows device names.
    "nul",
    "con",
    "prn",
    "aux",
    "com0",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "lpt0",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
  ].map(canon),
);

// crates.io's daily public database dump. Admins add reserved names after the migrations, and a deleted
// crate's name stays blocked until `available_at` (src/controllers/krate/publish.rs); the API answers 404
// for both, so they come from the dump's `reserved_crate_names` and `deleted_crates` tables.
const DUMP = "https://static.crates.io/db-dump.zip";

/** RFC 4180 rows as objects keyed by the header row; deletion messages hold commas, quotes and newlines. */
function csv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') {
      field += '"';
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (!quoted && c === ",") {
      endField();
    } else if (!quoted && c === "\n") {
      endField();
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    endField();
    rows.push(row);
  }
  const [head = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

/** A dump timestamp (`2024-11-18 09:03:35.16643+00`) in ISO form, or undefined when it is not one. */
const isoTime = (value = "") =>
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00$/
    .exec(value)
    ?.slice(1)
    .join("T")
    .concat("Z");

/** Reserved names and names still blocked after a deletion, one `canon\treserved` or `canon\tdeleted\tuntil` line each. */
async function nameList(ctx: Context): Promise<string> {
  const files = await remoteZipFiles(ctx, DUMP, ["reserved_crate_names.csv", "deleted_crates.csv"]);
  const reserved = csv(files.get("reserved_crate_names.csv")!.toString("utf8"));
  const deleted = csv(files.get("deleted_crates.csv")!.toString("utf8"));
  // Tables in an unexpected shape must fail the check, not read as "nothing reserved".
  if (
    !reserved.length ||
    !reserved.every((r) => r.name) ||
    !deleted.length ||
    !deleted.every((d) => d.name && isoTime(d.available_at))
  ) {
    throw new Error("crates.io database dump is not in the expected shape");
  }
  const now = ctx.now?.() ?? Date.now();
  const lines = reserved.map((r) => `${canon(r.name!)}\treserved`);
  for (const d of deleted) {
    const until = isoTime(d.available_at)!;
    if (Date.parse(until) > now) lines.push(`${canon(d.name!)}\tdeleted\t${until}`);
  }
  return `\n${lines.join("\n")}\n`;
}

export const crates: Channel = defineChannel({
  id: "crates",
  label: "crates.io",
  category: "package",
  rules: (name) => {
    if (!VALID.test(name)) {
      return "crate names start with a letter and use letters, digits, - and _ (max 64)";
    }
    if (RESERVED.has(canon(name))) return "crates.io reserves this name";
    return undefined;
  },
  async lookup(name, ctx) {
    // crates.io treats `-` and `_` and letter case as the same name, and the API resolves either spelling.
    const res = await get(ctx, `https://crates.io/api/v1/crates/${name}`);
    if (res.status === 404) {
      let list;
      try {
        list = await cachedList(ctx, "crates-names", () => nameList(ctx));
      } catch {
        return {
          status: "available",
          certainty: "probable",
          note: "could not read crates.io's database dump to check reserved and recently deleted names",
        };
      }
      const now = ctx.now?.() ?? Date.now();
      for (const [kind, until] of linesFor(list.text, canon(name))) {
        if (kind === "reserved")
          return { status: "unavailable", note: "crates.io reserves this name" };
        if (kind === "deleted" && Date.parse(until!) > now) {
          return {
            status: "unavailable",
            note: `recently deleted; crates.io frees the name after ${until!.slice(0, 16).replace("T", " ")} UTC`,
          };
        }
      }
      return list.stale
        ? {
            status: "available",
            certainty: "probable",
            note: `checked against crates.io's database dump from ${asOf(list)}`,
          }
        : { status: "available", certainty: "confirmed" };
    }
    if (res.status !== 200) return unexpected("crates.io", res);
    const { crate } = (await res.json()) as {
      crate: { name: string; description?: string; updated_at?: string; downloads?: number };
    };
    return {
      status: "taken",
      url: `https://crates.io/crates/${crate.name}`,
      note: crate.description?.trim() || undefined,
      meta: { name: crate.name, updated: crate.updated_at, downloads: crate.downloads },
    };
  },
});
