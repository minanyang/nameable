import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";

// https://doc.rust-lang.org/cargo/reference/manifest.html#the-name-field and crates.io's 64-character limit.
const VALID = /^[a-z][a-z0-9_-]{0,63}$/i;

export const crates: Channel = defineChannel({
  id: "crates",
  label: "crates.io",
  category: "package",
  rules: (name) =>
    VALID.test(name)
      ? undefined
      : "crate names start with a letter and use letters, digits, - and _ (max 64)",
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
