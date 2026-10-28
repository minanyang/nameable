#!/usr/bin/env node
import { a as clearStore, c as findProject, i as checkMany, l as selectChannels, n as GENERAL_CHANNELS, o as defaultCacheDir, r as channelIds, s as fileStore, t as DEFAULT_TLDS } from "./dist-CRL9h0G_.mjs";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { parseArgs, promisify, styleText } from "node:util";
import { homedir } from "node:os";
//#region src/render.ts
const LOOK = {
	available: {
		mark: "✓",
		style: "green"
	},
	reclaimable: {
		mark: "↺",
		style: "cyan"
	},
	taken: {
		mark: "✗",
		style: "red"
	},
	unavailable: {
		mark: "⊘",
		style: "red"
	},
	unknown: {
		mark: "?",
		style: "yellow"
	}
};
const ORDER = [
	"available",
	"reclaimable",
	"taken",
	"unavailable",
	"unknown"
];
const STATUS_WIDTH = 18;
const probable = (r) => r.status === "available" && r.certainty === "probable";
const free = (r) => r.status === "available" || r.status === "reclaimable";
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]|\p{Extended_Pictographic}/u;
const segmenter = new Intl.Segmenter();
const graphemes = (text) => Array.from(segmenter.segment(text), (s) => s.segment);
const graphemeWidth = (g) => WIDE.test(g) ? 2 : /^\p{M}+$/u.test(g) ? 0 : 1;
const displayWidth = (text) => graphemes(text).reduce((sum, g) => sum + graphemeWidth(g), 0);
/**
* Text from registries (descriptions, names) with control characters replaced by spaces, so it cannot
* move the cursor, rewrite a row or break the in-place redraw with a newline.
*/
const printable = (text) => text.replace(/[\p{Cc}\p{Bidi_Control}]+/gu, " ");
const pad = (text, width) => text + " ".repeat(Math.max(0, width - displayWidth(text)));
const labelWidth = (channels) => Math.max(...channels.map((c) => displayWidth(c.label)));
function clip(text, max) {
	if (max <= 0) return "";
	if (displayWidth(text) <= max) return text;
	let out = "";
	let used = 0;
	for (const g of graphemes(text)) {
		if (used + graphemeWidth(g) > max - 1) break;
		out += g;
		used += graphemeWidth(g);
	}
	return `${out}…`;
}
function createRenderer(out, color) {
	const paint = (style, text) => color ? styleText(style, text, { validateStream: false }) : text;
	const columns = () => out.columns || 80;
	const cellWidth = (channels, names) => Math.max(4, Math.min(Math.max(...names.map(displayWidth)), columns() - labelWidth(channels) - 6)) + 2;
	/**
	* Prints `rows` once and returns a function that rewrites the whole block in place after each of
	* `updates` changes. Rows must never wrap. A block taller than the terminal cannot be rewritten (the
	* cursor stops at the top of the screen), so it is printed once, after the last change.
	*/
	function block(rows, updates, fits) {
		const draw = (redraw) => out.write(`${redraw ? `\x1b[${rows.length}A` : ""}${rows.map((r) => `\r\x1b[2K${r}\n`).join("")}`);
		const live = fits && (!out.rows || rows.length < out.rows);
		if (live) draw(false);
		let done = 0;
		return (changed = true) => {
			done++;
			if (live && changed) draw(true);
			else if (!live && done === updates) draw(false);
		};
	}
	/** One row, clipped to the terminal so it never wraps. */
	function line(result, width) {
		const look = LOOK[result.status];
		const status = probable(result) ? "probably available" : result.status;
		const detail = printable(result.note ?? "");
		const used = 4 + width + 1 + STATUS_WIDTH + 1;
		return `  ${paint(look.style, look.mark)} ${pad(result.label, width)} ${paint(look.style, status.padEnd(STATUS_WIDTH))} ${paint("dim", clip(detail, columns() - used - 1))}`;
	}
	/** One name: a row per channel with its status and evidence, in a stable order. */
	function liveTable(channels) {
		const width = labelWidth(channels);
		const rows = channels.map((c) => `  ${paint("dim", "·")} ${pad(c.label, width)} ${paint("dim", "checking…")}`);
		const used = 4 + width + 1 + STATUS_WIDTH + 1;
		const redraw = block(rows, channels.length, used < columns());
		return (_name, result) => {
			rows[channels.findIndex((c) => c.id === result.channel)] = line(result, width);
			redraw();
		};
	}
	/** How many names fit across the terminal in the grid. */
	function gridFits(channels, names) {
		return Math.max(1, Math.floor((columns() - labelWidth(channels) - 4) / cellWidth(channels, names)));
	}
	/** Several names: channels down, names across, one mark per cell. */
	function liveGrid(channels, names) {
		const width = labelWidth(channels);
		const cell = cellWidth(channels, names);
		const shown = names.slice(0, gridFits(channels, names));
		const cells = channels.map(() => shown.map(() => ({
			text: paint("dim", "·"),
			plain: 1
		})));
		const row = (i) => `  ${pad(channels[i].label, width)}  ${cells[i].map((c) => c.text + " ".repeat(cell - c.plain)).join("")}`;
		const rows = [`  ${" ".repeat(width)}  ${shown.map((n) => pad(clip(printable(n), cell - 2), cell)).join("")}`, ...channels.map((_, i) => row(i))];
		const redraw = block(rows, channels.length * names.length, 2 + width + 2 + cell * shown.length < columns());
		return (name, result) => {
			const col = shown.indexOf(name);
			const i = channels.findIndex((c) => c.id === result.channel);
			if (col < 0 || i < 0) return redraw(false);
			const look = LOOK[result.status];
			const mark = `${look.mark}${probable(result) ? "*" : ""}`;
			cells[i][col] = {
				text: paint(look.style, mark),
				plain: mark.length
			};
			rows[i + 1] = row(i);
			redraw();
		};
	}
	function gridFooter(reports, channels) {
		const names = reports.map((r) => r.name);
		const shown = gridFits(channels, names);
		const cell = cellWidth(channels, names);
		const counts = reports.slice(0, shown).map((r) => `${r.results.filter(free).length}/${r.results.length} `.padEnd(cell)).join("");
		const legend = ORDER.map((s) => `${paint(LOOK[s].style, LOOK[s].mark)} ${s}`).join("  ");
		const hidden = reports.length - shown;
		return [
			`  ${"free".padEnd(labelWidth(channels))}  ${counts}`,
			"",
			`  ${legend}  ${paint("dim", "* probably available")}`,
			...hidden > 0 ? [`  ${paint("yellow", `${hidden} more did not fit; use --json`)}`] : [],
			`  ${paint("dim", "Check one name at a time for the details behind each mark.")}`
		].join("\n");
	}
	/** Full, unclipped links for every channel that is not free, printed once the table is final. */
	function evidence(results) {
		const linked = results.filter((r) => !free(r) && r.url);
		if (!linked.length) return "";
		const width = Math.max(...linked.map((r) => displayWidth(r.label)));
		return `\n${linked.map((r) => `  ${pad(r.label, width)}  ${paint("dim", printable(r.url))}`).join("\n")}\n`;
	}
	function summary(results) {
		const counts = /* @__PURE__ */ new Map();
		for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
		const maybe = results.filter(probable).length;
		return ORDER.filter((s) => counts.has(s)).map((s) => paint(LOOK[s].style, `${counts.get(s)} ${s}${s === "available" && maybe ? ` (${maybe} probably)` : ""}`)).join(paint("dim", " · "));
	}
	return {
		liveTable,
		liveGrid,
		gridFooter,
		evidence,
		summary
	};
}
//#endregion
//#region src/run.ts
const { version } = createRequire(import.meta.url)("../package.json");
/** Wraps a comma-separated list onto lines of `width`, continued under the help's option column. */
function wrap(list, width) {
	const lines = [""];
	for (const item of list.split(" ")) {
		const last = lines.length - 1;
		if (lines[last] && lines[last].length + item.length + 1 > width) lines.push(item);
		else lines[last] = lines[last] ? `${lines[last]} ${item}` : item;
	}
	return lines.join(`\n${" ".repeat(18)}`);
}
const HELP = `nameable ${version}
Find out if a name is free everywhere it matters for your project.

Usage
  nameable <name>... [options]
  nameable check <name>... [options]
  nameable mcp

  One name shows each channel with its evidence; several names show a comparison grid.
  \`mcp\` serves the same checks to AI agents as an MCP server over stdio.

  Channels are picked from the project files in the current directory, or its parents up to the
  repository root: package.json, pyproject.toml, setup.py, Cargo.toml, a .gemspec, composer.json,
  pubspec.yaml, a .NET project or solution, Package.swift, a Dockerfile, .claude-plugin, .cursor-plugin,
  gemini-extension.json, a VS Code extension, a JetBrains plugin, an MCP SDK dependency, and an
  Xcode, Android, Expo or Flutter app; at a workspace root, those of its members too. Private apps,
  servers and unpublished packages skip their registry.
  Outside a project, a general set is checked.

Options
  --only <ids>    Comma-separated channels:
                  ${wrap(channelIds().join(", "), 82)}
  --all           Check every channel
  --tlds <list>   Domains to check, at most 20 (default: ${DEFAULT_TLDS.join(",")}); with --only,
                  include domain
  --json          Print JSON (default when stdout is not a terminal)
  --refresh       Download the registry name lists even if the cached copy is fresh
  --clear-cache   Delete the cached name lists and exit
  -h, --help      Show this help
  -v, --version   Show the version

Exit codes
  0  every channel is available or reclaimable for every name
  1  taken or unavailable somewhere
  2  nothing taken, but some channels could not be checked (or the cache could not be cleared)
  64 usage error

GitHub checks use GITHUB_TOKEN, GH_TOKEN or \`gh auth token\` when available.
Several checks download registry-wide name lists (about 25 MB in all) at most once a day and keep
them in the cache directory (NAMEABLE_CACHE_DIR to change it).
`;
var UsageError = class extends Error {};
function exitCode(reports) {
	const results = reports.flatMap((r) => r.results);
	if (results.some((r) => r.status === "taken" || r.status === "unavailable")) return 1;
	if (results.some((r) => r.status === "unknown")) return 2;
	return 0;
}
const split = (s) => s?.split(",").map((x) => x.trim()).filter(Boolean);
function parse(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				only: { type: "string" },
				all: { type: "boolean" },
				tlds: { type: "string" },
				json: { type: "boolean" },
				refresh: { type: "boolean" },
				"clear-cache": { type: "boolean" },
				help: {
					type: "boolean",
					short: "h"
				},
				version: {
					type: "boolean",
					short: "v"
				}
			}
		});
	} catch (err) {
		const { code, message } = err;
		const option = /'(?:-\w, )?(-[^' ]*)/.exec(message)?.[1];
		if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && option) throw new UsageError(`unknown option ${option}`);
		if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && option) throw new UsageError(message.includes("does not take") ? `${option} takes no value` : `${option} needs a value`);
		throw new UsageError(message);
	}
	const { values, positionals } = parsed;
	const names = positionals[0] === "check" && positionals.length > 1 ? positionals.slice(1) : positionals;
	const mcp = positionals.length === 1 && positionals[0] === "mcp";
	return {
		values,
		names: [...new Set(names)],
		mcp
	};
}
async function run(argv, io) {
	let values;
	let names;
	let mcp;
	let channels;
	let picked;
	try {
		({values, names, mcp} = parse(argv));
		if (values.help) return io.stdout.write(HELP), 0;
		if (values.version) return io.stdout.write(`${version}\n`), 0;
		if (mcp) {
			if (Object.values(values).some((v) => v !== void 0)) throw new UsageError("`mcp` takes no options; the agent chooses them in each call");
			const { serveMcp } = await import("./mcp-IO8vjLAT.mjs");
			const { githubToken, fetch, whois, cacheDir, mcpTransport } = io;
			serveMcp({
				version,
				githubToken,
				fetch,
				whois,
				cacheDir
			}, mcpTransport);
			return 0;
		}
		if (values["clear-cache"]) {
			if (names.length || [
				values.only,
				values.all,
				values.tlds,
				values.refresh
			].some((v) => v !== void 0)) throw new UsageError("--clear-cache takes no names or other options");
			if (io.cacheDir) try {
				await clearStore(io.cacheDir);
			} catch (err) {
				const message = `could not clear ${io.cacheDir}: ${err.message}`;
				io.stderr.write(`nameable: ${message}\n`);
				if (values.json) io.stdout.write(`${JSON.stringify({
					cleared: null,
					error: message
				})}\n`);
				return 2;
			}
			if (values.json) {
				io.stdout.write(`${JSON.stringify({ cleared: io.cacheDir ?? null })}\n`);
				return 0;
			}
			return io.stdout.write(`Cleared ${io.cacheDir ?? "nothing (no cache directory)"}\n`), 0;
		}
		if (!names.length) throw new UsageError("missing <name>");
		if (names.some((n) => !n.trim())) throw new UsageError("names cannot be empty");
		for (const flag of ["only", "tlds"]) if (values[flag] !== void 0 && !split(values[flag])?.length) throw new UsageError(`--${flag} needs at least one value`);
		if (values.only !== void 0 && values.all) throw new UsageError("--only and --all cannot be combined");
		let only = split(values.only);
		if (!only && !values.all) {
			const detected = io.cwd ? await findProject(io.cwd, homedir()) : void 0;
			only = detected?.only ?? GENERAL_CHANNELS;
			picked = detected ? `picked from ${detected.from.length > 3 ? `${detected.from.slice(0, 3).join(", ")} and ${detected.from.length - 3} more` : detected.from.join(", ")}` : "no project files found: general set";
		}
		try {
			channels = selectChannels({
				only,
				tlds: split(values.tlds)
			});
		} catch (err) {
			const message = err.message;
			throw new UsageError(message.startsWith("TLDs apply to domains") ? "--tlds needs domain in --only (e.g. --only npm,domain)" : message);
		}
	} catch (err) {
		if (!(err instanceof UsageError)) throw err;
		io.stderr.write(`nameable: ${err.message}\nRun \`nameable --help\` for usage.\n`);
		return 64;
	}
	const json = values.json || !io.interactive;
	const render = createRenderer(io.stdout, io.color);
	const single = names.length === 1;
	if (!json) {
		const what = single ? `"${printable(names[0])}"` : `${names.length} names`;
		const how = picked ? ` (${picked}; --all for every channel)` : "";
		io.stdout.write(`\nChecking ${what} on ${channels.length} channels${how}\n\n`);
	}
	const reports = await checkMany(names, channels, {
		fetch: io.fetch,
		whois: io.whois,
		githubToken: channels.some((c) => c.id === "github") ? await io.githubToken?.() : void 0,
		store: io.cacheDir ? fileStore(io.cacheDir) : void 0,
		refresh: values.refresh,
		onResult: json ? void 0 : single ? render.liveTable(channels) : render.liveGrid(channels, names)
	});
	if (json) io.stdout.write(`${JSON.stringify({
		schema: 1,
		reports
	}, null, 2)}\n`);
	else if (single) io.stdout.write(`${render.evidence(reports[0].results)}\n  ${render.summary(reports[0].results)}\n\n`);
	else io.stdout.write(`${render.gridFooter(reports, channels)}\n\n`);
	return exitCode(reports);
}
//#endregion
//#region src/cli.ts
/** Token for the GitHub API's higher rate limit; checks still run without one. */
async function githubToken() {
	const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (env) return env;
	try {
		const { stdout } = await promisify(execFile)("gh", ["auth", "token"], { timeout: 3e3 });
		return stdout.trim() || void 0;
	} catch {
		return;
	}
}
process.stdout.on("error", (err) => {
	if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
	throw err;
});
process.exitCode = await run(process.argv.slice(2), {
	stdout: process.stdout,
	stderr: process.stderr,
	interactive: process.stdout.isTTY === true,
	color: process.stdout.isTTY === true && process.stdout.hasColors(),
	githubToken,
	cacheDir: defaultCacheDir(),
	cwd: process.cwd()
});
//#endregion
export {};
