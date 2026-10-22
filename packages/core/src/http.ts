import { gateFor } from "./gate.js";
import type { Context } from "./types.js";

const USER_AGENT = "nameable (+https://www.npmjs.com/package/nameable)";

export type RequestOptions = {
  headers?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
  /** "manual" returns a redirect itself, for services where the redirect is the answer. */
  redirect?: RequestRedirect;
};

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
  const gate = gateFor(ctx.gates, new URL(url).host);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
    try {
      // The timeout starts once a slot is free, so queueing behind other requests never counts against it.
      const res = await gate.run(() =>
        ctx.fetch(url, {
          headers: { "user-agent": USER_AGENT, ...opts.headers },
          redirect: opts.redirect,
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
      if (!retryable(res.status) || attempt === retries) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      // A slow service rarely answers faster on a second try; retrying would only multiply the wait.
      if (err instanceof Error && err.name === "TimeoutError") throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function memo<T>(ctx: Context, key: string, load: () => Promise<T>): Promise<T> {
  let hit = ctx.cache.get(key) as Promise<T> | undefined;
  if (!hit) {
    hit = load();
    ctx.cache.set(key, hit);
  }
  return hit;
}
