import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";

/** PEP 503: case-insensitive, runs of `-`, `_` and `.` are equivalent. */
export const normalizePypi = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

// PEP 508 names: ASCII letters and digits, with . _ - allowed only between them.
const VALID = /^([a-z0-9]|[a-z0-9][a-z0-9._-]*[a-z0-9])$/i;

export const pypi: Channel = defineChannel({
  id: "pypi",
  label: "PyPI",
  category: "package",
  rules: (name) =>
    VALID.test(name) ? undefined : "PyPI names are letters, digits, and inner . _ -",
  async lookup(name, ctx) {
    const normalized = normalizePypi(name);
    const res = await get(ctx, `https://pypi.org/pypi/${normalized}/json`);
    if (res.status === 404) return { status: "available", certainty: "confirmed" };
    if (res.status !== 200) return unexpected("PyPI", res);
    const { info } = (await res.json()) as {
      info: { name: string; summary?: string; version?: string };
    };
    return {
      status: "taken",
      url: `https://pypi.org/project/${normalized}/`,
      note: info.summary || undefined,
      meta: { name: info.name, latest: info.version },
    };
  },
});
