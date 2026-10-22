import { gateFor } from "./gate.js";
import type { Context } from "./types.js";

const USER_AGENT = "nameable (+https://www.npmjs.com/package/nameable)";

export type RequestOptions = {
  headers?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
  /** "manual" returns a redirect itself, for services where the redirect is the answer. */
  redirect?: RequestRedirect;
  /** Sends a POST with this body, for query APIs that only take one. Queries are safe to retry. */
  body?: string;
};

/** The longest `Retry-After` honored; a service asking for more is reported as rate limited instead. */
const MAX_RETRY_AFTER_MS = 10_000;

/** How long a 429 or 503 asks to wait, from its `Retry-After` header in seconds, when it says. */
function retryAfter(res: Response): number | undefined {
  // Number(null) and Number("") are 0, which would read a missing header as "retry at once".
  const header = res.headers.get("retry-after")?.trim();
  if (!header) return undefined;
  // Either seconds or an HTTP date, which has a weekday and month in letters. Anything else ("1.5")
  // is neither, and Date.parse would read it as some date anyway.
  const at = /[a-z]/i.test(header) ? Date.parse(header) : undefined;
  if (at !== undefined) return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * GET with a timeout and retries on network errors, 429 and 5xx (not on timeouts).
 * Returns the last response when retries run out on a retryable status, and throws when every attempt failed
 * at the network level, so callers never mistake a failure for a 404.
 */
export async function get(ctx: Context, url: string, opts: RequestOptions = {}): Promise<Response> {
  const { retries = 2, timeoutMs = 10_000 } = opts;
  const backoffMs = ctx.backoffMs ?? 500;
  const host = new URL(url).host;
  // Tests that set backoffMs to 0 fake every service, so nothing needs pacing.
  const gate = gateFor(ctx.gates, host, undefined, ctx.backoffMs !== 0);
  // A host that already timed out in this run is not waited on again: every request queued behind it
  // would otherwise take its full timeout too, and a run with many names would take minutes.
  const down = `down:${host}`;
  let lastError: unknown;
  let wait = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, Math.max(wait, backoffMs * 2 ** (attempt - 1))));
    }
    try {
      // The timeout starts once a slot is free, so queueing behind other requests never counts against it.
      const res = await gate.run(
        () => {
          if (ctx.cache.has(down)) {
            throw Object.assign(new Error(`${host} did not respond`), { name: "TimeoutError" });
          }
          return ctx
            .fetch(url, {
              headers: { "user-agent": USER_AGENT, ...opts.headers },
              redirect: opts.redirect,
              ...(opts.body === undefined ? {} : { method: "POST", body: opts.body }),
              signal: AbortSignal.timeout(timeoutMs),
            })
            .catch((err: unknown) => {
              // Marked before the slot passes to the next request in line, so that one sees it.
              if (err instanceof Error && err.name === "TimeoutError")
                ctx.cache.set(down, Promise.resolve());
              throw err;
            });
        },
        () => !ctx.cache.has(down),
      );
      if (!retryable(res.status) || attempt === retries) return res;
      // Honor a short Retry-After; waiting longer than a check should take is not worth it.
      const asked = retryAfter(res);
      if (asked !== undefined && asked > MAX_RETRY_AFTER_MS) return res;
      // A 429 without Retry-After still asks to slow down: wait longer than for a server error.
      const slowDown = res.status === 429 ? 2000 * 2 ** attempt : 0;
      wait = ctx.backoffMs === 0 ? 0 : (asked ?? slowDown);
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      // A slow service rarely answers faster on a second try; retrying would only multiply the wait.
      if (err instanceof Error && err.name === "TimeoutError") throw err;
      lastError = err;
    }
  }
  // Name the host: "fetch failed" alone does not say which of twenty services was unreachable.
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`could not reach ${host} (${reason})`);
}

export function memo<T>(ctx: Context, key: string, load: () => Promise<T>): Promise<T> {
  let hit = ctx.cache.get(key) as Promise<T> | undefined;
  if (!hit) {
    hit = load();
    ctx.cache.set(key, hit);
  }
  return hit;
}
