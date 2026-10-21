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

// Formulary.class_s turns a name into a Ruby class name; only these characters survive that.
const CHARSET = /^[a-z0-9@+._-]+$/;

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
    { name: string; aliases?: string[]; oldnames?: string[] }[],
    { token: string; old_tokens?: string[] }[],
  ];
  // A list in an unexpected shape must fail the check, not read as "no aliases at all".
  const isList = (x: unknown, key: string) =>
    Array.isArray(x) && x.length > 0 && x.every((e) => typeof e?.[key] === "string");
  if (!isList(formulae, "name") || !isList(casks, "token")) {
    throw new Error("Homebrew name lists are not in the expected shape");
  }
  const lines: string[] = [];
  for (const f of formulae) {
    lines.push(`${f.name}\tformula\t${f.name}`);
    for (const a of f.aliases ?? []) lines.push(`${a}\talias\t${f.name}`);
    for (const o of f.oldnames ?? []) lines.push(`${o}\told name\t${f.name}`);
  }
  for (const c of casks) {
    lines.push(`${c.token}\tcask\t${c.token}`);
    for (const o of c.old_tokens ?? []) lines.push(`${o}\told cask token\t${c.token}`);
  }
  return `\n${lines.join("\n")}\n`;
}

// The checks `brew audit --strict` runs on a new homebrew/core formula name (FormulaAuditor#audit_name).
export const homebrew: Channel = defineChannel({
  id: "homebrew",
  label: "Homebrew",
  category: "package",
  rules: (name) => {
    if (!name) return "Homebrew names cannot be empty";
    const problem = auditorProblem(name);
    if (problem) return `Homebrew names must not contain ${problem}`;
    if (!CHARSET.test(name)) return "Homebrew names use only letters, digits and @ + . _ -";
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
        const { desc } = (await res.json()) as { desc?: string };
        return {
          status: "taken",
          url: `https://formulae.brew.sh/${kind}/${name}`,
          note: desc,
          meta: { kind },
        };
      }
    }
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
