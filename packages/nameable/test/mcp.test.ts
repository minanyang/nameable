import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vite-plus/test";
import { fakeFetch } from "../../core/test/fake-fetch.js";
import { CRATES_DUMP, cratesDump } from "../../core/test/fixtures.js";
import { run } from "../src/run.js";

const CRATES = (name: string) => `https://crates.io/api/v1/crates/${name}`;

/** Starts `nameable mcp` on an in-memory transport and connects a client to it. */
async function connect(routes: Parameters<typeof fakeFetch>[0] = {}) {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const fetch = fakeFetch({ [CRATES_DUMP]: cratesDump(), ...routes });
  let stdout = "";
  const code = await run(["mcp"], {
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: () => undefined },
    interactive: false,
    color: false,
    fetch,
    mcpTransport: serverEnd,
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientEnd);
  return { client, code, stdout: () => stdout, fetch };
}

describe("nameable mcp", () => {
  it("serves one read-only check_names tool and writes nothing else to stdout", async () => {
    const { client, code, stdout } = await connect();
    const { tools } = await client.listTools();
    expect(code).toBe(0);
    expect(tools.map((t) => t.name)).toEqual(["check_names"]);
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tools[0]!.inputSchema.required).toEqual(["names"]);
    expect(tools[0]!.outputSchema).toBeDefined();
    // stdout is the MCP channel in production; anything else written there would corrupt it.
    expect(stdout()).toBe("");
  });

  it("returns the CLI's JSON contract as structured content and as text", async () => {
    const { client } = await connect({
      [CRATES("zz")]: 404,
      [CRATES("aa")]: [200, { crate: { name: "aa" } }],
    });
    const r = await client.callTool({
      name: "check_names",
      arguments: { names: ["zz", "aa", "zz"], channels: ["crates"] },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      schema: 1,
      reports: [
        {
          name: "zz",
          results: [{ channel: "crates", status: "available", certainty: "confirmed" }],
        },
        { name: "aa", results: [{ channel: "crates", status: "taken" }] },
      ],
    });
    const [text] = r.content as { type: string; text: string }[];
    expect(JSON.parse(text!.text)).toEqual(r.structuredContent);
  });

  it("refuses a name by the channel's rules without a request", async () => {
    const { client, fetch } = await connect();
    const r = await client.callTool({
      name: "check_names",
      arguments: { names: ["café"], channels: ["crates"] },
    });
    expect(r.structuredContent).toMatchObject({
      reports: [{ results: [{ status: "unavailable" }] }],
    });
    expect(fetch.calls).toEqual([]);
  });

  it.each([
    [{ names: ["zz"], channels: ["nope"] }, 'unknown channel "nope"'],
    [{ names: ["zz"], channels: ["domain"], tlds: ["co.uk"] }, "several labels"],
    [{ names: [] }, "names"],
    [{ names: [" "] }, "names cannot be empty"],
  ])("reports %j as a tool error the agent can read", async (args, message) => {
    const { client } = await connect();
    const r = await client.callTool({ name: "check_names", arguments: args });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[]).map((c) => c.text).join("\n")).toContain(message);
  });
});
