import { get } from "../http.js";
import type { Channel, CheckResult } from "../types.js";

/** PEP 503: case-insensitive, runs of `-`, `_` and `.` are equivalent. */
export const normalizePypi = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

const VALID = /^([a-z0-9]|[a-z0-9][a-z0-9._-]*[a-z0-9])$/i;

export const pypi: Channel = {
  id: "pypi",
  label: "PyPI",
  category: "package",
  async check(name, ctx): Promise<CheckResult> {
    const normalized = normalizePypi(name);
    const base = {
      channel: this.id,
      label: this.label,
      url: `https://pypi.org/project/${normalized}/`,
    };
    if (!VALID.test(name)) {
      return {
        ...base,
        status: "unavailable",
        note: "PyPI names are letters, digits, and inner . _ -",
        url: undefined,
      };
    }
    const res = await get(ctx, `https://pypi.org/pypi/${normalized}/json`);
    if (res.status === 404) return { ...base, status: "available", certainty: "confirmed" };
    if (res.status !== 200)
      return { ...base, status: "unknown", note: `PyPI returned HTTP ${res.status}` };
    const { info } = (await res.json()) as {
      info: { name: string; summary?: string; version?: string };
    };
    return {
      ...base,
      status: "taken",
      note: info.summary || undefined,
      meta: { name: info.name, latest: info.version },
    };
  },
};
