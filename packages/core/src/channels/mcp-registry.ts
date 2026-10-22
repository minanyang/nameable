import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** Every server in the mirror, one `name part\tfull name\tstatus` line each. */
async function serverList(ctx: Context): Promise<string> {
  const { DatabaseSync } = await sqlite();
  const res = await get(ctx, MIRROR, { timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`the MCP Registry mirror returned HTTP ${res.status}`);
  // SQLite opens files, so the copy goes to a temporary one for as long as it is read.
  const dir = await mkdtemp(join(tmpdir(), "nameable-mcp-"));
  let rows: unknown[];
  try {
    const file = join(dir, "registry.db");
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      rows = db.prepare("SELECT entry_name, status FROM servers").all();
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // A copy in another shape must fail the check, not read as an empty registry.
  const servers = rows as { entry_name?: unknown; status?: unknown }[];
  if (servers.length < 1000 || !servers.every((s) => typeof s.entry_name === "string")) {
    throw new Error("the MCP Registry mirror is not in the expected shape");
  }
  const lines = (servers as { entry_name: string; status: unknown }[]).flatMap((s) => {
    const part = s.entry_name.split("/")[1];
    return part ? [`${part.toLowerCase()}\t${s.entry_name}\t${String(s.status)}`] : [];
  });
  return `\n${lines.join("\n")}\n`;
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
      note: `no server uses this name in a community mirror of the registry from ${asOf(list)}`,
    };
  },
});
