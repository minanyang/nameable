import type { Category, Channel, CheckResult, Context } from "./types.js";

/** What a channel's lookup reports; the framework adds `channel` and `label`. */
export type Finding = Omit<CheckResult, "channel" | "label">;

export type ChannelSpec = {
  id: string;
  label: string;
  category: Category;
  /**
   * The channel's own naming rules, checked before any request. Returns why the name breaks them,
   * or undefined when it is acceptable. Cite the rule's source next to the implementation.
   */
  rules(name: string): string | undefined;
  /**
   * Looks up a name that passed `rules`. Map only responses you understand; return `unexpected()` for
   * anything else. A thrown error becomes `unknown` in the runner, never `available`.
   */
  lookup(name: string, ctx: Context): Promise<Finding>;
};

/** Every channel is built with this, so validation, result shape and failure handling are uniform. */
export function defineChannel(spec: ChannelSpec): Channel {
  return {
    id: spec.id,
    label: spec.label,
    category: spec.category,
    async check(name, ctx): Promise<CheckResult> {
      const base = { channel: spec.id, label: spec.label };
      // A lone surrogate is not text any registry accepts, and it breaks URL encoding.
      if (/\p{Surrogate}/u.test(name)) {
        return { ...base, status: "unavailable", note: "names must be valid Unicode text" };
      }
      const problem = spec.rules(name);
      if (problem) return { ...base, status: "unavailable", note: problem };
      const result: CheckResult = { ...base, ...(await spec.lookup(name, ctx)) };
      // Registry text such as a package description can be null or empty; the result keeps its
      // documented shape, in which `url` and `note` are present only as text.
      for (const key of ["url", "note"] as const) {
        const value: unknown = result[key];
        if (typeof value !== "string" || !value.trim()) delete result[key];
      }
      return result;
    },
  };
}

/** The finding for a response the channel does not know how to read. */
export function unexpected(service: string, res: Response): Finding {
  return { status: "unknown", note: `${service} returned HTTP ${res.status}` };
}
