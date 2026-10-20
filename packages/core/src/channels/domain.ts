import { get, memo } from "../http.js";
import type { Channel, CheckResult, Context } from "../types.js";
import { readWhois, whoisQuery, whoisServer } from "../whois.js";

const BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
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

type Base = { channel: string; label: string; url: string };

async function viaWhois(ctx: Context, fqdn: string, tld: string, base: Base): Promise<CheckResult> {
  const server = await whoisServer(ctx, tld);
  if (!server) return { ...base, status: "unknown", note: `.${tld} has neither RDAP nor whois` };
  const text = await whoisQuery(ctx, server, fqdn);
  const answer = readWhois(text);
  if (answer === "free") {
    return {
      ...base,
      status: "available",
      certainty: "probable",
      note: "not registered (whois); premium or reserved names can still be refused, confirm at a registrar",
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

export function domain(tld: string): Channel {
  return {
    id: `domain:${tld}`,
    label: `.${tld}`,
    category: "domain",
    async check(name, ctx): Promise<CheckResult> {
      const fqdn = `${name.toLowerCase()}.${tld}`;
      const base = {
        channel: this.id,
        label: this.label,
        url: `https://lookup.icann.org/en/lookup?name=${fqdn}`,
      };
      if (!LABEL.test(name.toLowerCase())) {
        return {
          ...base,
          status: "unavailable",
          note: "domain labels are letters, digits and inner hyphens (max 63)",
        };
      }
      // Many ccTLDs (.io, .sh, .co, .me, .de, .jp) have no RDAP service; whois answers for them.
      const rdap = await rdapBase(ctx, tld).catch(() => undefined);
      if (!rdap) return viaWhois(ctx, fqdn, tld, base);
      const res = await get(ctx, `${rdap}domain/${fqdn}`, {
        headers: { accept: "application/rdap+json" },
      });
      if (res.status === 404) {
        return {
          ...base,
          status: "available",
          certainty: "probable",
          note: "not registered; premium or reserved names can still be refused, confirm at a registrar",
        };
      }
      if (res.status !== 200)
        return { ...base, status: "unknown", note: `RDAP returned HTTP ${res.status}` };
      const doc = (await res.json()) as { events?: { eventAction: string; eventDate: string }[] };
      const event = (action: string) =>
        doc.events?.find((e) => e.eventAction === action)?.eventDate.slice(0, 10);
      const registered = event("registration");
      const expires = event("expiration");
      return {
        ...base,
        status: "taken",
        note:
          [registered && `registered ${registered}`, expires && `expires ${expires}`]
            .filter(Boolean)
            .join(", ") || undefined,
        meta: { registered, expires },
      };
    },
  };
}
