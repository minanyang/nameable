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

/** A status code, a status with a JSON body, or an error to throw (a network failure). */
export type Reply = number | [number, unknown] | Error;

/** Replies consumed in order; the last one repeats. */
export const seq = (...replies: Reply[]) => ({ seq: replies });

/** A fetch that answers from a route table keyed by exact URL. Unrouted URLs fail the test loudly. */
export function fakeFetch(
  routes: Record<string, Reply | { seq: Reply[] }>,
): Fetch & { calls: string[] } {
  const queues = new Map(
    Object.entries(routes).map(([url, r]) => [
      url,
      typeof r === "object" && "seq" in r ? [...r.seq] : [r],
    ]),
  );
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const queue = queues.get(url);
    if (!queue) throw new Error(`unexpected request: ${url}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (reply instanceof Error) throw reply;
    const [status, body] = typeof reply === "number" ? [reply, {}] : reply;
    return new Response(JSON.stringify(body), { status });
  };
  return Object.assign(f, { calls });
}

/** Builds a Response from a reply, or throws the reply when it is an error. */
export function toResponse(reply: Reply): Response {
  if (reply instanceof Error) throw reply;
  const [status, body] = typeof reply === "number" ? [reply, {}] : reply;
  return new Response(JSON.stringify(body), { status });
}

/** A fetch that asks `respond` for every URL, for tests that describe a whole service rather than routes. */
export function fetchFrom(respond: (url: string) => Reply): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    return toResponse(respond(url));
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
