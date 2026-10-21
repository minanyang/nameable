import { selectChannels, type Channel } from "../src/index.js";
import type { Reply } from "./fake-fetch.js";

/**
 * The standard inputs every channel is checked against. Adding a channel means deciding, for each one,
 * whether the channel accepts it — there is no default, so no class can be forgotten.
 */
export const INPUTS = {
  typical: "nameable",
  uppercase: "NameAble",
  digits: "name2go",
  leadingDigit: "2name",
  hyphen: "name-able",
  doubleHyphen: "name--able",
  // Hyphens in the 3rd and 4th position are reserved in domain labels (RFC 5891) unless punycode.
  reservedHyphens: "ab--cd",
  underscore: "name_able",
  dot: "name.able",
  leadingHyphen: "-nameable",
  trailingHyphen: "nameable-",
  single: "n",
  unicode: "café",
  space: "name able",
  empty: "",
} as const;

export type InputClass = keyof typeof INPUTS;

/** A whole fake service: what every HTTP request and whois query gets. */
export type Service = {
  http: (url: string) => Reply;
  whois: (server: string, query: string) => string | Error;
};

export type Fixture = {
  channel: Channel;
  /** A service under which every name is free. */
  free: Service;
  /** A service under which every name is held. */
  taken: Service;
  accepts: Record<InputClass, boolean>;
  /** The longest name the channel accepts, when it has a limit. */
  maxLength?: number;
};

const noWhois = (server: string, query: string) =>
  new Error(`unexpected whois: ${server} ${query}`);
const only = (id: string) => selectChannels({ only: [id] })[0]!;

const BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
const bootstrap: Reply = [200, { services: [[["dev"], ["https://rdap.example/"]]] }];

export const FIXTURES: Fixture[] = [
  {
    channel: only("npm"),
    free: {
      http: (u) => (u.includes("/-/v1/search") ? [200, { objects: [] }] : 404),
      whois: noWhois,
    },
    taken: {
      http: () => [200, { versions: { "1.0.0": {} }, description: "held" }],
      whois: noWhois,
    },
    accepts: {
      typical: true,
      uppercase: false,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      doubleHyphen: true,
      reservedHyphens: true,
      underscore: true,
      dot: true,
      leadingHyphen: true,
      trailingHyphen: true,
      single: true,
      unicode: false,
      space: false,
      empty: false,
    },
    maxLength: 214,
  },
  {
    channel: only("pypi"),
    free: { http: () => 404, whois: noWhois },
    taken: { http: () => [200, { info: { name: "held", summary: "held" } }], whois: noWhois },
    accepts: {
      typical: true,
      uppercase: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      doubleHyphen: true,
      reservedHyphens: true,
      underscore: true,
      dot: true,
      leadingHyphen: false,
      trailingHyphen: false,
      single: true,
      unicode: false,
      space: false,
      empty: false,
    },
  },
  {
    channel: only("crates"),
    free: { http: () => 404, whois: noWhois },
    taken: { http: () => [200, { crate: { name: "held" } }], whois: noWhois },
    accepts: {
      typical: true,
      uppercase: true,
      digits: true,
      leadingDigit: false,
      hyphen: true,
      doubleHyphen: true,
      reservedHyphens: true,
      underscore: true,
      dot: false,
      leadingHyphen: false,
      trailingHyphen: true,
      single: true,
      unicode: false,
      space: false,
      empty: false,
    },
    maxLength: 64,
  },
  {
    channel: only("homebrew"),
    free: { http: () => 404, whois: noWhois },
    taken: {
      http: (u) => (u.includes("/formula/") ? [200, { desc: "held" }] : 404),
      whois: noWhois,
    },
    accepts: {
      typical: true,
      uppercase: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      doubleHyphen: true,
      reservedHyphens: true,
      underscore: true,
      dot: true,
      leadingHyphen: false,
      trailingHyphen: true,
      single: true,
      unicode: false,
      space: false,
      empty: false,
    },
  },
  {
    channel: only("github"),
    free: { http: () => 404, whois: noWhois },
    taken: {
      http: () => [
        200,
        { login: "held", type: "User", public_repos: 1, updated_at: "2020-01-01T00:00:00Z" },
      ],
      whois: noWhois,
    },
    accepts: {
      typical: true,
      uppercase: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      doubleHyphen: false,
      reservedHyphens: false,
      underscore: false,
      dot: false,
      leadingHyphen: false,
      trailingHyphen: false,
      single: true,
      unicode: false,
      space: false,
      empty: false,
    },
    maxLength: 39,
  },
  // .dev goes through RDAP; .sh has no RDAP service, so it goes through whois.
  ...["domain:dev", "domain:sh"].map((id): Fixture => ({
    channel: only(id),
    free: {
      http: (u) => (u === BOOTSTRAP ? bootstrap : 404),
      whois: (server) =>
        server === "whois.iana.org" ? "whois:        whois.nic.sh\n" : "Domain not found.\n",
    },
    taken: {
      http: (u) => (u === BOOTSTRAP ? bootstrap : [200, { events: [] }]),
      whois: (server, q) =>
        server === "whois.iana.org" ? "whois:        whois.nic.sh\n" : `Domain Name: ${q}\n`,
    },
    accepts: {
      typical: true,
      uppercase: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      doubleHyphen: true,
      reservedHyphens: false,
      underscore: false,
      dot: false,
      leadingHyphen: false,
      trailingHyphen: false,
      single: true,
      unicode: true,
      space: false,
      empty: false,
    },
    maxLength: 63,
  })),
];
