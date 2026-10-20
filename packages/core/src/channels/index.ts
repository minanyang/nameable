import type { Channel } from "../types.js";
import { crates } from "./crates.js";
import { domain } from "./domain.js";
import { github } from "./github.js";
import { homebrew } from "./homebrew.js";
import { npm } from "./npm.js";
import { pypi } from "./pypi.js";

export const DEFAULT_TLDS: string[] = ["com", "dev"];

const fixed = [npm, pypi, crates, homebrew, github];

export type Selection = {
  /** Channel ids to keep: `npm`, `github`, `domain` (every TLD in `tlds`) or `domain:<tld>`. */
  only?: string[];
  tlds?: string[];
};

export function channelIds(): string[] {
  return [...fixed.map((c) => c.id), "domain", "domain:<tld>"];
}

export function selectChannels({ only, tlds = DEFAULT_TLDS }: Selection = {}): Channel[] {
  const all = [...fixed, ...tlds.map((t) => domain(t.replace(/^\./, "").toLowerCase()))];
  if (!only?.length) return all;

  const picked: Channel[] = [];
  for (const raw of only) {
    const id = raw.trim().toLowerCase();
    if (id === "domain") {
      picked.push(...all.filter((c) => c.category === "domain"));
    } else if (id.startsWith("domain:")) {
      picked.push(domain(id.slice("domain:".length).replace(/^\./, "")));
    } else {
      const channel = fixed.find((c) => c.id === id);
      if (!channel)
        throw new Error(`unknown channel "${raw}"; expected one of: ${channelIds().join(", ")}`);
      picked.push(channel);
    }
  }
  return picked.filter((c, i) => picked.findIndex((p) => p.id === c.id) === i);
}
