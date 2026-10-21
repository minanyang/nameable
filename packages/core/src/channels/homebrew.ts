import { defineChannel } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";

const API = "https://formulae.brew.sh/api";
// Formula and cask names are lowercase; formulae also use @ (versions), + and . (`openssl@3`, `c++`).
const VALID = /^[a-z0-9][a-z0-9@+._-]*$/;

export const homebrew: Channel = defineChannel({
  id: "homebrew",
  label: "Homebrew",
  category: "package",
  rules: (name) =>
    VALID.test(name.toLowerCase())
      ? undefined
      : "Homebrew names are letters, digits and - _ . + @, starting with a letter or digit",
  async lookup(name, ctx) {
    const lower = name.toLowerCase();
    const [formula, cask] = await Promise.all([
      get(ctx, `${API}/formula/${lower}.json`),
      get(ctx, `${API}/cask/${lower}.json`),
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
          url: `https://formulae.brew.sh/${kind}/${lower}`,
          note: desc,
          meta: { kind },
        };
      }
    }
    if (formula.status === 404 && cask.status === 404) {
      return {
        status: "available",
        certainty: "confirmed",
        note: "no homebrew-core formula or cask",
      };
    }
    return {
      status: "unknown",
      note: `Homebrew API returned HTTP ${formula.status}/${cask.status}`,
    };
  },
});
