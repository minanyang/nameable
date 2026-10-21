import { deflateRawSync } from "node:zlib";
import type { Fetch, Whois } from "../src/index.js";

/** A whois that answers from `"server query"` keys; anything else fails the test, so no real socket opens. */
export function fakeWhois(
  routes: Record<string, string | Error> = {},
): Whois & { calls: string[] } {
  const calls: string[] = [];
  const w = async (server: string, query: string) => {
    const key = `${server} ${query}`;
    calls.push(key);
    const reply = routes[key];
    if (reply === undefined) throw new Error(`unexpected whois: ${key}`);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return Object.assign(w, { calls });
}

/** A status code, a status with a JSON body, a ready response, or an error to throw (a network failure). */
export type Reply = number | [number, unknown] | Response | Error;

/** Request headers, for replies that depend on them (range requests). */
export type Headers = Record<string, string>;
const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Headers;

/** Replies consumed in order; the last one repeats. */
export const seq = (...replies: Reply[]) => ({ seq: replies });

/** A fetch that answers from a route table keyed by exact URL. Unrouted URLs fail the test loudly. */
export function fakeFetch(
  routes: Record<string, Reply | { seq: Reply[] } | ((headers: Headers) => Reply)>,
): Fetch & { calls: string[] } {
  const queues = new Map(
    Object.entries(routes).map(([url, r]) => [
      url,
      typeof r === "object" && "seq" in r ? [...r.seq] : [r],
    ]),
  );
  const calls: string[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push(url);
    const queue = queues.get(url);
    if (!queue) throw new Error(`unexpected request: ${url}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    return toResponse(typeof reply === "function" ? reply(headersOf(init)) : reply);
  };
  return Object.assign(f, { calls });
}

/** Builds a Response from a reply, or throws the reply when it is an error. */
export function toResponse(reply: Reply): Response {
  if (reply instanceof Error) throw reply;
  if (reply instanceof Response) return reply;
  const [status, body] = typeof reply === "number" ? [reply, {}] : reply;
  return new Response(JSON.stringify(body), { status });
}

/** A fetch that asks `respond` for every URL, for tests that describe a whole service rather than routes. */
export function fetchFrom(
  respond: (url: string, headers: Headers) => Reply,
): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push(url);
    return toResponse(respond(url, headersOf(init)));
  };
  return Object.assign(f, { calls });
}

/** A whois that asks `respond` for every query. */
export function whoisFrom(
  respond: (server: string, query: string) => string | Error,
): Whois & { calls: string[] } {
  const calls: string[] = [];
  const w = async (server: string, query: string) => {
    calls.push(`${server} ${query}`);
    const reply = respond(server, query);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return Object.assign(w, { calls });
}

/**
 * A zip archive holding `files`, laid out the way zip writers do: entries, directory, end record.
 * `method` 0 stores the files as they are; any other value deflates them and records that method.
 */
export function zipArchive(files: Record<string, string>, method = 8): Buffer {
  const locals: Buffer[] = [];
  const entries: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = method === 0 ? Buffer.from(text) : deflateRawSync(text);
    const fileName = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(text), 22);
    local.writeUInt16LE(fileName.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(Buffer.byteLength(text), 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    entries.push(entry, fileName);
    offset += 30 + fileName.length + data.length;
  }
  const directory = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Serves `body` the way a static file host does: 206 for a range (`a-b` or suffix `-n`), 200 without. */
export function rangeReply(body: Buffer, headers: Headers): Response {
  const range = /^bytes=(\d*)-(\d*)$/.exec(headers.range ?? "");
  if (!range) return new Response(new Uint8Array(body), { status: 200 });
  const [start, end] = range[1]
    ? [Number(range[1]), Math.min(Number(range[2] || body.length - 1), body.length - 1)]
    : [Math.max(0, body.length - Number(range[2])), body.length - 1];
  return new Response(new Uint8Array(body.subarray(start, end + 1)), { status: 206 });
}
