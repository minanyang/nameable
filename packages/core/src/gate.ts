/**
 * Limits how many tasks run at once, and optionally how often one starts; a finishing task hands its
 * slot straight to the next waiter.
 */
export class Gate {
  #active = 0;
  #waiting: (() => void)[] = [];
  #nextStart = 0;

  constructor(
    readonly max: number,
    readonly intervalMs = 0,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active < this.max) this.#active++;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    if (this.intervalMs) {
      const now = Date.now();
      const at = Math.max(now, this.#nextStart);
      this.#nextStart = at + this.intervalMs;
      if (at > now) await new Promise((r) => setTimeout(r, at - now));
    }
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }
}

/** Per host: requests at once, and the least time between two starting. Whois servers ban bursts. */
const LIMITS: Record<string, { max: number; intervalMs?: number }> = {
  "registry.npmjs.org": { max: 8 },
  "api.github.com": { max: 4 },
  // The App Store search allows about 20 calls a minute.
  "itunes.apple.com": { max: 1, intervalMs: 1000 },
  // Google Play publishes no limit, so it is kept gentle.
  "play.google.com": { max: 2 },
  // RDAP for Google's TLDs (.dev, .app) allows about 10 requests in 5 seconds.
  "pubapi.registry.google": { max: 2, intervalMs: 600 },
};
const DEFAULT_LIMIT = 4;
export const WHOIS_LIMIT = 1;

/** The gate for `host`. Unpaced gates skip the intervals, for tests that fake every service. */
export function gateFor(gates: Map<string, Gate>, host: string, max?: number, paced = true): Gate {
  let gate = gates.get(host);
  if (!gate) {
    const limit = LIMITS[host];
    gate = new Gate(max ?? limit?.max ?? DEFAULT_LIMIT, paced ? (limit?.intervalMs ?? 0) : 0);
    gates.set(host, gate);
  }
  return gate;
}
