import { defineChannel } from "../define.js";
import { get } from "../http.js";
import { asOf, cachedList, linesFor } from "../lists.js";
import type { Channel, Context } from "../types.js";

// The official registry has no bulk export, and its search scans every server (30 s or more a query).
// scripts/mcp-servers.ts reads the registry API daily and publishes every server's name and status on
// this repository's `data` branch (about 2 MB, 0.5 MB as sent).
const MCP_SERVERS = "https://raw.githubusercontent.com/minanyang/nameable/data/mcp-servers.tsv";
const API = "https://registry.modelcontextprotocol.io/v0.1";
const HEADER = "#nameable-data mcp-servers v1";
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

// server.json `name` is `namespace/name`, the name part matching [a-zA-Z0-9._-]+ (openapi.yaml). The
// namespace is a domain or GitHub account the publisher proves, so nobody owns the name part itself:
// a match means another server already goes by it.
const VALID = /^[a-zA-Z0-9._-]+$/;

/**
 * Every server in the published list, one `name part\tfull name\tstatus` line each, then `#asof\t<time>`:
 * when the list was read from the registry.
 */
async function serverList(ctx: Context): Promise<string> {
  const res = await get(ctx, MCP_SERVERS, { timeoutMs: 60_000 });
  if (!res.ok) throw new Error(`the MCP Registry list returned HTTP ${res.status}`);
  const lines = (await res.text()).split("\n");
  // A file in another shape must fail the check, not read as an empty registry.
  const asOf = lines.find((l) => l.startsWith("#asof\t"))?.slice(6) ?? "";
  const servers = lines.slice(1).filter((l) => l && !l.startsWith("#"));
  // The last line counts the servers, so a list cut short is never read as complete.
  const end = lines.find((l) => l.startsWith("#end\t"))?.slice(5);
  if (
    lines[0] !== HEADER ||
    Number.isNaN(Date.parse(asOf)) ||
    servers.length < 1000 ||
    Number(end) !== servers.length
  ) {
    throw new Error("the MCP Registry list is not in the expected shape");
  }
  const rows = servers.flatMap((line) => {
    const [full, status] = line.split("\t");
    const part = full?.split("/")[1];
    return part && status ? [`${part.toLowerCase()}\t${full}\t${status}`] : [];
  });
  return `\n${rows.join("\n")}\n#asof\t${asOf}\n`;
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
    const list = await cachedList(ctx, "mcp-servers", () => serverList(ctx));
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
        note: `clash, not a block: ${who} this name; your own namespace can still publish it`,
        meta: { servers: servers.length, examples: servers.slice(0, 10).map(([s]) => s) },
      };
    }
    const time = linesFor(list.text, "#asof")[0]?.[0] || asOf(list);
    const date = time.slice(0, 10);
    // The list is rebuilt daily; an older one means the workflow that builds it has stopped.
    const behind = (ctx.now?.() ?? Date.now()) - Date.parse(time) > STALE_AFTER_MS;
    return {
      status: "available",
      certainty: "probable",
      note: `no server uses this name in the registry as of ${date}${behind ? ", and the list has not been updated since" : ""}`,
    };
  },
});
