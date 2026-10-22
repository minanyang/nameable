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

const SIMPLE_JSON = "application/vnd.pypi.simple.v1+json";

/** Every project on PyPI, one `ultranormalized\tname` line each, from the simple index (about 10 MB). */
async function projectList(ctx: Context): Promise<string> {
  const res = await get(ctx, "https://pypi.org/simple/", {
    headers: { accept: SIMPLE_JSON },
    timeoutMs: 120_000,
  });
  if (!res.ok) throw new Error(`PyPI simple index returned HTTP ${res.status}`);
  // The index is large (about 45 MB of JSON for 900,000 projects): names are read from the stream as it
  // arrives, so memory holds the list being built rather than the whole document.
  if (!res.body) throw new Error("PyPI simple index has no body");
  const NAME = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  // One string per chunk, joined from an array: a million small strings, or a string grown with `+=`
  // (which V8 keeps as a rope of every piece), weigh several times their text.
  const parts: string[] = [];
  let count = 0;
  let projects = false;
  let carry = "";
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    const text = carry + chunk;
    projects ||= /"projects"\s*:\s*\[/.test(text);
    let end = 0;
    const found: string[] = [];
    NAME.lastIndex = 0;
    for (let m = NAME.exec(text); m; m = NAME.exec(text)) {
      const name = m[1]!.includes("\\") ? (JSON.parse(`"${m[1]}"`) as string) : m[1]!;
      found.push(`${ultranormalizePypi(name)}\t${name}`);
      end = NAME.lastIndex;
    }
    count += found.length;
    if (found.length) parts.push(`\n${found.join("\n")}`);
    // A match can straddle two chunks; keep the tail after the last one, which is never long.
    carry = text.slice(Math.max(end, text.length - 1024));
  }
  // An index in an unexpected shape must fail the check, not read as "no similar projects".
  if (!projects || !count) throw new Error("PyPI simple index is not in the expected shape");
  return `${parts.join("")}\n`;
}

// The rules are Warehouse's check_project_name (warehouse/packaging/services.py), except its
// admin-prohibited names, which are not public (see "certainty" in the README).
export const pypi: Channel = defineChannel({
  id: "pypi",
  label: "PyPI",
  category: "package",
  rules: (name) => {
    if (!VALID.test(name)) return "PyPI names are letters, digits, and inner . _ -";
    return undefined;
  },
  // Projects registered before the rule (asyncio, typing) keep their names.
  refuses: (name) =>
    PYPI_STDLIB.has(normalizePypi(name))
      ? "PyPI reserves Python standard library names"
      : undefined,
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

    // The JSON API also answers 404 for a project with no releases or a quarantined one; the simple
    // page of a single project does not filter either (Warehouse's ProjectFactory).
    const simple = await get(ctx, `https://pypi.org/simple/${normalized}/`, {
      headers: { accept: SIMPLE_JSON },
    });
    if (simple.status === 200) {
      const doc = (await simple.json()) as {
        name?: string;
        "project-status"?: { status?: string };
      };
      const state = doc["project-status"]?.status;
      return {
        status: "taken",
        url,
        note:
          state && state !== "active"
            ? `the project exists but is ${state}`
            : "the project exists but has no installable release",
        meta: { name: doc.name, state },
      };
    }
    if (simple.status !== 404) return unexpected("PyPI", simple);

    // The similar-name rule needs every project name. The full index leaves out quarantined projects,
    // so a name similar only to one of those is not caught.
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
