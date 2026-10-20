import type { Channel, CheckResult, Context, Fetch } from "./types.js";

export type CheckOptions = {
  fetch?: Fetch;
  githubToken?: string;
  backoffMs?: number;
  /** Called as each channel finishes, so a UI can stream results. */
  onResult?: (result: CheckResult) => void;
};

/** Runs every channel concurrently. A channel that throws becomes `unknown`, never `available`. */
export async function check(
  name: string,
  channels: Channel[],
  opts: CheckOptions = {},
): Promise<CheckResult[]> {
  const ctx: Context = {
    fetch: opts.fetch ?? fetch,
    githubToken: opts.githubToken,
    cache: new Map(),
    backoffMs: opts.backoffMs,
  };
  return Promise.all(
    channels.map(async (channel) => {
      let result: CheckResult;
      try {
        result = await channel.check(name, ctx);
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        result = {
          channel: channel.id,
          label: channel.label,
          status: "unknown",
          note: timedOut
            ? "timed out"
            : `request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      opts.onResult?.(result);
      return result;
    }),
  );
}
