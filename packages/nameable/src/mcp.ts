import { McpServer, type Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  channelIds,
  checkMany,
  DEFAULT_TLDS,
  fileStore,
  selectChannels,
  type Channel,
  type Fetch,
  type Whois,
} from "@nameable/core";
import * as z from "zod";

export type McpDeps = {
  version: string;
  githubToken?: () => Promise<string | undefined>;
  fetch?: Fetch;
  whois?: Whois;
  cacheDir?: string;
};

// Mirrors the CLI's JSON output, so an agent and a script read the same contract.
const result = z.object({
  channel: z.string(),
  label: z.string(),
  status: z.enum(["available", "reclaimable", "taken", "unavailable", "unknown"]),
  certainty: z.enum(["confirmed", "probable"]).optional(),
  url: z.string().optional(),
  note: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
const output = z.object({
  schema: z.literal(1),
  reports: z.array(z.object({ name: z.string(), results: z.array(result) })),
});

const DESCRIPTION = `Check whether names are free on package registries, GitHub and domains.

Each result has a status:
- available: nobody holds it and the registry would accept it. certainty "confirmed" means every rule
  that public data allows was checked; "probable" means one could not be, and note says which.
- reclaimable: held before but released; it can be taken again.
- taken: someone holds it; url shows who.
- unavailable: nobody holds it exactly, but the registry would refuse it (invalid, reserved, too
  similar to an existing name, or blocked for now after a deletion); note says why.
- unknown: no trustworthy answer (network error, rate limit). Never treat it as free.

Pick only the channels that matter for the project instead of checking everything.`;

/** The MCP server: one read-only tool that runs the same checks as the CLI. */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "nameable", version: deps.version });
  server.registerTool(
    "check_names",
    {
      title: "Check name availability",
      description: DESCRIPTION,
      inputSchema: z.object({
        names: z
          .array(z.string().refine((n) => n.trim() !== "", "names cannot be empty"))
          .min(1)
          .max(50)
          .describe("Candidate names, checked on every selected channel"),
        channels: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(
            `Channels to check (default: all). One of: ${channelIds().join(", ")}. "domain" means every TLD in tlds.`,
          ),
        tlds: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(`TLDs for "domain" (default: ${DEFAULT_TLDS.join(", ")})`),
        refresh: z
          .boolean()
          .optional()
          .describe("Download registry name lists again even when the cached copy is fresh"),
      }),
      outputSchema: output,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ names, channels: only, tlds, refresh }) => {
      let channels: Channel[];
      try {
        channels = selectChannels({ only, tlds });
      } catch (err) {
        // A bad channel or TLD is the caller's to fix, so it comes back as a tool error it can read.
        return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
      }
      const reports = await checkMany([...new Set(names)], channels, {
        fetch: deps.fetch,
        whois: deps.whois,
        githubToken: channels.some((c) => c.id === "github")
          ? await deps.githubToken?.()
          : undefined,
        store: deps.cacheDir ? fileStore(deps.cacheDir) : undefined,
        refresh,
      });
      const structured = { schema: 1 as const, reports };
      return {
        content: [{ type: "text", text: JSON.stringify(structured) }],
        structuredContent: structured,
      };
    },
  );
  return server;
}

/** Serves the MCP server over stdio, or over `transport` when given; it runs until the connection closes. */
export function serveMcp(deps: McpDeps, transport?: Transport): void {
  serveStdio(() => createMcpServer(deps), { transport });
}
