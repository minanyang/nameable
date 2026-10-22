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
   * Rules the registry applies only to new names (reserved words, names kept for its owners), checked
   * after `lookup` finds nobody holding the name, so a name published before the rule still shows as taken.
   */
  refuses?(name: string): string | undefined;
  /**
   * Looks up a name that passed `rules`. Map only responses you understand; return `unexpected()` for
   * anything else. A thrown error becomes `unknown` in the runner, never `available`.
   */
  lookup(name: string, ctx: Context): Promise<Finding>;
};

/**
 * A note on one line. Descriptions and error messages arrive with line breaks, indentation, stray
 * control characters and bidirectional controls that would reorder a terminal row.
 */
const clean = (note: string) =>
  note
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

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
      let result: CheckResult;
      try {
        result = { ...base, ...(await spec.lookup(name, ctx)) };
      } catch (err) {
        // A lookup that throws (a network error, a list it could not download) is handled by the runner,
        // unless a new-name rule applies: then the answer keeps both reasons, as below.
        const rule = spec.refuses?.(name);
        if (!rule) throw err;
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        const reason = timedOut ? "timed out" : err instanceof Error ? err.message : String(err);
        return {
          ...base,
          status: "unknown",
          note: clean(`${reason}; if nobody holds it, ${rule}`),
        };
      }
      const refused =
        result.status === "available" || result.status === "unknown"
          ? spec.refuses?.(name)
          : undefined;
      if (refused && result.status === "available")
        return { ...base, status: "unavailable", note: refused };
      // When the lookup failed the name may still be held, so it stays unknown, with both reasons.
      if (refused)
        result.note = `${result.note ?? "the lookup failed"}; if nobody holds it, ${refused}`;
      // Registry text such as a package description can be null or empty; the result keeps its
      // documented shape, in which `url` and `note` are present only as text.
      for (const key of ["url", "note"] as const) {
        const value: unknown = result[key];
        if (typeof value !== "string" || !value.trim()) delete result[key];
      }
      if (result.note) result.note = clean(result.note);
      return result;
    },
  };
}

/** The finding for a response the channel does not know how to read. */
export function unexpected(service: string, res: Response): Finding {
  return { status: "unknown", note: `${service} returned HTTP ${res.status}` };
}
