import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineChannel } from "../define.js";
import { get } from "../http.js";
import { asOf, cachedList, linesFor } from "../lists.js";
import type { Channel, Context } from "../types.js";

// The official registry has no bulk export, and its search scans every server (30 s or more a query).
// This community mirror, listed in the registry's docs/community-projects.md, rebuilds a SQLite copy of
// every server's latest version each day (about 16 MB).
const MIRROR =
  "https://raw.githubusercontent.com/rosmur/official-mcp-registry-database/main/official_mcp_registry.db";
const API = "https://registry.modelcontextprotocol.io/v0.1";

// server.json `name` is `namespace/name`, the name part matching [a-zA-Z0-9._-]+ (openapi.yaml). The
// namespace is a domain or GitHub account the publisher proves, so nobody owns the name part itself:
// a match means another server already goes by it.
const VALID = /^[a-zA-Z0-9._-]+$/;

class NoSqlite extends Error {}

let loading: Promise<typeof import("node:sqlite")> | undefined;

/**
 * node:sqlite, without the experimental-feature warning Node 22 prints when it loads. Loaded once per
 * process, so concurrent checks never stack their own copies of the patched emitWarning.
 */
function sqlite(): Promise<typeof import("node:sqlite")> {
  loading ??= (async () => {
    // oxlint-disable-next-line typescript/unbound-method -- restored as the same function, never called unbound
    const original = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: never[]) => {
      if (!String(warning).includes("SQLite")) original.call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      return await import("node:sqlite");
    } catch {
      throw new NoSqlite("the MCP Registry check needs Node.js 22.13 or later");
    } finally {
      process.emitWarning = original;
    }
  })();
  return loading;
}

const TEMP_PREFIX = "nameable-mcp-";

/** Temporary copies older than an hour were left by a run that was interrupted (Ctrl-C) mid-read. */
async function sweepTemp(): Promise<void> {
  const entries = await readdir(tmpdir()).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((e) => e.startsWith(TEMP_PREFIX))
      .map(async (e) => {
        const path = join(tmpdir(), e);
        const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: Date.now() }));
        if (Date.now() - mtimeMs > 60 * 60 * 1000) await rm(path, { recursive: true, force: true });
      }),
  );
}

type Row = { entry_name?: unknown; status?: unknown };

/** The servers in a copy of the mirror, and the newest update it holds (when the mirror was built). */
async function readMirror(bytes: Uint8Array): Promise<{ rows: Row[]; newest: unknown }> {
  const { DatabaseSync } = await sqlite();
  const read = (db: InstanceType<typeof DatabaseSync>) => ({
    rows: db.prepare("SELECT entry_name, status FROM servers").all() as Row[],
    newest: db.prepare("SELECT MAX(updated_at) AS newest FROM servers").get()?.newest,
  });
  // Node 24 can open a database from memory; Node 22 needs a file, kept only while it is read.
  const memory = new DatabaseSync(":memory:");
  if (typeof memory.deserialize === "function") {
    try {
      memory.deserialize(bytes);
      return read(memory);
    } finally {
      memory.close();
    }
  }
  memory.close();
  await sweepTemp();
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const file = join(dir, "registry.db");
    await writeFile(file, bytes);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Every server in the mirror, one `name part\tfull name\tstatus` line each, then `#asof\t<date>`: the
 * newest update in the copy, which dates the mirror itself.
 */
async function serverList(ctx: Context): Promise<string> {
  await sqlite();
  const res = await get(ctx, MIRROR, { timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`the MCP Registry mirror returned HTTP ${res.status}`);
  const { rows, newest } = await readMirror(new Uint8Array(await res.arrayBuffer()));
  // A copy in another shape must fail the check, not read as an empty registry.
  if (rows.length < 1000 || !rows.every((s) => typeof s.entry_name === "string")) {
    throw new Error("the MCP Registry mirror is not in the expected shape");
  }
  const lines = (rows as { entry_name: string; status: unknown }[]).flatMap((s) => {
    const part = s.entry_name.split("/")[1];
    return part ? [`${part.toLowerCase()}\t${s.entry_name}\t${String(s.status)}`] : [];
  });
  const asOf = typeof newest === "string" ? newest.slice(0, 10) : "";
  return `\n${lines.join("\n")}\n#asof\t${asOf}\n`;
}

export const mcpRegistry: Channel = defineChannel({
  id: "mcp-registry",
  label: "MCP Registry",
  category: "agent",
  rules: (name) =>
    VALID.test(name)
      ? undefined
      : "MCP server names are letters, digits, dots, hyphens and underscores",
  async lookup(name, ctx) {
    let list;
    try {
      list = await cachedList(ctx, "mcp-servers", () => serverList(ctx));
    } catch (err) {
      if (err instanceof NoSqlite) return { status: "unknown", note: err.message };
      throw err;
    }
    // An active server leads, ahead of deprecated ones.
    const servers = linesFor(list.text, name.toLowerCase()).sort(
      (a, b) => Number(a[1] === "deprecated") - Number(b[1] === "deprecated"),
    );
    if (servers.length) {
      const [full, status] = servers[0]!;
      const lead = `${full}${status === "deprecated" ? " (deprecated)" : ""}`;
      const who =
        servers.length === 1 ? `${lead} uses` : `${lead} and ${servers.length - 1} more use`;
      return {
        status: "taken",
        url: `${API}/servers/${encodeURIComponent(full!)}/versions/latest`,
        note: `${who} this name; your own namespace can still publish it, but clients list servers by name`,
        meta: { servers: servers.length, examples: servers.slice(0, 10).map(([s]) => s) },
      };
    }
    return {
      status: "available",
      certainty: "probable",
      note: `no server uses this name in a community mirror of the registry from ${linesFor(list.text, "#asof")[0]?.[0] || asOf(list)}`,
    };
  },
});
