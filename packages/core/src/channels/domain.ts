import { domainToASCII } from "node:url";
import { get, memo } from "../http.js";
import { defineChannel, unexpected, type Finding } from "../define.js";
import type { Channel, Context } from "../types.js";
import { readWhois, whoisQuery, whoisServer } from "../whois.js";

const BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
// RFC 1035 labels (letters, digits, inner hyphens, at most 63), after IDNA conversion to punycode.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type Bootstrap = { services: [string[], string[]][] };

/** RDAP base URL for a TLD from IANA's bootstrap registry, or undefined when the TLD has no RDAP service. */
async function rdapBase(ctx: Context, tld: string): Promise<string | undefined> {
  const boot = await memo(ctx, BOOTSTRAP, async () => {
    const res = await get(ctx, BOOTSTRAP);
    if (!res.ok) throw new Error(`IANA RDAP bootstrap returned HTTP ${res.status}`);
    return (await res.json()) as Bootstrap;
  });
  const service = boot.services.find(([tlds]) => tlds.includes(tld));
  const url = service?.[1].find((u) => u.startsWith("https://")) ?? service?.[1][0];
  return url && (url.endsWith("/") ? url : `${url}/`);
}

async function viaWhois(ctx: Context, fqdn: string, tld: string, url: string): Promise<Finding> {
  const base = { url };
  const server = await whoisServer(ctx, tld);
  if (!server) return { ...base, status: "unknown", note: `.${tld} has neither RDAP nor whois` };
  const text = await whoisQuery(ctx, server, fqdn);
  const answer = readWhois(text);
  if (answer === "free") {
    return {
      ...base,
      status: "available",
      certainty: "probable",
      note: freeNote(tld, " (whois)"),
    };
  }
  if (answer === "registered") {
    const registered = /^\s*(?:creation date|created|registered on):\s*(\d{4}-\d{2}-\d{2})/im.exec(
      text,
    )?.[1];
    return {
      ...base,
      status: "taken",
      note: registered ? `registered ${registered} (whois)` : "registered (whois)",
      meta: { registered, whois: server },
    };
  }
  return { ...base, status: "unknown", note: `unrecognized whois answer from ${server}` };
}

/** Why a free answer is still only probable. IDN TLDs (`xn--…`) also limit which scripts they take. */
const freeNote = (tld: string, via: string) =>
  `not registered${via}; premium or reserved names can still be refused` +
  (tld.startsWith("xn--") ? ", and this TLD accepts only some scripts" : "") +
  ", confirm at a registrar";

/** `tld` is in its ASCII (punycode) form; `display` is how to show it. */
export function domain(tld: string, display: string = tld): Channel {
  return defineChannel({
    id: `domain:${tld}`,
    label: `.${display}`,
    category: "domain",
    // Internationalized names are registered in punycode (café → xn--caf-dma); this also lowercases.
    rules: (name) => {
      // IDNA2008 (RFC 5892) allows letters, marks and digits; Node's UTS-46 conversion would also turn
      // emoji and symbols into punycode that registries refuse. This approximates the PVALID table.
      if (/\P{ASCII}/u.test(name) && /[^\p{L}\p{M}\p{N}-]/u.test(name)) {
        return "internationalized domain labels may only use letters, marks and digits (no emoji or symbols)";
      }
      const ascii = domainToASCII(name);
      if (!LABEL.test(ascii)) return "domain labels are letters, digits and inner hyphens (max 63)";
      // RFC 5891: "--" in the 3rd and 4th position is reserved for punycode ("xn--").
      if (ascii.slice(2, 4) === "--" && !ascii.startsWith("xn--")) {
        return 'domain labels cannot have "--" in the 3rd and 4th position';
      }
      return undefined;
    },
    async lookup(name, ctx) {
      const fqdn = `${domainToASCII(name)}.${tld}`;
      const url = `https://lookup.icann.org/en/lookup?name=${fqdn}`;
      // Many ccTLDs (.io, .sh, .co, .me, .de, .jp) have no RDAP service; whois answers for them.
      const rdap = await rdapBase(ctx, tld).catch(() => undefined);
      if (!rdap) return viaWhois(ctx, fqdn, tld, url);
      const res = await get(ctx, `${rdap}domain/${fqdn}`, {
        headers: { accept: "application/rdap+json" },
      });
      if (res.status === 404) {
        return {
          status: "available",
          certainty: "probable",
          url,
          note: freeNote(tld, ""),
        };
      }
      if (res.status !== 200) return { ...unexpected("RDAP", res), url };
      const doc = (await res.json()) as { events?: { eventAction: string; eventDate: string }[] };
      const event = (action: string) =>
        doc.events?.find((e) => e.eventAction === action)?.eventDate.slice(0, 10);
      const registered = event("registration");
      const expires = event("expiration");
      return {
        status: "taken",
        url,
        note:
          [registered && `registered ${registered}`, expires && `expires ${expires}`]
            .filter(Boolean)
            .join(", ") || undefined,
        meta: { registered, expires },
      };
    },
  });
}
