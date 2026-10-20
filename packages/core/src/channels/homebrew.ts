import { get } from "../http.js";
import type { Channel, CheckResult } from "../types.js";

const API = "https://formulae.brew.sh/api";

export const homebrew: Channel = {
  id: "homebrew",
  label: "Homebrew",
  category: "package",
  async check(name, ctx): Promise<CheckResult> {
    const base = { channel: this.id, label: this.label };
    const lower = name.toLowerCase();
    const [formula, cask] = await Promise.all([
      get(ctx, `${API}/formula/${lower}.json`),
      get(ctx, `${API}/cask/${lower}.json`),
    ]);
    if (formula.status === 200) {
      const { desc } = (await formula.json()) as { desc?: string };
      return { ...base, status: "taken", url: `https://formulae.brew.sh/formula/${lower}`, note: desc, meta: { kind: "formula" } };
    }
    if (cask.status === 200) {
      const { desc } = (await cask.json()) as { desc?: string };
      return { ...base, status: "taken", url: `https://formulae.brew.sh/cask/${lower}`, note: desc, meta: { kind: "cask" } };
    }
    if (formula.status === 404 && cask.status === 404) {
      return { ...base, status: "available", certainty: "confirmed", note: "no homebrew-core formula or cask" };
    }
    return { ...base, status: "unknown", note: `Homebrew API returned HTTP ${formula.status}/${cask.status}` };
  },
};
