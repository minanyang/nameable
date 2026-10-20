/**
 * - available: nobody holds the name and it passes the channel's naming rules
 * - taken: someone holds it
 * - reclaimable: it was held but released (e.g. an unpublished npm package); anyone may take it again
 * - unavailable: nobody holds it exactly, but the channel would refuse it (invalid, too similar, reserved)
 * - unknown: the check did not produce a trustworthy answer (network error, rate limit, unsupported)
 */
export type Status = "available" | "taken" | "reclaimable" | "unavailable" | "unknown";

/** "probable" marks an `available` the channel cannot fully prove, e.g. GitHub hides suspended accounts. */
export type Certainty = "confirmed" | "probable";

export type Category = "package" | "code" | "domain";

export type CheckResult = {
  channel: string;
  label: string;
  status: Status;
  certainty?: Certainty;
  /** A page a human can open to see the evidence. */
  url?: string;
  note?: string;
  meta?: Record<string, unknown>;
};

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type Context = {
  fetch: Fetch;
  githubToken?: string;
  /** Per-run memo for shared lookups such as the RDAP bootstrap file. */
  cache: Map<string, Promise<unknown>>;
  /** Base delay for retry backoff; tests set it to 0. */
  backoffMs?: number;
};

export type Channel = {
  id: string;
  label: string;
  category: Category;
  check(name: string, ctx: Context): Promise<CheckResult>;
};
