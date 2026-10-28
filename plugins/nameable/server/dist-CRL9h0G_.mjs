import { builtinModules } from "node:module";
import { connect } from "node:net";
import { domainToASCII, domainToUnicode } from "node:url";
import { gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, relative, resolve, win32 } from "node:path";
import { randomUUID } from "node:crypto";
//#region ../core/dist/index.mjs
/**
* Plain whois over TCP port 43. The only code that opens a socket: unit tests inject a fake whois,
* and the contract and live tests cover this.
*/
const tcpWhois = (server, query) => new Promise((resolve, reject) => {
	const chunks = [];
	const socket = connect({
		host: server,
		port: 43
	}, () => {
		socket.write(`${query}\r\n`);
	});
	const deadline = setTimeout(() => {
		socket.destroy();
		reject(Object.assign(/* @__PURE__ */ new Error(`whois ${server} timed out`), { name: "TimeoutError" }));
	}, 1e4);
	socket.on("close", () => {
		clearTimeout(deadline);
		reject(/* @__PURE__ */ new Error(`whois ${server} closed the connection`));
	});
	socket.on("data", (chunk) => chunks.push(chunk));
	socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	socket.on("error", reject);
});
function createContext(opts) {
	return {
		fetch: opts.fetch ?? fetch,
		whois: opts.whois ?? tcpWhois,
		githubToken: opts.githubToken,
		cache: opts.shared?.cache ?? /* @__PURE__ */ new Map(),
		gates: opts.shared?.gates ?? /* @__PURE__ */ new Map(),
		backoffMs: opts.backoffMs,
		store: opts.store,
		refresh: opts.refresh,
		now: opts.now
	};
}
async function run(name, channel, ctx, onResult) {
	let result;
	try {
		result = await channel.check(name, ctx);
	} catch (err) {
		const timedOut = err instanceof Error && err.name === "TimeoutError";
		result = {
			channel: channel.id,
			label: channel.label,
			status: "unknown",
			note: timedOut ? "timed out" : err instanceof Error ? err.message : String(err)
		};
	}
	onResult?.(name, result);
	return result;
}
/**
* Checks every name on every channel concurrently, sharing lookups and per-host limits across names.
* A channel that throws becomes `unknown`, never `available`.
*/
function checkMany(names, channels, opts = {}) {
	const ctx = createContext(opts);
	return Promise.all(names.map(async (name) => ({
		name,
		results: await Promise.all(channels.map((c) => run(name, c, ctx, opts.onResult)))
	})));
}
/**
* A note on one line. Descriptions and error messages arrive with line breaks, indentation, stray
* control characters and bidirectional controls that would reorder a terminal row.
*/
const clean = (note) => note.replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ").replace(/\s+/g, " ").trim();
/** Every channel is built with this, so validation, result shape and failure handling are uniform. */
function defineChannel(spec) {
	return {
		id: spec.id,
		label: spec.label,
		category: spec.category,
		async check(name, ctx) {
			const base = {
				channel: spec.id,
				label: spec.label
			};
			if (/\p{Surrogate}/u.test(name)) return {
				...base,
				status: "unavailable",
				note: "names must be valid Unicode text"
			};
			const problem = spec.rules(name);
			if (problem) return {
				...base,
				status: "unavailable",
				note: problem
			};
			let result;
			try {
				result = {
					...base,
					...await spec.lookup(name, ctx)
				};
			} catch (err) {
				const rule = spec.refuses?.(name);
				if (!rule) throw err;
				const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : err instanceof Error ? err.message : String(err);
				return {
					...base,
					status: "unknown",
					note: clean(`${reason}; if nobody holds it, ${rule}`)
				};
			}
			const refused = result.status === "available" || result.status === "unknown" ? spec.refuses?.(name) : void 0;
			if (refused && result.status === "available") return {
				...base,
				status: "unavailable",
				note: refused
			};
			if (refused) result.note = `${result.note ?? "the lookup failed"}; if nobody holds it, ${refused}`;
			for (const key of ["url", "note"]) {
				const value = result[key];
				if (typeof value !== "string" || !value.trim()) delete result[key];
			}
			if (result.note) result.note = clean(result.note);
			return result;
		}
	};
}
/** The finding for a response the channel does not know how to read. */
function unexpected(service, res) {
	return {
		status: "unknown",
		note: `${service} returned HTTP ${res.status}`
	};
}
/**
* Limits how many tasks run at once, and optionally how often one starts; a finishing task hands its
* slot straight to the next waiter.
*/
var Gate = class {
	max;
	intervalMs;
	#active = 0;
	#waiting = [];
	#turn = Promise.resolve();
	#lastStart = -Infinity;
	constructor(max, intervalMs = 0) {
		this.max = max;
		this.intervalMs = intervalMs;
	}
	/** `paced` says whether the task will make a request; one that will fail at once is not spaced out. */
	async run(task, paced = () => true) {
		if (this.#active < this.max) this.#active++;
		else await new Promise((resolve) => this.#waiting.push(resolve));
		try {
			if (this.intervalMs && paced()) {
				const turn = this.#turn.then(async () => {
					const wait = this.#lastStart + this.intervalMs - Date.now();
					if (wait > 0) await new Promise((r) => setTimeout(r, wait));
					this.#lastStart = Date.now();
				});
				this.#turn = turn;
				await turn;
			}
			return await task();
		} finally {
			const next = this.#waiting.shift();
			if (next) next();
			else this.#active--;
		}
	}
};
/** Per host: requests at once, and the least time between two starting. Whois servers ban bursts. */
const LIMITS = {
	"registry.npmjs.org": { max: 8 },
	"api.github.com": { max: 4 },
	"itunes.apple.com": {
		max: 1,
		intervalMs: 1e3
	},
	"play.google.com": { max: 2 },
	"pubapi.registry.google": {
		max: 2,
		intervalMs: 600
	}
};
const DEFAULT_LIMIT = 4;
/** The gate for `host`. Unpaced gates skip the intervals, for tests that fake every service. */
function gateFor(gates, host, max, paced = true) {
	let gate = gates.get(host);
	if (!gate) {
		const limit = LIMITS[host];
		gate = new Gate(max ?? limit?.max ?? DEFAULT_LIMIT, paced ? limit?.intervalMs ?? 0 : 0);
		gates.set(host, gate);
	}
	return gate;
}
const USER_AGENT = "nameable (+https://www.npmjs.com/package/nameable)";
/** The longest `Retry-After` honored; a service asking for more is reported as rate limited instead. */
const MAX_RETRY_AFTER_MS = 1e4;
/** How long a 429 or 503 asks to wait, from its `Retry-After` header in seconds, when it says. */
function retryAfter(res) {
	const header = res.headers.get("retry-after")?.trim();
	if (!header) return void 0;
	const at = /[a-z]/i.test(header) ? Date.parse(header) : void 0;
	if (at !== void 0) return Number.isNaN(at) ? void 0 : Math.max(0, at - Date.now());
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1e3 : void 0;
}
function retryable(status) {
	return status === 429 || status >= 500;
}
/**
* GET with a timeout and retries on network errors, 429 and 5xx (not on timeouts).
* Returns the last response when retries run out on a retryable status, and throws when every attempt failed
* at the network level, so callers never mistake a failure for a 404.
*/
async function get(ctx, url, opts = {}) {
	const { retries = 2, timeoutMs = 1e4 } = opts;
	const backoffMs = ctx.backoffMs ?? 500;
	const host = new URL(url).host;
	const gate = gateFor(ctx.gates, host, void 0, ctx.backoffMs !== 0);
	const down = `down:${host}`;
	let lastError;
	let wait = 0;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, Math.max(wait, backoffMs * 2 ** (attempt - 1))));
		try {
			const res = await gate.run(() => {
				if (ctx.cache.has(down)) throw Object.assign(/* @__PURE__ */ new Error(`${host} did not respond`), { name: "TimeoutError" });
				return ctx.fetch(url, {
					headers: {
						"user-agent": USER_AGENT,
						...opts.headers
					},
					redirect: opts.redirect,
					...opts.body === void 0 ? {} : {
						method: "POST",
						body: opts.body
					},
					signal: AbortSignal.timeout(timeoutMs)
				}).catch((err) => {
					if (err instanceof Error && err.name === "TimeoutError") ctx.cache.set(down, Promise.resolve());
					throw err;
				});
			}, () => !ctx.cache.has(down));
			if (!retryable(res.status) || attempt === retries) return res;
			const asked = retryAfter(res);
			if (asked !== void 0 && asked > MAX_RETRY_AFTER_MS) return res;
			const slowDown = res.status === 429 ? 2e3 * 2 ** attempt : 0;
			wait = ctx.backoffMs === 0 ? 0 : asked ?? slowDown;
			lastError = /* @__PURE__ */ new Error(`HTTP ${res.status}`);
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") throw err;
			lastError = err;
		}
	}
	const reason = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`could not reach ${host} (${reason})`);
}
function memo(ctx, key, load) {
	let hit = ctx.cache.get(key);
	if (!hit) {
		hit = load();
		ctx.cache.set(key, hit);
	}
	return hit;
}
/**
* App titles compared the way a person reads them: NFKC, ignoring case and anything but letters and
* digits. A title also matches by its head, before a subtitle such as "Todoist: To Do List".
*/
const norm = (s) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const head = (title) => title.split(/:| [-–—|] /)[0];
/** Whether a name has letters or digits to compare at all ("🚀" and "!!" do not). */
const comparable = (name) => norm(name) !== "";
/**
* How a store title relates to a name. "same": the title is the name, ignoring case and punctuation.
* "similar": the title adds a subtitle ("Todoist: To Do List") or its maker, before the name ("Google
* Gemini" by Google LLC) or after "by" ("Claude by Anthropic"). Store names are unique by their exact
* title, so a similar one is a clash to weigh, not a holder of the name.
*/
function appNameMatch(title, name, developer) {
	const wanted = norm(name);
	if (wanted === "") return void 0;
	if (norm(title) === wanted) return "same";
	const close = (t) => norm(t) === wanted || norm(head(t)) === wanted;
	if (close(title)) return "similar";
	const maker = typeof developer === "string" ? developer.split(/[^\p{L}\p{N}]+/u).find(Boolean) : "";
	if (!maker) return void 0;
	if (title.toLowerCase().startsWith(`${maker.toLowerCase()} `) && close(title.slice(maker.length + 1))) return "similar";
	const by = title.toLowerCase().lastIndexOf(" by ");
	if (by > 0 && norm(title.slice(by + 4)).startsWith(norm(maker)) && close(title.slice(0, by))) return "similar";
}
/**
* The stores to search: the US one, plus those a name in Chinese, Japanese or Korean would be
* released in, since titles differ by localization ("微信" in China is "WeChat" elsewhere).
*/
function storefronts(name) {
	const found = [{
		country: "us",
		language: "en"
	}];
	if (/\p{Script=Han}/u.test(name)) found.push({
		country: "cn",
		language: "zh-CN"
	}, {
		country: "tw",
		language: "zh-TW"
	});
	if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name)) found.push({
		country: "jp",
		language: "ja"
	});
	if (/\p{Script=Hangul}/u.test(name)) found.push({
		country: "kr",
		language: "ko"
	});
	return found;
}
/** "the US store", "the US, CN and TW stores". */
function storeNames(stores) {
	const codes = stores.map((s) => s.country.toUpperCase());
	return `the ${codes.length > 1 ? `${codes.slice(0, -1).join(", ")} and ${codes.at(-1)}` : codes[0]} ${codes.length > 1 ? "stores" : "store"}`;
}
/** A title's length as a person counts it: one per grapheme, so an emoji or accented letter is one. */
const titleLength = (title) => [...new Intl.Segmenter().segment(title.trim())].length;
const appStore = defineChannel({
	id: "app-store",
	label: "App Store",
	category: "app",
	rules: (name) => titleLength(name) < 2 || titleLength(name) > 30 ? "App Store names are 2 to 30 characters" : void 0,
	async lookup(name, ctx) {
		if (!comparable(name)) return {
			status: "unknown",
			note: "a name without letters or digits cannot be matched to app titles"
		};
		const stores = storefronts(name);
		let similar;
		for (const { country } of stores) for (const entity of ["software", "macSoftware"]) {
			const res = await get(ctx, `https://itunes.apple.com/search?${new URLSearchParams({
				term: name,
				entity,
				limit: "200",
				country
			})}`);
			if (res.status !== 200) return unexpected("the App Store", res);
			const text = await res.text();
			if (/rate limit/i.test(text.slice(0, 200))) return {
				status: "unknown",
				note: "the App Store rate limited the search; try again in a minute"
			};
			const { results } = JSON.parse(text) ?? {};
			if (!Array.isArray(results)) return {
				status: "unknown",
				note: "the App Store returned an unexpected list"
			};
			const titled = (r) => typeof r?.trackName === "string" && typeof r.trackViewUrl === "string";
			const same = results.find((r) => titled(r) && appNameMatch(String(r.trackName), name) === "same");
			if (same) return {
				status: "taken",
				url: String(same.trackViewUrl),
				note: typeof same.sellerName === "string" ? `"${String(same.trackName)}" by ${same.sellerName}` : `"${String(same.trackName)}"`
			};
			similar ??= results.find((r) => titled(r) && appNameMatch(String(r.trackName), name, r.sellerName) === "similar");
		}
		const free = `no app with this name in ${storeNames(stores)}; unreleased apps are not listed`;
		if (!similar) return {
			status: "available",
			certainty: "probable",
			note: free
		};
		const maker = typeof similar.sellerName === "string" ? ` by ${similar.sellerName}` : "";
		return {
			status: "available",
			certainty: "probable",
			note: `clash, not a block: "${String(similar.trackName)}"${maker} goes by this name; ${free}`
		};
	}
});
const MARKETPLACE = "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json";
const MARKETPLACE_PAGE = "https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json";
const INSTALLABLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const words = (name) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const VENDOR = [
	"claude",
	"anthropic",
	"anthropics"
];
const OFFICIAL = /official[^a-z0-9]*(?:anthropic|claude)|(?:anthropic|claude)[^a-z0-9]*official/;
function reserved(name) {
	const w = words(name);
	const joined = w.join("");
	if ([
		"claude",
		"anthropic",
		"anthropics",
		"claudecode",
		"claudemods"
	].includes(joined)) return true;
	for (let i = 1; i < w.length; i++) if ([...VENDOR, "ccplugin"].includes(w.slice(0, i).join(""))) return true;
	return OFFICIAL.test(name.toLowerCase()) || OFFICIAL.test(joined);
}
/** Every plugin in the official marketplace, by lowercased name. */
function pluginList$1(ctx) {
	return memo(ctx, "claude-plugins", async () => {
		const res = await get(ctx, MARKETPLACE);
		if (!res.ok) throw new Error(`the official marketplace returned HTTP ${res.status}`);
		const { plugins } = await res.json() ?? {};
		if (!Array.isArray(plugins) || !plugins.length || !plugins.every((p) => typeof p?.name === "string")) throw new Error("the official marketplace is not in the expected shape");
		return new Map(plugins.map((p) => [p.name.toLowerCase(), p]));
	});
}
const claudePlugins = defineChannel({
	id: "claude-plugins",
	label: "Claude plugins",
	category: "agent",
	rules: (name) => INSTALLABLE.test(name) ? void 0 : "Claude Code installs plugins from a marketplace only under names of letters, digits, . _ and -, starting with a letter or digit",
	refuses: (name) => reserved(name) ? "Claude Code refuses names that look like an Anthropic plugin (claude, anthropic, official)" : void 0,
	async lookup(name, ctx) {
		const plugin = (await pluginList$1(ctx)).get(name.toLowerCase());
		if (plugin) return {
			status: "taken",
			url: (typeof plugin.homepage === "string" ? plugin.homepage : void 0) ?? MARKETPLACE_PAGE,
			note: typeof plugin.description === "string" ? plugin.description : void 0
		};
		return {
			status: "available",
			certainty: "confirmed",
			note: words(name).some((w) => VENDOR.includes(w)) ? "not in the official marketplace; Claude Code warns that the name reads as one of Anthropic's own" : "not in the official marketplace"
		};
	}
});
/** Every list kept in the store, so clearing the cache removes exactly these files and nothing else. */
const LIST_KEYS = [
	"pypi-projects",
	"homebrew-names",
	"crates-names",
	"pub-names",
	"rubygems-names",
	"cursor-plugins",
	"gemini-extensions",
	"mcp-servers",
	"openvsx-namespaces"
];
const FORMAT = 1;
/** The first line of a stored list, naming the list and its format. */
const listHeader = (key) => `#nameable ${key} v${FORMAT}\n`;
/**
* A registry-wide list (every PyPI project, every Homebrew alias), from the store when fresh enough,
* downloaded otherwise. A failed download falls back to an older copy; with no copy at all it throws,
* and the channel reports that it could not run the check.
*/
function cachedList(ctx, key, download) {
	return memo(ctx, `list:${key}${ctx.refresh ? ":refresh" : ""}`, async () => {
		const now = ctx.now?.() ?? Date.now();
		const stored = await ctx.store?.read(key);
		const saved = stored?.text.startsWith(listHeader(key)) ? {
			...stored,
			text: stored.text.slice(listHeader(key).length)
		} : void 0;
		const age = saved ? now - saved.savedAt : -Infinity;
		if (saved && !ctx.refresh && age > -1e3 && age < 864e5) return {
			...saved,
			stale: false
		};
		try {
			const text = await download();
			await ctx.store?.write(key, listHeader(key) + text).catch(() => void 0);
			return {
				text,
				savedAt: now,
				stale: false
			};
		} catch (err) {
			if (saved) return {
				...saved,
				stale: true
			};
			throw err;
		}
	});
}
/** The values on every line of `text` whose first tab-separated field is `key`. */
function linesFor(text, key) {
	const found = [];
	const needle = `\n${key}\t`;
	for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
		const end = text.indexOf("\n", at + 1);
		found.push(text.slice(at + needle.length, end < 0 ? void 0 : end).split("	"));
	}
	return found;
}
/** How old a stale list is, for notes. */
const asOf = (list) => new Date(list.savedAt).toISOString().slice(0, 10);
const END = Buffer.from([
	80,
	75,
	5,
	6
]);
const ENTRY = 33639248;
const LOCAL = 67324752;
const MAX32 = 4294967295;
/**
* Files named `wanted` (matched on their last path segment) from a remote zip archive, read with HTTP
* range requests, so a few small files come out of a multi-gigabyte archive without downloading it.
* Throws when the archive cannot be read this way (no range support, zip64, a missing file).
*/
async function remoteZipFiles(ctx, url, wanted) {
	const range = async (spec) => {
		const res = await get(ctx, url, {
			headers: { range: `bytes=${spec}` },
			timeoutMs: 12e4
		});
		if (res.status !== 206) throw new Error(`${url} answered a range request with HTTP ${res.status}`);
		return Buffer.from(await res.arrayBuffer());
	};
	const tail = await range("-65557");
	const end = tail.lastIndexOf(END);
	if (end < 0) throw new Error(`${url} is not a zip archive`);
	const count = tail.readUInt16LE(end + 10);
	const size = tail.readUInt32LE(end + 12);
	const offset = tail.readUInt32LE(end + 16);
	if (size === MAX32 || offset === MAX32) throw new Error(`${url} is a zip64 archive`);
	const dir = await range(`${offset}-${offset + size - 1}`);
	const entries = [];
	for (let at = 0, i = 0; i < count; i++) {
		if (dir.readUInt32LE(at) !== ENTRY) throw new Error(`${url} has a broken central directory`);
		const nameLength = dir.readUInt16LE(at + 28);
		const name = dir.toString("utf8", at + 46, at + 46 + nameLength);
		const file = wanted.find((w) => name === w || name.endsWith(`/${w}`));
		if (file) entries.push({
			file,
			method: dir.readUInt16LE(at + 10),
			size: dir.readUInt32LE(at + 20),
			offset: dir.readUInt32LE(at + 42)
		});
		at += 46 + nameLength + dir.readUInt16LE(at + 30) + dir.readUInt16LE(at + 32);
	}
	const files = /* @__PURE__ */ new Map();
	for (const e of entries) {
		if (e.size === MAX32 || e.offset === MAX32) throw new Error(`${url} is a zip64 archive`);
		const header = await range(`${e.offset}-${e.offset + 29}`);
		if (header.readUInt32LE(0) !== LOCAL) throw new Error(`${url} has a broken local header`);
		const start = e.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
		const data = e.size ? await range(`${start}-${start + e.size - 1}`) : Buffer.alloc(0);
		if (e.method === 0) files.set(e.file, data);
		else if (e.method === 8) files.set(e.file, inflateRawSync(data));
		else throw new Error(`${url} uses zip compression method ${e.method}`);
	}
	const missing = wanted.filter((w) => !files.has(w));
	if (missing.length) throw new Error(`${url} has no ${missing.join(", ")}`);
	return files;
}
const VALID$12 = /^[a-z][a-z0-9_-]{0,63}$/i;
const canon = (name) => name.toLowerCase().replace(/-/g, "_");
const RESERVED = new Set([
	"alloc",
	"arena",
	"ast",
	"builtins",
	"collections",
	"compiler-builtins",
	"compiler-rt",
	"compiletest",
	"core",
	"coretest",
	"debug",
	"driver",
	"flate",
	"fmt_macros",
	"grammar",
	"graphviz",
	"macro",
	"macros",
	"proc_macro",
	"rbml",
	"rust-installer",
	"rustbook",
	"rustc",
	"rustc_back",
	"rustc_borrowck",
	"rustc_driver",
	"rustc_llvm",
	"rustc_resolve",
	"rustc_trans",
	"rustc_typeck",
	"rustdoc",
	"rustllvm",
	"rustuv",
	"serialize",
	"std",
	"syntax",
	"test",
	"unicode",
	"nul",
	"con",
	"prn",
	"aux",
	"com0",
	"com1",
	"com2",
	"com3",
	"com4",
	"com5",
	"com6",
	"com7",
	"com8",
	"com9",
	"lpt0",
	"lpt1",
	"lpt2",
	"lpt3",
	"lpt4",
	"lpt5",
	"lpt6",
	"lpt7",
	"lpt8",
	"lpt9"
].map(canon));
const DUMP = "https://static.crates.io/db-dump.zip";
/** RFC 4180 rows as objects keyed by the header row; deletion messages hold commas, quotes and newlines. */
function csv(text) {
	const rows = [];
	let row = [];
	let field = "";
	let quoted = false;
	const endField = () => {
		row.push(field);
		field = "";
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted && c === "\"" && text[i + 1] === "\"") {
			field += "\"";
			i++;
		} else if (c === "\"") quoted = !quoted;
		else if (!quoted && c === ",") endField();
		else if (!quoted && c === "\n") {
			endField();
			rows.push(row);
			row = [];
		} else field += c;
	}
	if (field || row.length) {
		endField();
		rows.push(row);
	}
	const [head = [], ...body] = rows;
	return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
/** A dump timestamp (`2024-11-18 09:03:35.16643+00`) in ISO form, or undefined when it is not one. */
const isoTime = (value = "") => /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00$/.exec(value)?.slice(1).join("T").concat("Z");
/** Reserved names and names still blocked after a deletion, one `canon\treserved` or `canon\tdeleted\tuntil` line each. */
async function nameList$3(ctx) {
	const files = await remoteZipFiles(ctx, DUMP, ["reserved_crate_names.csv", "deleted_crates.csv"]);
	const reserved = csv(files.get("reserved_crate_names.csv").toString("utf8"));
	const deleted = csv(files.get("deleted_crates.csv").toString("utf8"));
	if (!reserved.length || !reserved.every((r) => r.name) || !deleted.length || !deleted.every((d) => d.name && isoTime(d.available_at))) throw new Error("crates.io database dump is not in the expected shape");
	const now = ctx.now?.() ?? Date.now();
	const lines = reserved.map((r) => `${canon(r.name)}\treserved`);
	for (const d of deleted) {
		const until = isoTime(d.available_at);
		if (Date.parse(until) > now) lines.push(`${canon(d.name)}\tdeleted\t${until}`);
	}
	return `\n${lines.join("\n")}\n`;
}
const crates = defineChannel({
	id: "crates",
	label: "crates.io",
	category: "package",
	rules: (name) => {
		if (!VALID$12.test(name)) return "crate names start with a letter and use letters, digits, - and _ (max 64)";
	},
	refuses: (name) => RESERVED.has(canon(name)) ? "crates.io reserves this name" : void 0,
	async lookup(name, ctx) {
		const res = await get(ctx, `https://crates.io/api/v1/crates/${name}`);
		if (res.status === 404) {
			let list;
			try {
				list = await cachedList(ctx, "crates-names", () => nameList$3(ctx));
			} catch {
				return {
					status: "available",
					certainty: "probable",
					note: "could not read crates.io's database dump to check reserved and recently deleted names"
				};
			}
			const now = ctx.now?.() ?? Date.now();
			for (const [kind, until] of linesFor(list.text, canon(name))) {
				if (kind === "reserved") return {
					status: "unavailable",
					note: "crates.io reserves this name"
				};
				if (kind === "deleted" && Date.parse(until) > now) return {
					status: "unavailable",
					note: `recently deleted; crates.io frees the name after ${until.slice(0, 16).replace("T", " ")} UTC`
				};
			}
			return list.stale ? {
				status: "available",
				certainty: "probable",
				note: `could not refresh crates.io's reserved and deleted names; used the copy from ${asOf(list)}`
			} : {
				status: "available",
				certainty: "confirmed"
			};
		}
		if (res.status !== 200) return unexpected("crates.io", res);
		const { crate } = await res.json();
		return {
			status: "taken",
			url: `https://crates.io/crates/${crate.name}`,
			note: crate.description?.trim() || void 0,
			meta: {
				name: crate.name,
				updated: crate.updated_at,
				downloads: crate.downloads
			}
		};
	}
});
const VALID$11 = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
/**
* Every plugin in Cursor's marketplace, one name per line. There is no API: the marketplace page,
* asked for its React Server Components payload, lists each plugin's `fullRef` (about 2 MB).
*/
async function pluginList(ctx) {
	const res = await get(ctx, "https://cursor.com/marketplace", {
		headers: { rsc: "1" },
		timeoutMs: 6e4
	});
	if (!res.ok) throw new Error(`Cursor's marketplace returned HTTP ${res.status}`);
	const names = new Set([...(await res.text()).matchAll(/"fullRef":"([^"]+)"/g)].map((m) => m[1]));
	if (names.size < 50) throw new Error("Cursor's marketplace is not in the expected shape");
	return `\n${[...names].map((n) => `${n}\t`).join("\n")}\n`;
}
const cursor = defineChannel({
	id: "cursor",
	label: "Cursor plugins",
	category: "agent",
	rules: (name) => VALID$11.test(name.toLowerCase()) ? void 0 : "Cursor plugin names are letters, digits, - and ., starting and ending with a letter or digit",
	refuses: (name) => name === name.toLowerCase() ? void 0 : "Cursor plugin names are lowercase",
	async lookup(name, ctx) {
		const list = await cachedList(ctx, "cursor-plugins", () => pluginList(ctx));
		if (linesFor(list.text, name.toLowerCase()).length) return {
			status: "taken",
			url: `https://cursor.com/marketplace/${name.toLowerCase()}`,
			note: "a plugin in Cursor's marketplace"
		};
		return {
			status: "available",
			certainty: "probable",
			note: list.stale ? `could not refresh Cursor's plugin list; not in the copy from ${asOf(list)}` : "not among Cursor's listed plugins; plugins in review or in team marketplaces are not visible"
		};
	}
});
const API$5 = "https://hub.docker.com/v2";
const VALID$10 = /^[a-z0-9]{4,30}$/i;
const docker = defineChannel({
	id: "docker",
	label: "Docker Hub",
	category: "package",
	rules: (name) => /^[a-z0-9][a-z0-9._-]{0,254}$/i.test(name) ? void 0 : "Docker Hub names are letters, digits, . _ and -",
	refuses: (name) => VALID$10.test(name) ? void 0 : "new Docker IDs are 4 to 30 letters and digits",
	async lookup(raw, ctx) {
		const name = raw.toLowerCase();
		const [user, org, repos, official] = await Promise.all([
			get(ctx, `${API$5}/users/${name}/`, { redirect: "manual" }),
			get(ctx, `${API$5}/orgs/${name}/`, { redirect: "manual" }),
			get(ctx, `${API$5}/namespaces/${name}/repositories/?page_size=1`),
			get(ctx, `${API$5}/repositories/library/${name}/`)
		]);
		const account = async (res, key) => res.status === 308 || res.status === 200 && typeof (await res.json())?.[key] === "string";
		const [isUser, isOrg] = await Promise.all([account(user, "username"), account(org, "orgname")]);
		const held = (res) => res === user ? isUser : isOrg;
		const count = repos.status === 200 ? await repoCount(repos) : void 0;
		if (held(user) || held(org) || (count ?? 0) > 0) {
			const kind = isUser && user.status === 200 ? "user" : isOrg && org.status === 200 ? "organization" : "account";
			const page = kind !== "account";
			return {
				status: "taken",
				url: page ? `https://hub.docker.com/u/${name}` : `${API$5}/namespaces/${name}/repositories/`,
				note: `${count === void 0 ? `Docker ${kind}` : `Docker ${kind}, ${plural(count)}`}${page ? "" : "; it has no profile page, the link lists its repositories"}`,
				meta: {
					kind,
					repositories: count
				}
			};
		}
		if (official.status === 200 && (await official.json())?.namespace === "library") return {
			status: "taken",
			url: `https://hub.docker.com/_/${name}`,
			note: `an official image; \`docker pull ${name}\` already gets it`,
			meta: { kind: "official image" }
		};
		if (user.status !== 404 || org.status !== 404 || count !== 0 || official.status !== 404) return {
			status: "unknown",
			note: `Docker Hub returned HTTP ${[
				user,
				org,
				repos,
				official
			].map((r) => r.status).join("/")}`
		};
		return {
			status: "available",
			certainty: "probable",
			note: "no user or organization; deactivated or reserved Docker IDs also look free"
		};
	}
});
async function repoCount(res) {
	const { count } = await res.json() ?? {};
	return typeof count === "number" ? count : void 0;
}
const plural = (n) => `${n} public ${n === 1 ? "repository" : "repositories"}`;
const IANA = "whois.iana.org";
/** One query, at most one at a time per server: whois servers ban bursts. */
function whoisQuery(ctx, server, query) {
	const down = `down:whois:${server}`;
	return gateFor(ctx.gates, `whois:${server}`, 1).run(() => {
		if (ctx.cache.has(down)) return Promise.reject(Object.assign(/* @__PURE__ */ new Error(`whois ${server} did not respond`), { name: "TimeoutError" }));
		return ctx.whois(server, query).catch((err) => {
			if (err instanceof Error && err.name === "TimeoutError") ctx.cache.set(down, Promise.resolve());
			throw err;
		});
	});
}
/** The registry's whois server for a TLD, as IANA refers it, or undefined when it lists none. */
function whoisServer(ctx, tld) {
	return memo(ctx, `whois-server:${tld}`, async () => {
		const text = await whoisQuery(ctx, IANA, tld);
		return /^whois:[ \t]*(\S+)/im.exec(text)?.[1];
	});
}
const FREE = [
	/^domain not found/im,
	/^not found/im,
	/^no match/im,
	/^no data found/im,
	/^no entries found/im,
	/^the queried object does not exist/im,
	/^status:\s*free\s*$/im,
	/^status:\s*available\s*$/im
];
const REGISTERED = [
	/^domain name:\s*\S/im,
	/^domain:\s*\S/im,
	/^\[domain name\]\s*\S/im
];
const NOTICE = /^\s*(%|#|>>>|\[ |NOTICE|TERMS)/;
function readWhois(text) {
	const body = text.split(/\r?\n/).filter((line) => !NOTICE.test(line)).map((line) => line.trim()).join("\n");
	if (FREE.some((re) => re.test(body))) return "free";
	if (REGISTERED.some((re) => re.test(body))) return "registered";
	return "unrecognized";
}
const BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** RDAP base URL for a TLD from IANA's bootstrap registry, or undefined when the TLD has no RDAP service. */
async function rdapBase(ctx, tld) {
	const service = (await memo(ctx, BOOTSTRAP, async () => {
		const res = await get(ctx, BOOTSTRAP);
		if (!res.ok) throw new Error(`IANA RDAP bootstrap returned HTTP ${res.status}`);
		return await res.json();
	})).services.find(([tlds]) => tlds.includes(tld));
	const url = service?.[1].find((u) => u.startsWith("https://")) ?? service?.[1][0];
	return url && (url.endsWith("/") ? url : `${url}/`);
}
async function viaWhois(ctx, fqdn, tld, url, rdapUnknown) {
	const base = { url };
	const server = await whoisServer(ctx, tld);
	if (!server) {
		const note = rdapUnknown ? `could not download IANA's RDAP server list, and .${tld} has no whois server` : `.${tld} has no RDAP or whois server at IANA; check that the TLD exists`;
		return {
			...base,
			status: "unknown",
			note
		};
	}
	const text = await whoisQuery(ctx, server, fqdn);
	const answer = readWhois(text);
	if (answer === "free") return {
		...base,
		status: "available",
		certainty: "probable",
		note: freeNote(tld, " (whois)")
	};
	if (answer === "registered") {
		const registered = /^\s*(?:creation date|created|registered on):\s*(\d{4}-\d{2}-\d{2})/im.exec(text)?.[1];
		return {
			...base,
			status: "taken",
			note: registered ? `registered ${registered} (whois)` : "registered (whois)",
			meta: {
				registered,
				whois: server
			}
		};
	}
	return {
		...base,
		status: "unknown",
		note: `unrecognized whois answer from ${server}`
	};
}
/** Why a free answer is still only probable. IDN TLDs (`xn--…`) also limit which scripts they take. */
const freeNote = (tld, via) => `not registered${via}` + (tld.startsWith("xn--") ? "; this TLD accepts only some scripts" : "") + "; a registry can still refuse premium or reserved names, so confirm at a registrar";
/** `tld` is in its ASCII (punycode) form; `display` is how to show it. */
function domain(tld, display = tld) {
	return defineChannel({
		id: `domain:${tld}`,
		label: `.${display}`,
		category: "domain",
		rules: (name) => {
			const ascii = domainToASCII(name);
			const unicode = domainToUnicode(ascii);
			if (/\P{ASCII}/u.test(unicode) && /[^\p{L}\p{M}\p{N}-]/u.test(unicode)) return "internationalized domain labels may only use letters, marks and digits (no emoji or symbols)";
			if (!LABEL.test(ascii)) return "domain labels are letters, digits and inner hyphens (max 63)";
			if (ascii.slice(2, 4) === "--" && !ascii.startsWith("xn--")) return "domain labels cannot have \"--\" in the 3rd and 4th position";
		},
		async lookup(name, ctx) {
			const fqdn = `${domainToASCII(name)}.${tld}`;
			const url = `https://lookup.icann.org/en/lookup?name=${fqdn}`;
			let rdapUnknown = false;
			const rdap = await rdapBase(ctx, tld).catch(() => {
				rdapUnknown = true;
			});
			if (!rdap) return viaWhois(ctx, fqdn, tld, url, rdapUnknown);
			const res = await get(ctx, `${rdap}domain/${fqdn}`, { headers: { accept: "application/rdap+json" } });
			if (res.status === 404) return {
				status: "available",
				certainty: "probable",
				url,
				note: freeNote(tld, "")
			};
			if (res.status !== 200) return {
				...unexpected("RDAP", res),
				url
			};
			const doc = await res.json();
			if (doc?.objectClassName !== "domain") return {
				status: "unknown",
				url,
				note: "RDAP returned something other than a domain record"
			};
			const event = (action) => doc.events?.find((e) => e.eventAction === action)?.eventDate.slice(0, 10);
			const registered = event("registration");
			const expires = event("expiration");
			return {
				status: "taken",
				url,
				note: [registered && `registered ${registered}`, expires && `expires ${expires}`].filter(Boolean).join(", ") || void 0,
				meta: {
					registered,
					expires
				}
			};
		}
	});
}
/**
* Every extension in the Gemini CLI gallery, one `name\trepository` line each, from the gallery's own
* data file (about 2 MB). The gallery is crawled from GitHub repositories tagged `gemini-cli-extension`.
*/
async function extensionList(ctx) {
	const res = await get(ctx, "https://geminicli.com/extensions.json", { timeoutMs: 6e4 });
	if (!res.ok) throw new Error(`the Gemini CLI gallery returned HTTP ${res.status}`);
	const entries = await res.json();
	if (!Array.isArray(entries) || entries.length < 50 || !entries.every((e) => typeof e?.extensionName === "string" && typeof e?.url === "string")) throw new Error("the Gemini CLI gallery is not in the expected shape");
	return `\n${entries.filter((e) => e.extensionName.trim()).map((e) => `${e.extensionName.trim().toLowerCase()}\t${e.url}`).join("\n")}\n`;
}
const gemini = defineChannel({
	id: "gemini",
	label: "Gemini extensions",
	category: "agent",
	rules: (name) => !name.trim() ? "Gemini CLI extension names cannot be empty" : /[\t\r\n]/.test(name) ? "Gemini CLI extension names cannot contain tabs or line breaks" : void 0,
	refuses: (name) => /^[a-zA-Z0-9-]+$/.test(name) ? void 0 : "Gemini CLI extension names are letters, digits and dashes",
	async lookup(name, ctx) {
		const list = await cachedList(ctx, "gemini-extensions", () => extensionList(ctx));
		const repos = linesFor(list.text, name.trim().toLowerCase()).map(([url]) => url);
		if (repos.length) return {
			status: "taken",
			url: repos[0],
			note: repos.length === 1 ? "clash, not a block: a gallery extension uses this name; two installed extensions cannot share one" : `clash, not a block: ${repos.length} gallery extensions use this name`,
			meta: { repositories: repos }
		};
		return {
			status: "available",
			certainty: "probable",
			note: list.stale ? `could not refresh the Gemini CLI gallery; not in the copy from ${asOf(list)}` : "not in the Gemini CLI gallery; it lists only tagged GitHub repositories"
		};
	}
});
const VALID$9 = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;
const github = defineChannel({
	id: "github",
	label: "GitHub user/org",
	category: "code",
	rules: (name) => /^[A-Za-z0-9_-]{1,39}$/.test(name) ? void 0 : "GitHub names are letters, digits, hyphens and underscores (max 39)",
	refuses: (name) => VALID$9.test(name) ? void 0 : "new GitHub names are letters, digits and single inner hyphens (max 39)",
	async lookup(name, ctx) {
		const headers = { accept: "application/vnd.github+json" };
		if (ctx.githubToken) headers.authorization = `Bearer ${ctx.githubToken}`;
		const res = await get(ctx, `https://api.github.com/users/${name}`, { headers });
		if (res.status === 200) {
			const user = await res.json();
			if (typeof user?.login !== "string") return {
				status: "unknown",
				note: "GitHub returned something other than an account"
			};
			return {
				status: "taken",
				url: `https://github.com/${user.login}`,
				note: `${user.type.toLowerCase()}, ${user.public_repos} public repos, profile updated ${user.updated_at.slice(0, 10)}`,
				meta: {
					type: user.type,
					publicRepos: user.public_repos,
					updated: user.updated_at
				}
			};
		}
		if (res.status === 404) return {
			status: "available",
			certainty: "probable",
			note: "suspended, deleted or reserved accounts also look free; confirm on GitHub's sign-up page"
		};
		if (res.status === 401) return {
			status: "unknown",
			note: "GitHub rejected the token (HTTP 401); check GITHUB_TOKEN"
		};
		if (res.status === 403 || res.status === 429) return {
			status: "unknown",
			note: "rate limited; set GITHUB_TOKEN or log in with `gh auth login`"
		};
		return unexpected("GitHub", res);
	}
});
const DATA = /AF_initDataCallback\(\{key: 'ds:4',.*?data:(.*?), sideChannel: \{\}\}\);<\/script>/s;
/** Whether a section is the one Play shows for no results; its token decodes to "zero_results_cluster". */
const zeroResults = (section) => typeof section?.[3]?.[0] === "string" && Buffer.from(section[3][0], "base64").toString("latin1").includes("zero_results_cluster");
/** The apps a search page lists, an empty list when it says there are none, undefined when unreadable. */
function apps(html) {
	const m = DATA.exec(html);
	if (!m) return void 0;
	let data;
	try {
		data = JSON.parse(m[1]);
	} catch {
		return;
	}
	const found = [];
	const sections = Array.isArray(data?.[0]?.[1]) ? data[0][1] : [];
	for (const section of sections) {
		const top = section?.[23]?.[16];
		const topId = top?.[3]?.["12"]?.[0]?.[0];
		if (typeof topId === "string" && typeof top[2]?.[0]?.[0] === "string") found.push({
			id: topId,
			title: top[2][0][0],
			developer: top[2]?.[68]?.[0]
		});
		for (const item of Array.isArray(section?.[22]?.[0]) ? section[22][0] : []) {
			const app = item?.[0];
			if (typeof app?.[0]?.[0] === "string" && typeof app[3] === "string") found.push({
				id: app[0][0],
				title: app[3],
				developer: app[14]
			});
		}
	}
	if (!found.length && !sections.some(zeroResults)) return void 0;
	return found;
}
const googlePlay = defineChannel({
	id: "google-play",
	label: "Google Play",
	category: "app",
	rules: (name) => titleLength(name) < 1 || titleLength(name) > 30 ? "Google Play titles are 1 to 30 characters" : void 0,
	async lookup(name, ctx) {
		if (!comparable(name)) return {
			status: "unknown",
			note: "a name without letters or digits cannot be matched to app titles"
		};
		const stores = storefronts(name).filter((s) => s.country !== "cn");
		let similar;
		for (const { country, language } of stores) {
			const res = await get(ctx, `https://play.google.com/store/search?${new URLSearchParams({
				q: name,
				c: "apps",
				hl: language,
				gl: country.toUpperCase()
			})}`);
			if (res.status !== 200) return unexpected("Google Play", res);
			const found = apps(await res.text());
			if (!found) return {
				status: "unknown",
				note: "the Google Play search page could not be read"
			};
			const by = (a) => typeof a.developer === "string" ? ` by ${a.developer}` : "";
			const same = found.find((a) => appNameMatch(a.title, name) === "same");
			if (same) return {
				status: "taken",
				url: `https://play.google.com/store/apps/details?id=${same.id}`,
				note: `clash, not a block: "${same.title}"${by(same)} uses this title; Play titles are not unique`
			};
			const near = found.find((a) => appNameMatch(a.title, name, a.developer) === "similar");
			similar ??= near && `"${near.title}"${by(near)}`;
		}
		const free = `no app with this title in search results of ${storeNames(stores)}; unreleased apps are not listed`;
		if (!similar) return {
			status: "available",
			certainty: "probable",
			note: free
		};
		return {
			status: "available",
			certainty: "probable",
			note: `clash, not a block: ${similar} goes by this name; ${free}`
		};
	}
});
const API$4 = "https://formulae.brew.sh/api";
function auditorProblem(name) {
	if (/[A-Z]/.test(name)) return "uppercase letters";
	if (/\s/.test(name)) return "whitespace";
	if (/[^\x20-\x7e]/.test(name)) return "non-ASCII characters";
	if (name.includes("--")) return "double hyphens";
	if (name.startsWith("@")) return "a leading @";
	if (name.endsWith("@")) return "a trailing @";
	if (name.startsWith("-")) return "a leading hyphen";
	if (name.endsWith("-")) return "a trailing hyphen";
	if ((name.match(/@/g) ?? []).length > 1) return "multiple @ symbols";
	if (name.includes("-@")) return "a hyphen followed by an @";
	if (name.includes("@-")) return "an @ followed by a hyphen";
}
const formulaClass = (name) => (name.charAt(0).toUpperCase() + name.slice(1)).replace(/[-_.\s]([a-zA-Z0-9])/g, (_, c) => c.toUpperCase()).replaceAll("+", "x").replace(/(.)@(\d)/, "$1AT$2");
const CONSTANT = /^[A-Z]\w*$/;
const DISALLOWED = /^(?:gem|rubygems?|pip|pil|macruby|gsutil|gfortran|play|haskell-platform|mysqldump-secure|ngrok|cargo|cargo-completion|uconv|postgresql|postgres)$/;
const disallowed = (name) => DISALLOWED.test(name) || /(?:lib)?lzma/.test(name);
/**
* Every name homebrew/core and homebrew/cask hold: formulae with their aliases and old names, casks with
* their old tokens, one `name\tkind\ttarget` line each (about 7 MB to download).
*/
async function nameList$2(ctx) {
	const load = async (path) => {
		const res = await get(ctx, `${API$4}/${path}`, { timeoutMs: 12e4 });
		if (!res.ok) throw new Error(`Homebrew ${path} returned HTTP ${res.status}`);
		return res.json();
	};
	const [formulae, casks] = await Promise.all([load("formula.json"), load("cask.json")]);
	const isList = (x, key, arrays) => Array.isArray(x) && x.length > 0 && x.every((e) => typeof e?.[key] === "string" && arrays.every((a) => Array.isArray(e[a])));
	if (!isList(formulae, "name", ["aliases", "oldnames"]) || !isList(casks, "token", ["old_tokens"])) throw new Error("Homebrew name lists are not in the expected shape");
	const lines = [];
	for (const f of formulae) {
		lines.push(`${f.name}\tformula\t${f.name}`);
		for (const a of f.aliases) lines.push(`${a}\talias\t${f.name}`);
		for (const o of f.oldnames) lines.push(`${o}\told name\t${f.name}`);
	}
	for (const c of casks) {
		lines.push(`${c.token}\tcask\t${c.token}`);
		for (const o of c.old_tokens) lines.push(`${o}\told cask token\t${c.token}`);
	}
	return `\n${lines.join("\n")}\n`;
}
const homebrew = defineChannel({
	id: "homebrew",
	label: "Homebrew",
	category: "package",
	rules: (name) => /^[A-Za-z0-9@._+-]+$/.test(name) ? void 0 : "Homebrew names are letters, digits and @ . _ + -",
	refuses: (name) => {
		const problem = auditorProblem(name);
		if (problem) return `Homebrew names must not contain ${problem}`;
		if (!CONSTANT.test(formulaClass(name))) return "Homebrew formula names start with a letter and use letters, digits, + . _ - and @ before a version";
		if (disallowed(name)) return "homebrew/core does not allow this name";
	},
	async lookup(typed, ctx) {
		const name = typed.toLowerCase();
		const [formula, cask] = await Promise.all([get(ctx, `${API$4}/formula/${name}.json`), get(ctx, `${API$4}/cask/${name}.json`)]);
		for (const [kind, res] of [["formula", formula], ["cask", cask]]) if (res.status === 200) {
			const found = await res.json();
			if (typeof found?.name !== "string" && typeof found?.token !== "string") continue;
			const { desc } = found;
			return {
				status: "taken",
				url: `https://formulae.brew.sh/${kind}/${name}`,
				note: desc,
				meta: { kind }
			};
		}
		if (formula.status !== 404 || cask.status !== 404) return {
			status: "unknown",
			note: `Homebrew API returned HTTP ${formula.status}/${cask.status}`
		};
		let list;
		try {
			list = await cachedList(ctx, "homebrew-names", () => nameList$2(ctx));
		} catch {
			return {
				status: "available",
				certainty: "probable",
				note: "could not download Homebrew's alias list to check aliases and old names"
			};
		}
		const [hit] = linesFor(list.text, name);
		if (hit) {
			const [kind, target] = hit;
			return {
				status: "taken",
				url: `https://formulae.brew.sh/${kind.includes("cask") ? "cask" : "formula"}/${target}`,
				note: target === name ? void 0 : `${kind} of ${target}`,
				meta: {
					kind,
					target
				}
			};
		}
		return list.stale ? {
			status: "available",
			certainty: "probable",
			note: `could not refresh Homebrew's aliases and old names; used the copy from ${asOf(list)}`
		} : {
			status: "available",
			certainty: "confirmed",
			note: "no homebrew-core formula or cask"
		};
	}
});
const MCP_SERVERS = "https://raw.githubusercontent.com/minanyang/nameable/data/mcp-servers.tsv";
const API$3 = "https://registry.modelcontextprotocol.io/v0.1";
const HEADER = "#nameable-data mcp-servers v1";
const STALE_AFTER_MS = 2592e5;
const VALID$8 = /^[a-zA-Z0-9._-]+$/;
/**
* Every server in the published list, one `name part\tfull name\tstatus` line each, then `#asof\t<time>`:
* when the list was read from the registry.
*/
async function serverList(ctx) {
	const res = await get(ctx, MCP_SERVERS, { timeoutMs: 6e4 });
	if (!res.ok) throw new Error(`the MCP Registry list returned HTTP ${res.status}`);
	const lines = (await res.text()).split("\n");
	const asOf = lines.find((l) => l.startsWith("#asof	"))?.slice(6) ?? "";
	const servers = lines.slice(1).filter((l) => l && !l.startsWith("#"));
	const end = lines.find((l) => l.startsWith("#end	"))?.slice(5);
	if (lines[0] !== HEADER || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(asOf) || servers.length < 1e3 || Number(end) !== servers.length) throw new Error("the MCP Registry list is not in the expected shape");
	return `\n${servers.flatMap((line) => {
		const [full, status] = line.split("	");
		const part = full?.split("/")[1];
		return part && status ? [`${part.toLowerCase()}\t${full}\t${status}`] : [];
	}).join("\n")}\n#asof\t${asOf}\n`;
}
const mcpRegistry = defineChannel({
	id: "mcp-registry",
	label: "MCP Registry",
	category: "agent",
	rules: (name) => VALID$8.test(name) ? void 0 : "MCP server names are letters, digits, dots, hyphens and underscores",
	async lookup(name, ctx) {
		const list = await cachedList(ctx, "mcp-servers", () => serverList(ctx));
		const servers = linesFor(list.text, name.toLowerCase()).sort((a, b) => Number(a[1] === "deprecated") - Number(b[1] === "deprecated"));
		if (servers.length) {
			const [full, status] = servers[0];
			const lead = `${full}${status === "deprecated" ? " (deprecated)" : ""}`;
			const who = servers.length === 1 ? `${lead} uses` : `${lead} and ${servers.length - 1} more use`;
			return {
				status: "taken",
				url: `${API$3}/servers/${encodeURIComponent(full)}/versions/latest`,
				note: `clash, not a block: ${who} this name; your own namespace can still publish it`,
				meta: {
					servers: servers.length,
					examples: servers.slice(0, 10).map(([s]) => s)
				}
			};
		}
		const time = linesFor(list.text, "#asof")[0]?.[0] || asOf(list);
		return {
			status: "available",
			certainty: "probable",
			note: `no server uses this name in the registry as of ${time.slice(0, 10)}${(ctx.now?.() ?? Date.now()) - Date.parse(time) > STALE_AFTER_MS ? ", and the list has not been updated since" : ""}`
		};
	}
});
const API$2 = "https://plugins.jetbrains.com/api";
const RESTRICTED = /plugin|jetbrains|idea|pycharm|clion|appcode|datagrip|fleet|goland|phpstorm|webstorm|rider|resharper|teamcity|youtrack|rubymine|intellij/i;
const NAME_CHARS = /^[a-zA-Z0-9 .,+_\-/:()#'&[\]|]{1,64}$/;
const TEMPLATE_NAMES = /* @__PURE__ */ new Set([
	"template",
	"demo",
	"my framework support",
	"plugin display name here"
]);
const jetbrains = defineChannel({
	id: "jetbrains",
	label: "JetBrains Marketplace",
	category: "editor",
	rules: (name) => !name.trim() ? "JetBrains plugin names cannot be empty" : name.length > 255 ? "JetBrains plugin names and IDs are at most 255 characters" : void 0,
	refuses: (name) => {
		if (!NAME_CHARS.test(name.trim())) return "JetBrains plugin names are letters, digits, spaces and . , + _ - / : ( ) # ' & [ ] |, at most 64";
		const word = RESTRICTED.exec(name)?.[0];
		if (word) return `JetBrains refuses new plugin names containing "${word}"`;
		if (TEMPLATE_NAMES.has(name.trim().toLowerCase())) return "JetBrains refuses template plugin names";
	},
	async lookup(name, ctx) {
		const byId = /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name) ? await get(ctx, `${API$2}/plugins/intellij/${name}`) : void 0;
		if (byId?.status === 200) {
			const plugin = await byId.json();
			if (typeof plugin?.xmlId !== "string") return {
				status: "unknown",
				note: "JetBrains Marketplace returned something other than a plugin"
			};
			return {
				status: "taken",
				url: `https://plugins.jetbrains.com${typeof plugin?.link === "string" ? plugin.link : ""}`,
				note: typeof plugin?.name === "string" ? `the plugin ID of ${plugin.name}` : "a plugin ID"
			};
		}
		if (byId && byId.status !== 404) return unexpected("JetBrains Marketplace", byId);
		const query = new URLSearchParams({
			search: name,
			max: "20"
		});
		const res = await get(ctx, `${API$2}/searchPlugins?${query}`);
		if (res.status !== 200) return unexpected("JetBrains Marketplace", res);
		const { plugins } = await res.json() ?? {};
		if (!Array.isArray(plugins)) return {
			status: "unknown",
			note: "JetBrains Marketplace returned an unexpected list"
		};
		const wanted = name.trim().toLowerCase();
		const hit = plugins.find((p) => typeof p?.name === "string" && p.name.toLowerCase() === wanted || typeof p?.xmlId === "string" && p.xmlId.toLowerCase() === wanted);
		if (hit) return {
			status: "taken",
			url: typeof hit.link === "string" ? `https://plugins.jetbrains.com${hit.link}` : `https://plugins.jetbrains.com/search?search=${encodeURIComponent(name)}`,
			note: typeof hit.name === "string" && hit.name.toLowerCase() === wanted ? "a plugin with this name; plugin names must be unique" : typeof hit.name === "string" ? `the plugin ID of ${hit.name}` : "a plugin ID"
		};
		return {
			status: "available",
			certainty: "probable",
			note: "no plugin with this name or ID; unapproved and hidden plugins are not listed"
		};
	}
});
const REGISTRY = "https://registry.npmjs.org";
const EXCLUDED = /* @__PURE__ */ new Set(["node_modules", "favicon.ico"]);
const SCOPED = /^(?:@([^/]+?)[/])?([^/]+?)$/;
/**
* validate-npm-package-name (lib/index.js, v7): errors make a name invalid for any package. Returns the
* first reason, in the validator's order.
*/
function problem(name) {
	if (!name.length) return "npm names cannot be empty";
	if (name.startsWith(".")) return "npm names cannot start with a period";
	if (name.startsWith("_")) return "npm names cannot start with an underscore";
	if (name.trim() !== name) return "npm names cannot have leading or trailing spaces";
	if (EXCLUDED.has(name.toLowerCase())) return `${name} is not a valid npm name`;
	if (encodeURIComponent(name) !== name) {
		const match = SCOPED.exec(name);
		const [user, pkg] = [match?.[1], match?.[2]];
		if (match && pkg?.startsWith(".")) return "npm names cannot start with a period";
		const urlSafe = (s) => s !== void 0 && encodeURIComponent(s) === s;
		if (!(match && urlSafe(user) && urlSafe(pkg))) return "npm names may only contain URL-safe characters";
	}
}
/**
* The validator's warnings: names old packages may have (`events`, `JSONStream`) but `validForNewPackages`
* rules out, so they apply only once nobody holds the name.
*/
function newOnly(name) {
	if (name.startsWith("-")) return "npm names cannot start with a hyphen";
	if (builtinModules.includes(name.toLowerCase())) return "npm reserves Node.js core module names";
	if (name.length > 214) return "npm names are at most 214 characters";
	if (name.toLowerCase() !== name) return "npm names must be lowercase";
	if (/[~'!()*]/.test(name.split("/").at(-1))) return "npm names cannot contain ~ ' ! ( ) *";
}
const squash = (s) => s.replace(/[-_.]/g, "");
/**
* npm refuses an unscoped name that equals an existing package once punctuation is removed
* (`first-one` vs `firstone`, `babelpresetenv` vs `babel-preset-env`). The registry has no lookup for
* that, so this catches the common cases: it searches both spellings (search does not surface
* `firstone` for `first-one`) and, for a name without punctuation, probes every single-hyphen
* spelling (search never surfaces `lodash-es` for `lodashes`). Spellings with several separators
* cannot all be probed, so a name that passes is only probably free.
*/
const SEARCH_LENGTH = {
	min: 2,
	max: 64
};
const MAX_PROBED_LENGTH = 20;
async function similar$1(ctx, name) {
	const queries = [.../* @__PURE__ */ new Set([name, squash(name)])].filter((q) => q.length >= SEARCH_LENGTH.min && q.length <= SEARCH_LENGTH.max);
	const found = (await Promise.all(queries.map(async (q) => {
		const res = await get(ctx, `${REGISTRY}/-/v1/search?text=${encodeURIComponent(q)}&size=50`);
		if (!res.ok) throw new Error(`search HTTP ${res.status}`);
		return (await res.json()).objects;
	}))).flat().map((o) => o.package.name).find((n) => !n.startsWith("@") && n !== name && squash(n) === squash(name));
	if (found || name.length > MAX_PROBED_LENGTH) return found;
	const variants = name !== squash(name) ? [
		"-",
		"_",
		"."
	].map((sep) => name.replace(/[-_.]/g, sep)).concat(squash(name)) : Array.from({ length: name.length - 1 }, (_, i) => `${name.slice(0, i + 1)}-${name.slice(i + 1)}`);
	return (await Promise.all([...new Set(variants)].filter((v) => v !== name).map(async (variant) => {
		const res = await get(ctx, `${REGISTRY}/${encodeURIComponent(variant)}`, { headers: { accept: "application/vnd.npm.install-v1+json" } });
		if (res.status !== 200 && res.status !== 404) throw new Error(`registry HTTP ${res.status}`);
		if (res.status === 404) return void 0;
		return (await res.json())?.name === variant ? variant : void 0;
	}))).find(Boolean);
}
/** Only the npm user or organization named after a scope can publish under it. */
async function scopeNote(ctx, scope) {
	const res = await get(ctx, `${REGISTRY}/-/org/${encodeURIComponent(scope)}/package`).catch(() => void 0);
	if (res?.status === 200) return `@${scope} belongs to the npm user or organization "${scope}"; only they can publish under it`;
	if (res?.status === 404) return `no npm user or organization is named "${scope}"; create the organization to publish under @${scope}`;
	return `only the owner of @${scope} can publish under it; whether that is you could not be checked`;
}
const npm = defineChannel({
	id: "npm",
	label: "npm",
	category: "package",
	rules: problem,
	refuses: newOnly,
	async lookup(name, ctx) {
		const url = `https://www.npmjs.com/package/${name}`;
		const res = await get(ctx, `${REGISTRY}/${name.replace("/", "%2f")}`);
		if (res.status === 200) {
			const doc = await res.json();
			if (typeof doc?.name !== "string") return {
				status: "unknown",
				note: "npm returned something other than a package document"
			};
			if (!doc.versions && doc.time?.unpublished) {
				const at = doc.time.unpublished.time;
				const until = Date.parse(at) + 864e5;
				if (!((ctx.now?.() ?? Date.now()) >= until)) return {
					status: "unavailable",
					url,
					note: `unpublished on ${at.slice(0, 10)}; npm blocks the name until ${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC`
				};
				return {
					status: "reclaimable",
					url,
					note: `unpublished on ${at.slice(0, 10)}; anyone can publish it again`
				};
			}
			return {
				status: "taken",
				url,
				note: doc.description,
				meta: {
					latest: doc["dist-tags"]?.latest,
					modified: doc.time?.modified
				}
			};
		}
		if (res.status !== 404) return unexpected("npm registry", res);
		const scope = SCOPED.exec(name)?.[1];
		if (scope) return {
			status: "available",
			certainty: "probable",
			note: await scopeNote(ctx, scope)
		};
		try {
			const clash = await similar$1(ctx, name);
			if (clash) return {
				status: "unavailable",
				note: `npm refuses it: the same as "${clash}" without punctuation`
			};
			return {
				status: "available",
				certainty: "probable",
				note: "not every punctuation variant can be checked (npm refuses first-one if firstone exists)"
			};
		} catch {
			return {
				status: "available",
				certainty: "probable",
				note: "could not check npm's similar-name rule"
			};
		}
	}
});
const VALID$7 = /^[\p{L}\p{Nd}\p{Mn}\p{Pc}]+(?:[.-][\p{L}\p{Nd}\p{Mn}\p{Pc}]+)*$/u;
const MAX$1 = 100;
const nuget = defineChannel({
	id: "nuget",
	label: "NuGet",
	category: "package",
	rules: (name) => {
		if (!VALID$7.test(name)) return "NuGet IDs are letters, digits and _, joined by single . or -";
		if (name.length > MAX$1) return `NuGet IDs are at most ${MAX$1} characters`;
	},
	async lookup(name, ctx) {
		const id = name.toLowerCase();
		const url = `https://www.nuget.org/packages/${encodeURIComponent(name)}`;
		const reg = await get(ctx, `https://api.nuget.org/v3/registration5-gz-semver2/${encodeURIComponent(id)}/index.json`);
		if (reg.status === 200) {
			const body = await reg.json();
			if (!Array.isArray(body?.items)) return {
				status: "unknown",
				note: "NuGet returned something other than a registration"
			};
			return {
				status: "taken",
				url,
				note: (body?.items?.at(-1)?.items?.at(-1)?.catalogEntry)?.description
			};
		}
		if (reg.status !== 404) return unexpected("NuGet", reg);
		const page = await get(ctx, url);
		if (page.status === 200) return (await page.text()).includes("This package has been deleted from the gallery") ? {
			status: "unavailable",
			url,
			note: "deleted by the NuGet team; the ID stays held"
		} : {
			status: "taken",
			url,
			note: "listed on the gallery but not yet in the API"
		};
		if (page.status !== 404) return {
			status: "available",
			certainty: "probable",
			note: `could not check for a deleted package with this ID (HTTP ${page.status})`
		};
		return {
			status: "available",
			certainty: "probable",
			note: "no package with this ID; reserved prefixes and the typosquatting check are hidden and can still refuse it"
		};
	}
});
/** The edit distance between two strings, by code unit. */
function levenshtein(a, b) {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		prev = row;
	}
	return prev[b.length];
}
const API$1 = "https://open-vsx.org/api";
const VALID$6 = /^[\w\-+$~]{1,255}$/;
const SIMILARITY = .2;
const similar = (a, b) => a !== b && levenshtein(a, b) <= SIMILARITY * Math.max(a.length, b.length);
const PAGE = 1e3;
const WINDOW = 1e4;
/**
* Every namespace with a public extension, one per line, then a `#coverage\tread\ttotal` line. Built from
* search pages sorted both ways by date, which together reach 20,000 extensions (about 25 requests).
*/
async function namespaceList(ctx) {
	const page = async (order, offset) => {
		const query = new URLSearchParams({
			size: String(PAGE),
			offset: String(offset),
			sortBy: "timestamp",
			sortOrder: order
		});
		const res = await get(ctx, `${API$1}/-/search?${query}`, { timeoutMs: 6e4 });
		if (!res.ok) throw new Error(`Open VSX search returned HTTP ${res.status}`);
		const body = await res.json();
		if (typeof body?.totalSize !== "number" || !Array.isArray(body.extensions)) throw new Error("Open VSX search is not in the expected shape");
		return body;
	};
	const first = await page("asc", 0);
	const offsets = Array.from({ length: WINDOW / PAGE }, (_, i) => i * PAGE).filter((o) => o < first.totalSize);
	const pages = await Promise.all([...offsets.slice(1).map((o) => page("asc", o)), ...offsets.map((o) => page("desc", o))]);
	const seen = /* @__PURE__ */ new Set();
	const namespaces = /* @__PURE__ */ new Set();
	for (const { extensions } of [first, ...pages]) for (const e of extensions) {
		if (typeof e?.namespace !== "string") continue;
		namespaces.add(e.namespace);
		seen.add(`${e.namespace}.${String(e.name)}`);
	}
	if (namespaces.size < 100) throw new Error("Open VSX search returned too few namespaces");
	return `\n${[...namespaces].join("\n")}\n#coverage\t${seen.size}\t${first.totalSize}\n`;
}
const openVsx = defineChannel({
	id: "open-vsx",
	label: "Open VSX",
	category: "editor",
	rules: (name) => VALID$6.test(name) && name !== "-" ? void 0 : "Open VSX namespaces are letters, digits and _ - + $ ~",
	async lookup(name, ctx) {
		const url = `https://open-vsx.org/namespace/${name}`;
		const res = await get(ctx, `${API$1}/${name}`);
		if (res.status === 200) {
			const body = await res.json();
			if (typeof body?.name === "string" && body.name.toLowerCase() === name.toLowerCase()) return {
				status: "taken",
				url,
				note: "a namespace has this name; it blocks only using it as your namespace, not as an extension name"
			};
		} else if (res.status !== 404) return unexpected("Open VSX", res);
		const publisher = await get(ctx, `https://marketplace.visualstudio.com/publishers/${name}`, { redirect: "manual" });
		if (publisher.status === 200 || publisher.status === 301) return {
			status: "unavailable",
			url: `https://marketplace.visualstudio.com/publishers/${name}`,
			note: "a VS Code Marketplace publisher has this name; Open VSX lets only its verified owner publish under it"
		};
		if (publisher.status !== 404) return unexpected("the VS Code Marketplace", publisher);
		const list = await cachedList(ctx, "openvsx-namespaces", () => namespaceList(ctx));
		const lines = list.text.split("\n");
		const wanted = name.toLowerCase();
		const near = lines.find((n) => n && !n.startsWith("#") && similar(n.toLowerCase(), wanted));
		if (near) return {
			status: "unavailable",
			url: `https://open-vsx.org/namespace/${near}`,
			note: `Open VSX refuses namespaces too similar to "${near}"`
		};
		const [read, total] = (lines.find((l) => l.startsWith("#coverage	")) ?? "").split("	").slice(1).map(Number);
		const partial = read < total ? `; ${total - read} of ${total} extensions could not be read` : "";
		return {
			status: "available",
			certainty: "probable",
			note: `no namespace or similar one${list.stale ? ` as of ${asOf(list)}` : ""}; namespaces without public extensions are not listed${partial}`
		};
	}
});
const VALID$5 = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
/** pub-dev's reducePackageName: `_` is dropped and case ignored when names are compared. */
const reduce = (name) => name.replaceAll("_", "").toLowerCase();
const RESERVED_WORDS = new Set("abstract as assert augment await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for get hide if implements import in inline interface is late library mixin new null of on operator part required rethrow return sealed set show static super switch sync this throw true try type typedef var void while with yield".split(" "));
const MIXED_CASE_TWINS = new Set("autolinker dartdemocli filetecouch flutter_nectar google_search_v2 loadingbox polymerintro pong ral transmission_rpc viauthclient".split(" "));
const TEAM_NAMES = new Set("_macros brick core dart dart2js dart2native dartanalyzer dartaotruntime dartdevc dartfmt flutter_web flutter_web_test flutter_web_ui google_maps_flutter hummingbird in_app_purchase location_background web_socket math mirrors developer pub swift_ui swiftgen versions webview_flutter firebaseui fluttery fluttery_audio fluttery_seekbar data_class hook kotlin ok_http credilio_sbm app_update flutterkit".split(" ").map(reduce));
const SDK$1 = new Set("flutter flutter_driver flutter_driver_extension flutter_gpu flutter_localizations flutter_test flutter_web_plugins".split(" "));
const HOMOGLYPHS = [
	["1", "l"],
	["d", "cl"],
	["g", "cj"],
	["m", "rn"],
	["w", "vv"]
];
function conflictForms(name) {
	const r = reduce(name);
	const forms = /* @__PURE__ */ new Set([r]);
	if (!r.endsWith("s") && r.length >= 3) forms.add(`${r}s`);
	if (r.endsWith("s") && r.length >= 4) forms.add(r.slice(0, -1));
	for (const [a, b] of HOMOGLYPHS) {
		if (r.includes(a)) forms.add(r.replaceAll(a, b));
		if (r.includes(b)) forms.add(r.replaceAll(b, a));
	}
	return forms;
}
/**
* Every package on pub.dev, one `form\tname` line for each conflict form of each name (about 6 MB).
* Moderated packages are left out of the public list, though they still block similar names.
*/
async function nameList$1(ctx) {
	const names = [];
	const seen = /* @__PURE__ */ new Set();
	for (let url = "https://pub.dev/api/package-names"; url;) {
		if (seen.has(url)) throw new Error("pub.dev package-names pages loop");
		seen.add(url);
		const res = await get(ctx, url, { timeoutMs: 12e4 });
		if (!res.ok) throw new Error(`pub.dev package-names returned HTTP ${res.status}`);
		const page = await res.json();
		if (!Array.isArray(page?.packages)) throw new Error("pub.dev package-names is not a list");
		names.push(...page.packages);
		url = page.nextUrl ?? null;
	}
	if (!names.length || !names.every((n) => typeof n === "string")) throw new Error("pub.dev package-names is not in the expected shape");
	const lines = [];
	for (const name of names) for (const form of conflictForms(name)) lines.push(`${form}\t${name}`);
	return `\n${lines.join("\n")}\n`;
}
const pub = defineChannel({
	id: "pub",
	label: "pub.dev",
	category: "package",
	rules: (name) => {
		if (!VALID$5.test(name)) return "pub.dev names are letters, digits and _, start with a letter or _, at most 64 characters";
	},
	refuses: (name) => {
		if (name !== name.toLowerCase()) return "pub.dev names must be lowercase";
		if (RESERVED_WORDS.has(reduce(name))) return "pub.dev refuses Dart reserved words";
		if (MIXED_CASE_TWINS.has(name)) return "pub.dev refuses the lowercase twin of an older mixed-case package";
		if (SDK$1.has(name)) return "this package is part of the Flutter SDK";
		if (TEAM_NAMES.has(reduce(name))) return "pub.dev keeps this name for the Dart and Flutter teams";
	},
	async lookup(name, ctx) {
		const url = `https://pub.dev/packages/${name}`;
		const res = await get(ctx, `https://pub.dev/api/packages/${name}`);
		if (res.status === 200) {
			const doc = await res.json();
			if (typeof doc?.name !== "string") return {
				status: "unknown",
				note: "pub.dev returned something other than a package"
			};
			const { isDiscontinued, latest } = doc;
			return {
				status: "taken",
				url,
				note: isDiscontinued ? "discontinued" : latest?.pubspec?.description,
				meta: { discontinued: isDiscontinued === true }
			};
		}
		if (res.status !== 404) return unexpected("pub.dev", res);
		let list;
		try {
			list = await cachedList(ctx, "pub-names", () => nameList$1(ctx));
		} catch {
			return {
				status: "available",
				certainty: "probable",
				note: "could not download pub.dev's package list to check similar names"
			};
		}
		for (const form of conflictForms(name)) {
			const clash = linesFor(list.text, form).find(([existing]) => existing !== name);
			if (clash) return {
				status: "unavailable",
				url: `https://pub.dev/packages/${clash[0]}`,
				note: `pub.dev rejects names too similar to "${clash[0]}"`
			};
		}
		return {
			status: "available",
			certainty: "probable",
			note: list.stale ? `could not refresh pub.dev's package list; used the copy from ${asOf(list)}` : "no package with this name; moderated packages and reserved names are hidden and can still block it"
		};
	}
});
const SITE$2 = "https://packagist.org";
const VALID$4 = /^[a-z0-9]+(?:[_.-]?[a-z0-9]+)*$/i;
const MAX = 191;
const RESERVED_VENDORS = new Set("php packagist api sdk auth openai annotation authentication authorization dependency dependencies kernel namespace namespaces rfc routing standards standard token composer automation unknown admin create".split(" "));
const DEVICE_NAMES = /^(?:nul|con|prn|aux|com[1-9]|lpt[1-9])$/;
const BRANDS = /symfony|packagist|composer/;
const MIN_DOWNLOADS = 1e6;
const packageNames = async (ctx, query) => {
	const res = await get(ctx, `${SITE$2}/packages/list.json?${query}`);
	if (res.status !== 200) return res;
	const { packageNames: names } = await res.json() ?? {};
	return Array.isArray(names) && names.every((n) => typeof n === "string") ? names : void 0;
};
const packagist = defineChannel({
	id: "packagist",
	label: "Packagist",
	category: "package",
	rules: (name) => VALID$4.test(name) && name.length <= MAX ? void 0 : "Packagist vendors are letters and digits, with single . _ or - between them",
	refuses: (name) => {
		if (name !== name.toLowerCase()) return "Packagist names must be lowercase";
		if (RESERVED_VENDORS.has(name) || DEVICE_NAMES.test(name)) return "Packagist reserves this vendor name";
		if (BRANDS.test(name)) return "Packagist blocks new vendors containing symfony, packagist or composer";
		if (name.endsWith(".json")) return "Packagist names cannot end in .json";
	},
	async lookup(name, ctx) {
		const owned = await packageNames(ctx, `vendor=${name}`);
		if (owned instanceof Response) return unexpected("Packagist", owned);
		if (!owned) return {
			status: "unknown",
			note: "Packagist returned an unexpected list"
		};
		if (owned.length) return {
			status: "taken",
			url: `${SITE$2}/packages/${name}/`,
			note: owned.length === 1 ? `vendor of ${owned[0]}` : `vendor of ${owned.length} packages, such as ${owned[0]}`,
			meta: { packages: owned.length }
		};
		const like = new RegExp(`^[^/]+/${name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&").replaceAll("_", ".")}$`, "i");
		const listed = await packageNames(ctx, `filter=*/${name.replaceAll("_", "*")}`);
		const twins = Array.isArray(listed) ? listed.filter((n) => like.test(n)) : listed;
		if (!Array.isArray(twins)) return {
			status: "available",
			certainty: "probable",
			note: `could not check Packagist's typosquatting rule for ${name}/${name}`
		};
		for (const twin of twins) {
			const vendor = twin.split("/")[0];
			if (levenshtein(vendor, name) > 1) continue;
			const res = await get(ctx, `${SITE$2}/packages/${twin}/stats.json`);
			const total = res.status === 200 ? (await res.json())?.downloads?.total : void 0;
			if (typeof total !== "number") return {
				status: "available",
				certainty: "probable",
				note: `could not check whether ${twin} blocks ${name}/${name} as a typo`
			};
			if (total >= MIN_DOWNLOADS) return {
				status: "unavailable",
				url: `${SITE$2}/packages/${twin}`,
				note: `Packagist refuses the package ${name}/${name} as too similar to ${twin}; the vendor itself is free`
			};
		}
		return {
			status: "available",
			certainty: "probable",
			note: "no packages under this vendor; packages frozen for spam are hidden and still hold it"
		};
	}
});
const PYPI_STDLIB = /* @__PURE__ */ new Set([
	"abc",
	"abcoll",
	"aepack",
	"aetools",
	"aetypes",
	"aifc",
	"aix-support",
	"al",
	"android-support",
	"annotationlib",
	"antigravity",
	"anydbm",
	"apple-support",
	"applesingle",
	"argparse",
	"array",
	"ast",
	"ast-unparse",
	"asynchat",
	"asyncio",
	"asyncio-base-events",
	"asyncio-base-futures",
	"asyncio-base-subprocess",
	"asyncio-base-tasks",
	"asyncio-compat",
	"asyncio-constants",
	"asyncio-coroutines",
	"asyncio-events",
	"asyncio-exceptions",
	"asyncio-format-helpers",
	"asyncio-futures",
	"asyncio-graph",
	"asyncio-locks",
	"asyncio-log",
	"asyncio-main",
	"asyncio-mixins",
	"asyncio-proactor-events",
	"asyncio-protocols",
	"asyncio-queues",
	"asyncio-runners",
	"asyncio-selector-events",
	"asyncio-sslproto",
	"asyncio-staggered",
	"asyncio-streams",
	"asyncio-subprocess",
	"asyncio-taskgroups",
	"asyncio-tasks",
	"asyncio-test-utils",
	"asyncio-threads",
	"asyncio-timeouts",
	"asyncio-tools",
	"asyncio-transports",
	"asyncio-trsock",
	"asyncio-unix-events",
	"asyncio-windows-events",
	"asyncio-windows-utils",
	"asyncore",
	"atexit",
	"audiodev",
	"audioop",
	"autogil",
	"base64",
	"basehttpserver",
	"bastion",
	"bdb",
	"binascii",
	"binhex",
	"bisect",
	"blake2",
	"bootlocale",
	"bootsubprocess",
	"bsddb",
	"bsddb-db",
	"bsddb-dbobj",
	"bsddb-dbrecio",
	"bsddb-dbshelve",
	"bsddb-dbtables",
	"bsddb-dbutils",
	"bsddb-test",
	"bsddb-test-test-all",
	"bsddb-test-test-associate",
	"bsddb-test-test-basics",
	"bsddb-test-test-compare",
	"bsddb-test-test-compat",
	"bsddb-test-test-cursor-pget-bug",
	"bsddb-test-test-db",
	"bsddb-test-test-dbenv",
	"bsddb-test-test-dbobj",
	"bsddb-test-test-dbshelve",
	"bsddb-test-test-dbtables",
	"bsddb-test-test-distributed-transactions",
	"bsddb-test-test-early-close",
	"bsddb-test-test-fileid",
	"bsddb-test-test-get-none",
	"bsddb-test-test-join",
	"bsddb-test-test-lock",
	"bsddb-test-test-misc",
	"bsddb-test-test-pickle",
	"bsddb-test-test-queue",
	"bsddb-test-test-recno",
	"bsddb-test-test-replication",
	"bsddb-test-test-sequence",
	"bsddb-test-test-thread",
	"buildtools",
	"builtin",
	"builtins",
	"bz2",
	"calendar",
	"canvas",
	"carbon",
	"carbon-ae",
	"carbon-ah",
	"carbon-app",
	"carbon-appearance",
	"carbon-carbonevents",
	"carbon-carbonevt",
	"carbon-cf",
	"carbon-cg",
	"carbon-cm",
	"carbon-components",
	"carbon-controlaccessor",
	"carbon-controls",
	"carbon-corefounation",
	"carbon-coregraphics",
	"carbon-ctl",
	"carbon-dialogs",
	"carbon-dlg",
	"carbon-drag",
	"carbon-dragconst",
	"carbon-events",
	"carbon-evt",
	"carbon-file",
	"carbon-files",
	"carbon-fm",
	"carbon-folder",
	"carbon-folders",
	"carbon-fonts",
	"carbon-help",
	"carbon-ibcarbon",
	"carbon-ibcarbonruntime",
	"carbon-icns",
	"carbon-icons",
	"carbon-launch",
	"carbon-launchservices",
	"carbon-list",
	"carbon-lists",
	"carbon-machelp",
	"carbon-mediadescr",
	"carbon-menu",
	"carbon-menus",
	"carbon-mlte",
	"carbon-osa",
	"carbon-osaconst",
	"carbon-qd",
	"carbon-qdoffs",
	"carbon-qdoffscreen",
	"carbon-qt",
	"carbon-quickdraw",
	"carbon-quicktime",
	"carbon-res",
	"carbon-resources",
	"carbon-scrap",
	"carbon-snd",
	"carbon-sound",
	"carbon-te",
	"carbon-textedit",
	"carbon-win",
	"carbon-windows",
	"cd",
	"cfmfile",
	"cgi",
	"cgihttpserver",
	"cgitb",
	"chunk",
	"cmath",
	"cmd",
	"code",
	"codecs",
	"codecs-cn",
	"codecs-hk",
	"codecs-iso2022",
	"codecs-jp",
	"codecs-kr",
	"codecs-tw",
	"codeop",
	"collections",
	"collections-abc",
	"collections-main",
	"colorize",
	"colorpicker",
	"colorsys",
	"commands",
	"compat-pickle",
	"compileall",
	"compiler",
	"compiler-ast",
	"compiler-consts",
	"compiler-future",
	"compiler-misc",
	"compiler-pyassem",
	"compiler-pycodegen",
	"compiler-symbols",
	"compiler-syntax",
	"compiler-transformer",
	"compiler-visitor",
	"compression",
	"compression-bz2",
	"compression-common",
	"compression-common-streams",
	"compression-gzip",
	"compression-lzma",
	"compression-zlib",
	"compression-zstd",
	"compression-zstd-zstdfile",
	"concurrent",
	"concurrent-futures",
	"concurrent-futures-base",
	"concurrent-futures-interpreter",
	"concurrent-futures-process",
	"concurrent-futures-thread",
	"concurrent-interpreters",
	"concurrent-interpreters-crossinterp",
	"concurrent-interpreters-queues",
	"configparser",
	"contextlib",
	"contextvars",
	"cookie",
	"cookielib",
	"copy",
	"copy-reg",
	"copyreg",
	"cpickle",
	"cprofile",
	"crypt",
	"cstringio",
	"csv",
	"ctypes",
	"ctypes-aix",
	"ctypes-endian",
	"ctypes-layout",
	"ctypes-macholib",
	"ctypes-macholib-dyld",
	"ctypes-macholib-dylib",
	"ctypes-macholib-framework",
	"ctypes-test",
	"ctypes-test-main",
	"ctypes-test-runtests",
	"ctypes-test-test-anon",
	"ctypes-test-test-array-in-pointer",
	"ctypes-test-test-arrays",
	"ctypes-test-test-as-parameter",
	"ctypes-test-test-bitfields",
	"ctypes-test-test-buffers",
	"ctypes-test-test-bytes",
	"ctypes-test-test-byteswap",
	"ctypes-test-test-callbacks",
	"ctypes-test-test-cast",
	"ctypes-test-test-cfuncs",
	"ctypes-test-test-checkretval",
	"ctypes-test-test-delattr",
	"ctypes-test-test-errno",
	"ctypes-test-test-find",
	"ctypes-test-test-frombuffer",
	"ctypes-test-test-funcptr",
	"ctypes-test-test-functions",
	"ctypes-test-test-incomplete",
	"ctypes-test-test-init",
	"ctypes-test-test-internals",
	"ctypes-test-test-keeprefs",
	"ctypes-test-test-libc",
	"ctypes-test-test-loading",
	"ctypes-test-test-macholib",
	"ctypes-test-test-memfunctions",
	"ctypes-test-test-numbers",
	"ctypes-test-test-objects",
	"ctypes-test-test-parameters",
	"ctypes-test-test-pep3118",
	"ctypes-test-test-pickling",
	"ctypes-test-test-pointers",
	"ctypes-test-test-prototypes",
	"ctypes-test-test-python-api",
	"ctypes-test-test-random-things",
	"ctypes-test-test-refcounts",
	"ctypes-test-test-repr",
	"ctypes-test-test-returnfuncptrs",
	"ctypes-test-test-simplesubclasses",
	"ctypes-test-test-sizes",
	"ctypes-test-test-slicing",
	"ctypes-test-test-stringptr",
	"ctypes-test-test-strings",
	"ctypes-test-test-struct-fields",
	"ctypes-test-test-structures",
	"ctypes-test-test-unaligned-structures",
	"ctypes-test-test-unicode",
	"ctypes-test-test-values",
	"ctypes-test-test-varsize-struct",
	"ctypes-test-test-win32",
	"ctypes-test-test-wintypes",
	"ctypes-util",
	"ctypes-wintypes",
	"curses",
	"curses-ascii",
	"curses-has-key",
	"curses-panel",
	"curses-textpad",
	"curses-wrapper",
	"dataclasses",
	"datetime",
	"dbhash",
	"dbm",
	"dbm-dumb",
	"dbm-gnu",
	"dbm-ndbm",
	"dbm-sqlite3",
	"decimal",
	"device",
	"dialog",
	"difflib",
	"dircache",
	"dis",
	"distutils",
	"distutils-archive-util",
	"distutils-bcppcompiler",
	"distutils-ccompiler",
	"distutils-cmd",
	"distutils-collections",
	"distutils-command",
	"distutils-command-bdist",
	"distutils-command-bdist-dumb",
	"distutils-command-bdist-msi",
	"distutils-command-bdist-packager",
	"distutils-command-bdist-rpm",
	"distutils-command-bdist-wininst",
	"distutils-command-build",
	"distutils-command-build-clib",
	"distutils-command-build-ext",
	"distutils-command-build-py",
	"distutils-command-build-scripts",
	"distutils-command-check",
	"distutils-command-clean",
	"distutils-command-config",
	"distutils-command-framework-compat",
	"distutils-command-install",
	"distutils-command-install-data",
	"distutils-command-install-egg-info",
	"distutils-command-install-headers",
	"distutils-command-install-lib",
	"distutils-command-install-scripts",
	"distutils-command-py37compat",
	"distutils-command-register",
	"distutils-command-sdist",
	"distutils-command-upload",
	"distutils-config",
	"distutils-core",
	"distutils-cygwinccompiler",
	"distutils-debug",
	"distutils-dep-util",
	"distutils-dir-util",
	"distutils-dist",
	"distutils-emxccompiler",
	"distutils-errors",
	"distutils-extension",
	"distutils-fancy-getopt",
	"distutils-file-util",
	"distutils-filelist",
	"distutils-functools",
	"distutils-log",
	"distutils-macos-compat",
	"distutils-msvc9compiler",
	"distutils-msvccompiler",
	"distutils-mwerkscompiler",
	"distutils-py38compat",
	"distutils-py39compat",
	"distutils-spawn",
	"distutils-sysconfig",
	"distutils-tests",
	"distutils-tests-setuptools-build-ext",
	"distutils-tests-setuptools-extension",
	"distutils-tests-support",
	"distutils-tests-test-archive-util",
	"distutils-tests-test-bdist",
	"distutils-tests-test-bdist-dumb",
	"distutils-tests-test-bdist-msi",
	"distutils-tests-test-bdist-rpm",
	"distutils-tests-test-bdist-wininst",
	"distutils-tests-test-build",
	"distutils-tests-test-build-clib",
	"distutils-tests-test-build-ext",
	"distutils-tests-test-build-py",
	"distutils-tests-test-build-scripts",
	"distutils-tests-test-ccompiler",
	"distutils-tests-test-check",
	"distutils-tests-test-clean",
	"distutils-tests-test-cmd",
	"distutils-tests-test-config",
	"distutils-tests-test-config-cmd",
	"distutils-tests-test-core",
	"distutils-tests-test-cygwinccompiler",
	"distutils-tests-test-dep-util",
	"distutils-tests-test-dir-util",
	"distutils-tests-test-dist",
	"distutils-tests-test-extension",
	"distutils-tests-test-file-util",
	"distutils-tests-test-filelist",
	"distutils-tests-test-install",
	"distutils-tests-test-install-data",
	"distutils-tests-test-install-headers",
	"distutils-tests-test-install-lib",
	"distutils-tests-test-install-scripts",
	"distutils-tests-test-log",
	"distutils-tests-test-msvc9compiler",
	"distutils-tests-test-msvccompiler",
	"distutils-tests-test-register",
	"distutils-tests-test-sdist",
	"distutils-tests-test-spawn",
	"distutils-tests-test-sysconfig",
	"distutils-tests-test-text-file",
	"distutils-tests-test-unixccompiler",
	"distutils-tests-test-upload",
	"distutils-tests-test-util",
	"distutils-tests-test-version",
	"distutils-tests-test-versionpredicate",
	"distutils-text-file",
	"distutils-unixccompiler",
	"distutils-util",
	"distutils-version",
	"distutils-versionpredicate",
	"dl",
	"doctest",
	"docxmlrpcserver",
	"dumbdbm",
	"dummy-thread",
	"dummy-threading",
	"easydialogs",
	"elementtree",
	"email",
	"email-base64mime",
	"email-charset",
	"email-contentmanager",
	"email-encoded-words",
	"email-encoders",
	"email-errors",
	"email-feedparser",
	"email-generator",
	"email-header",
	"email-header-value-parser",
	"email-headerregistry",
	"email-iterators",
	"email-message",
	"email-mime",
	"email-mime-application",
	"email-mime-audio",
	"email-mime-base",
	"email-mime-image",
	"email-mime-message",
	"email-mime-multipart",
	"email-mime-nonmultipart",
	"email-mime-text",
	"email-parseaddr",
	"email-parser",
	"email-policy",
	"email-policybase",
	"email-quoprimime",
	"email-test",
	"email-test-test-email",
	"email-test-test-email-codecs",
	"email-test-test-email-codecs-renamed",
	"email-test-test-email-renamed",
	"email-test-test-email-torture",
	"email-utils",
	"encodings",
	"encodings-aliases",
	"encodings-ascii",
	"encodings-base64-codec",
	"encodings-big5",
	"encodings-big5hkscs",
	"encodings-builtin",
	"encodings-bz2-codec",
	"encodings-charmap",
	"encodings-codecs",
	"encodings-cp037",
	"encodings-cp1006",
	"encodings-cp1026",
	"encodings-cp1125",
	"encodings-cp1140",
	"encodings-cp1250",
	"encodings-cp1251",
	"encodings-cp1252",
	"encodings-cp1253",
	"encodings-cp1254",
	"encodings-cp1255",
	"encodings-cp1256",
	"encodings-cp1257",
	"encodings-cp1258",
	"encodings-cp273",
	"encodings-cp424",
	"encodings-cp437",
	"encodings-cp500",
	"encodings-cp65001",
	"encodings-cp720",
	"encodings-cp737",
	"encodings-cp775",
	"encodings-cp850",
	"encodings-cp852",
	"encodings-cp855",
	"encodings-cp856",
	"encodings-cp857",
	"encodings-cp858",
	"encodings-cp860",
	"encodings-cp861",
	"encodings-cp862",
	"encodings-cp863",
	"encodings-cp864",
	"encodings-cp865",
	"encodings-cp866",
	"encodings-cp869",
	"encodings-cp874",
	"encodings-cp875",
	"encodings-cp932",
	"encodings-cp949",
	"encodings-cp950",
	"encodings-encodings",
	"encodings-euc-jis-2004",
	"encodings-euc-jisx0213",
	"encodings-euc-jp",
	"encodings-euc-kr",
	"encodings-gb18030",
	"encodings-gb2312",
	"encodings-gbk",
	"encodings-hex-codec",
	"encodings-hp-roman8",
	"encodings-hz",
	"encodings-idna",
	"encodings-iso2022-jp",
	"encodings-iso2022-jp-1",
	"encodings-iso2022-jp-2",
	"encodings-iso2022-jp-2004",
	"encodings-iso2022-jp-3",
	"encodings-iso2022-jp-ext",
	"encodings-iso2022-kr",
	"encodings-iso8859-1",
	"encodings-iso8859-10",
	"encodings-iso8859-11",
	"encodings-iso8859-13",
	"encodings-iso8859-14",
	"encodings-iso8859-15",
	"encodings-iso8859-16",
	"encodings-iso8859-2",
	"encodings-iso8859-3",
	"encodings-iso8859-4",
	"encodings-iso8859-5",
	"encodings-iso8859-6",
	"encodings-iso8859-7",
	"encodings-iso8859-8",
	"encodings-iso8859-9",
	"encodings-johab",
	"encodings-koi8-r",
	"encodings-koi8-t",
	"encodings-koi8-u",
	"encodings-kz1048",
	"encodings-latin-1",
	"encodings-mac-arabic",
	"encodings-mac-centeuro",
	"encodings-mac-croatian",
	"encodings-mac-cyrillic",
	"encodings-mac-farsi",
	"encodings-mac-greek",
	"encodings-mac-iceland",
	"encodings-mac-latin2",
	"encodings-mac-roman",
	"encodings-mac-romanian",
	"encodings-mac-turkish",
	"encodings-mbcs",
	"encodings-oem",
	"encodings-palmos",
	"encodings-ptcp154",
	"encodings-punycode",
	"encodings-quopri-codec",
	"encodings-raw-unicode-escape",
	"encodings-rot-13",
	"encodings-shift-jis",
	"encodings-shift-jis-2004",
	"encodings-shift-jisx0213",
	"encodings-string-escape",
	"encodings-tis-620",
	"encodings-undefined",
	"encodings-unicode-escape",
	"encodings-unicode-internal",
	"encodings-utf-16",
	"encodings-utf-16-be",
	"encodings-utf-16-le",
	"encodings-utf-32",
	"encodings-utf-32-be",
	"encodings-utf-32-le",
	"encodings-utf-7",
	"encodings-utf-8",
	"encodings-utf-8-sig",
	"encodings-uu-codec",
	"encodings-win-cp-codecs",
	"encodings-zlib-codec",
	"ensurepip",
	"ensurepip-bundled",
	"ensurepip-main",
	"ensurepip-uninstall",
	"enum",
	"errno",
	"exceptions",
	"faulthandler",
	"fcntl",
	"filecmp",
	"filedialog",
	"fileinput",
	"findertools",
	"fixtk",
	"fl",
	"flp",
	"fm",
	"fnmatch",
	"formatter",
	"fpectl",
	"fpformat",
	"fractions",
	"framework",
	"frozen-importlib",
	"frozen-importlib-external",
	"ftplib",
	"functools",
	"future",
	"future-builtins",
	"gc",
	"gdbm",
	"genericpath",
	"gensuitemodule",
	"getopt",
	"getpass",
	"gettext",
	"gl",
	"glob",
	"graphlib",
	"grp",
	"gzip",
	"hashlib",
	"heapq",
	"hmac",
	"hotshot",
	"hotshot-log",
	"hotshot-stats",
	"hotshot-stones",
	"html",
	"html-entities",
	"html-parser",
	"htmlentitydefs",
	"htmllib",
	"htmlparser",
	"http",
	"http-client",
	"http-cookiejar",
	"http-cookies",
	"http-server",
	"httplib",
	"ic",
	"icopen",
	"idlelib",
	"idlelib-aboutdialog",
	"idlelib-autocomplete",
	"idlelib-autocomplete-w",
	"idlelib-autocompletewindow",
	"idlelib-autoexpand",
	"idlelib-bindings",
	"idlelib-browser",
	"idlelib-calltip",
	"idlelib-calltip-w",
	"idlelib-calltips",
	"idlelib-calltipwindow",
	"idlelib-classbrowser",
	"idlelib-codecontext",
	"idlelib-colordelegator",
	"idlelib-colorizer",
	"idlelib-config",
	"idlelib-config-key",
	"idlelib-configdialog",
	"idlelib-confighandler",
	"idlelib-confighelpsourceedit",
	"idlelib-configsectionnamedialog",
	"idlelib-debugger",
	"idlelib-debugger-r",
	"idlelib-debugobj",
	"idlelib-debugobj-r",
	"idlelib-delegator",
	"idlelib-dynoption",
	"idlelib-dynoptionmenuwidget",
	"idlelib-editor",
	"idlelib-editorwindow",
	"idlelib-filelist",
	"idlelib-format",
	"idlelib-formatparagraph",
	"idlelib-grep",
	"idlelib-grepdialog",
	"idlelib-help",
	"idlelib-help-about",
	"idlelib-history",
	"idlelib-hyperparser",
	"idlelib-idle",
	"idlelib-idle-test",
	"idlelib-idle-test-htest",
	"idlelib-idle-test-mock-idle",
	"idlelib-idle-test-mock-tk",
	"idlelib-idle-test-template",
	"idlelib-idle-test-test-autocomplete",
	"idlelib-idle-test-test-autocomplete-w",
	"idlelib-idle-test-test-autoexpand",
	"idlelib-idle-test-test-browser",
	"idlelib-idle-test-test-calltip",
	"idlelib-idle-test-test-calltip-w",
	"idlelib-idle-test-test-calltips",
	"idlelib-idle-test-test-codecontext",
	"idlelib-idle-test-test-colorizer",
	"idlelib-idle-test-test-config",
	"idlelib-idle-test-test-config-help",
	"idlelib-idle-test-test-config-key",
	"idlelib-idle-test-test-config-name",
	"idlelib-idle-test-test-configdialog",
	"idlelib-idle-test-test-debugger",
	"idlelib-idle-test-test-debugger-r",
	"idlelib-idle-test-test-debugobj",
	"idlelib-idle-test-test-debugobj-r",
	"idlelib-idle-test-test-delegator",
	"idlelib-idle-test-test-editmenu",
	"idlelib-idle-test-test-editor",
	"idlelib-idle-test-test-filelist",
	"idlelib-idle-test-test-format",
	"idlelib-idle-test-test-formatparagraph",
	"idlelib-idle-test-test-grep",
	"idlelib-idle-test-test-help",
	"idlelib-idle-test-test-help-about",
	"idlelib-idle-test-test-helpabout",
	"idlelib-idle-test-test-history",
	"idlelib-idle-test-test-hyperparser",
	"idlelib-idle-test-test-idlehistory",
	"idlelib-idle-test-test-io",
	"idlelib-idle-test-test-iomenu",
	"idlelib-idle-test-test-macosx",
	"idlelib-idle-test-test-mainmenu",
	"idlelib-idle-test-test-multicall",
	"idlelib-idle-test-test-outwin",
	"idlelib-idle-test-test-paragraph",
	"idlelib-idle-test-test-parenmatch",
	"idlelib-idle-test-test-pathbrowser",
	"idlelib-idle-test-test-percolator",
	"idlelib-idle-test-test-pyparse",
	"idlelib-idle-test-test-pyshell",
	"idlelib-idle-test-test-query",
	"idlelib-idle-test-test-redirector",
	"idlelib-idle-test-test-replace",
	"idlelib-idle-test-test-replacedialog",
	"idlelib-idle-test-test-rpc",
	"idlelib-idle-test-test-rstrip",
	"idlelib-idle-test-test-run",
	"idlelib-idle-test-test-runscript",
	"idlelib-idle-test-test-scrolledlist",
	"idlelib-idle-test-test-search",
	"idlelib-idle-test-test-searchbase",
	"idlelib-idle-test-test-searchdialog",
	"idlelib-idle-test-test-searchdialogbase",
	"idlelib-idle-test-test-searchengine",
	"idlelib-idle-test-test-sidebar",
	"idlelib-idle-test-test-squeezer",
	"idlelib-idle-test-test-stackviewer",
	"idlelib-idle-test-test-statusbar",
	"idlelib-idle-test-test-text",
	"idlelib-idle-test-test-textview",
	"idlelib-idle-test-test-tooltip",
	"idlelib-idle-test-test-tree",
	"idlelib-idle-test-test-undo",
	"idlelib-idle-test-test-undodelegator",
	"idlelib-idle-test-test-util",
	"idlelib-idle-test-test-warning",
	"idlelib-idle-test-test-widgetredir",
	"idlelib-idle-test-test-window",
	"idlelib-idle-test-test-zoomheight",
	"idlelib-idle-test-test-zzdummy",
	"idlelib-idle-test-tkinter-testing-utils",
	"idlelib-idlehistory",
	"idlelib-idlever",
	"idlelib-iobinding",
	"idlelib-iomenu",
	"idlelib-keybindingdialog",
	"idlelib-macosx",
	"idlelib-macosxsupport",
	"idlelib-main",
	"idlelib-mainmenu",
	"idlelib-multicall",
	"idlelib-multistatusbar",
	"idlelib-objectbrowser",
	"idlelib-outputwindow",
	"idlelib-outwin",
	"idlelib-paragraph",
	"idlelib-parenmatch",
	"idlelib-pathbrowser",
	"idlelib-percolator",
	"idlelib-pyclbr",
	"idlelib-pyparse",
	"idlelib-pyshell",
	"idlelib-query",
	"idlelib-redirector",
	"idlelib-remotedebugger",
	"idlelib-remoteobjectbrowser",
	"idlelib-replace",
	"idlelib-replacedialog",
	"idlelib-rpc",
	"idlelib-rstrip",
	"idlelib-rstripextension",
	"idlelib-run",
	"idlelib-runscript",
	"idlelib-scriptbinding",
	"idlelib-scrolledlist",
	"idlelib-search",
	"idlelib-searchbase",
	"idlelib-searchdialog",
	"idlelib-searchdialogbase",
	"idlelib-searchengine",
	"idlelib-sidebar",
	"idlelib-squeezer",
	"idlelib-stackviewer",
	"idlelib-statusbar",
	"idlelib-tabbedpages",
	"idlelib-textview",
	"idlelib-tooltip",
	"idlelib-tree",
	"idlelib-treewidget",
	"idlelib-undo",
	"idlelib-undodelegator",
	"idlelib-util",
	"idlelib-widgetredirector",
	"idlelib-window",
	"idlelib-windowlist",
	"idlelib-zoomheight",
	"idlelib-zzdummy",
	"ihooks",
	"imageop",
	"imaplib",
	"imgfile",
	"imghdr",
	"imp",
	"importlib",
	"importlib-abc",
	"importlib-adapters",
	"importlib-bootstrap",
	"importlib-bootstrap-external",
	"importlib-common",
	"importlib-machinery",
	"importlib-metadata",
	"importlib-metadata-adapters",
	"importlib-metadata-collections",
	"importlib-metadata-diagnose",
	"importlib-metadata-functools",
	"importlib-metadata-itertools",
	"importlib-metadata-meta",
	"importlib-metadata-text",
	"importlib-readers",
	"importlib-resources",
	"importlib-resources-abc",
	"importlib-resources-adapters",
	"importlib-resources-common",
	"importlib-resources-functional",
	"importlib-resources-itertools",
	"importlib-resources-legacy",
	"importlib-resources-readers",
	"importlib-resources-simple",
	"importlib-simple",
	"importlib-util",
	"imputil",
	"inspect",
	"interpchannels",
	"interpqueues",
	"interpreters",
	"io",
	"ios-support",
	"ipaddress",
	"itertools",
	"jpeg",
	"json",
	"json-decoder",
	"json-encoder",
	"json-json",
	"json-main",
	"json-re",
	"json-scanner",
	"json-struct",
	"json-sys",
	"json-tests",
	"json-tests-test-check-circular",
	"json-tests-test-decode",
	"json-tests-test-default",
	"json-tests-test-dump",
	"json-tests-test-encode-basestring-ascii",
	"json-tests-test-fail",
	"json-tests-test-float",
	"json-tests-test-indent",
	"json-tests-test-pass1",
	"json-tests-test-pass2",
	"json-tests-test-pass3",
	"json-tests-test-recursion",
	"json-tests-test-scanstring",
	"json-tests-test-separators",
	"json-tests-test-speedups",
	"json-tests-test-tool",
	"json-tests-test-unicode",
	"json-tool",
	"keyword",
	"lib",
	"lib-libpython3",
	"lib2to3",
	"lib2to3-btm-matcher",
	"lib2to3-btm-utils",
	"lib2to3-fixer-base",
	"lib2to3-fixer-util",
	"lib2to3-fixes",
	"lib2to3-fixes-fix-apply",
	"lib2to3-fixes-fix-asserts",
	"lib2to3-fixes-fix-basestring",
	"lib2to3-fixes-fix-buffer",
	"lib2to3-fixes-fix-callable",
	"lib2to3-fixes-fix-dict",
	"lib2to3-fixes-fix-except",
	"lib2to3-fixes-fix-exec",
	"lib2to3-fixes-fix-execfile",
	"lib2to3-fixes-fix-exitfunc",
	"lib2to3-fixes-fix-filter",
	"lib2to3-fixes-fix-funcattrs",
	"lib2to3-fixes-fix-future",
	"lib2to3-fixes-fix-getcwdu",
	"lib2to3-fixes-fix-has-key",
	"lib2to3-fixes-fix-idioms",
	"lib2to3-fixes-fix-import",
	"lib2to3-fixes-fix-imports",
	"lib2to3-fixes-fix-imports2",
	"lib2to3-fixes-fix-input",
	"lib2to3-fixes-fix-intern",
	"lib2to3-fixes-fix-isinstance",
	"lib2to3-fixes-fix-itertools",
	"lib2to3-fixes-fix-itertools-imports",
	"lib2to3-fixes-fix-long",
	"lib2to3-fixes-fix-map",
	"lib2to3-fixes-fix-metaclass",
	"lib2to3-fixes-fix-methodattrs",
	"lib2to3-fixes-fix-ne",
	"lib2to3-fixes-fix-next",
	"lib2to3-fixes-fix-nonzero",
	"lib2to3-fixes-fix-numliterals",
	"lib2to3-fixes-fix-operator",
	"lib2to3-fixes-fix-paren",
	"lib2to3-fixes-fix-print",
	"lib2to3-fixes-fix-raise",
	"lib2to3-fixes-fix-raw-input",
	"lib2to3-fixes-fix-reduce",
	"lib2to3-fixes-fix-reload",
	"lib2to3-fixes-fix-renames",
	"lib2to3-fixes-fix-repr",
	"lib2to3-fixes-fix-set-literal",
	"lib2to3-fixes-fix-standarderror",
	"lib2to3-fixes-fix-sys-exc",
	"lib2to3-fixes-fix-throw",
	"lib2to3-fixes-fix-tuple-params",
	"lib2to3-fixes-fix-types",
	"lib2to3-fixes-fix-unicode",
	"lib2to3-fixes-fix-urllib",
	"lib2to3-fixes-fix-ws-comma",
	"lib2to3-fixes-fix-xrange",
	"lib2to3-fixes-fix-xreadlines",
	"lib2to3-fixes-fix-zip",
	"lib2to3-main",
	"lib2to3-patcomp",
	"lib2to3-pgen2",
	"lib2to3-pgen2-conv",
	"lib2to3-pgen2-driver",
	"lib2to3-pgen2-grammar",
	"lib2to3-pgen2-literals",
	"lib2to3-pgen2-parse",
	"lib2to3-pgen2-pgen",
	"lib2to3-pgen2-token",
	"lib2to3-pgen2-tokenize",
	"lib2to3-pygram",
	"lib2to3-pytree",
	"lib2to3-refactor",
	"lib2to3-tests",
	"lib2to3-tests-data",
	"lib2to3-tests-data-bom",
	"lib2to3-tests-data-crlf",
	"lib2to3-tests-data-different-encoding",
	"lib2to3-tests-data-false-encoding",
	"lib2to3-tests-data-fixers",
	"lib2to3-tests-data-fixers-bad-order",
	"lib2to3-tests-data-fixers-myfixes",
	"lib2to3-tests-data-fixers-myfixes-fix-explicit",
	"lib2to3-tests-data-fixers-myfixes-fix-first",
	"lib2to3-tests-data-fixers-myfixes-fix-last",
	"lib2to3-tests-data-fixers-myfixes-fix-parrot",
	"lib2to3-tests-data-fixers-myfixes-fix-preorder",
	"lib2to3-tests-data-fixers-no-fixer-cls",
	"lib2to3-tests-data-fixers-parrot-example",
	"lib2to3-tests-data-infinite-recursion",
	"lib2to3-tests-data-py2-test-grammar",
	"lib2to3-tests-data-py3-test-grammar",
	"lib2to3-tests-main",
	"lib2to3-tests-pytree-idempotency",
	"lib2to3-tests-support",
	"lib2to3-tests-test-all-fixers",
	"lib2to3-tests-test-fixers",
	"lib2to3-tests-test-main",
	"lib2to3-tests-test-parser",
	"lib2to3-tests-test-pytree",
	"lib2to3-tests-test-refactor",
	"lib2to3-tests-test-util",
	"linecache",
	"linuxaudiodev",
	"locale",
	"logging",
	"logging-config",
	"logging-handlers",
	"lsprof",
	"lwpcookiejar",
	"lzma",
	"macerrors",
	"macos",
	"macostools",
	"macpath",
	"macresource",
	"macurl2path",
	"mailbox",
	"mailcap",
	"main",
	"markupbase",
	"marshal",
	"math",
	"md5",
	"mhlib",
	"mimetools",
	"mimetypes",
	"mimewriter",
	"mimify",
	"miniaeframe",
	"mmap",
	"modulefinder",
	"mozillacookiejar",
	"msi",
	"msilib",
	"msvcrt",
	"multibytecodec",
	"multifile",
	"multiprocessing",
	"multiprocessing-connection",
	"multiprocessing-context",
	"multiprocessing-dummy",
	"multiprocessing-dummy-connection",
	"multiprocessing-forking",
	"multiprocessing-forkserver",
	"multiprocessing-heap",
	"multiprocessing-managers",
	"multiprocessing-pool",
	"multiprocessing-popen-fork",
	"multiprocessing-popen-forkserver",
	"multiprocessing-popen-spawn-posix",
	"multiprocessing-popen-spawn-win32",
	"multiprocessing-process",
	"multiprocessing-queues",
	"multiprocessing-reduction",
	"multiprocessing-resource-sharer",
	"multiprocessing-resource-tracker",
	"multiprocessing-semaphore-tracker",
	"multiprocessing-shared-memory",
	"multiprocessing-sharedctypes",
	"multiprocessing-spawn",
	"multiprocessing-synchronize",
	"multiprocessing-util",
	"mutex",
	"nav",
	"netrc",
	"new",
	"nis",
	"nntplib",
	"nt",
	"ntpath",
	"nturl2path",
	"numbers",
	"opcode",
	"opcode-metadata",
	"operator",
	"optparse",
	"os",
	"os-path",
	"os2emxpath",
	"ossaudiodev",
	"osx-support",
	"overlapped",
	"parser",
	"pathlib",
	"pathlib-abc",
	"pathlib-local",
	"pathlib-os",
	"pathlib-types",
	"pdb",
	"peg-parser",
	"phello",
	"phello-foo",
	"pickle",
	"pickletools",
	"pipes",
	"pixmapwrapper",
	"pkgutil",
	"platform",
	"plistlib",
	"popen2",
	"poplib",
	"posix",
	"posixfile",
	"posixpath",
	"posixshmem",
	"posixsubprocess",
	"pprint",
	"profile",
	"pstats",
	"pty",
	"pwd",
	"py-abc",
	"py-compile",
	"py-warnings",
	"pyclbr",
	"pydatetime",
	"pydecimal",
	"pydoc",
	"pydoc-data",
	"pydoc-data-topics",
	"pyexpat",
	"pyexpat-errors",
	"pyexpat-model",
	"pyio",
	"pylong",
	"pyrepl",
	"pyrepl-base-eventqueue",
	"pyrepl-commands",
	"pyrepl-completing-reader",
	"pyrepl-console",
	"pyrepl-curses",
	"pyrepl-fancy-termios",
	"pyrepl-historical-reader",
	"pyrepl-input",
	"pyrepl-keymap",
	"pyrepl-main",
	"pyrepl-minimal-curses",
	"pyrepl-module-completer",
	"pyrepl-pager",
	"pyrepl-reader",
	"pyrepl-readline",
	"pyrepl-simple-interact",
	"pyrepl-terminfo",
	"pyrepl-threading-handler",
	"pyrepl-trace",
	"pyrepl-types",
	"pyrepl-unix-console",
	"pyrepl-unix-eventqueue",
	"pyrepl-utils",
	"pyrepl-windows-console",
	"pyrepl-windows-eventqueue",
	"queue",
	"quopri",
	"random",
	"re",
	"re-casefix",
	"re-compiler",
	"re-constants",
	"re-parser",
	"readline",
	"remote-debugging",
	"repr",
	"reprlib",
	"resource",
	"rexec",
	"rfc822",
	"rlcompleter",
	"robotparser",
	"runpy",
	"sched",
	"scproxy",
	"scrolledtext",
	"secrets",
	"select",
	"selectors",
	"sets",
	"sgmllib",
	"sha",
	"sha1",
	"sha2",
	"sha256",
	"sha3",
	"sha512",
	"shelve",
	"shlex",
	"shutil",
	"signal",
	"simpledialog",
	"simplehttpserver",
	"simplexmlrpcserver",
	"site",
	"sitebuiltins",
	"smtpd",
	"smtplib",
	"sndhdr",
	"socket",
	"socketserver",
	"spwd",
	"sqlite3",
	"sqlite3-dbapi2",
	"sqlite3-dump",
	"sqlite3-main",
	"sqlite3-test",
	"sqlite3-test-backup",
	"sqlite3-test-dbapi",
	"sqlite3-test-dump",
	"sqlite3-test-factory",
	"sqlite3-test-hooks",
	"sqlite3-test-py25tests",
	"sqlite3-test-regression",
	"sqlite3-test-transactions",
	"sqlite3-test-types",
	"sqlite3-test-userfunctions",
	"sre",
	"sre-compile",
	"sre-constants",
	"sre-parse",
	"ssl",
	"stat",
	"statistics",
	"statvfs",
	"string",
	"string-templatelib",
	"stringio",
	"stringold",
	"stringprep",
	"strop",
	"strptime",
	"struct",
	"subprocess",
	"suggestions",
	"sunau",
	"sunaudio",
	"sunaudiodev",
	"symbol",
	"symtable",
	"sys",
	"sysconfig",
	"sysconfig-main",
	"sysconfigdata",
	"sysconfigdata-x86-64-conda-cos6-linux-gnu",
	"sysconfigdata-x86-64-conda-linux-gnu",
	"syslog",
	"tabnanny",
	"tarfile",
	"telnetlib",
	"tempfile",
	"termios",
	"test",
	"test-ann-module",
	"test-ann-module2",
	"test-ann-module3",
	"test-ann-module5",
	"test-ann-module6",
	"test-ann-module7",
	"test-audiotests",
	"test-audit-tests",
	"test-autotest",
	"test-bad-coding",
	"test-bad-coding2",
	"test-bad-coding3",
	"test-bad-getattr",
	"test-bad-getattr2",
	"test-bad-getattr3",
	"test-badsyntax-3131",
	"test-badsyntax-async1",
	"test-badsyntax-async2",
	"test-badsyntax-async3",
	"test-badsyntax-async4",
	"test-badsyntax-async5",
	"test-badsyntax-async6",
	"test-badsyntax-async7",
	"test-badsyntax-async8",
	"test-badsyntax-future10",
	"test-badsyntax-future3",
	"test-badsyntax-future4",
	"test-badsyntax-future5",
	"test-badsyntax-future6",
	"test-badsyntax-future7",
	"test-badsyntax-future8",
	"test-badsyntax-future9",
	"test-badsyntax-nocaret",
	"test-badsyntax-pep3120",
	"test-bisect",
	"test-bisect-cmd",
	"test-buffer-tests",
	"test-bytecode-helper",
	"test-coding20731",
	"test-curses-tests",
	"test-dataclass-module-1",
	"test-dataclass-module-1-str",
	"test-dataclass-module-2",
	"test-dataclass-module-2-str",
	"test-dataclass-textanno",
	"test-datetimetester",
	"test-dis-module",
	"test-doctest-aliases",
	"test-double-const",
	"test-dtracedata",
	"test-dtracedata-call-stack",
	"test-dtracedata-gc",
	"test-dtracedata-instance",
	"test-dtracedata-line",
	"test-eintrdata",
	"test-eintrdata-eintr-tester",
	"test-encoded-modules",
	"test-encoded-modules-module-iso-8859-1",
	"test-encoded-modules-module-koi8-r",
	"test-final-a",
	"test-final-b",
	"test-fork-wait",
	"test-future-test1",
	"test-future-test2",
	"test-gdb-sample",
	"test-good-getattr",
	"test-imp-dummy",
	"test-infinite-reload",
	"test-inspect-fodder",
	"test-inspect-fodder2",
	"test-libregrtest",
	"test-libregrtest-cmdline",
	"test-libregrtest-main",
	"test-libregrtest-pgo",
	"test-libregrtest-refleak",
	"test-libregrtest-runtest",
	"test-libregrtest-runtest-mp",
	"test-libregrtest-save-env",
	"test-libregrtest-setup",
	"test-libregrtest-utils",
	"test-libregrtest-win-utils",
	"test-list-tests",
	"test-lock-tests",
	"test-main",
	"test-make-ssl-certs",
	"test-mapping-tests",
	"test-memory-watchdog",
	"test-mock-backport",
	"test-mock-socket",
	"test-mod-generics-cache",
	"test-mp-fork-bomb",
	"test-mp-preload",
	"test-multibytecodec-support",
	"test-outstanding-bugs",
	"test-pickletester",
	"test-profilee",
	"test-pyclbr-input",
	"test-pydoc-mod",
	"test-pydocfodder",
	"test-pystone",
	"test-pythoninfo",
	"test-re-tests",
	"test-regrtest",
	"test-relimport",
	"test-reperf",
	"test-sample-doctest",
	"test-sample-doctest-no-docstrings",
	"test-sample-doctest-no-doctests",
	"test-script-helper",
	"test-seq-tests",
	"test-signalinterproctester",
	"test-sortperf",
	"test-ssl-servers",
	"test-ssltests",
	"test-string-tests",
	"test-subprocessdata",
	"test-subprocessdata-fd-status",
	"test-subprocessdata-input-reader",
	"test-subprocessdata-qcat",
	"test-subprocessdata-qgrep",
	"test-subprocessdata-sigchild-ignore",
	"test-support",
	"test-support-bytecode-helper",
	"test-support-hashlib-helper",
	"test-support-logging-helper",
	"test-support-script-helper",
	"test-support-socket-helper",
	"test-support-testresult",
	"test-support-warnings-helper",
	"test-symlink-support",
	"test-test-abc",
	"test-test-abstract-numbers",
	"test-test-aepack",
	"test-test-aifc",
	"test-test-al",
	"test-test-all",
	"test-test-anydbm",
	"test-test-applesingle",
	"test-test-argparse",
	"test-test-array",
	"test-test-ascii-formatd",
	"test-test-asdl-parser",
	"test-test-ast",
	"test-test-asyncgen",
	"test-test-asynchat",
	"test-test-asyncio",
	"test-test-asyncio-echo",
	"test-test-asyncio-echo2",
	"test-test-asyncio-echo3",
	"test-test-asyncio-functional",
	"test-test-asyncio-main",
	"test-test-asyncio-test-asyncio-waitfor",
	"test-test-asyncio-test-base-events",
	"test-test-asyncio-test-buffered-proto",
	"test-test-asyncio-test-context",
	"test-test-asyncio-test-events",
	"test-test-asyncio-test-futures",
	"test-test-asyncio-test-futures2",
	"test-test-asyncio-test-locks",
	"test-test-asyncio-test-pep492",
	"test-test-asyncio-test-proactor-events",
	"test-test-asyncio-test-protocols",
	"test-test-asyncio-test-queues",
	"test-test-asyncio-test-runners",
	"test-test-asyncio-test-selector-events",
	"test-test-asyncio-test-sendfile",
	"test-test-asyncio-test-server",
	"test-test-asyncio-test-sock-lowlevel",
	"test-test-asyncio-test-sslproto",
	"test-test-asyncio-test-streams",
	"test-test-asyncio-test-subprocess",
	"test-test-asyncio-test-tasks",
	"test-test-asyncio-test-threads",
	"test-test-asyncio-test-transports",
	"test-test-asyncio-test-unix-events",
	"test-test-asyncio-test-waitfor",
	"test-test-asyncio-test-windows-events",
	"test-test-asyncio-test-windows-utils",
	"test-test-asyncio-utils",
	"test-test-asyncore",
	"test-test-atexit",
	"test-test-audioop",
	"test-test-audit",
	"test-test-augassign",
	"test-test-base64",
	"test-test-baseexception",
	"test-test-bastion",
	"test-test-bdb",
	"test-test-bigaddrspace",
	"test-test-bigmem",
	"test-test-binascii",
	"test-test-binhex",
	"test-test-binop",
	"test-test-bisect",
	"test-test-bool",
	"test-test-bsddb",
	"test-test-bsddb185",
	"test-test-bsddb3",
	"test-test-buffer",
	"test-test-bufio",
	"test-test-builtin",
	"test-test-bytes",
	"test-test-bz2",
	"test-test-c-locale-coercion",
	"test-test-calendar",
	"test-test-call",
	"test-test-capi",
	"test-test-cd",
	"test-test-cfgparser",
	"test-test-cgi",
	"test-test-cgitb",
	"test-test-charmapcodec",
	"test-test-check-c-globals",
	"test-test-cl",
	"test-test-class",
	"test-test-clinic",
	"test-test-cmath",
	"test-test-cmd",
	"test-test-cmd-line",
	"test-test-cmd-line-script",
	"test-test-code",
	"test-test-code-module",
	"test-test-codeccallbacks",
	"test-test-codecencodings-cn",
	"test-test-codecencodings-hk",
	"test-test-codecencodings-iso2022",
	"test-test-codecencodings-jp",
	"test-test-codecencodings-kr",
	"test-test-codecencodings-tw",
	"test-test-codecmaps-cn",
	"test-test-codecmaps-hk",
	"test-test-codecmaps-jp",
	"test-test-codecmaps-kr",
	"test-test-codecmaps-tw",
	"test-test-codecs",
	"test-test-codeop",
	"test-test-coercion",
	"test-test-collections",
	"test-test-colorsys",
	"test-test-commands",
	"test-test-compare",
	"test-test-compile",
	"test-test-compileall",
	"test-test-compiler",
	"test-test-complex",
	"test-test-complex-args",
	"test-test-concurrent-futures",
	"test-test-configparser",
	"test-test-contains",
	"test-test-context",
	"test-test-contextlib",
	"test-test-contextlib-async",
	"test-test-cookie",
	"test-test-cookielib",
	"test-test-copy",
	"test-test-copy-reg",
	"test-test-copyreg",
	"test-test-coroutines",
	"test-test-cpickle",
	"test-test-cprofile",
	"test-test-crashers",
	"test-test-crypt",
	"test-test-csv",
	"test-test-ctypes",
	"test-test-curses",
	"test-test-dataclasses",
	"test-test-datetime",
	"test-test-dbm",
	"test-test-dbm-dumb",
	"test-test-dbm-gnu",
	"test-test-dbm-ndbm",
	"test-test-decimal",
	"test-test-decorators",
	"test-test-defaultdict",
	"test-test-deque",
	"test-test-descr",
	"test-test-descrtut",
	"test-test-devpoll",
	"test-test-dict",
	"test-test-dict-version",
	"test-test-dictcomps",
	"test-test-dictviews",
	"test-test-difflib",
	"test-test-dircache",
	"test-test-dis",
	"test-test-distutils",
	"test-test-dl",
	"test-test-doctest",
	"test-test-doctest2",
	"test-test-docxmlrpc",
	"test-test-dtrace",
	"test-test-dumbdbm",
	"test-test-dummy-thread",
	"test-test-dummy-threading",
	"test-test-dynamic",
	"test-test-dynamicclassattribute",
	"test-test-eintr",
	"test-test-email",
	"test-test-email-codecs",
	"test-test-email-main",
	"test-test-email-renamed",
	"test-test-email-test-asian-codecs",
	"test-test-email-test-contentmanager",
	"test-test-email-test-defect-handling",
	"test-test-email-test-email",
	"test-test-email-test-encoded-words",
	"test-test-email-test-generator",
	"test-test-email-test-header-value-parser",
	"test-test-email-test-headerregistry",
	"test-test-email-test-inversion",
	"test-test-email-test-message",
	"test-test-email-test-parser",
	"test-test-email-test-pickleable",
	"test-test-email-test-policy",
	"test-test-email-test-utils",
	"test-test-email-torture-test",
	"test-test-embed",
	"test-test-ensurepip",
	"test-test-enum",
	"test-test-enumerate",
	"test-test-eof",
	"test-test-epoll",
	"test-test-errno",
	"test-test-exception-hierarchy",
	"test-test-exception-variations",
	"test-test-exceptions",
	"test-test-extcall",
	"test-test-faulthandler",
	"test-test-fcntl",
	"test-test-file",
	"test-test-file-eintr",
	"test-test-file2k",
	"test-test-filecmp",
	"test-test-fileinput",
	"test-test-fileio",
	"test-test-finalization",
	"test-test-float",
	"test-test-flufl",
	"test-test-fnmatch",
	"test-test-fork1",
	"test-test-format",
	"test-test-fpformat",
	"test-test-fractions",
	"test-test-frame",
	"test-test-frozen",
	"test-test-fstring",
	"test-test-ftplib",
	"test-test-funcattrs",
	"test-test-functools",
	"test-test-future",
	"test-test-future-builtins",
	"test-test-future1",
	"test-test-future2",
	"test-test-future3",
	"test-test-future4",
	"test-test-future5",
	"test-test-gc",
	"test-test-gdb",
	"test-test-gdbm",
	"test-test-generator-stop",
	"test-test-generators",
	"test-test-genericalias",
	"test-test-genericclass",
	"test-test-genericpath",
	"test-test-genexps",
	"test-test-getargs",
	"test-test-getargs2",
	"test-test-getopt",
	"test-test-getpass",
	"test-test-gettext",
	"test-test-gl",
	"test-test-glob",
	"test-test-global",
	"test-test-grammar",
	"test-test-graphlib",
	"test-test-grp",
	"test-test-gzip",
	"test-test-hash",
	"test-test-hashlib",
	"test-test-heapq",
	"test-test-hmac",
	"test-test-hotshot",
	"test-test-html",
	"test-test-htmllib",
	"test-test-htmlparser",
	"test-test-http-cookiejar",
	"test-test-http-cookies",
	"test-test-httplib",
	"test-test-httpservers",
	"test-test-idle",
	"test-test-imageop",
	"test-test-imaplib",
	"test-test-imgfile",
	"test-test-imghdr",
	"test-test-imp",
	"test-test-import",
	"test-test-import-data",
	"test-test-import-data-circular-imports",
	"test-test-import-data-circular-imports-basic",
	"test-test-import-data-circular-imports-basic2",
	"test-test-import-data-circular-imports-binding",
	"test-test-import-data-circular-imports-binding2",
	"test-test-import-data-circular-imports-from-cycle1",
	"test-test-import-data-circular-imports-from-cycle2",
	"test-test-import-data-circular-imports-indirect",
	"test-test-import-data-circular-imports-rebinding",
	"test-test-import-data-circular-imports-rebinding2",
	"test-test-import-data-circular-imports-source",
	"test-test-import-data-circular-imports-subpackage",
	"test-test-import-data-circular-imports-subpkg",
	"test-test-import-data-circular-imports-subpkg-subpackage2",
	"test-test-import-data-circular-imports-subpkg-util",
	"test-test-import-data-circular-imports-use",
	"test-test-import-data-circular-imports-util",
	"test-test-import-data-package",
	"test-test-import-data-package-submodule",
	"test-test-import-data-package2",
	"test-test-import-data-package2-submodule1",
	"test-test-import-data-package2-submodule2",
	"test-test-import-magic",
	"test-test-import-main",
	"test-test-importhooks",
	"test-test-importlib",
	"test-test-importlib-abc",
	"test-test-importlib-builtin",
	"test-test-importlib-builtin-main",
	"test-test-importlib-builtin-test-finder",
	"test-test-importlib-builtin-test-loader",
	"test-test-importlib-builtin-util",
	"test-test-importlib-data",
	"test-test-importlib-data01",
	"test-test-importlib-data01-subdirectory",
	"test-test-importlib-data02",
	"test-test-importlib-data02-one",
	"test-test-importlib-data02-two",
	"test-test-importlib-data03",
	"test-test-importlib-data03-namespace",
	"test-test-importlib-data03-namespace-portion1",
	"test-test-importlib-data03-namespace-portion2",
	"test-test-importlib-extension",
	"test-test-importlib-extension-main",
	"test-test-importlib-extension-test-case-sensitivity",
	"test-test-importlib-extension-test-finder",
	"test-test-importlib-extension-test-loader",
	"test-test-importlib-extension-test-path-hook",
	"test-test-importlib-extension-util",
	"test-test-importlib-fixtures",
	"test-test-importlib-frozen",
	"test-test-importlib-frozen-main",
	"test-test-importlib-frozen-test-finder",
	"test-test-importlib-frozen-test-loader",
	"test-test-importlib-import",
	"test-test-importlib-import-main",
	"test-test-importlib-import-test-api",
	"test-test-importlib-import-test-caching",
	"test-test-importlib-import-test-fromlist",
	"test-test-importlib-import-test-loader",
	"test-test-importlib-import-test-meta-path",
	"test-test-importlib-import-test-package",
	"test-test-importlib-import-test-packages",
	"test-test-importlib-import-test-path",
	"test-test-importlib-import-test-relative-imports",
	"test-test-importlib-import-util",
	"test-test-importlib-main",
	"test-test-importlib-namespace-pkgs",
	"test-test-importlib-namespace-pkgs-both-portions",
	"test-test-importlib-namespace-pkgs-both-portions-foo",
	"test-test-importlib-namespace-pkgs-both-portions-foo-one",
	"test-test-importlib-namespace-pkgs-both-portions-foo-two",
	"test-test-importlib-namespace-pkgs-module-and-namespace-package",
	"test-test-importlib-namespace-pkgs-module-and-namespace-package-a-test",
	"test-test-importlib-namespace-pkgs-not-a-namespace-pkg",
	"test-test-importlib-namespace-pkgs-not-a-namespace-pkg-foo",
	"test-test-importlib-namespace-pkgs-not-a-namespace-pkg-foo-one",
	"test-test-importlib-namespace-pkgs-portion1",
	"test-test-importlib-namespace-pkgs-portion1-foo",
	"test-test-importlib-namespace-pkgs-portion1-foo-one",
	"test-test-importlib-namespace-pkgs-portion2",
	"test-test-importlib-namespace-pkgs-portion2-foo",
	"test-test-importlib-namespace-pkgs-portion2-foo-two",
	"test-test-importlib-namespace-pkgs-project1",
	"test-test-importlib-namespace-pkgs-project1-parent",
	"test-test-importlib-namespace-pkgs-project1-parent-child",
	"test-test-importlib-namespace-pkgs-project1-parent-child-one",
	"test-test-importlib-namespace-pkgs-project2",
	"test-test-importlib-namespace-pkgs-project2-parent",
	"test-test-importlib-namespace-pkgs-project2-parent-child",
	"test-test-importlib-namespace-pkgs-project2-parent-child-two",
	"test-test-importlib-namespace-pkgs-project3",
	"test-test-importlib-namespace-pkgs-project3-parent",
	"test-test-importlib-namespace-pkgs-project3-parent-child",
	"test-test-importlib-namespace-pkgs-project3-parent-child-three",
	"test-test-importlib-regrtest",
	"test-test-importlib-source",
	"test-test-importlib-source-main",
	"test-test-importlib-source-test-case-sensitivity",
	"test-test-importlib-source-test-file-loader",
	"test-test-importlib-source-test-finder",
	"test-test-importlib-source-test-path-hook",
	"test-test-importlib-source-test-source-encoding",
	"test-test-importlib-source-util",
	"test-test-importlib-stubs",
	"test-test-importlib-test-abc",
	"test-test-importlib-test-api",
	"test-test-importlib-test-files",
	"test-test-importlib-test-lazy",
	"test-test-importlib-test-locks",
	"test-test-importlib-test-main",
	"test-test-importlib-test-metadata-api",
	"test-test-importlib-test-namespace-pkgs",
	"test-test-importlib-test-open",
	"test-test-importlib-test-path",
	"test-test-importlib-test-pkg-import",
	"test-test-importlib-test-read",
	"test-test-importlib-test-resource",
	"test-test-importlib-test-spec",
	"test-test-importlib-test-threaded-import",
	"test-test-importlib-test-util",
	"test-test-importlib-test-windows",
	"test-test-importlib-test-zip",
	"test-test-importlib-threaded-import-hangers",
	"test-test-importlib-util",
	"test-test-importlib-zipdata01",
	"test-test-importlib-zipdata02",
	"test-test-index",
	"test-test-inspect",
	"test-test-int",
	"test-test-int-literal",
	"test-test-io",
	"test-test-ioctl",
	"test-test-ipaddress",
	"test-test-isinstance",
	"test-test-iter",
	"test-test-iterlen",
	"test-test-itertools",
	"test-test-json",
	"test-test-json-main",
	"test-test-json-test-decode",
	"test-test-json-test-default",
	"test-test-json-test-dump",
	"test-test-json-test-encode-basestring-ascii",
	"test-test-json-test-enum",
	"test-test-json-test-fail",
	"test-test-json-test-float",
	"test-test-json-test-indent",
	"test-test-json-test-pass1",
	"test-test-json-test-pass2",
	"test-test-json-test-pass3",
	"test-test-json-test-recursion",
	"test-test-json-test-scanstring",
	"test-test-json-test-separators",
	"test-test-json-test-speedups",
	"test-test-json-test-tool",
	"test-test-json-test-unicode",
	"test-test-keyword",
	"test-test-keywordonlyarg",
	"test-test-kqueue",
	"test-test-largefile",
	"test-test-lib2to3",
	"test-test-linecache",
	"test-test-linuxaudiodev",
	"test-test-list",
	"test-test-listcomps",
	"test-test-lltrace",
	"test-test-locale",
	"test-test-logging",
	"test-test-long",
	"test-test-long-future",
	"test-test-longexp",
	"test-test-lzma",
	"test-test-macos",
	"test-test-macostools",
	"test-test-macpath",
	"test-test-macurl2path",
	"test-test-mailbox",
	"test-test-mailcap",
	"test-test-marshal",
	"test-test-math",
	"test-test-md5",
	"test-test-memoryio",
	"test-test-memoryview",
	"test-test-metaclass",
	"test-test-mhlib",
	"test-test-mimetools",
	"test-test-mimetypes",
	"test-test-mimewriter",
	"test-test-minidom",
	"test-test-mmap",
	"test-test-module",
	"test-test-modulefinder",
	"test-test-msilib",
	"test-test-multibytecodec",
	"test-test-multifile",
	"test-test-multiprocessing",
	"test-test-multiprocessing-fork",
	"test-test-multiprocessing-forkserver",
	"test-test-multiprocessing-main-handling",
	"test-test-multiprocessing-spawn",
	"test-test-mutants",
	"test-test-mutex",
	"test-test-named-expressions",
	"test-test-netrc",
	"test-test-new",
	"test-test-nis",
	"test-test-nntplib",
	"test-test-normalization",
	"test-test-ntpath",
	"test-test-numeric-tower",
	"test-test-old-mailbox",
	"test-test-opcode",
	"test-test-opcodes",
	"test-test-openpty",
	"test-test-operator",
	"test-test-optparse",
	"test-test-ordered-dict",
	"test-test-os",
	"test-test-ossaudiodev",
	"test-test-osx-env",
	"test-test-osx-support",
	"test-test-parser",
	"test-test-pathlib",
	"test-test-pdb",
	"test-test-peepholer",
	"test-test-peg-generator",
	"test-test-peg-generator-main",
	"test-test-peg-generator-test-c-parser",
	"test-test-peg-generator-test-first-sets",
	"test-test-peg-generator-test-pegen",
	"test-test-peg-parser",
	"test-test-pep247",
	"test-test-pep277",
	"test-test-pep292",
	"test-test-pep3120",
	"test-test-pep3131",
	"test-test-pep3151",
	"test-test-pep352",
	"test-test-pep380",
	"test-test-pep479",
	"test-test-pickle",
	"test-test-picklebuffer",
	"test-test-pickletools",
	"test-test-pipes",
	"test-test-pkg",
	"test-test-pkgimport",
	"test-test-pkgutil",
	"test-test-platform",
	"test-test-plistlib",
	"test-test-poll",
	"test-test-popen",
	"test-test-popen2",
	"test-test-poplib",
	"test-test-positional-only-arg",
	"test-test-posix",
	"test-test-posixpath",
	"test-test-pow",
	"test-test-pprint",
	"test-test-print",
	"test-test-profile",
	"test-test-property",
	"test-test-pstats",
	"test-test-pty",
	"test-test-pulldom",
	"test-test-pwd",
	"test-test-py-compile",
	"test-test-py3kwarn",
	"test-test-pyclbr",
	"test-test-pydoc",
	"test-test-pyexpat",
	"test-test-queue",
	"test-test-quopri",
	"test-test-raise",
	"test-test-random",
	"test-test-range",
	"test-test-re",
	"test-test-readline",
	"test-test-regrtest",
	"test-test-repl",
	"test-test-repr",
	"test-test-reprlib",
	"test-test-resource",
	"test-test-rfc822",
	"test-test-richcmp",
	"test-test-rlcompleter",
	"test-test-robotparser",
	"test-test-runpy",
	"test-test-sax",
	"test-test-sched",
	"test-test-scope",
	"test-test-script-helper",
	"test-test-scriptpackages",
	"test-test-secrets",
	"test-test-select",
	"test-test-selectors",
	"test-test-set",
	"test-test-setcomps",
	"test-test-sets",
	"test-test-sgmllib",
	"test-test-sha",
	"test-test-shelve",
	"test-test-shlex",
	"test-test-shutil",
	"test-test-signal",
	"test-test-simplehttpserver",
	"test-test-site",
	"test-test-slice",
	"test-test-smtpd",
	"test-test-smtplib",
	"test-test-smtpnet",
	"test-test-sndhdr",
	"test-test-socket",
	"test-test-socketserver",
	"test-test-softspace",
	"test-test-sort",
	"test-test-source-encoding",
	"test-test-spwd",
	"test-test-sqlite",
	"test-test-ssl",
	"test-test-startfile",
	"test-test-stat",
	"test-test-statistics",
	"test-test-str",
	"test-test-strftime",
	"test-test-string",
	"test-test-string-literals",
	"test-test-stringio",
	"test-test-stringprep",
	"test-test-strlit",
	"test-test-strop",
	"test-test-strptime",
	"test-test-strtod",
	"test-test-struct",
	"test-test-structmembers",
	"test-test-structseq",
	"test-test-subclassinit",
	"test-test-subprocess",
	"test-test-sunau",
	"test-test-sunaudiodev",
	"test-test-sundry",
	"test-test-super",
	"test-test-support",
	"test-test-symbol",
	"test-test-symtable",
	"test-test-syntax",
	"test-test-sys",
	"test-test-sys-setprofile",
	"test-test-sys-settrace",
	"test-test-sysconfig",
	"test-test-syslog",
	"test-test-tabnanny",
	"test-test-tarfile",
	"test-test-tcl",
	"test-test-telnetlib",
	"test-test-tempfile",
	"test-test-test-support",
	"test-test-textwrap",
	"test-test-thread",
	"test-test-threaded-import",
	"test-test-threadedtempfile",
	"test-test-threading",
	"test-test-threading-local",
	"test-test-threadsignals",
	"test-test-time",
	"test-test-timeit",
	"test-test-timeout",
	"test-test-tix",
	"test-test-tk",
	"test-test-tokenize",
	"test-test-tools",
	"test-test-tools-main",
	"test-test-tools-test-fixcid",
	"test-test-tools-test-gprof2html",
	"test-test-tools-test-i18n",
	"test-test-tools-test-lll",
	"test-test-tools-test-md5sum",
	"test-test-tools-test-pathfix",
	"test-test-tools-test-pdeps",
	"test-test-tools-test-pindent",
	"test-test-tools-test-reindent",
	"test-test-tools-test-sundry",
	"test-test-tools-test-unparse",
	"test-test-trace",
	"test-test-traceback",
	"test-test-tracemalloc",
	"test-test-transformer",
	"test-test-ttk-guionly",
	"test-test-ttk-textonly",
	"test-test-tuple",
	"test-test-turtle",
	"test-test-type-comments",
	"test-test-typechecks",
	"test-test-types",
	"test-test-typing",
	"test-test-ucn",
	"test-test-unary",
	"test-test-undocumented-details",
	"test-test-unicode",
	"test-test-unicode-file",
	"test-test-unicode-file-functions",
	"test-test-unicode-identifiers",
	"test-test-unicodedata",
	"test-test-unittest",
	"test-test-univnewlines",
	"test-test-univnewlines2k",
	"test-test-unpack",
	"test-test-unpack-ex",
	"test-test-unparse",
	"test-test-urllib",
	"test-test-urllib-response",
	"test-test-urllib2",
	"test-test-urllib2-localnet",
	"test-test-urllib2net",
	"test-test-urllibnet",
	"test-test-urlparse",
	"test-test-userdict",
	"test-test-userlist",
	"test-test-userstring",
	"test-test-utf8-mode",
	"test-test-utf8source",
	"test-test-uu",
	"test-test-uuid",
	"test-test-venv",
	"test-test-wait3",
	"test-test-wait4",
	"test-test-warnings",
	"test-test-warnings-data",
	"test-test-warnings-data-import-warning",
	"test-test-warnings-data-stacklevel",
	"test-test-warnings-main",
	"test-test-wave",
	"test-test-weakref",
	"test-test-weakset",
	"test-test-webbrowser",
	"test-test-whichdb",
	"test-test-winconsoleio",
	"test-test-winreg",
	"test-test-winsound",
	"test-test-with",
	"test-test-wsgiref",
	"test-test-xdrlib",
	"test-test-xml-dom-minicompat",
	"test-test-xml-etree",
	"test-test-xml-etree-c",
	"test-test-xmllib",
	"test-test-xmlrpc",
	"test-test-xmlrpc-net",
	"test-test-xpickle",
	"test-test-xrange",
	"test-test-xxsubinterpreters",
	"test-test-xxtestfuzz",
	"test-test-yield-from",
	"test-test-zipapp",
	"test-test-zipfile",
	"test-test-zipfile64",
	"test-test-zipimport",
	"test-test-zipimport-support",
	"test-test-zlib",
	"test-test-zoneinfo",
	"test-test-zoneinfo-main",
	"test-test-zoneinfo-support",
	"test-test-zoneinfo-test-zoneinfo",
	"test-testall",
	"test-testcodec",
	"test-tf-inherit-check",
	"test-threaded-import-hangers",
	"test-time-hashlib",
	"test-tracedmodules",
	"test-tracedmodules-testmod",
	"test-typed-dict-helper",
	"test-warning-tests",
	"test-win-console-handler",
	"test-xmltests",
	"test-ziptestdata",
	"test-ziptestdata-testdata-module-inside-zip",
	"testbuffer",
	"testcapi",
	"testimportmultiple",
	"testinternalcapi",
	"testmultiphase",
	"textwrap",
	"this",
	"thread",
	"threading",
	"threading-local",
	"time",
	"timeit",
	"tix",
	"tkcolorchooser",
	"tkcommondialog",
	"tkconstants",
	"tkdnd",
	"tkfiledialog",
	"tkfont",
	"tkinter",
	"tkinter-colorchooser",
	"tkinter-commondialog",
	"tkinter-constants",
	"tkinter-dialog",
	"tkinter-dnd",
	"tkinter-filedialog",
	"tkinter-fix",
	"tkinter-font",
	"tkinter-main",
	"tkinter-messagebox",
	"tkinter-scrolledtext",
	"tkinter-simpledialog",
	"tkinter-test",
	"tkinter-test-runtktests",
	"tkinter-test-support",
	"tkinter-test-test-tkinter",
	"tkinter-test-test-tkinter-test-colorchooser",
	"tkinter-test-test-tkinter-test-font",
	"tkinter-test-test-tkinter-test-geometry-managers",
	"tkinter-test-test-tkinter-test-images",
	"tkinter-test-test-tkinter-test-loadtk",
	"tkinter-test-test-tkinter-test-messagebox",
	"tkinter-test-test-tkinter-test-misc",
	"tkinter-test-test-tkinter-test-simpledialog",
	"tkinter-test-test-tkinter-test-text",
	"tkinter-test-test-tkinter-test-variables",
	"tkinter-test-test-tkinter-test-widgets",
	"tkinter-test-test-ttk",
	"tkinter-test-test-ttk-test-extensions",
	"tkinter-test-test-ttk-test-functions",
	"tkinter-test-test-ttk-test-style",
	"tkinter-test-test-ttk-test-widgets",
	"tkinter-test-widget-tests",
	"tkinter-tix",
	"tkinter-ttk",
	"tkmessagebox",
	"tksimpledialog",
	"toaiff",
	"token",
	"tokenize",
	"tomllib",
	"tomllib-parser",
	"tomllib-re",
	"tomllib-types",
	"trace",
	"traceback",
	"tracemalloc",
	"ttk",
	"tty",
	"turtle",
	"turtledemo",
	"turtledemo-bytedesign",
	"turtledemo-chaos",
	"turtledemo-clock",
	"turtledemo-colormixer",
	"turtledemo-forest",
	"turtledemo-fractalcurves",
	"turtledemo-lindenmayer",
	"turtledemo-main",
	"turtledemo-minimal-hanoi",
	"turtledemo-nim",
	"turtledemo-paint",
	"turtledemo-peace",
	"turtledemo-penrose",
	"turtledemo-planet-and-moon",
	"turtledemo-rosette",
	"turtledemo-round-dance",
	"turtledemo-sorting-animate",
	"turtledemo-tree",
	"turtledemo-two-canvases",
	"turtledemo-wikipedia",
	"turtledemo-yinyang",
	"types",
	"typing",
	"typing-io",
	"typing-re",
	"unicodedata",
	"unittest",
	"unittest-async-case",
	"unittest-case",
	"unittest-loader",
	"unittest-log",
	"unittest-main",
	"unittest-mock",
	"unittest-result",
	"unittest-runner",
	"unittest-signals",
	"unittest-suite",
	"unittest-test",
	"unittest-test-dummy",
	"unittest-test-main",
	"unittest-test-support",
	"unittest-test-test-assertions",
	"unittest-test-test-async-case",
	"unittest-test-test-break",
	"unittest-test-test-case",
	"unittest-test-test-discovery",
	"unittest-test-test-functiontestcase",
	"unittest-test-test-loader",
	"unittest-test-test-program",
	"unittest-test-test-result",
	"unittest-test-test-runner",
	"unittest-test-test-setups",
	"unittest-test-test-skipping",
	"unittest-test-test-suite",
	"unittest-test-test-warnings",
	"unittest-test-testmock",
	"unittest-test-testmock-main",
	"unittest-test-testmock-support",
	"unittest-test-testmock-testasync",
	"unittest-test-testmock-testcallable",
	"unittest-test-testmock-testhelpers",
	"unittest-test-testmock-testmagicmethods",
	"unittest-test-testmock-testmock",
	"unittest-test-testmock-testpatch",
	"unittest-test-testmock-testsealable",
	"unittest-test-testmock-testsentinel",
	"unittest-test-testmock-testwith",
	"unittest-util",
	"urllib",
	"urllib-error",
	"urllib-parse",
	"urllib-request",
	"urllib-response",
	"urllib-robotparser",
	"urllib2",
	"urlparse",
	"user",
	"userdict",
	"userlist",
	"userstring",
	"uu",
	"uuid",
	"venv",
	"venv-main",
	"videoreader",
	"w",
	"warnings",
	"wave",
	"weakref",
	"weakrefset",
	"webbrowser",
	"whichdb",
	"winapi",
	"winreg",
	"winsound",
	"wmi",
	"wsgiref",
	"wsgiref-handlers",
	"wsgiref-headers",
	"wsgiref-simple-server",
	"wsgiref-types",
	"wsgiref-util",
	"wsgiref-validate",
	"xdrlib",
	"xml",
	"xml-dom",
	"xml-dom-domreg",
	"xml-dom-expatbuilder",
	"xml-dom-minicompat",
	"xml-dom-minidom",
	"xml-dom-nodefilter",
	"xml-dom-pulldom",
	"xml-dom-xmlbuilder",
	"xml-etree",
	"xml-etree-celementtree",
	"xml-etree-elementinclude",
	"xml-etree-elementpath",
	"xml-etree-elementtree",
	"xml-parsers",
	"xml-parsers-expat",
	"xml-parsers-expat-errors",
	"xml-parsers-expat-errors-dom",
	"xml-parsers-expat-errors-etree",
	"xml-parsers-expat-errors-parsers",
	"xml-parsers-expat-errors-sax",
	"xml-parsers-expat-model",
	"xml-parsers-expat-model-dom",
	"xml-parsers-expat-model-etree",
	"xml-parsers-expat-model-parsers",
	"xml-parsers-expat-model-sax",
	"xml-sax",
	"xml-sax-exceptions",
	"xml-sax-expatreader",
	"xml-sax-handler",
	"xml-sax-saxutils",
	"xml-sax-xmlreader",
	"xmllib",
	"xmlrpc",
	"xmlrpc-client",
	"xmlrpc-server",
	"xmlrpclib",
	"xxlimited",
	"xxsubinterpreters",
	"xxsubtype",
	"xxtestfuzz",
	"zipapp",
	"zipfile",
	"zipfile-main",
	"zipfile-path",
	"zipfile-path-glob",
	"zipimport",
	"zlib",
	"zoneinfo",
	"zoneinfo-common",
	"zoneinfo-tzpath",
	"zoneinfo-zoneinfo",
	"zstd"
]);
/** PEP 503: case-insensitive, runs of `-`, `_` and `.` are equivalent. */
const normalizePypi = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
/**
* Warehouse's `ultranormalize_name`: drops `. _ -`, then maps l/L/i/I to 1 and o/O to 0, so `f1ask`
* collides with `flask`. PyPI refuses a new name whose ultranormalized form matches an existing project.
*/
const ultranormalizePypi = (name) => name.replace(/[._-]/g, "").replace(/[lLiI]/g, "1").replace(/[oO]/g, "0").toLowerCase();
const VALID$3 = /^([a-z0-9]|[a-z0-9][a-z0-9._-]*[a-z0-9])$/i;
const SIMPLE_JSON = "application/vnd.pypi.simple.v1+json";
/** Every project on PyPI, one `ultranormalized\tname` line each, from the simple index (about 10 MB). */
async function projectList(ctx) {
	const res = await get(ctx, "https://pypi.org/simple/", {
		headers: { accept: SIMPLE_JSON },
		timeoutMs: 12e4
	});
	if (!res.ok) throw new Error(`PyPI simple index returned HTTP ${res.status}`);
	if (!res.body) throw new Error("PyPI simple index has no body");
	const NAME = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
	const parts = [];
	let count = 0;
	let projects = false;
	let carry = "";
	for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
		const text = carry + chunk;
		projects ||= /"projects"\s*:\s*\[/.test(text);
		let end = 0;
		const found = [];
		NAME.lastIndex = 0;
		for (let m = NAME.exec(text); m; m = NAME.exec(text)) {
			const name = m[1].includes("\\") ? JSON.parse(`"${m[1]}"`) : m[1];
			found.push(`${ultranormalizePypi(name)}\t${name}`);
			end = NAME.lastIndex;
		}
		count += found.length;
		if (found.length) parts.push(`\n${found.join("\n")}`);
		carry = text.slice(Math.max(end, text.length - 1024));
	}
	if (!projects || !count || !/\]\s*\}\s*$/.test(carry)) throw new Error("PyPI simple index is not in the expected shape or ended early");
	return `${parts.join("")}\n`;
}
const pypi = defineChannel({
	id: "pypi",
	label: "PyPI",
	category: "package",
	rules: (name) => {
		if (!VALID$3.test(name)) return "PyPI names are letters, digits, and inner . _ -";
	},
	refuses: (name) => PYPI_STDLIB.has(normalizePypi(name)) ? "PyPI reserves Python standard library names" : void 0,
	async lookup(name, ctx) {
		const normalized = normalizePypi(name);
		const url = `https://pypi.org/project/${normalized}/`;
		const res = await get(ctx, `https://pypi.org/pypi/${normalized}/json`);
		if (res.status === 200) {
			const { info } = await res.json();
			return {
				status: "taken",
				url,
				note: info.summary || void 0,
				meta: {
					name: info.name,
					latest: info.version
				}
			};
		}
		if (res.status !== 404) return unexpected("PyPI", res);
		const simple = await get(ctx, `https://pypi.org/simple/${normalized}/`, { headers: { accept: SIMPLE_JSON } });
		if (simple.status === 200) {
			const doc = await simple.json();
			const state = doc["project-status"]?.status;
			return {
				status: "taken",
				url,
				note: state && state !== "active" ? `the project exists but is ${state}` : "the project exists but has no installable release",
				meta: {
					name: doc.name,
					state
				}
			};
		}
		if (simple.status !== 404) return unexpected("PyPI", simple);
		let list;
		try {
			list = await cachedList(ctx, "pypi-projects", () => projectList(ctx));
		} catch {
			return {
				status: "available",
				certainty: "probable",
				note: "could not download PyPI's project list to check its similar-name rule"
			};
		}
		const matches = linesFor(list.text, ultranormalizePypi(name)).map(([n]) => n);
		if (matches[0]) return {
			status: "unavailable",
			note: `PyPI rejects names too similar to "${matches[0]}"`
		};
		return list.stale ? {
			status: "available",
			certainty: "probable",
			note: `could not refresh PyPI's project list; used the copy from ${asOf(list)}`
		} : {
			status: "available",
			certainty: "confirmed"
		};
	}
});
const SITE$1 = "https://rubygems.org";
const VALID$2 = /^[A-Za-z0-9._-]{1,255}$/;
const EDGE = /^[._-]|[._-]$/;
const EXTENSION = /\.(?:gem|json|html|gemspec)$/i;
/** GemTypo: names are compared uppercased with `-` and `_` dropped (`.` is kept). */
const typoKey = (name) => name.toUpperCase().replace(/[_-]/g, "");
const DOWNLOADS = 1e4;
const FIVE_YEARS_MS = 157788e6;
/** Every gem with an indexed version, one `key\tname` line each, from /names (about 3 MB). */
async function nameList(ctx) {
	const res = await get(ctx, `${SITE$1}/names`, { timeoutMs: 12e4 });
	if (!res.ok) throw new Error(`RubyGems /names returned HTTP ${res.status}`);
	const [head, ...names] = (await res.text()).split("\n").filter(Boolean);
	if (head !== "---" || names.length < 1e3) throw new Error("RubyGems /names is not in the expected shape");
	return `\n${names.map((n) => `${typoKey(n)}\t${n}`).join("\n")}\n`;
}
/** The API serves `info` HTML-escaped ("Gender &amp; Ethnicity"). */
const unescape = (text) => text.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (e) => e === "&amp;" ? "&" : e === "&lt;" ? "<" : e === "&gt;" ? ">" : e === "&quot;" ? "\"" : "'");
const fetchGem = (ctx, name) => get(ctx, `${SITE$1}/api/v1/gems/${name}.json`);
/** What the gem page says about a name the API does not list: reserved, held after a yank, or free. */
async function gemPage(ctx, name, asked) {
	const url = `${SITE$1}/gems/${name}`;
	const res = await get(ctx, url);
	if (res.status === 404) return void 0;
	if (res.status !== 200) return unexpected("RubyGems", res);
	const html = await res.text();
	if (html.includes("reserved by rubygems.org")) return {
		status: "unavailable",
		url,
		note: "RubyGems.org reserves this name"
	};
	const held = /reserved this gem name for (\d+) more days?/.exec(html);
	if (held) return {
		status: "unavailable",
		url,
		note: `yanked by its owner; RubyGems.org holds the name for ${held[1]} more days`
	};
	if (html.includes("not currently hosted on RubyGems.org")) return {
		status: "reclaimable",
		url,
		note: "every version was yanked; anyone can push it"
	};
	if (name !== asked) return {
		status: "taken",
		url,
		note: `held as "${name}"`
	};
	return {
		status: "unknown",
		note: "the RubyGems page for this name could not be read"
	};
}
const rubygems = defineChannel({
	id: "rubygems",
	label: "RubyGems",
	category: "package",
	rules: (name) => {
		if (!VALID$2.test(name)) return "gem names are letters, digits, . - and _ (max 255)";
	},
	refuses: (name) => {
		if (!/[a-zA-Z]/.test(name)) return "gem names must include a letter";
		if (EDGE.test(name)) return "gem names cannot begin or end with . - or _";
		if (EXTENSION.test(name)) return "gem names cannot end with a file extension such as .gem";
	},
	async lookup(name, ctx) {
		const res = await fetchGem(ctx, name);
		if (res.status === 200) {
			const gem = await res.json();
			if (typeof gem?.name !== "string") return {
				status: "unknown",
				note: "RubyGems returned an unexpected gem"
			};
			return {
				status: "taken",
				url: `${SITE$1}/gems/${gem.name}`,
				note: typeof gem.info === "string" ? unescape(gem.info) : void 0
			};
		}
		if (res.status !== 404) return unexpected("RubyGems", res);
		for (const spelling of /* @__PURE__ */ new Set([name, name.toLowerCase()])) {
			const page = await gemPage(ctx, spelling, name);
			if (page) return page;
		}
		let list;
		try {
			list = await cachedList(ctx, "rubygems-names", () => nameList(ctx));
		} catch {
			return {
				status: "available",
				certainty: "probable",
				note: "could not download RubyGems' name list to check similar names"
			};
		}
		const matches = linesFor(list.text, typoKey(name)).map(([n]) => n);
		const twin = matches.find((n) => n.toLowerCase() === name.toLowerCase());
		if (twin) return {
			status: "taken",
			url: `${SITE$1}/gems/${twin}`,
			note: `held as "${twin}"`
		};
		const now = ctx.now?.() ?? Date.now();
		for (const match of matches) {
			const r = await fetchGem(ctx, match);
			const gem = r.status === 200 ? await r.json() : void 0;
			const released = Date.parse(gem?.version_created_at ?? "");
			if (typeof gem?.downloads !== "number" || Number.isNaN(released)) return {
				status: "available",
				certainty: "probable",
				note: `could not check whether the similar gem "${match}" blocks it`
			};
			if (gem.downloads >= DOWNLOADS || now - released < FIVE_YEARS_MS) return {
				status: "unavailable",
				url: `${SITE$1}/gems/${match}`,
				note: `RubyGems rejects names too similar to "${match}"`
			};
		}
		return list.stale ? {
			status: "available",
			certainty: "probable",
			note: `could not refresh RubyGems' name list; used the copy from ${asOf(list)}`
		} : {
			status: "available",
			certainty: "probable",
			note: "no gem with this name; a yanked gem spelled with other capitals is hidden and would still hold it"
		};
	}
});
const API = "https://api.smithery.ai";
const VALID$1 = /^[a-z0-9-]+$/;
const isServerList = (x) => {
	const list = x;
	return Array.isArray(list?.servers) && list.servers.every((s) => typeof s?.qualifiedName === "string") && typeof list.pagination?.totalCount === "number";
};
const smithery = defineChannel({
	id: "smithery",
	label: "Smithery",
	category: "agent",
	rules: (name) => /^[a-z0-9-]+$/i.test(name) ? void 0 : "Smithery namespaces are letters, digits and hyphens",
	refuses: (name) => VALID$1.test(name) ? void 0 : "new Smithery namespaces are lowercase",
	async lookup(name, ctx) {
		const res = await get(ctx, `${API}/servers?namespace=${name}&pageSize=1`);
		if (res.status !== 200) return unexpected("Smithery", res);
		const list = await res.json();
		if (!isServerList(list)) return {
			status: "unknown",
			note: "Smithery returned an unexpected list"
		};
		const [first] = list.servers;
		const total = list.pagination.totalCount;
		if (first) return {
			status: "taken",
			url: `https://smithery.ai/servers/${first.qualifiedName}`,
			note: total === 1 ? `1 server in this namespace: ${first.displayName ?? first.qualifiedName}` : `${total} servers in this namespace, such as ${first.displayName ?? first.qualifiedName}`,
			meta: { servers: total }
		};
		return {
			status: "available",
			certainty: "probable",
			note: "no public servers; a namespace with none, or with only unlisted ones, also looks free"
		};
	}
});
const SITE = "https://marketplace.visualstudio.com";
const VALID = /^[a-z0-9][a-z0-9-]*$/i;
/** The extensions a text search finds, from the gallery API the marketplace site uses itself. */
async function search(ctx, name) {
	const res = await get(ctx, `${SITE}/_apis/public/gallery/extensionquery`, {
		headers: {
			accept: "application/json;api-version=7.2-preview.1",
			"content-type": "application/json"
		},
		body: JSON.stringify({
			filters: [{
				criteria: [{
					filterType: 8,
					value: "Microsoft.VisualStudio.Code"
				}, {
					filterType: 10,
					value: name
				}],
				pageSize: 1e3
			}],
			flags: 0
		})
	});
	if (res.status !== 200) return res;
	const extensions = (await res.json())?.results?.[0]?.extensions;
	if (!Array.isArray(extensions)) throw new Error("the VS Code Marketplace returned an unexpected list");
	return extensions;
}
const vscode = defineChannel({
	id: "vscode",
	label: "VS Code Marketplace",
	category: "editor",
	rules: (name) => VALID.test(name) ? void 0 : "VS Code extension and publisher names are letters, digits and hyphens",
	async lookup(name, ctx) {
		const found = await search(ctx, name);
		if (found instanceof Response) return unexpected("the VS Code Marketplace", found);
		const wanted = name.toLowerCase();
		const same = (v) => typeof v === "string" && v.toLowerCase() === wanted;
		const hit = found.find((e) => same(e.extensionName) || same(e.displayName));
		if (hit) {
			const id = `${String(hit.publisher?.publisherName)}.${String(hit.extensionName)}`;
			return {
				status: "taken",
				url: `${SITE}/items?itemName=${id}`,
				note: `${id}${typeof hit.displayName === "string" ? ` (${hit.displayName})` : ""} uses this name; a new extension cannot reuse its name or display name`
			};
		}
		const publisher = await get(ctx, `${SITE}/publishers/${name}`, { redirect: "manual" });
		if (publisher.status === 200 || publisher.status === 301) return {
			status: "taken",
			url: `${SITE}/publishers/${name}`,
			note: "a publisher has this ID; it blocks only using it as your publisher, not as an extension name"
		};
		if (publisher.status !== 404) return unexpected("the VS Code Marketplace", publisher);
		return {
			status: "available",
			certainty: "probable",
			note: "no extension or publisher; removed extensions keep their names but are hidden"
		};
	}
});
const DEFAULT_TLDS = ["com", "dev"];
const fixed = [
	npm,
	pypi,
	crates,
	homebrew,
	rubygems,
	packagist,
	pub,
	nuget,
	docker,
	github,
	mcpRegistry,
	smithery,
	claudePlugins,
	cursor,
	gemini,
	vscode,
	openVsx,
	jetbrains,
	appStore,
	googlePlay
];
function channelIds() {
	return [
		...fixed.map((c) => c.id),
		"domain",
		"domain:<tld>"
	];
}
/** A domain channel for a TLD as typed (`.dev`, `COM`, `рф`), or an error for one it cannot check. */
function domainFor(raw) {
	const display = raw.trim().replace(/^\./, "").toLowerCase();
	if (!display) throw new Error("a domain channel needs a TLD, as in domain:dev");
	if (display.includes(".")) throw new Error(`"${display}" has several labels; only top-level domains are supported`);
	const ascii = domainToASCII(display);
	if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(ascii)) throw new Error(`"${display}" is not a valid TLD`);
	return domain(ascii, display);
}
const unique = (channels) => channels.filter((c, i) => channels.findIndex((p) => p.id === c.id) === i);
function selectChannels({ only, tlds = DEFAULT_TLDS } = {}) {
	const all = unique([...fixed, ...tlds.map(domainFor)]);
	if (!only?.length) {
		if (all.filter((c) => c.category === "domain").length > 20) throw new Error(`at most 20 TLDs at a time`);
		return all;
	}
	const picked = [];
	for (const raw of only) {
		const id = raw.trim().toLowerCase();
		if (id === "domain") picked.push(...all.filter((c) => c.category === "domain"));
		else if (id.startsWith("domain:")) picked.push(domainFor(raw.trim().slice(7)));
		else {
			const channel = fixed.find((c) => c.id === id);
			if (!channel) throw new Error(`unknown channel "${raw}"; expected one of: ${channelIds().join(", ")}`);
			picked.push(channel);
		}
	}
	const chosen = unique(picked);
	if (chosen.filter((c) => c.category === "domain").length > 20) throw new Error(`at most 20 TLDs at a time`);
	if (tlds !== DEFAULT_TLDS && !chosen.some((c) => c.category === "domain")) throw new Error("TLDs apply to domains; add domain to the channels");
	return chosen;
}
/** Checked when no manifest says what the project is: the channels most projects meet. */
const GENERAL_CHANNELS = [
	"npm",
	"pypi",
	"crates",
	"homebrew",
	"github",
	"domain"
];
const MCP_PACKAGES = /"(?:@modelcontextprotocol\/(?:sdk|server)|fastmcp|mcp-framework)"\s*:/;
const MCP_REQUIREMENT = /["'](?:mcp|fastmcp)(?:\[[^\]]*\])?\s*(?:[<>=~!;]|["'])/;
async function text(dir, file) {
	try {
		return await readFile(join(dir, file), "utf8");
	} catch {
		return;
	}
}
async function json(dir, file) {
	const raw = await text(dir, file);
	if (raw === void 0) return void 0;
	try {
		const value = JSON.parse(raw);
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}
function parses(raw) {
	try {
		JSON.parse(raw);
		return true;
	} catch {
		return false;
	}
}
async function list(dir) {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}
/** The body of one TOML table, up to the next table header. */
function table(toml, name) {
	const start = toml.search(new RegExp(`^\\[${name.replaceAll(".", "\\.")}\\]\\s*$`, "m"));
	if (start < 0) return "";
	const rest = toml.slice(start).split("\n").slice(1);
	const end = rest.findIndex((line) => /^\[[^\]]+\]\s*$/.test(line));
	return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}
/** Whether a Python manifest describes a package to publish, not an app or a tool's settings. */
function pythonPackage(file, py) {
	if (file === "setup.py") return /\bsetup\s*\(/.test(py);
	if (file === "setup.cfg") return /^\[metadata\]/m.test(py);
	if (/^[ \t]*package[ \t]*=[ \t]*false/m.test(table(py, "tool.uv"))) return false;
	if (/^[ \t]*package-mode[ \t]*=[ \t]*false/m.test(py)) return false;
	if (/^\[tool\.poetry\]/m.test(py)) return true;
	return /^\[project\]/m.test(py) && /^\[build-system\]/m.test(py);
}
/** MSBuild XML without its comments and CDATA sections, whose text holds no elements. */
function uncommented(xml) {
	return xml.replace(/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, "");
}
const ATTRIBUTES = `(?:\\s(?:[^<>"']|"[^"<]*"|'[^'<]*')*)?`;
/**
* MSBuild XML without what it sets only under a condition: elements with a Condition attribute and
* Choose blocks. Which projects a props file's conditions reach cannot be told without evaluating MSBuild.
*/
function unconditional(xml) {
	let out = "";
	let last = 0;
	let skipping;
	let depth = 0;
	for (const m of xml.matchAll(new RegExp(`<(\\/?)([\\w.-]+)(${ATTRIBUTES})>`, "g"))) {
		const [tag, close, name, attrs] = m;
		const empty = attrs.endsWith("/");
		if (skipping) {
			if (name === skipping && !empty) depth += close ? -1 : 1;
			if (depth === 0) {
				skipping = void 0;
				last = m.index + tag.length;
			}
			continue;
		}
		if (close || name !== "Choose" && !/\sCondition\s*=/.test(attrs)) continue;
		out += xml.slice(last, m.index);
		last = m.index + tag.length;
		if (!empty) [skipping, depth] = [name, 1];
	}
	return skipping ? out : out + xml.slice(last);
}
const TEST_REFERENCE = /Include\s*=\s*["'](?:Microsoft\.NET\.Test\.Sdk|xunit\.v3|TUnit|MSTest)["']/i;
const SDK = /\bSdk(?:\s+Name)?\s*=\s*["']([\w.]+)/gi;
/**
* What a .NET project builds, from its own properties and those of the Directory.Build.props and
* Directory.Build.targets files it imports. A tool (`PackAsTool`) is a package. Then none: a test project,
* or one that only groups others. Then an app: a web, worker, WebAssembly, Aspire AppHost, Azure
* Functions or AWS Lambda project, or an executable; package metadata does not make one a
* package, since a props file often sets it for every project. Then none: a project marked not
* packable. Then a package: one that is packable, built as a package or declares package metadata.
* A plain library is packable by default, so NuGet takes it unless something says otherwise.
*/
function dotnetProject(project, props = "", targets = "") {
	const xml = unconditional(props) + uncommented(project) + unconditional(targets);
	const prop = (name) => {
		return [...xml.matchAll(new RegExp(`<${name}${ATTRIBUTES}>([^<]*)</${name}>`, "gi"))].at(-1)?.[1]?.trim().toLowerCase();
	};
	const sdks = [...xml.matchAll(SDK)].map((m) => m[1].toLowerCase());
	if (prop("PackAsTool") === "true") return "package";
	if (prop("IsTestProject") === "true" || prop("EnableMSTestRunner") === "true" || prop("EnableNUnitRunner") === "true" || sdks.includes("mstest.sdk") || sdks.some((sdk) => /^microsoft\.build\.(?:notargets|traversal)$/.test(sdk)) || TEST_REFERENCE.test(xml)) return "none";
	if (sdks.some((sdk) => /^(?:microsoft\.net\.sdk\.(?:web|worker|blazorwebassembly|webassembly)|aspire\.apphost\.sdk)$/.test(sdk)) || /^(?:winexe|exe)$/.test(prop("OutputType") ?? "") || prop("AzureFunctionsVersion") !== void 0 || prop("AWSProjectType") !== void 0) return "app";
	if (prop("IsPackable") === "false") return "none";
	if (prop("IsPackable") === "true" || prop("GeneratePackageOnBuild") === "true" || /<Package(?:Id|LicenseExpression|LicenseFile|Tags|ProjectUrl|ReadmeFile|Icon)\b/i.test(xml)) return "package";
	return "library";
}
/**
* The import of the same file further up, in the forms MSBuild documents: `GetPathOfFileAbove` or a `..`
* path, unconditional or only on the file existing.
*/
function parentImport(xml, file) {
	const name = file.replaceAll(".", "\\.");
	const above = new RegExp(`GetPathOfFileAbove\\(\\s*'${name}'|\\.\\.[\\\\/]${name}$`, "i");
	for (const m of xml.matchAll(new RegExp(`<Import(${ATTRIBUTES})>`, "gi"))) {
		const attribute = (key) => {
			const value = new RegExp(`\\s${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(m[1]);
			return value ? value[1] ?? value[2] : void 0;
		};
		const condition = attribute("Condition");
		if (above.test(attribute("Project") ?? "") && (condition === void 0 || /^\s*Exists\(/i.test(condition))) return m;
	}
}
/**
* The Directory.Build.props or Directory.Build.targets MSBuild imports for a project in `dir`: the nearest
* one up the tree, as far as the repository root, with the one above it in place of its import of it.
*/
async function buildFile(dir, file) {
	for (let at = resolve(dir); at !== homedir(); at = dirname(at)) {
		const entries = await list(at);
		const top = entries.includes(".git") || dirname(at) === at;
		if (entries.includes(file)) {
			const xml = uncommented(await text(at, file) ?? "");
			const parent = parentImport(xml, file);
			if (!parent || top) return xml;
			const outer = await buildFile(dirname(at), file);
			return xml.slice(0, parent.index) + outer + xml.slice(parent.index + parent[0].length);
		}
		if (top) break;
	}
	return "";
}
/**
* Whether a .NET project or solution is published to NuGet. A solution that holds an application
* keeps its plain libraries to itself; only projects that declare package metadata count there. Test
* projects take no side, and projects the solution lists but that are missing are skipped.
*/
async function nugetPackage(dir, file, xml) {
	const kind = async (project, sub) => dotnetProject(project, await buildFile(join(dir, sub), "Directory.Build.props"), await buildFile(join(dir, sub), "Directory.Build.targets"));
	if (!/\.slnx?$/i.test(file)) {
		const own = await kind(xml, ".");
		return own === "package" || own === "library";
	}
	const paths = [...xml.matchAll(/"([^"]+\.(?:cs|fs|vb)proj)"/gi)].map((m) => m[1].replaceAll("\\", "/"));
	const kinds = await Promise.all(paths.map(async (path) => {
		const project = await text(dir, path);
		if (project === void 0) return "none";
		return kind(project, dirname(path));
	}));
	return kinds.includes("package") || kinds.includes("library") && !kinds.includes("app");
}
/** Subdirectories that can hold workspace members: not hidden, not installed dependencies. */
async function subdirs(dir) {
	const found = [];
	for (const e of await list(dir)) {
		if (e.startsWith(".") || e === "node_modules") continue;
		if (await stat(join(dir, e)).then((st) => st.isDirectory(), () => false)) found.push(e);
	}
	return found;
}
/** How deep `**` looks for members, which keeps a large tree from being walked whole. */
const MAX_GLOBSTAR_DEPTH = 4;
/** The directories a workspace pattern such as `packages/*` or `components/**` names. */
async function expand(dir, pattern) {
	let found = [""];
	for (const segment of pattern.replace(/^\.\//, "").split("/").filter(Boolean)) if (segment === "**") {
		const all = [...found];
		let level = found;
		for (let depth = 0; depth < MAX_GLOBSTAR_DEPTH && level.length; depth++) {
			const next = [];
			for (const f of level) for (const e of await subdirs(join(dir, f))) next.push(join(f, e));
			all.push(...next);
			level = next;
		}
		found = all;
	} else if (segment.includes("*")) {
		const match = new RegExp(`^${segment.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll(/\*+/g, "[^/]*")}$`);
		const next = [];
		for (const f of found) for (const e of await subdirs(join(dir, f))) if (match.test(e)) next.push(join(f, e));
		found = next;
	} else found = found.map((f) => join(f, segment));
	return found.map((f) => join(f)).filter((f) => f !== "." && f !== "");
}
/**
* The quoted strings of a TOML array such as `members = [...]`, read past comments and line breaks.
* A `]` or `"` inside a comment does not end it.
*/
function tomlStrings(toml, key) {
	const start = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\[`, "m").exec(toml);
	if (!start) return [];
	const found = [];
	for (let i = start.index + start[0].length; i < toml.length; i++) {
		const c = toml[i];
		if (c === "]") break;
		if (c === "#") {
			const end = toml.indexOf("\n", i);
			i = end < 0 ? toml.length : end;
		} else if (c === "\"" || c === "'") {
			const end = toml.indexOf(c, i + 1);
			if (end < 0) break;
			found.push(toml.slice(i + 1, end));
			i = end;
		}
	}
	return found;
}
/**
* The `packages` globs of a pnpm-workspace.yaml, as a block list (`- "glob"` per line, indented or
* not) or a flow list (`[a, b]`). Undefined when the file has no `packages` key: pnpm 10 keeps its
* settings there in single-package repositories too.
*/
function pnpmPackages(yaml) {
	const lines = yaml.split(/\r?\n/);
	const at = lines.findIndex((l) => /^packages[ \t]*:/.test(l));
	if (at < 0) return void 0;
	const unquote = (item) => item.trim().replace(/^(["'])(.*)\1$/, "$2");
	const rest = lines[at].replace(/^packages[ \t]*:/, "").replace(/#.*$/, "").trim();
	if (rest.startsWith("[")) {
		const flow = [rest, ...lines.slice(at + 1)].join("\n");
		return flow.slice(1, flow.includes("]") ? flow.indexOf("]") : void 0).split(",").map(unquote).filter(Boolean);
	}
	const found = [];
	for (const line of lines.slice(at + 1)) {
		const content = line.replace(/(^|\s)#.*$/, "").trimEnd();
		if (!content.trim()) continue;
		const item = /^[ \t]*-[ \t]*(.*)$/.exec(content);
		if (!item) break;
		found.push(unquote(item[1]));
	}
	return found.filter(Boolean);
}
/** The member directories a JavaScript or Cargo workspace root lists, or undefined when it is none. */
async function workspaceMembers(dir, manifest, cargo) {
	const patterns = [];
	const add = (value) => {
		if (Array.isArray(value)) {
			for (const v of value) if (typeof v === "string") patterns.push(v);
		}
	};
	const { workspaces } = manifest ?? {};
	add(Array.isArray(workspaces) ? workspaces : workspaces?.packages);
	const pnpm = pnpmPackages(await text(dir, "pnpm-workspace.yaml") ?? "");
	add(pnpm);
	const lerna = await json(dir, "lerna.json");
	add(lerna && (Array.isArray(lerna.packages) ? lerna.packages : ["packages/*"]));
	const js = patterns.length > 0;
	const cargoWorkspace = cargo !== void 0 && /^\[workspace\]/m.test(cargo);
	const excluded = cargoWorkspace ? tomlStrings(table(cargo, "workspace"), "exclude") : [];
	if (cargoWorkspace) patterns.push(...tomlStrings(table(cargo, "workspace"), "members"));
	if (!workspaces && !pnpm && !lerna && !cargoWorkspace) return void 0;
	const expanded = async (globs) => (await Promise.all(globs.filter((p) => !p.startsWith("!")).map((p) => expand(dir, p)))).flat();
	const skip = /* @__PURE__ */ new Set([...await expanded(excluded), ...await expanded(patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1)))]);
	return {
		members: [...new Set(await expanded(patterns))].filter((m) => !skip.has(m)),
		js
	};
}
/** Whether a Python manifest depends on an MCP SDK. */
function pythonMcp(py) {
	const lists = [...py.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]\s*$/gm)].map((m) => m[1]);
	const poetry = /^\[tool\.poetry\.dependencies\]([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(py)?.[1] ?? "";
	return lists.some((l) => MCP_REQUIREMENT.test(l)) || /^[ \t]*(?:mcp|fastmcp)[ \t]*=/m.test(poetry) || MCP_REQUIREMENT.test(/install_requires\s*=\s*\[([\s\S]*?)\]/.exec(py)?.[1] ?? "");
}
/**
* Reads the manifests in `dir` (not its subdirectories) and picks the channels the project would be
* published on. GitHub and domains always apply. Returns undefined when no manifest is found.
*/
function detectProject(dir) {
	return detect(dir, 0);
}
/** How deep workspaces nest: a root, and a member that is itself a workspace of packages. */
const MAX_WORKSPACE_DEPTH = 2;
async function detect(dir, depth) {
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	const has = (name) => entries.includes(name);
	const only = /* @__PURE__ */ new Set();
	const from = [];
	const pick = (file, ...ids) => {
		for (const id of ids) only.add(id);
		if (!from.includes(file)) from.push(file);
	};
	const manifest = has("package.json") ? await json(dir, "package.json") ?? {} : void 0;
	const cargo = has("Cargo.toml") ? await text(dir, "Cargo.toml") : void 0;
	const workspace = depth < MAX_WORKSPACE_DEPTH ? await workspaceMembers(dir, manifest, cargo) : void 0;
	let rootPublishes = false;
	if (manifest) {
		const pkg = await text(dir, "package.json") ?? "";
		const named = typeof manifest.name === "string" || !parses(pkg);
		const publishes = [
			"files",
			"exports",
			"publishConfig",
			"bin",
			"types",
			"typings",
			"module"
		].some((key) => key in manifest);
		const scripts = manifest.scripts && typeof manifest.scripts === "object" ? Object.keys(manifest.scripts) : [];
		const runs = !publishes && scripts.some((s) => /^(?:start|serve|deploy)(?::|$)/.test(s));
		rootPublishes = !manifest.engines?.vscode && !runs;
		pick("package.json");
		if (manifest.engines?.vscode) pick("package.json", "vscode", "open-vsx");
		else if (named && manifest.private !== true && !runs) pick("package.json", "npm");
		if (manifest.bin && named) pick("package.json", "homebrew");
		if (MCP_PACKAGES.test(pkg)) pick("package.json", "mcp-registry", "smithery");
	}
	if (has("Pipfile")) pick("Pipfile");
	for (const file of [
		"pyproject.toml",
		"setup.py",
		"setup.cfg"
	]) {
		const py = has(file) ? await text(dir, file) : void 0;
		if (py === void 0) continue;
		pick(file);
		if (!pythonPackage(file, py)) continue;
		pick(file, "pypi");
		if (/^\[(?:project\.scripts|tool\.poetry\.scripts)\]|console_scripts/m.test(py)) pick(file, "homebrew");
		if (pythonMcp(py)) pick(file, "mcp-registry", "smithery");
	}
	if (cargo !== void 0) {
		pick("Cargo.toml");
		if ((/^\[package\]/m.test(cargo) || !/^\[workspace\]/m.test(cargo)) && !/^[ \t]*publish[ \t]*=[ \t]*(?:false|\[\s*\])/m.test(cargo)) pick("Cargo.toml", "crates");
		if (/^\[\[bin\]\]/m.test(cargo) || await text(dir, "src/main.rs") !== void 0 || (await list(join(dir, "src/bin"))).length > 0) pick("Cargo.toml", "homebrew");
	}
	const gemspec = entries.find((e) => e.endsWith(".gemspec"));
	if (gemspec) {
		pick(gemspec, "rubygems");
		if (has("exe")) pick(gemspec, "homebrew");
	} else if (has("Gemfile")) pick("Gemfile");
	if (has("go.mod")) {
		pick("go.mod");
		const main = await text(dir, "main.go");
		if (main !== void 0 && /^package main\b/m.test(main) || has("cmd")) pick("go.mod", "homebrew");
	}
	const swift = has("Package.swift") ? await text(dir, "Package.swift") : void 0;
	if (swift !== void 0) {
		pick("Package.swift");
		if (/\.executable(?:Target)?\s*\(/.test(swift)) pick("Package.swift", "homebrew");
	}
	const composer = await json(dir, "composer.json");
	if (composer !== void 0) {
		pick("composer.json");
		if (composer.type !== "project") pick("composer.json", "packagist");
	}
	const pubspec = has("pubspec.yaml") ? await text(dir, "pubspec.yaml") : void 0;
	if (pubspec !== void 0) {
		pick("pubspec.yaml");
		if (!/^publish_to:\s*["']?none/m.test(pubspec)) pick("pubspec.yaml", "pub");
		else if (/^[ \t]+sdk:[ \t]*flutter/m.test(pubspec)) pick("pubspec.yaml", "app-store", "google-play");
	}
	const dotnet = entries.find((e) => /\.(?:(?:cs|fs|vb)proj|slnx?)$/i.test(e));
	if (dotnet) {
		pick(dotnet);
		if (await nugetPackage(dir, dotnet, await text(dir, dotnet) ?? "")) pick(dotnet, "nuget");
	}
	const container = entries.find((e) => /^(?:Dockerfile|Containerfile)(?:\..+)?$|\.Dockerfile$/i.test(e));
	if (container) pick(container, "docker");
	if (has(".claude-plugin")) pick(".claude-plugin", "claude-plugins");
	if (has(".cursor-plugin")) pick(".cursor-plugin", "cursor");
	const descriptor = "src/main/resources/META-INF/plugin.xml";
	const gradle = ["build.gradle.kts", "build.gradle"].find((f) => has(f));
	if (await text(dir, descriptor) !== void 0) pick(descriptor, "jetbrains");
	else if (gradle && /org\.jetbrains\.intellij/.test(await text(dir, gradle) ?? "")) pick(gradle, "jetbrains");
	if (has("gemini-extension.json")) pick("gemini-extension.json", "gemini");
	const xcodeIn = async (sub) => (await list(join(dir, sub))).find((e) => /\.(?:xcodeproj|xcworkspace)$/.test(e));
	const xcode = await xcodeIn(".") ?? await xcodeIn("ios");
	if (xcode) pick(xcode, "app-store");
	for (const manifest of [
		"AndroidManifest.xml",
		"app/src/main/AndroidManifest.xml",
		"android/app/src/main/AndroidManifest.xml"
	]) if (await text(dir, manifest) !== void 0) {
		pick(manifest, "google-play");
		break;
	}
	if ((await json(dir, "app.json"))?.expo) pick("app.json", "app-store", "google-play");
	const expoConfig = entries.find((e) => /^app\.config\.(?:js|ts|mjs|cjs)$/.test(e));
	if (expoConfig && /"expo"\s*:/.test(await text(dir, "package.json") ?? "")) pick(expoConfig, "app-store", "google-play");
	let projects = 0;
	for (const member of workspace?.members ?? []) {
		const found = await detect(join(dir, member), depth + 1);
		if (found) projects++;
		const ids = found?.only.filter((id) => id !== "github" && id !== "domain") ?? [];
		if (!ids.length) continue;
		for (const id of ids) only.add(id);
		for (const file of found.from) if (!from.includes(join(member, file))) from.push(join(member, file));
	}
	if (workspace?.js && !projects && rootPublishes) pick("package.json", "npm");
	if (!from.length) return void 0;
	return {
		only: [
			...only,
			"github",
			"domain"
		],
		from
	};
}
/**
* Detects the project `start` is in: the directory itself, or the nearest parent with manifests, up to
* the repository root (a directory with `.git`) or the home directory. Files are named relative to `start`.
*/
async function findProject(start, home) {
	for (let dir = resolve(start);; dir = dirname(dir)) {
		if (home && dir === resolve(home)) return void 0;
		const found = await detectProject(dir);
		if (found) return {
			...found,
			from: found.from.map((f) => relative(start, join(dir, f)) || f)
		};
		if ((await list(dir)).includes(".git") || dir === home || dirname(dir) === dir) return void 0;
	}
}
/** The OS cache directory: ~/Library/Caches on macOS, XDG on Linux, LOCALAPPDATA on Windows. */
function defaultCacheDir(env = process.env, platform = process.platform, home = homedir()) {
	if (env.NAMEABLE_CACHE_DIR) return env.NAMEABLE_CACHE_DIR;
	const path = platform === "win32" ? win32 : posix;
	const base = (value) => value && path.isAbsolute(value) ? value : void 0;
	if (platform === "darwin") return path.join(home, "Library", "Caches", "nameable");
	if (platform === "win32") return path.join(base(env.LOCALAPPDATA) ?? path.join(home, "AppData", "Local"), "nameable", "Cache");
	return path.join(base(env.XDG_CACHE_HOME) ?? path.join(home, ".cache"), "nameable");
}
/** Gzipped files in `dir`, one per key; a file's modification time is when it was saved. */
function fileStore(dir) {
	const path = (key) => join(dir, `${key}.gz`);
	return {
		async read(key) {
			try {
				const [data, info] = await Promise.all([readFile(path(key)), stat(path(key))]);
				return {
					text: gunzipSync(data).toString("utf8"),
					savedAt: info.mtimeMs
				};
			} catch {
				return;
			}
		},
		async write(key, text) {
			await mkdir(dir, { recursive: true });
			const partial = `${path(key)}.${process.pid}.${randomUUID()}.partial`;
			await writeFile(partial, gzipSync(text));
			await rename(partial, path(key));
		}
	};
}
/** Deletes the lists this tool saves in `dir`, and `dir` itself only when nothing else is left in it. */
async function clearStore(dir) {
	const partials = (await readdir(dir).catch(() => [])).filter((f) => LIST_KEYS.some((key) => f.startsWith(`${key}.gz.`) && f.endsWith(".partial")));
	await Promise.all([...LIST_KEYS.map((key) => rm(join(dir, `${key}.gz`), { force: true })), ...partials.map((f) => rm(join(dir, f), { force: true }))]);
	await rmdir(dir).catch(() => void 0);
}
//#endregion
export { clearStore as a, findProject as c, checkMany as i, selectChannels as l, GENERAL_CHANNELS as n, defaultCacheDir as o, channelIds as r, fileStore as s, DEFAULT_TLDS as t };
