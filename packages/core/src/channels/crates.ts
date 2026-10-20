import { get } from "../http.js";
import type { Channel, CheckResult } from "../types.js";

const VALID = /^[a-z][a-z0-9_-]{0,63}$/i;

export const crates: Channel = {
  id: "crates",
  label: "crates.io",
  category: "package",
  async check(name, ctx): Promise<CheckResult> {
    const base = { channel: this.id, label: this.label, url: `https://crates.io/crates/${name}` };
    if (!VALID.test(name)) {
      return {
        ...base,
        status: "unavailable",
        note: "crate names start with a letter and use letters, digits, - and _ (max 64)",
        url: undefined,
      };
    }
    // crates.io treats `-` and `_` and letter case as the same name, and the API resolves either spelling.
    const res = await get(ctx, `https://crates.io/api/v1/crates/${name}`);
    if (res.status === 404) return { ...base, status: "available", certainty: "confirmed" };
    if (res.status !== 200) return { ...base, status: "unknown", note: `crates.io returned HTTP ${res.status}` };
    const { crate } = (await res.json()) as {
      crate: { name: string; description?: string; updated_at?: string; downloads?: number };
    };
    return {
      ...base,
      url: `https://crates.io/crates/${crate.name}`,
      status: "taken",
      note: crate.description?.trim() || undefined,
      meta: { name: crate.name, updated: crate.updated_at, downloads: crate.downloads },
    };
  },
};
