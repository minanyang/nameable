/** Limits how many tasks run at once; a finishing task hands its slot straight to the next waiter. */
export class Gate {
  #active = 0;
  #waiting: (() => void)[] = [];

  constructor(readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active < this.max) this.#active++;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }
}

/** Concurrent requests allowed per host. Whois servers ban bursts, so they get one. */
// The App Store search allows about 20 calls a minute; Google Play has no published limit, so keep it gentle.
const LIMITS: Record<string, number> = {
  "registry.npmjs.org": 8,
  "api.github.com": 4,
  "itunes.apple.com": 2,
  "play.google.com": 2,
};
const DEFAULT_LIMIT = 4;
export const WHOIS_LIMIT = 1;

export function gateFor(gates: Map<string, Gate>, host: string, max?: number): Gate {
  let gate = gates.get(host);
  if (!gate) {
    gate = new Gate(max ?? LIMITS[host] ?? DEFAULT_LIMIT);
    gates.set(host, gate);
  }
  return gate;
}
