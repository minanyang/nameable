import { domainToASCII } from "node:url";
import type { Channel } from "../types.js";
import { claudePlugins } from "./claude-plugins.js";
import { crates } from "./crates.js";
import { domain } from "./domain.js";
import { github } from "./github.js";
import { homebrew } from "./homebrew.js";
import { npm } from "./npm.js";
import { pypi } from "./pypi.js";
import { smithery } from "./smithery.js";

export const DEFAULT_TLDS: string[] = ["com", "dev"];

const fixed = [npm, pypi, crates, homebrew, github, smithery, claudePlugins];

export type Selection = {
  /** Channel ids to keep: `npm`, `github`, `domain` (every TLD in `tlds`) or `domain:<tld>`. */
  only?: string[];
  tlds?: string[];
};

export function channelIds(): string[] {
  return [...fixed.map((c) => c.id), "domain", "domain:<tld>"];
}

/** A domain channel for a TLD as typed (`.dev`, `COM`, `рф`), or an error for one it cannot check. */
function domainFor(raw: string): Channel {
  const display = raw.trim().replace(/^\./, "").toLowerCase();
  if (!display) throw new Error("a domain channel needs a TLD, as in domain:dev");
  if (display.includes(".")) {
    throw new Error(`"${display}" has several labels; only top-level domains are supported`);
  }
  const ascii = domainToASCII(display);
  if (!ascii) throw new Error(`"${display}" is not a valid TLD`);
  return domain(ascii, display);
}

const unique = (channels: Channel[]) =>
  channels.filter((c, i) => channels.findIndex((p) => p.id === c.id) === i);

export function selectChannels({ only, tlds = DEFAULT_TLDS }: Selection = {}): Channel[] {
  const all = unique([...fixed, ...tlds.map(domainFor)]);
  if (!only?.length) return all;

  const picked: Channel[] = [];
  for (const raw of only) {
    const id = raw.trim().toLowerCase();
    if (id === "domain") {
      picked.push(...all.filter((c) => c.category === "domain"));
    } else if (id.startsWith("domain:")) {
      picked.push(domainFor(raw.trim().slice("domain:".length)));
    } else {
      const channel = fixed.find((c) => c.id === id);
      if (!channel)
        throw new Error(`unknown channel "${raw}"; expected one of: ${channelIds().join(", ")}`);
      picked.push(channel);
    }
  }
  return unique(picked);
}
