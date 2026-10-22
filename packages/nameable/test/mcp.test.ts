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

  it("counts a TLD written two ways once, as the CLI does", async () => {
    const { client } = await connect();
    const tlds = [...Array.from({ length: 19 }, (_, i) => `t${i}`), "com", ".com"];
    // Past the schema, the call fails on what it checks (no domain), not on the number of TLDs.
    const r = await client.callTool({
      name: "check_names",
      arguments: { names: ["zz"], channels: ["crates"], tlds },
    });
    expect(JSON.stringify(r.content)).toContain("TLDs apply to domains");
  });

  it("refuses TLDs for a call that checks no domain, as the CLI does", async () => {
    const { client } = await connect();
    const r = await client.callTool({
      name: "check_names",
      arguments: { names: ["zz"], channels: ["crates"], tlds: ["io"] },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("TLDs apply to domains");
  });

  it("downloads a list once for calls running at the same time, and again after they finish", async () => {
    const routes = { [CRATES("aa")]: 404, [CRATES("bb")]: 404 };
    const call = (client: Client, name: string) =>
      client.callTool({ name: "check_names", arguments: { names: [name], channels: ["crates"] } });
    const dump = (calls: string[]) => calls.filter((u) => u === CRATES_DUMP).length;

    const alone = await connect(routes);
    await call(alone.client, "aa");
    const once = dump(alone.fetch.calls);

    const { client, fetch } = await connect(routes);
    await Promise.all([call(client, "aa"), call(client, "bb")]);
    expect(dump(fetch.calls)).toBe(once);
    // No cache directory here, so a later call reads the list again rather than keeping it forever.
    await call(client, "aa");
    expect(dump(fetch.calls)).toBe(2 * once);
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

  it("keeps the output schema when a registry sends a null description", async () => {
    const api = "https://formulae.brew.sh/api";
    const { client } = await connect({
      [`${api}/formula/backlog.json`]: 404,
      [`${api}/cask/backlog.json`]: [200, { token: "backlog", desc: null }],
    });
    const r = await client.callTool({
      name: "check_names",
      arguments: { names: ["backlog"], channels: ["homebrew"] },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ reports: [{ results: [{ status: "taken" }] }] });
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
    // An empty list would check nothing, which an agent could read as "nothing is taken".
    [{ names: ["zz"], channels: [] }, "channels"],
    [{ names: ["zz"], channels: ["domain"], tlds: [] }, "tlds"],
    [
      { names: ["zz"], channels: ["domain"], tlds: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      "at most 20 TLDs",
    ],
  ])("reports %j as a tool error the agent can read", async (args, message) => {
    const { client } = await connect();
    const r = await client.callTool({ name: "check_names", arguments: args });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[]).map((c) => c.text).join("\n")).toContain(message);
  });
});
