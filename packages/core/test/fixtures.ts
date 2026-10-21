import { selectChannels, type Channel, type Status } from "../src/index.js";
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
  trailingAt: "nameable@",
  specialChars: "name!able",
  single: "n",
  unicode: "café",
  emoji: "😀",
  space: "name able",
  scoped: "@scope/name",
  scopedUnderscore: "@scope/_name",
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
  /**
   * The certainty a free name reaches when every request succeeds. Asserted, so a change that quietly
   * downgrades every answer to "probable" fails instead of passing unnoticed.
   */
  freeCertainty: "confirmed" | "probable";
  /**
   * Names the service answers 404 for, or that pass the basic syntax, but that the registry would still
   * refuse: reserved names, aliases, similar names. Each must come back with `expect`, never available.
   */
  refused: { name: string; why: string; expect: Status; service?: Service }[];
};

const noWhois = (server: string, query: string) =>
  new Error(`unexpected whois: ${server} ${query}`);
const only = (id: string) => selectChannels({ only: [id] })[0]!;
const reject: Record<InputClass, boolean> = Object.fromEntries(
  Object.keys(INPUTS).map((k) => [k, false]),
) as Record<InputClass, boolean>;

const BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
const bootstrap: Reply = [200, { services: [[["dev"], ["https://rdap.example/"]]] }];

const PYPI_INDEX = "https://pypi.org/simple/";
// Real lists are never empty, and an empty one is treated as broken, so the fakes always hold something.
const pypiFree = (projects: string[] = ["requests"]): Service => ({
  http: (u) => (u === PYPI_INDEX ? [200, { projects: projects.map((name) => ({ name })) }] : 404),
  whois: noWhois,
});

const BREW = "https://formulae.brew.sh/api";
const brewFree = (
  formulae: { name: string; aliases?: string[]; oldnames?: string[] }[] = [{ name: "wget" }],
): Service => ({
  http: (u) =>
    u === `${BREW}/formula.json`
      ? [200, formulae]
      : u === `${BREW}/cask.json`
        ? [200, [{ token: "firefox" }]]
        : 404,
  whois: noWhois,
});

const npmFree = (searchHits: string[] = [], existing: string[] = []): Service => ({
  http: (u) => {
    if (u.includes("/-/v1/search")) {
      return [200, { objects: searchHits.map((name) => ({ package: { name } })) }];
    }
    const name = decodeURIComponent(u.slice("https://registry.npmjs.org/".length));
    return existing.includes(name) ? [200, { versions: { "1.0.0": {} } }] : 404;
  },
  whois: noWhois,
});

export const FIXTURES: Fixture[] = [
  {
    channel: only("npm"),
    freeCertainty: "probable",
    free: npmFree(),
    taken: {
      http: () => [200, { versions: { "1.0.0": {} }, description: "held" }],
      whois: noWhois,
    },
    // validate-npm-package-name v7, validForNewPackages.
    accepts: {
      ...reject,
      typical: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      doubleHyphen: true,
      reservedHyphens: true,
      underscore: true,
      dot: true,
      trailingHyphen: true,
      single: true,
      scoped: true,
      scopedUnderscore: true,
    },
    maxLength: 214,
    refused: [
      { name: "fs", why: "Node.js core module", expect: "unavailable" },
      { name: "node_modules", why: "excluded name", expect: "unavailable" },
      {
        name: "first-one",
        why: "similar to firstone, found by search",
        expect: "unavailable",
        service: npmFree(["firstone"]),
      },
      {
        name: "lodashes",
        why: "similar to lodash-es, found by probing",
        expect: "unavailable",
        service: npmFree([], ["lodash-es"]),
      },
    ],
  },
  {
    channel: only("pypi"),
    freeCertainty: "confirmed",
    free: pypiFree(),
    taken: { http: () => [200, { info: { name: "held", summary: "held" } }], whois: noWhois },
    // PEP 508 names.
    accepts: {
      ...reject,
      typical: true,
      uppercase: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      doubleHyphen: true,
      reservedHyphens: true,
      underscore: true,
      dot: true,
      single: true,
    },
    refused: [
      { name: "tomllib", why: "standard library module", expect: "unavailable" },
      { name: "os.path", why: "standard library module path", expect: "unavailable" },
      {
        name: "f1ask",
        why: "ultranormalizes to flask",
        expect: "unavailable",
        service: pypiFree(["Flask"]),
      },
      {
        name: "ghost",
        why: "a project with no releases: the JSON API 404s but the index lists it",
        expect: "taken",
        service: pypiFree(["Ghost"]),
      },
    ],
  },
  {
    channel: only("crates"),
    freeCertainty: "confirmed",
    free: { http: () => 404, whois: noWhois },
    taken: { http: () => [200, { crate: { name: "held" } }], whois: noWhois },
    // Cargo package names, crates.io's 64-character limit.
    accepts: {
      ...reject,
      typical: true,
      uppercase: true,
      digits: true,
      hyphen: true,
      doubleHyphen: true,
      reservedHyphens: true,
      underscore: true,
      trailingHyphen: true,
      single: true,
    },
    maxLength: 64,
    refused: [
      { name: "std", why: "reserved", expect: "unavailable" },
      { name: "Rustdoc", why: "reserved, compared case-insensitively", expect: "unavailable" },
      { name: "proc-macro", why: "reserved, - and _ the same", expect: "unavailable" },
      { name: "con", why: "Windows device name", expect: "unavailable" },
    ],
  },
  {
    channel: only("homebrew"),
    freeCertainty: "confirmed",
    free: brewFree(),
    taken: {
      http: (u) => (u.includes("/formula/") ? [200, { desc: "held" }] : 404),
      whois: noWhois,
    },
    // FormulaNameCaskTokenAuditor.
    accepts: {
      ...reject,
      typical: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      underscore: true,
      dot: true,
      single: true,
    },
    refused: [
      { name: "pip", why: "disallowed in homebrew/core", expect: "unavailable" },
      { name: "liblzma5", why: "disallowed (unanchored lzma pattern)", expect: "unavailable" },
      {
        name: "golang",
        why: "alias of go",
        expect: "taken",
        service: brewFree([{ name: "go", aliases: ["golang"] }]),
      },
      {
        name: "atk",
        why: "old name of a renamed formula",
        expect: "taken",
        service: brewFree([{ name: "at-spi2-core", oldnames: ["at-spi2-atk", "atk"] }]),
      },
      {
        name: "nodejs",
        why: "old name listed on the formula",
        expect: "taken",
        service: brewFree([{ name: "node", oldnames: ["nodejs"] }]),
      },
    ],
  },
  {
    channel: only("github"),
    freeCertainty: "probable",
    free: { http: () => 404, whois: noWhois },
    taken: {
      http: () => [
        200,
        { login: "held", type: "User", public_repos: 1, updated_at: "2020-01-01T00:00:00Z" },
      ],
      whois: noWhois,
    },
    // GitHub's sign-up form.
    accepts: {
      ...reject,
      typical: true,
      uppercase: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      single: true,
    },
    maxLength: 39,
    refused: [],
  },
  // .dev goes through RDAP; .sh has no RDAP service, so it goes through whois.
  ...["domain:dev", "domain:sh"].map((id): Fixture => ({
    channel: only(id),
    freeCertainty: "probable",
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
    // RFC 1035 labels after IDNA2008 conversion.
    accepts: {
      ...reject,
      typical: true,
      uppercase: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      doubleHyphen: true,
      single: true,
      unicode: true,
    },
    maxLength: 63,
    refused: [
      { name: "☃", why: "symbol, not allowed by IDNA2008", expect: "unavailable" },
      { name: "①", why: "circled digit, not allowed by IDNA2008", expect: "unavailable" },
    ],
  })),
];
