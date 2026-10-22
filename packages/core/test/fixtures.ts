import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectChannels, type Channel, type Status } from "../src/index.js";
import { rangeReply, zipArchive, type Headers, type Reply } from "./fake-fetch.js";

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
  // Not valid Unicode text; only JSON input (MCP) can carry it.
  loneSurrogate: "\ud800",
  space: "name able",
  scoped: "@scope/name",
  scopedUnderscore: "@scope/_name",
  // A label typed already in punycode (café).
  punycode: "xn--caf-dma",
  empty: "",
} as const;

export type InputClass = keyof typeof INPUTS;

/** A whole fake service: what every HTTP request and whois query gets. */
export type Service = {
  http: (url: string, headers: Headers) => Reply;
  whois: (server: string, query: string) => string | Error;
};

export type Fixture = {
  channel: Channel;
  /** A service under which every name is free. */
  free: Service;
  /** A service under which every name is held. */
  taken: Service;
  accepts: Record<InputClass, boolean>;
  /**
   * Classes the channel refuses only after looking the name up, because names published before a rule
   * keep it (`refuses` in define.ts). Every other rejected class must be refused without a request.
   */
  refusedAfterLookup?: InputClass[];
  /** Whether a name over `maxLength` is refused only after a lookup, as with `refusedAfterLookup`. */
  lengthRefusedAfterLookup?: boolean;
  /** Classes the channel cannot check at all, answered `unknown`: neither free nor refused. */
  unchecked?: InputClass[];
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
// `detail` is what the simple page of a single project answers; free names get 404.
const pypiFree = (projects: string[] = ["requests"], detail: Reply = 404): Service => ({
  http: (u) =>
    u === PYPI_INDEX
      ? [200, { projects: projects.map((name) => ({ name })) }]
      : u.startsWith(PYPI_INDEX)
        ? detail
        : 404,
  whois: noWhois,
});

export const CRATES_DUMP = "https://static.crates.io/db-dump.zip";
/**
 * crates.io's database dump, served by byte range, with its reserved and deleted tables. A deleted row
 * pairs a name with its `available_at`; its message holds the commas, quotes and newlines real ones do.
 */
export function cratesDump(
  reserved: string[] = ["std"],
  deleted: [string, string][] = [["gone", "2020-01-01 00:00:00.5+00"]],
): (headers: Headers) => Response {
  const row = ([name, at]: [string, string]) =>
    `${at},${at},${at},1,1,"squatting, ""see"" the\nreport",${name}`;
  const zip = zipArchive({
    "2026-10-21-020000/README.md": "The crates.io database dump.",
    "2026-10-21-020000/data/reserved_crate_names.csv": `name\n${reserved.join("\n")}\n`,
    "2026-10-21-020000/data/deleted_crates.csv": `available_at,created_at,deleted_at,deleted_by,id,message,name\n${deleted.map(row).join("\n")}\n`,
  });
  return (headers) => rangeReply(zip, headers);
}
const cratesFree = (...args: Parameters<typeof cratesDump>): Service => {
  const dump = cratesDump(...args);
  return { http: (u, h) => (u === CRATES_DUMP ? dump(h) : 404), whois: noWhois };
};

const BREW = "https://formulae.brew.sh/api";
const brewFree = (
  formulae: { name: string; aliases?: string[]; oldnames?: string[] }[] = [{ name: "wget" }],
): Service => ({
  http: (u) =>
    u === `${BREW}/formula.json`
      ? [200, formulae.map((f) => ({ aliases: [], oldnames: [], ...f }))]
      : u === `${BREW}/cask.json`
        ? [200, [{ token: "firefox", old_tokens: [] }]]
        : 404,
  whois: noWhois,
});

const npmFree = (searchHits: string[] = [], existing: string[] = []): Service => ({
  http: (u) => {
    if (u.includes("/-/v1/search")) {
      return [200, { objects: searchHits.map((name) => ({ package: { name } })) }];
    }
    const name = decodeURIComponent(u.slice("https://registry.npmjs.org/".length));
    return existing.includes(name) ? [200, { name, versions: { "1.0.0": {} } }] : 404;
  },
  whois: noWhois,
});

const GEMS = "https://rubygems.org";
// /names is a YAML-ish list of every gem with an indexed version; a real one has about 200,000.
const gemNames = (extra: string[]) =>
  new Response(["---", ...Array.from({ length: 1000 }, (_, i) => `gem${i}`), ...extra].join("\n"));
const rubyFree = (
  opts: { names?: string[]; gems?: Record<string, Reply>; pages?: Record<string, string> } = {},
): Service => ({
  http: (u) => {
    if (u === `${GEMS}/names`) return gemNames(opts.names ?? []);
    const gem = /\/api\/v1\/gems\/(.+)\.json$/.exec(u)?.[1];
    if (gem) return opts.gems?.[gem] ?? 404;
    const page = opts.pages?.[u.slice(`${GEMS}/gems/`.length)];
    return page === undefined ? 404 : new Response(page);
  },
  whois: noWhois,
});
const packagistFree = (
  opts: { vendor?: string[]; twins?: string[]; downloads?: number } = {},
): Service => ({
  http: (u) => {
    if (u.includes("list.json?vendor=")) return [200, { packageNames: opts.vendor ?? [] }];
    if (u.includes("list.json?filter=")) return [200, { packageNames: opts.twins ?? [] }];
    if (u.endsWith("/stats.json")) return [200, { downloads: { total: opts.downloads ?? 0 } }];
    return 404;
  },
  whois: noWhois,
});
// Cursor's marketplace page lists each plugin as "fullRef":"<name>" in its RSC payload.
const cursorFree = (names: string[] = []): Service => ({
  http: () =>
    new Response(
      [...Array.from({ length: 60 }, (_, i) => `plugin${i}`), ...names]
        .map((n) => `{"fullRef":"${n}","lifecycleState":"PLUGIN_LIFECYCLE_STATE_PUBLIC_LISTED"}`)
        .join(","),
    ),
  whois: noWhois,
});
const geminiFree = (names: string[] = []): Service => ({
  http: () => [
    200,
    [...Array.from({ length: 60 }, (_, i) => `ext${i}`), ...names].map((n) => ({
      extensionName: n,
      url: `https://github.com/someone/${n}`,
    })),
  ],
  whois: noWhois,
});
const appStoreFree = (trackName = "Nameable Pro Suite"): Service => ({
  http: () => [
    200,
    {
      resultCount: 1,
      results: [
        { trackName, sellerName: "Someone", trackViewUrl: "https://apps.apple.com/us/app/x/id1" },
      ],
    },
  ],
  whois: noWhois,
});
/** A Google Play search page: its results sit in an AF_initDataCallback call, as on the real page. */
/** Each app is a title, or a title and its developer. */
type PlayApp = string | [title: string, developer: string];
const playPage = (titles: PlayApp[]) => {
  const items = titles.map((entry, i) => {
    const [title, developer] = typeof entry === "string" ? [entry, "Developer"] : entry;
    const app: unknown[] = [];
    app[0] = [`com.example.app${i}`];
    app[3] = title;
    app[14] = developer;
    return [app];
  });
  const section: unknown[] = [];
  if (items.length) section[22] = [items];
  // With no results, Play sends one section whose token decodes to "zero_results_cluster".
  else section[3] = [Buffer.from("\x12\x14zero_results_cluster").toString("base64")];
  const data = JSON.stringify([[null, [section]]]);
  return new Response(
    `<script>AF_initDataCallback({key: 'ds:4', hash: '1', data:${data}, sideChannel: {}});</script>`,
  );
};
const playFree = (titles: PlayApp[] = []): Service => ({
  http: () => playPage(titles),
  whois: noWhois,
});
const vscodeFree = (
  extensions: { extensionName: string; displayName?: string }[] = [{ extensionName: "other" }],
  publisher: Reply = 404,
): Service => ({
  http: (u) =>
    u.endsWith("/extensionquery")
      ? [
          200,
          {
            results: [
              {
                extensions: extensions.map((e) => ({ ...e, publisher: { publisherName: "pub" } })),
              },
            ],
          },
        ]
      : publisher,
  whois: noWhois,
});
// Open VSX search pages list extensions with their namespace; the channel reads every namespace from them.
const openVsxFree = (
  namespaces: string[] = ["redhat"],
  opts: { publisher?: Reply } = {},
): Service => {
  const all = [...Array.from({ length: 120 }, (_, i) => `publisher${i}`), ...namespaces];
  return {
    http: (u) => {
      if (u.startsWith("https://marketplace.visualstudio.com/publishers/"))
        return opts.publisher ?? 404;
      if (u.includes("/-/search?")) {
        return [
          200,
          { totalSize: all.length, extensions: all.map((namespace) => ({ namespace, name: "x" })) },
        ];
      }
      return 404;
    },
    whois: noWhois,
  };
};
const jetbrainsFree = (names: string[] = ["Other"]): Service => ({
  http: (u) =>
    u.includes("/searchPlugins?")
      ? [
          200,
          { plugins: names.map((name, i) => ({ name, xmlId: `x${i}`, link: `/plugin/${i}-x` })) },
        ]
      : 404,
  whois: noWhois,
});
/** node:sqlite where this Node has it (22.13 and later); the MCP Registry channel needs it. */
export const sqlite = () =>
  process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;

/** A copy of the MCP Registry mirror's database, with the servers table the channel reads. */
export function mcpDatabase(names: string[] = []): Buffer {
  const { DatabaseSync } = sqlite()!;
  const dir = mkdtempSync(join(tmpdir(), "nameable-mcp-fixture-"));
  try {
    const db = new DatabaseSync(join(dir, "registry.db"));
    db.exec(
      "CREATE TABLE servers (id INTEGER PRIMARY KEY, entry_name TEXT NOT NULL, status TEXT, updated_at TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO servers (entry_name, status, updated_at) VALUES (?, ?, ?)",
    );
    for (let i = 0; i < 1000; i++) {
      insert.run(`io.github.someone/server${i}`, "active", "2026-10-20T00:00:00Z");
    }
    for (const name of names) insert.run(name, "active", "2026-10-21T08:00:00Z");
    db.close();
    return readFileSync(join(dir, "registry.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const mcpFree = (names: string[] = ["io.github.x/nameable-tools"]): Service => {
  let bytes: Buffer | undefined;
  return {
    http: () => new Response(new Uint8Array((bytes ??= mcpDatabase(names)))),
    whois: noWhois,
  };
};
const NUGET_DELETED = "<p>This package has been deleted from the gallery.</p>";
const PUB_NAMES = "https://pub.dev/api/package-names";
const pubFree = (names: string[] = ["http"]): Service => ({
  http: (u) => (u === PUB_NAMES ? [200, { packages: names, nextUrl: null }] : 404),
  whois: noWhois,
});
const DOCKER = "https://hub.docker.com/v2";
// Every endpoint answers for a missing namespace: 404 for accounts and images, an empty repository list.
const dockerFree = (overrides: Record<string, Reply> = {}): Service => ({
  http: (u) => {
    const path = u.slice(DOCKER.length).split("/")[1]!;
    return overrides[path] ?? (path === "namespaces" ? [200, { count: 0, results: [] }] : 404);
  },
  whois: noWhois,
});
const smitheryFree = (
  servers: { qualifiedName: string; displayName?: string }[] = [],
): Service => ({
  http: () => [200, { servers, pagination: { totalCount: servers.length } }],
  whois: noWhois,
});
const claudeFree = (names: string[] = ["other"]): Service => ({
  http: () => [200, { plugins: names.map((name) => ({ name, description: "held" })) }],
  whois: noWhois,
});

export const FIXTURES: Fixture[] = [
  {
    channel: only("npm"),
    freeCertainty: "probable",
    // Old packages may have capitals, ~'!()* and more than 214 characters; new ones may not.
    refusedAfterLookup: ["uppercase", "specialChars", "leadingHyphen"],
    lengthRefusedAfterLookup: true,
    free: npmFree(),
    taken: {
      http: () => [200, { name: "nameable", versions: { "1.0.0": {} }, description: "held" }],
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
      punycode: true,
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
      punycode: true,
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
        why: "a project with no releases: the JSON API 404s but its simple page exists",
        expect: "taken",
        service: pypiFree(["requests"], [200, { name: "ghost" }]),
      },
      {
        name: "quarantined",
        why: "a quarantined project: left out of the JSON API and the full index",
        expect: "taken",
        service: pypiFree(
          ["requests"],
          [200, { name: "quarantined", "project-status": { status: "quarantined" } }],
        ),
      },
    ],
  },
  {
    channel: only("crates"),
    freeCertainty: "confirmed",
    free: cratesFree(),
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
      punycode: true,
    },
    maxLength: 64,
    refused: [
      { name: "std", why: "reserved", expect: "unavailable" },
      { name: "Rustdoc", why: "reserved, compared case-insensitively", expect: "unavailable" },
      { name: "proc-macro", why: "reserved, - and _ the same", expect: "unavailable" },
      { name: "con", why: "Windows device name", expect: "unavailable" },
      {
        name: "Rust",
        why: "reserved by admins after the migrations; only the dump lists it",
        expect: "unavailable",
        service: cratesFree(["std", "rust"]),
      },
      {
        name: "gh",
        why: "recently deleted; blocked until available_at",
        expect: "unavailable",
        service: cratesFree(["std"], [["gh", "2099-01-01 00:00:00+00"]]),
      },
    ],
  },
  {
    channel: only("homebrew"),
    freeCertainty: "confirmed",
    free: brewFree(),
    taken: {
      http: (u) => (u.includes("/formula/") ? [200, { name: "held", desc: "held" }] : 404),
      whois: noWhois,
    },
    // FormulaNameCaskTokenAuditor, and Formulary.class_s for the class name a formula loads as.
    // Casks hold names a new formula may not have, so the formula rules apply after the lookup.
    refusedAfterLookup: [
      "uppercase",
      "leadingDigit",
      "doubleHyphen",
      "reservedHyphens",
      "leadingHyphen",
      "trailingHyphen",
      "trailingAt",
      "punycode",
    ],
    accepts: {
      ...reject,
      typical: true,
      digits: true,
      hyphen: true,
      underscore: true,
      dot: true,
      single: true,
    },
    refused: [
      {
        name: "1password",
        why: "a cask whose name a new formula could not have",
        expect: "taken",
        service: {
          http: (u) =>
            u.includes("/cask/1password.json")
              ? [200, { token: "1password", desc: "Password manager" }]
              : 404,
          whois: noWhois,
        },
      },
      { name: "pip", why: "disallowed in homebrew/core", expect: "unavailable" },
      { name: "liblzma5", why: "disallowed (unanchored lzma pattern)", expect: "unavailable" },
      { name: "name@beta", why: "@ not before a version: no Ruby class", expect: "unavailable" },
      { name: "a._b", why: "a dot before _ survives into the class name", expect: "unavailable" },
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
    // Names that exist despite these rules are looked up first; the rules apply to new names.
    refusedAfterLookup: [
      "doubleHyphen",
      "leadingHyphen",
      "punycode",
      "reservedHyphens",
      "trailingHyphen",
      "underscore",
    ],
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
  {
    channel: only("rubygems"),
    freeCertainty: "probable",
    // Gems pushed before the edge rule, such as `_amon`, still exist.
    refusedAfterLookup: ["leadingHyphen", "trailingHyphen"],
    free: rubyFree(),
    taken: rubyFree({ gems: { nameable: [200, { name: "nameable", info: "held" }] } }),
    // lib/name_format_validator.rb: letters, digits, . - _, a letter, no . - _ at either end.
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
      punycode: true,
    },
    maxLength: 255,
    refused: [
      { name: "thing.gemspec", why: "ends with a file extension", expect: "unavailable" },
      {
        name: "foo.gem",
        why: "its page answers 403, so the lookup cannot tell; held or refused, never free",
        expect: "unknown",
        service: { http: (u) => (u.endsWith("/gems/foo.gem") ? 403 : 404), whois: noWhois },
      },
      { name: "123", why: "no letter", expect: "unavailable" },
      {
        name: "rbconfig",
        why: "reserved; the API answers 404",
        expect: "unavailable",
        service: rubyFree({ pages: { rbconfig: "This namespace is reserved by rubygems.org." } }),
      },
      {
        name: "inbio",
        why: "yanked, held for its owner",
        expect: "unavailable",
        service: rubyFree({
          pages: { inbio: "The RubyGems.org team has reserved this gem name for 91 more days." },
        }),
      },
      {
        name: "web3-eth-utils",
        why: "yanked and past the hold",
        expect: "reclaimable",
        service: rubyFree({
          pages: { "web3-eth-utils": "This gem is not currently hosted on RubyGems.org." },
        }),
      },
      {
        name: "Inbio",
        why: "a case variant of a yanked gem still held; the page is case-sensitive",
        expect: "unavailable",
        service: rubyFree({
          pages: { inbio: "The RubyGems.org team has reserved this gem name for 91 more days." },
        }),
      },
      {
        name: "_amon",
        why: "a gem pushed before the edge rule is taken, not refused",
        expect: "taken",
        service: rubyFree({ gems: { _amon: [200, { name: "_amon" }] } }),
      },
      {
        name: "Sinatra",
        why: "a case variant whose lowercase page is a hosted gem",
        expect: "taken",
        service: rubyFree({ pages: { sinatra: "<h1>sinatra</h1> Classy web-development" } }),
      },
      {
        name: "Rails",
        why: "a case variant; names are unique ignoring case",
        expect: "taken",
        service: rubyFree({ names: ["rails"] }),
      },
      {
        name: "rail_s",
        why: "the same as a popular gem without - and _",
        expect: "unavailable",
        service: rubyFree({
          names: ["rails"],
          gems: { rails: [200, { downloads: 9e8, version_created_at: "2001-01-01T00:00:00Z" }] },
        }),
      },
    ],
  },
  {
    channel: only("nuget"),
    freeCertainty: "probable",
    free: { http: () => 404, whois: noWhois },
    taken: {
      http: () => [
        200,
        { items: [{ items: [{ catalogEntry: { id: "Nameable", description: "held" } }] }] },
      ],
      whois: noWhois,
    },
    // NuGetGallery PackageIdValidator: .NET \w (letters of any script), digits and _, joined by . or -.
    accepts: {
      ...reject,
      typical: true,
      uppercase: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      underscore: true,
      dot: true,
      single: true,
      unicode: true,
    },
    maxLength: 100,
    refused: [
      {
        name: "Coinbase.Core",
        why: "deleted by the NuGet team; gone from the API, the ID still held",
        expect: "unavailable",
        service: {
          http: (u) => (u.startsWith("https://www.nuget.org/") ? new Response(NUGET_DELETED) : 404),
          whois: noWhois,
        },
      },
    ],
  },
  {
    channel: only("packagist"),
    freeCertainty: "probable",
    // Lookups ignore case, so an existing vendor typed in capitals is still found.
    refusedAfterLookup: ["uppercase"],
    free: packagistFree(),
    taken: packagistFree({ vendor: ["nameable/held"] }),
    // Package::PACKAGE_NAME_REGEX for the vendor part, lowercase only.
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
    maxLength: 191,
    refused: [
      { name: "php", why: "a reserved vendor", expect: "unavailable" },
      { name: "con", why: "a Windows device name", expect: "unavailable" },
      { name: "my-symfony", why: "contains symfony", expect: "unavailable" },
      { name: "name.json", why: "ends in .json", expect: "unavailable" },
      {
        name: "php_amqplib",
        why: "`_` is a LIKE wildcard in the typo rule, so php-amqplib/php-amqplib matches",
        expect: "unavailable",
        service: packagistFree({ twins: ["php-amqplib/php-amqplib"], downloads: 142_000_000 }),
      },
      {
        name: "composer",
        why: "a reserved vendor that already holds packages is taken, not refused",
        expect: "taken",
        service: packagistFree({ vendor: ["composer/composer"] }),
      },
      {
        name: "illuminat",
        why: "one edit from the vendor of a package with the same name and a million downloads",
        expect: "unavailable",
        service: packagistFree({ twins: ["illuminate/illuminat"], downloads: 5_000_000 }),
      },
    ],
  },
  {
    channel: only("pub"),
    freeCertainty: "probable",
    // Mixed-case packages such as Pong predate the lowercase rule.
    refusedAfterLookup: ["uppercase"],
    free: pubFree(),
    taken: {
      http: (u) =>
        u === PUB_NAMES
          ? [200, { packages: ["nameable"], nextUrl: null }]
          : [200, { name: "nameable", latest: { pubspec: { description: "held" } } }],
      whois: noWhois,
    },
    // pub_package_reader: letters, digits and _, starting with a letter or _, lowercase for new names.
    accepts: { ...reject, typical: true, digits: true, underscore: true, single: true },
    maxLength: 64,
    refused: [
      { name: "class", why: "a Dart reserved word", expect: "unavailable" },
      {
        name: "Pong",
        why: "a mixed-case package from before the lowercase rule is taken, not refused",
        expect: "taken",
        service: {
          http: (u) => (u.endsWith("/api/packages/Pong") ? [200, { name: "Pong" }] : 404),
          whois: noWhois,
        },
      },
      { name: "c_lass", why: "a reserved word once _ is dropped", expect: "unavailable" },
      { name: "pong", why: "lowercase twin of the older Pong", expect: "unavailable" },
      { name: "flutter_test", why: "part of the Flutter SDK", expect: "unavailable" },
      { name: "dart_", why: "kept for the Dart team, compared reduced", expect: "unavailable" },
      {
        name: "providers",
        why: "plural of an existing package",
        expect: "unavailable",
        service: pubFree(["provider"]),
      },
      { name: "h_ttp", why: "equal to http without _", expect: "unavailable", service: pubFree() },
      {
        name: "rnath",
        why: "rn for m: math, the singular of maths",
        expect: "unavailable",
        service: pubFree(["maths"]),
      },
    ],
  },
  {
    channel: only("docker"),
    freeCertainty: "probable",
    free: dockerFree(),
    taken: dockerFree({ users: [200, { username: "nameable" }] }),
    // docs.docker.com/accounts/create-account: 4 to 30 letters and numbers, stored in lowercase.
    // Names that exist despite these rules are looked up first; the rules apply to new names.
    refusedAfterLookup: [
      "dot",
      "doubleHyphen",
      "hyphen",
      "punycode",
      "reservedHyphens",
      "single",
      "trailingHyphen",
      "underscore",
    ],
    lengthRefusedAfterLookup: true,
    accepts: {
      ...reject,
      typical: true,
      uppercase: true,
      digits: true,
      leadingDigit: true,
    },
    maxLength: 30,
    refused: [
      {
        name: "bitnami",
        why: "an organization, which /users redirects to /orgs",
        expect: "taken",
        service: dockerFree({ users: 308, orgs: [200, { orgname: "bitnami" }] }),
      },
      {
        name: "hiddenid",
        why: "an account /users does not show, which /orgs still redirects and which owns repositories",
        expect: "taken",
        service: dockerFree({ users: 404, orgs: 308, namespaces: [200, { count: 8 }] }),
      },
      {
        name: "postgres",
        why: "an official image whose name no account holds",
        expect: "taken",
        service: dockerFree({ repositories: [200, { namespace: "library" }] }),
      },
    ],
  },
  {
    channel: only("smithery"),
    freeCertainty: "probable",
    free: smitheryFree(),
    taken: smitheryFree([{ qualifiedName: "nameable/server", displayName: "Held" }]),
    // "lowercase alphanumeric with hyphens" (smithery.ai/docs/concepts/namespaces).
    // Names that exist despite these rules are looked up first; the rules apply to new names.
    refusedAfterLookup: ["uppercase"],
    accepts: {
      ...reject,
      typical: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      doubleHyphen: true,
      reservedHyphens: true,
      leadingHyphen: true,
      trailingHyphen: true,
      single: true,
      punycode: true,
    },
    refused: [],
  },
  {
    channel: only("claude-plugins"),
    freeCertainty: "confirmed",
    free: claudeFree(),
    taken: claudeFree(["nameable"]),
    // `claude plugin validate`: a marketplace installs only names of letters, digits, . _ and -.
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
      trailingHyphen: true,
      single: true,
      punycode: true,
    },
    refused: [
      { name: "claude-tools", why: "starts with claude-", expect: "unavailable" },
      { name: "claudecode", why: "claude code without a separator", expect: "unavailable" },
      { name: "claude+tools", why: "+ separates words too", expect: "unavailable" },
      {
        name: "myclaudeofficial",
        why: "official beside claude inside one word",
        expect: "unavailable",
      },
      { name: "official-anthropics", why: "official beside anthropic", expect: "unavailable" },
      {
        name: "Claude__Code",
        why: "claude-code, ignoring case and separators",
        expect: "unavailable",
      },
      { name: "official-claude-tools", why: "official beside claude", expect: "unavailable" },
      { name: "cc_plugin_x", why: "starts with cc-plugin-", expect: "unavailable" },
      { name: "anthropics", why: "reserved", expect: "unavailable" },
      {
        // Built from its code point: formatters write the escape back as the invisible character.
        name: `rtl${String.fromCodePoint(0x202e)}name`,
        why: "bidirectional formatting",
        expect: "unavailable",
      },
      {
        name: "GitHub",
        why: "listed, compared ignoring case",
        expect: "taken",
        service: claudeFree(["github"]),
      },
    ],
  },
  {
    channel: only("cursor"),
    freeCertainty: "probable",
    free: cursorFree(),
    taken: cursorFree(["nameable"]),
    // cursor.com/docs/reference/plugins: lowercase kebab-case, letters, digits, - and .
    // Names that exist despite these rules are looked up first; the rules apply to new names.
    refusedAfterLookup: ["uppercase"],
    accepts: {
      ...reject,
      typical: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      doubleHyphen: true,
      reservedHyphens: true,
      dot: true,
      single: true,
      punycode: true,
    },
    refused: [],
  },
  {
    channel: only("gemini"),
    freeCertainty: "probable",
    free: geminiFree(),
    taken: geminiFree(["nameable"]),
    // Gemini CLI's validateName: letters, digits and dashes.
    // Names that exist despite these rules are looked up first; the rules apply to new names.
    refusedAfterLookup: [
      "dot",
      "emoji",
      "specialChars",
      "trailingAt",
      "underscore",
      "unicode",
      "space",
      "scoped",
      "scopedUnderscore",
    ],
    accepts: {
      ...reject,
      typical: true,
      uppercase: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      doubleHyphen: true,
      reservedHyphens: true,
      leadingHyphen: true,
      trailingHyphen: true,
      single: true,
      punycode: true,
    },
    refused: [
      {
        name: "GitHub",
        why: "listed, compared ignoring case",
        expect: "taken",
        service: geminiFree(["github"]),
      },
    ],
  },
  {
    channel: only("vscode"),
    freeCertainty: "probable",
    free: vscodeFree(),
    taken: vscodeFree([{ extensionName: "nameable" }]),
    // vsce src/validation.ts.
    accepts: {
      ...reject,
      typical: true,
      uppercase: true,
      digits: true,
      leadingDigit: true,
      hyphen: true,
      doubleHyphen: true,
      reservedHyphens: true,
      trailingHyphen: true,
      single: true,
      punycode: true,
    },
    refused: [
      {
        name: "prettier",
        why: "another publisher's display name; display names are unique",
        expect: "taken",
        service: vscodeFree([{ extensionName: "prettier-vscode", displayName: "Prettier" }]),
      },
      {
        name: "esbenp",
        why: "a publisher ID",
        expect: "taken",
        service: vscodeFree(undefined, [200, {}]),
      },
    ],
  },
  {
    channel: only("open-vsx"),
    freeCertainty: "probable",
    free: openVsxFree(),
    taken: { http: () => [200, { name: "nameable" }], whois: noWhois },
    // openvsx ExtensionValidator: word characters and - + $ ~.
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
      leadingHyphen: true,
      trailingHyphen: true,
      single: true,
      punycode: true,
    },
    maxLength: 255,
    refused: [
      {
        name: "redhatt",
        why: "within 20% of an existing namespace",
        expect: "unavailable",
        service: openVsxFree(["redhat"]),
      },
      {
        name: "muhammadsammy",
        why: "within 20% of a namespace that search for the name does not return",
        expect: "unavailable",
        service: openVsxFree(["muhammad-sammy"]),
      },
      {
        name: "esbenp",
        why: "a VS Code Marketplace publisher's name, which only its verified owner may use",
        expect: "unavailable",
        service: openVsxFree(undefined, { publisher: [200, {}] }),
      },
    ],
  },
  {
    channel: only("jetbrains"),
    freeCertainty: "probable",
    free: jetbrainsFree(),
    taken: {
      http: () => [200, { xmlId: "dev.nameable", name: "Nameable", link: "/plugin/1-nameable" }],
      whois: noWhois,
    },
    // structure-base Validator.kt: ALLOWED_NAME_SYMBOLS, at most 64.
    // Names that exist despite these rules are looked up first; the rules apply to new names.
    refusedAfterLookup: [
      "emoji",
      "scoped",
      "scopedUnderscore",
      "specialChars",
      "trailingAt",
      "unicode",
    ],
    lengthRefusedAfterLookup: true,
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
      leadingHyphen: true,
      trailingHyphen: true,
      single: true,
      space: true,
      punycode: true,
    },
    maxLength: 64,
    refused: [
      { name: "Ideal Tools", why: "contains IDEA", expect: "unavailable" },
      { name: "my-plugin", why: "contains plugin", expect: "unavailable" },
      { name: "Demo", why: "a template name", expect: "unavailable" },
      {
        name: "rust",
        why: "a plugin with this name; names must be unique",
        expect: "taken",
        service: jetbrainsFree(["Rust"]),
      },
    ],
  },
  {
    channel: only("app-store"),
    freeCertainty: "probable",
    free: appStoreFree(),
    taken: appStoreFree("Nameable"),
    // App Store Connect: 2 to 30 characters.
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
      leadingHyphen: true,
      trailingHyphen: true,
      trailingAt: true,
      specialChars: true,
      unicode: true,
      space: true,
      scoped: true,
      scopedUnderscore: true,
      punycode: true,
    },
    maxLength: 30,
    refused: [
      {
        name: "slack",
        why: "a title with a subtitle is a similar title, not this one",
        expect: "available",
        service: appStoreFree("Slack - Team Chat"),
      },
    ],
  },
  {
    channel: only("google-play"),
    freeCertainty: "probable",
    free: playFree(),
    taken: playFree(["Nameable"]),
    // Play Console: a title is at most 30 characters.
    // An emoji has no letters or digits to compare with app titles.
    unchecked: ["emoji"],
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
      leadingHyphen: true,
      trailingHyphen: true,
      trailingAt: true,
      specialChars: true,
      single: true,
      unicode: true,
      emoji: true,
      space: true,
      scoped: true,
      scopedUnderscore: true,
      punycode: true,
    },
    maxLength: 30,
    refused: [
      {
        name: "claude",
        why: "a title that only adds its maker after 'by' is a similar title, not this one",
        expect: "available",
        service: playFree([["Claude by Anthropic", "Anthropic PBC"]]),
      },
      {
        name: "todoist",
        why: "a title with a subtitle after a colon is a similar title, not this one",
        expect: "available",
        service: playFree(["Notion", "Todoist: To-Do List & Planner"]),
      },
    ],
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
      http: (u) => (u === BOOTSTRAP ? bootstrap : [200, { objectClassName: "domain", events: [] }]),
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
      punycode: true,
    },
    maxLength: 63,
    refused: [
      { name: "☃", why: "symbol, not allowed by IDNA2008", expect: "unavailable" },
      { name: "①", why: "circled digit, not allowed by IDNA2008", expect: "unavailable" },
      { name: "xn--ls8h", why: "an emoji typed as punycode", expect: "unavailable" },
      { name: "xn--n3h", why: "a symbol typed as punycode", expect: "unavailable" },
    ],
  })),
];

// Without node:sqlite (Node before 22.13) the channel can only answer unknown, so it has no fixture.
if (sqlite()) {
  FIXTURES.push({
    channel: only("mcp-registry"),
    freeCertainty: "probable",
    free: mcpFree(),
    taken: mcpFree(["io.github.someone/nameable"]),
    // server.json: the name part of `namespace/name` is [a-zA-Z0-9._-]+.
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
      leadingHyphen: true,
      trailingHyphen: true,
      single: true,
      punycode: true,
    },
    refused: [
      {
        name: "NameAble",
        why: "another namespace's server, compared ignoring case",
        expect: "taken",
        service: mcpFree(["com.example/nameable"]),
      },
    ],
  });
}
