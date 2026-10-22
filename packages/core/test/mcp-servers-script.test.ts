import { describe, expect, it } from "vite-plus/test";
import {
  formatList,
  HEADER,
  merge,
  parseList,
  update,
  type ServerList,
} from "../../../scripts/mcp-servers.ts";
import { fakeFetch } from "./fake-fetch.js";

const API = "https://registry.modelcontextprotocol.io/v0.1/servers";
const entry = (name: string, status = "active") => ({
  server: { name },
  _meta: { "io.modelcontextprotocol.registry/official": { status } },
});
const many = (n: number) => Array.from({ length: n }, (_, i) => entry(`io.github.x/s${i}`));
const previous = (asOf: string, full = asOf): ServerList => ({
  servers: new Map(many(1000).map((e) => [e.server.name, "active"])),
  asOf,
  full,
});

describe("scripts/mcp-servers.ts", () => {
  it("writes a list it reads back", () => {
    const list = previous("2026-10-22T00:00:00.000Z");
    const text = formatList(list);
    expect(text.startsWith(`${HEADER}\n#asof\t2026-10-22T00:00:00.000Z\n`)).toBe(true);
    expect(parseList(text)).toEqual(list);
    expect(parseList("something else")).toBeUndefined();
    expect(parseList(`${HEADER}\na/b\tactive\n`)).toBeUndefined();
  });

  it("drops a deleted server and keeps a deprecated one with its status", () => {
    const servers = new Map([
      ["a/one", "active"],
      ["a/two", "active"],
    ]);
    merge(servers, [
      { name: "a/one", status: "deleted" },
      { name: "a/two", status: "deprecated" },
      { name: "a/three", status: "active" },
    ]);
    expect([...servers]).toEqual([
      ["a/two", "deprecated"],
      ["a/three", "active"],
    ]);
  });

  it("reads only the updates since the previous list, from a little before it", async () => {
    const fetch = fakeFetch({
      [`${API}?limit=100&version=latest&updated_since=2026-10-21T23%3A00%3A00.000Z`]: [
        200,
        { servers: [entry("io.github.x/s0", "deleted"), entry("a/new")], metadata: {} },
      ],
    });
    const next = await update(previous("2026-10-22T00:00:00.000Z", "2026-10-20T00:00:00.000Z"), {
      now: new Date("2026-10-23T00:00:00.000Z"),
      fetchFn: fetch,
    });
    expect(next.servers.has("io.github.x/s0")).toBe(false);
    expect(next.servers.get("a/new")).toBe("active");
    expect(next).toMatchObject({
      asOf: "2026-10-23T00:00:00.000Z",
      full: "2026-10-20T00:00:00.000Z",
    });
  });

  it("reads every server, page by page, once a week", async () => {
    const fetch = fakeFetch({
      [`${API}?limit=100&version=latest`]: [
        200,
        { servers: many(600), metadata: { nextCursor: "c1" } },
      ],
      [`${API}?limit=100&version=latest&cursor=c1`]: [
        200,
        { servers: many(1100).slice(600), metadata: {} },
      ],
    });
    const next = await update(previous("2026-10-22T00:00:00.000Z", "2026-10-15T00:00:00.000Z"), {
      now: new Date("2026-10-23T00:00:00.000Z"),
      fetchFn: fetch,
    });
    expect(next.servers.size).toBe(1100);
    expect(next.full).toBe("2026-10-23T00:00:00.000Z");
  });

  it("refuses to publish a list the registry answered with too few servers", async () => {
    const fetch = fakeFetch({
      [`${API}?limit=100&version=latest`]: [200, { servers: many(10), metadata: {} }],
    });
    await expect(update(undefined, { fetchFn: fetch })).rejects.toThrow("only 10 servers");
  });

  it("stops on a page that is not a server list", async () => {
    const fetch = fakeFetch({ [`${API}?limit=100&version=latest`]: [200, { error: "x" }] });
    await expect(update(undefined, { fetchFn: fetch })).rejects.toThrow("no server list");
  });
});
