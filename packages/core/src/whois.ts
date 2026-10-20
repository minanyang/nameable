import { connect } from "node:net";
import { gateFor, WHOIS_LIMIT } from "./gate.js";
import { memo } from "./http.js";
import type { Context, Whois } from "./types.js";

const IANA = "whois.iana.org";

/** Plain whois over TCP port 43. */
export const tcpWhois: Whois = (server, query) =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: server, port: 43, timeout: 10_000 }, () => {
      socket.write(`${query}\r\n`);
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("timeout", () => {
      socket.destroy();
      reject(Object.assign(new Error(`whois ${server} timed out`), { name: "TimeoutError" }));
    });
    socket.on("error", reject);
  });

/** One query, at most one at a time per server: whois servers ban bursts. */
export function whoisQuery(ctx: Context, server: string, query: string): Promise<string> {
  return gateFor(ctx.gates, `whois:${server}`, WHOIS_LIMIT).run(() => ctx.whois(server, query));
}

/** The registry's whois server for a TLD, as IANA refers it, or undefined when it lists none. */
export function whoisServer(ctx: Context, tld: string): Promise<string | undefined> {
  return memo(ctx, `whois-server:${tld}`, async () => {
    const text = await whoisQuery(ctx, IANA, tld);
    return /^whois:\s*(\S+)/im.exec(text)?.[1];
  });
}

// Each pattern matches the start of a line, after notices and disclaimers are removed, so legal text
// that happens to say "not found" cannot make a registered domain look free. "Free" is checked first
// because some answers for a free name echo it back (.so: "Domain Name: x.so" then "No Object Found").
const FREE = [
  /^domain not found/im,
  /^not found/im,
  /^no match/im,
  /^no data found/im,
  /^no entries found/im,
  /^the queried object does not exist/im,
  /^status:\s*free\s*$/im,
];
const REGISTERED = [/^domain name:\s*\S/im, /^domain:\s*\S/im, /^\[domain name\]\s*\S/im];
const NOTICE = /^\s*(%|#|>>>|\[ |NOTICE|TERMS)/;

export type WhoisAnswer = "free" | "registered" | "unrecognized";

export function readWhois(text: string): WhoisAnswer {
  const body = text
    .split(/\r?\n/)
    .filter((line) => !NOTICE.test(line))
    .map((line) => line.trim())
    .join("\n");
  if (FREE.some((re) => re.test(body))) return "free";
  if (REGISTERED.some((re) => re.test(body))) return "registered";
  return "unrecognized";
}
