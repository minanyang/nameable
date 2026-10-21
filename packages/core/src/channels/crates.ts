import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";

// https://doc.rust-lang.org/cargo/reference/manifest.html#the-name-field and crates.io's 64-character limit.
const VALID = /^[a-z][a-z0-9_-]{0,63}$/i;

// crates.io's `canon_crate_name`: case-insensitive, `-` and `_` the same.
const canon = (name: string) => name.toLowerCase().replace(/-/g, "_");

// reserved_crate_names, from crates.io migrations 20170305095748, 20170430202433 and 2021-02-10-141019.
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
    if (res.status === 404) return { status: "available", certainty: "confirmed" };
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
