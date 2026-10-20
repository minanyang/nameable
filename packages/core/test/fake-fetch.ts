import type { Fetch } from "../src/index.js";

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
