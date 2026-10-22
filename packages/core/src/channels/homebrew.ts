import { defineChannel } from "../define.js";
import { get } from "../http.js";
import { asOf, cachedList, linesFor } from "../lists.js";
import type { Channel, Context } from "../types.js";

const API = "https://formulae.brew.sh/api";

// Library/Homebrew/formula_name_cask_token_auditor.rb, checked in the same order.
function auditorProblem(name: string): string | undefined {
  if (/[A-Z]/.test(name)) return "uppercase letters";
  if (/\s/.test(name)) return "whitespace";
  if (/[^\x20-\x7e]/.test(name)) return "non-ASCII characters";
  if (name.includes("--")) return "double hyphens";
  if (name.startsWith("@")) return "a leading @";
  if (name.endsWith("@")) return "a trailing @";
  if (name.startsWith("-")) return "a leading hyphen";
  if (name.endsWith("-")) return "a trailing hyphen";
  if ((name.match(/@/g) ?? []).length > 1) return "multiple @ symbols";
  if (name.includes("-@")) return "a hyphen followed by an @";
  if (name.includes("@-")) return "an @ followed by a hyphen";
  return undefined;
}

// Formulary.class_s (Library/Homebrew/formulary.rb): a formula loads as the Ruby constant this returns,
// so a name whose class is not a valid constant (a leading digit, `@` not before a version) cannot be one.
const formulaClass = (name: string) =>
  (name.charAt(0).toUpperCase() + name.slice(1))
    .replace(/[-_.\s]([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase())
    .replaceAll("+", "x")
    .replace(/(.)@(\d)/, "$1AT$2");
const CONSTANT = /^[A-Z]\w*$/;

// MissingFormula.disallowed_reason (Library/Homebrew/missing_formula.rb); the lzma pattern is unanchored there.
const DISALLOWED =
  /^(?:gem|rubygems?|pip|pil|macruby|gsutil|gfortran|play|haskell-platform|mysqldump-secure|ngrok|cargo|cargo-completion|uconv|postgresql|postgres)$/;
const disallowed = (name: string) => DISALLOWED.test(name) || /(?:lib)?lzma/.test(name);

/**
 * Every name homebrew/core and homebrew/cask hold: formulae with their aliases and old names, casks with
 * their old tokens, one `name\tkind\ttarget` line each (about 7 MB to download).
 */
async function nameList(ctx: Context): Promise<string> {
  const load = async (path: string) => {
    const res = await get(ctx, `${API}/${path}`, { timeoutMs: 120_000 });
    if (!res.ok) throw new Error(`Homebrew ${path} returned HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  // Renamed formulae keep their old names in `oldnames`; there is no separate renames file in the API.
  const [formulae, casks] = (await Promise.all([load("formula.json"), load("cask.json")])) as [
    { name: string; aliases: string[]; oldnames: string[] }[],
    { token: string; old_tokens: string[] }[],
  ];
  // A list in an unexpected shape must fail the check, not read as "no aliases at all": every entry
  // carries its name and the arrays of other names it holds.
  const isList = (x: unknown, key: string, arrays: string[]) =>
    Array.isArray(x) &&
    x.length > 0 &&
    x.every((e) => typeof e?.[key] === "string" && arrays.every((a) => Array.isArray(e[a])));
  if (
    !isList(formulae, "name", ["aliases", "oldnames"]) ||
    !isList(casks, "token", ["old_tokens"])
  ) {
    throw new Error("Homebrew name lists are not in the expected shape");
  }
  const lines: string[] = [];
  for (const f of formulae) {
    lines.push(`${f.name}\tformula\t${f.name}`);
    for (const a of f.aliases) lines.push(`${a}\talias\t${f.name}`);
    for (const o of f.oldnames) lines.push(`${o}\told name\t${f.name}`);
  }
  for (const c of casks) {
    lines.push(`${c.token}\tcask\t${c.token}`);
    for (const o of c.old_tokens) lines.push(`${o}\told cask token\t${c.token}`);
  }
  return `\n${lines.join("\n")}\n`;
}

// The checks `brew audit --strict` runs on a new homebrew/core formula name (FormulaAuditor#audit_name).
export const homebrew: Channel = defineChannel({
  id: "homebrew",
  label: "Homebrew",
  category: "package",
  // Only what can be looked up: casks hold names a new formula may not (1password, firefox@beta).
  rules: (name) =>
    /^[A-Za-z0-9@._+-]+$/.test(name)
      ? undefined
      : "Homebrew names are letters, digits and @ . _ + -",
  // A new formula's rules; a formula, cask or alias that already has the name is taken, not refused.
  refuses: (name) => {
    const problem = auditorProblem(name);
    if (problem) return `Homebrew names must not contain ${problem}`;
    if (!CONSTANT.test(formulaClass(name))) {
      return "Homebrew formula names start with a letter and use letters, digits, + . _ - and @ before a version";
    }
    if (disallowed(name)) return "homebrew/core does not allow this name";
    return undefined;
  },
  async lookup(name, ctx) {
    const [formula, cask] = await Promise.all([
      get(ctx, `${API}/formula/${name}.json`),
      get(ctx, `${API}/cask/${name}.json`),
    ]);
    // Either kind being present is proof enough, even if the other request failed.
    for (const [kind, res] of [
      ["formula", formula],
      ["cask", cask],
    ] as const) {
      if (res.status === 200) {
        const found = (await res.json()) as {
          name?: unknown;
          token?: unknown;
          desc?: string;
        } | null;
        // A formula has a name and a cask a token; anything else is not Homebrew's answer.
        if (typeof found?.name !== "string" && typeof found?.token !== "string") continue;
        const { desc } = found;
        return {
          status: "taken",
          url: `https://formulae.brew.sh/${kind}/${name}`,
          note: desc,
          meta: { kind },
        };
      }
    }
    // Anything but 404 from both, including a 200 that was not Homebrew's answer, leaves it unknown.
    if (formula.status !== 404 || cask.status !== 404) {
      return {
        status: "unknown",
        note: `Homebrew API returned HTTP ${formula.status}/${cask.status}`,
      };
    }

    // Aliases and old names 404 on the per-name API but still block a new formula.
    let list;
    try {
      list = await cachedList(ctx, "homebrew-names", () => nameList(ctx));
    } catch {
      return {
        status: "available",
        certainty: "probable",
        note: "could not download Homebrew's alias list to check aliases and old names",
      };
    }
    const [hit] = linesFor(list.text, name);
    if (hit) {
      const [kind, target] = hit as [string, string];
      const page = kind.includes("cask") ? "cask" : "formula";
      return {
        status: "taken",
        url: `https://formulae.brew.sh/${page}/${target}`,
        note: target === name ? undefined : `${kind} of ${target}`,
        meta: { kind, target },
      };
    }
    return list.stale
      ? {
          status: "available",
          certainty: "probable",
          note: `checked against Homebrew's names from ${asOf(list)}`,
        }
      : { status: "available", certainty: "confirmed", note: "no homebrew-core formula or cask" };
  },
});
