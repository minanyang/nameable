import { i as checkMany, l as selectChannels, r as channelIds, s as fileStore, t as DEFAULT_TLDS } from "./dist-CRL9h0G_.mjs";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
//#region src/mcp.ts
const result = z.object({
	channel: z.string(),
	label: z.string(),
	status: z.enum([
		"available",
		"reclaimable",
		"taken",
		"unavailable",
		"unknown"
	]),
	certainty: z.enum(["confirmed", "probable"]).optional(),
	url: z.string().optional(),
	note: z.string().optional(),
	meta: z.record(z.string(), z.unknown()).optional()
});
const output = z.object({
	schema: z.literal(1),
	reports: z.array(z.object({
		name: z.string(),
		results: z.array(result)
	}))
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
/** The MCP server: one read-only tool that runs the same checks as the CLI. */
function createMcpServer(deps) {
	const server = new McpServer({
		name: "nameable",
		version: deps.version
	});
	const fresh = () => ({
		cache: /* @__PURE__ */ new Map(),
		gates: /* @__PURE__ */ new Map()
	});
	let shared = fresh();
	let running = 0;
	server.registerTool("check_names", {
		title: "Check name availability",
		description: DESCRIPTION,
		inputSchema: z.object({
			names: z.array(z.string().refine((n) => n.trim() !== "", "names cannot be empty")).min(1).max(50).describe("Candidate names, checked on every selected channel"),
			channels: z.array(z.string()).min(1).optional().describe(`Channels to check (default: all). One of: ${channelIds().join(", ")}. "domain" means every TLD in tlds.`),
			tlds: z.array(z.string()).min(1).optional().describe(`TLDs for "domain", at most 20 (default: ${DEFAULT_TLDS.join(", ")})`),
			refresh: z.boolean().optional().describe("Download registry name lists again even when the cached copy is fresh")
		}),
		outputSchema: output,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: true
		}
	}, async ({ names, channels: only, tlds, refresh }) => {
		let channels;
		try {
			channels = selectChannels({
				only,
				tlds
			});
		} catch (err) {
			return {
				isError: true,
				content: [{
					type: "text",
					text: err.message
				}]
			};
		}
		running++;
		const structured = {
			schema: 1,
			reports: await checkMany([...new Set(names)], channels, {
				shared,
				fetch: deps.fetch,
				whois: deps.whois,
				githubToken: channels.some((c) => c.id === "github") ? await deps.githubToken?.() : void 0,
				store: deps.cacheDir ? fileStore(deps.cacheDir) : void 0,
				refresh
			}).finally(() => {
				if (--running === 0) shared = fresh();
			})
		};
		return {
			content: [{
				type: "text",
				text: JSON.stringify(structured)
			}],
			structuredContent: structured
		};
	});
	return server;
}
const reply = (code, message) => ({
	jsonrpc: "2.0",
	id: null,
	error: {
		code,
		message
	}
});
/**
* stdin with every line that is not JSON answered with a JSON-RPC parse error and taken out: the SDK
* skips such lines without a word, which leaves a client waiting for an answer that never comes.
*/
function screened(stdin, stdout) {
	let rest = "";
	const decoder = new TextDecoder();
	const screen = (lines) => lines.filter((line) => {
		if (!line.trim()) return true;
		try {
			JSON.parse(line);
			return true;
		} catch {
			stdout.write(`${JSON.stringify(reply(-32700, "Parse error"))}\n`);
			return false;
		}
	});
	return Readable.from((async function* () {
		for await (const chunk of stdin) {
			const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
			rest = lines.pop();
			const kept = screen(lines);
			if (kept.length) yield Buffer.from(`${kept.join("\n")}\n`);
		}
		rest += decoder.decode();
		if (rest) yield Buffer.from(`${screen([rest]).join("\n")}\n`);
	})());
}
/** Serves the MCP server over stdio, or over `transport` when given; it runs until the connection closes. */
function serveMcp(deps, transport) {
	const wire = transport ?? new StdioServerTransport(screened(process.stdin, process.stdout), process.stdout);
	serveStdio(() => createMcpServer(deps), {
		transport: wire,
		onerror: (error) => {
			if (error?.name !== "ZodError") return;
			wire.send(reply(-32600, "Invalid Request")).catch(() => void 0);
		}
	});
}
//#endregion
export { serveMcp };
