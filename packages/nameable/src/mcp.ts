import { Readable } from "node:stream";
import { McpServer, type Transport } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  channelIds,
  checkMany,
  DEFAULT_TLDS,
  fileStore,
  MAX_TLDS,
  selectChannels,
  type Channel,
  type CheckOptions,
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

const DESCRIPTION = `Check whether names are free on package registries, GitHub, agent and editor directories, app stores and domains.

Each result has a status:
- available: nobody holds it and the registry would accept it. certainty "confirmed" means every rule
  that public data allows was checked; "probable" means one could not be, and note says which.
- reclaimable: held before but released; it can be taken again.
- taken: someone holds it; url shows who. Where names are not exclusive (MCP Registry, Google Play, Gemini
  CLI gallery) it means another entry uses the name, and note says it does not block a new one.
- unavailable: nobody holds it exactly, but the registry would refuse it (invalid, reserved, too
  similar to an existing name, or blocked for now after a deletion); note says why.
- unknown: no trustworthy answer (network error, rate limit). Never treat it as free.

Pick only the channels that matter for the project instead of checking everything.`;

/**
 * An optional list as given, or undefined when it holds nothing but blanks: form-based clients send a
 * list left blank as [] or [""] instead of leaving it out.
 */
const given = (list?: string[]) => {
  const kept = list?.filter((item) => item.trim() !== "");
  return kept?.length ? kept : undefined;
};

/** The MCP server: one read-only tool that runs the same checks as the CLI. */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "nameable", version: deps.version });
  // Calls running at once share downloads and per-host limits. Once none is running the state is
  // dropped, so a server left running for days still reads fresh lists and retries hosts that failed.
  const fresh = (): NonNullable<CheckOptions["shared"]> => ({ cache: new Map(), gates: new Map() });
  let shared = fresh();
  let running = 0;
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
          .optional()
          .describe(
            `Channels to check (default: all). One of: ${channelIds().join(", ")}. "domain" means every TLD in tlds.`,
          ),
        tlds: z
          .array(z.string())
          .optional()
          // The limit is counted after "com" and ".com" are taken as one, as the CLI counts it.
          .describe(`TLDs for "domain", at most ${MAX_TLDS} (default: ${DEFAULT_TLDS.join(", ")})`),
        refresh: z
          .boolean()
          .optional()
          .describe("Download registry name lists again even when the cached copy is fresh"),
      }),
      outputSchema: output,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ names, channels: only, tlds, refresh }) => {
      let channels: Channel[];
      try {
        channels = selectChannels({ only: given(only), tlds: given(tlds) });
      } catch (err) {
        // A bad channel or TLD is the caller's to fix, so it comes back as a tool error it can read.
        return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
      }
      running++;
      const reports = await checkMany([...new Set(names)], channels, {
        shared,
        fetch: deps.fetch,
        whois: deps.whois,
        githubToken: channels.some((c) => c.id === "github")
          ? await deps.githubToken?.()
          : undefined,
        store: deps.cacheDir ? fileStore(deps.cacheDir) : undefined,
        refresh,
      }).finally(() => {
        if (--running === 0) shared = fresh();
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

const reply = (code: number, message: string) =>
  ({ jsonrpc: "2.0", id: null, error: { code, message } }) as const;

/**
 * stdin with every line that is not JSON answered with a JSON-RPC parse error and taken out: the SDK
 * skips such lines without a word, which leaves a client waiting for an answer that never comes.
 */
function screened(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): Readable {
  let rest = "";
  // Decoded as a stream: a character split between two chunks must not turn into replacement marks.
  const decoder = new TextDecoder();
  const screen = (lines: string[]) =>
    lines.filter((line) => {
      if (!line.trim()) return true;
      try {
        JSON.parse(line);
        return true;
      } catch {
        stdout.write(`${JSON.stringify(reply(-32700, "Parse error"))}\n`);
        return false;
      }
    });
  return Readable.from(
    (async function* () {
      for await (const chunk of stdin) {
        const lines = (rest + decoder.decode(chunk as Uint8Array, { stream: true })).split("\n");
        rest = lines.pop()!;
        const kept = screen(lines);
        // The SDK's read buffer takes bytes, not strings.
        if (kept.length) yield Buffer.from(`${kept.join("\n")}\n`);
      }
      rest += decoder.decode();
      if (rest) yield Buffer.from(`${screen([rest]).join("\n")}\n`);
    })(),
  );
}

/** Serves the MCP server over stdio, or over `transport` when given; it runs until the connection closes. */
export function serveMcp(deps: McpDeps, transport?: Transport): void {
  const wire =
    transport ?? new StdioServerTransport(screened(process.stdin, process.stdout), process.stdout);
  serveStdio(() => createMcpServer(deps), {
    transport: wire,
    // JSON that is not a JSON-RPC message (`42`, `[]`) reaches here; the SDK would drop it unanswered.
    // Only that error is answered: any other (a failed write, say) answered in turn could loop.
    onerror: (error) => {
      if (error?.name !== "ZodError") return;
      wire.send(reply(-32600, "Invalid Request") as never).catch(() => undefined);
    },
  });
}
