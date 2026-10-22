import type { Channel, CheckResult, Context, Fetch, Report, Whois } from "./types.js";
import type { Store } from "./store.js";
import { tcpWhois } from "./tcp-whois.js";

export type CheckOptions = {
  fetch?: Fetch;
  whois?: Whois;
  githubToken?: string;
  backoffMs?: number;
  /** Keeps downloaded name lists between runs. */
  store?: Store;
  /** Download name lists even when the stored copy is fresh. */
  refresh?: boolean;
  now?: () => number;
  /**
   * Lookups and per-host limits to share with checks running at the same time (an MCP server handling
   * several calls), so they download each list once and pace each host together.
   */
  shared?: Pick<Context, "cache" | "gates">;
  /** Called as each channel finishes for a name, so a UI can stream results. */
  onResult?: (name: string, result: CheckResult) => void;
};

function createContext(opts: CheckOptions): Context {
  return {
    fetch: opts.fetch ?? fetch,
    whois: opts.whois ?? tcpWhois,
    githubToken: opts.githubToken,
    cache: opts.shared?.cache ?? new Map(),
    gates: opts.shared?.gates ?? new Map(),
    backoffMs: opts.backoffMs,
    store: opts.store,
    refresh: opts.refresh,
    now: opts.now,
  };
}

async function run(
  name: string,
  channel: Channel,
  ctx: Context,
  onResult: CheckOptions["onResult"],
): Promise<CheckResult> {
  let result: CheckResult;
  try {
    result = await channel.check(name, ctx);
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    result = {
      channel: channel.id,
      label: channel.label,
      status: "unknown",
      note: timedOut ? "timed out" : err instanceof Error ? err.message : String(err),
    };
  }
  onResult?.(name, result);
  return result;
}

/**
 * Checks every name on every channel concurrently, sharing lookups and per-host limits across names.
 * A channel that throws becomes `unknown`, never `available`.
 */
export function checkMany(
  names: string[],
  channels: Channel[],
  opts: CheckOptions = {},
): Promise<Report[]> {
  const ctx = createContext(opts);
  return Promise.all(
    names.map(async (name) => ({
      name,
      results: await Promise.all(channels.map((c) => run(name, c, ctx, opts.onResult))),
    })),
  );
}

export async function check(
  name: string,
  channels: Channel[],
  opts: CheckOptions = {},
): Promise<CheckResult[]> {
  const [report] = await checkMany([name], channels, opts);
  return report!.results;
}
