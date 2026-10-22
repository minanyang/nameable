// Builds the list of MCP Registry servers the mcp-registry channel downloads: one `name\tstatus` line
// per server, from the official registry API. The registry has no bulk export and its search takes 30
// seconds or more, so .github/workflows/mcp-servers.yml runs this daily and publishes the result on the
// `data` branch. A day's run reads only the servers updated since the previous list (deleted ones
// included); once a week, or with --full, it reads every server again, so a missed change cannot last.
//
// Usage: node scripts/mcp-servers.ts <previous list, may be missing> <output> [--full]
import { readFile, writeFile } from "node:fs/promises";

const API = "https://registry.modelcontextprotocol.io/v0.1/servers";
export const HEADER = "#nameable-data mcp-servers v1";
const FULL_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
// Reading from a little before the previous run covers servers updated while it was paging.
const OVERLAP_MS = 60 * 60 * 1000;
// The registry holds well over this many; fewer means the API answered something else.
const MIN_SERVERS = 1000;

export type Update = { name: string; status: string };
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type ServerList = {
  servers: Map<string, string>;
  /** When the list was read from the registry (the start of that run). */
  asOf: string;
  /** When every server was last read, rather than only the updated ones. */
  full: string;
};

export function parseList(text: string): ServerList | undefined {
  const lines = text.split("\n");
  if (lines[0] !== HEADER) return undefined;
  const servers = new Map<string, string>();
  let asOf = "";
  let full = "";
  for (const line of lines.slice(1)) {
    const [name, value] = line.split("\t");
    if (!name || value === undefined) continue;
    if (name === "#asof") asOf = value;
    else if (name === "#full") full = value;
    else servers.set(name, value);
  }
  return asOf && full ? { servers, asOf, full } : undefined;
}

export function formatList({ servers, asOf, full }: ServerList): string {
  const names = [...servers.keys()].sort();
  return [
    HEADER,
    `#asof\t${asOf}`,
    `#full\t${full}`,
    ...names.map((n) => `${n}\t${servers.get(n)}`),
    "",
  ].join("\n");
}

/** Applies the registry's changes: a deleted server leaves the list, any other takes its new status. */
export function merge(servers: Map<string, string>, updates: Update[]): void {
  for (const { name, status } of updates) {
    if (status === "deleted") servers.delete(name);
    else servers.set(name, status);
  }
}

/** Every server's latest version, or those updated since `since`, as name and status. */
export async function readRegistry(since?: string, fetchFn: FetchFn = fetch): Promise<Update[]> {
  const found: Update[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: "100", version: "latest" });
    if (since) query.set("updated_since", since);
    if (cursor) query.set("cursor", cursor);
    const page = (await getJson(`${API}?${query}`, fetchFn)) as {
      servers?: { server?: { name?: unknown }; _meta?: Record<string, { status?: unknown }> }[];
      metadata?: { nextCursor?: unknown };
    };
    if (!Array.isArray(page.servers)) throw new Error("the registry returned no server list");
    for (const entry of page.servers) {
      const name = entry.server?.name;
      const status = entry._meta?.["io.modelcontextprotocol.registry/official"]?.status;
      if (typeof name !== "string" || typeof status !== "string") {
        throw new Error("the registry returned a server without a name or status");
      }
      found.push({ name, status });
    }
    cursor = typeof page.metadata?.nextCursor === "string" ? page.metadata.nextCursor : undefined;
  } while (cursor);
  return found;
}

/** A page, retried a few times through network errors, rate limits and server errors. */
async function getJson(url: string, fetchFn: FetchFn): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(60_000) }).catch(
      (err: unknown) => {
        if (attempt >= 5) throw err;
        return undefined;
      },
    );
    if (res?.ok) return await res.json();
    if (res && res.status < 500 && res.status !== 429)
      throw new Error(`HTTP ${res.status} for ${url}`);
    if (res && attempt >= 5) throw new Error(`HTTP ${res.status} for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
  }
}

/** The next list: the previous one with the registry's changes, or a full read when one is due. */
export async function update(
  previous: ServerList | undefined,
  { now = new Date(), full = false, fetchFn = fetch as FetchFn } = {},
): Promise<ServerList> {
  const asOf = now.toISOString();
  const due = !previous || full || now.getTime() - Date.parse(previous.full) >= FULL_EVERY_MS;
  let next: ServerList;
  if (due) {
    const servers = new Map<string, string>();
    merge(servers, await readRegistry(undefined, fetchFn));
    next = { servers, asOf, full: asOf };
  } else {
    const since = new Date(Date.parse(previous.asOf) - OVERLAP_MS).toISOString();
    const servers = new Map(previous.servers);
    merge(servers, await readRegistry(since, fetchFn));
    next = { servers, asOf, full: previous.full };
  }
  if (next.servers.size < MIN_SERVERS) {
    throw new Error(`only ${next.servers.size} servers; refusing to publish the list`);
  }
  return next;
}

if (import.meta.main) {
  const [previousPath, output, flag] = process.argv.slice(2);
  if (!previousPath || !output) {
    console.error("usage: node scripts/mcp-servers.ts <previous list> <output> [--full]");
    process.exit(64);
  }
  const previous = parseList(await readFile(previousPath, "utf8").catch(() => ""));
  const next = await update(previous, { full: flag === "--full" });
  await writeFile(output, formatList(next));
  const kind = next.full === next.asOf ? "full" : "incremental";
  console.log(`${next.servers.size} servers (${kind} read, as of ${next.asOf})`);
}
