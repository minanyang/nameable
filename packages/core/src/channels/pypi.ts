import { PYPI_STDLIB } from "../data/pypi-stdlib.js";
import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import { asOf, cachedList, linesFor } from "../lists.js";
import type { Channel, Context } from "../types.js";

/** PEP 503: case-insensitive, runs of `-`, `_` and `.` are equivalent. */
export const normalizePypi = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

/**
 * Warehouse's `ultranormalize_name`: drops `. _ -`, then maps l/L/i/I to 1 and o/O to 0, so `f1ask`
 * collides with `flask`. PyPI refuses a new name whose ultranormalized form matches an existing project.
 */
export const ultranormalizePypi = (name: string): string =>
  name
    .replace(/[._-]/g, "")
    .replace(/[lLiI]/g, "1")
    .replace(/[oO]/g, "0")
    .toLowerCase();

// PEP 508 names: ASCII letters and digits, with . _ - allowed only between them.
const VALID = /^([a-z0-9]|[a-z0-9][a-z0-9._-]*[a-z0-9])$/i;

/** Every project on PyPI, one `ultranormalized\tname` line each, from the simple index (about 10 MB). */
async function projectList(ctx: Context): Promise<string> {
  const res = await get(ctx, "https://pypi.org/simple/", {
    headers: { accept: "application/vnd.pypi.simple.v1+json" },
    timeoutMs: 120_000,
  });
  if (!res.ok) throw new Error(`PyPI simple index returned HTTP ${res.status}`);
  const { projects } = (await res.json()) as { projects: { name: string }[] };
  // An index in an unexpected shape must fail the check, not read as "no similar projects".
  if (!Array.isArray(projects) || !projects.length || typeof projects[0]?.name !== "string") {
    throw new Error("PyPI simple index is not in the expected shape");
  }
  return `\n${projects.map((p) => `${ultranormalizePypi(p.name)}\t${p.name}`).join("\n")}\n`;
}

// The rules are Warehouse's check_project_name (warehouse/packaging/services.py), except its
// admin-prohibited names, which are not public.
export const pypi: Channel = defineChannel({
  id: "pypi",
  label: "PyPI",
  category: "package",
  rules: (name) => {
    if (!VALID.test(name)) return "PyPI names are letters, digits, and inner . _ -";
    if (PYPI_STDLIB.has(normalizePypi(name))) return "PyPI reserves Python standard library names";
    return undefined;
  },
  async lookup(name, ctx) {
    const normalized = normalizePypi(name);
    const url = `https://pypi.org/project/${normalized}/`;
    const res = await get(ctx, `https://pypi.org/pypi/${normalized}/json`);
    if (res.status === 200) {
      const { info } = (await res.json()) as {
        info: { name: string; summary?: string; version?: string };
      };
      return {
        status: "taken",
        url,
        note: info.summary || undefined,
        meta: { name: info.name, latest: info.version },
      };
    }
    if (res.status !== 404) return unexpected("PyPI", res);

    // The JSON API also answers 404 for a project with no releases or a quarantined one, and the
    // similar-name rule needs every project name, so both come from the full project list.
    let list;
    try {
      list = await cachedList(ctx, "pypi-projects", () => projectList(ctx));
    } catch {
      return {
        status: "available",
        certainty: "probable",
        note: "could not download PyPI's project list to check its similar-name rule",
      };
    }
    const matches = linesFor(list.text, ultranormalizePypi(name)).map(([n]) => n!);
    const same = matches.find((n) => normalizePypi(n) === normalized);
    if (same) {
      return {
        status: "taken",
        url,
        note: "the project exists but has no installable release",
        meta: { name: same },
      };
    }
    if (matches[0]) {
      return { status: "unavailable", note: `PyPI rejects names too similar to "${matches[0]}"` };
    }
    return list.stale
      ? {
          status: "available",
          certainty: "probable",
          note: `checked against PyPI's project list from ${asOf(list)}`,
        }
      : { status: "available", certainty: "confirmed" };
  },
});
