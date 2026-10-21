import { styleText } from "node:util";
import type { Channel, CheckResult, Report, Status } from "@nameable/core";

type Style = Parameters<typeof styleText>[0];

export type Output = { write(text: string): unknown; columns?: number };

const LOOK: Record<Status, { mark: string; style: Style }> = {
  available: { mark: "✓", style: "green" },
  reclaimable: { mark: "↺", style: "cyan" },
  taken: { mark: "✗", style: "red" },
  unavailable: { mark: "⊘", style: "red" },
  unknown: { mark: "?", style: "yellow" },
};
const ORDER: Status[] = ["available", "reclaimable", "taken", "unavailable", "unknown"];
const STATUS_WIDTH = 18;

const probable = (r: CheckResult) => r.status === "available" && r.certainty === "probable";
const free = (r: CheckResult) => r.status === "available" || r.status === "reclaimable";
// Terminal columns, not string length: East Asian wide characters and emoji take two columns,
// combining marks none. Close to wcwidth for the text this tool prints (names, labels, notes).
const WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]|\p{Extended_Pictographic}/u;
const segmenter = new Intl.Segmenter();
const graphemes = (text: string) => Array.from(segmenter.segment(text), (s) => s.segment);
const graphemeWidth = (g: string) => (WIDE.test(g) ? 2 : /^\p{M}+$/u.test(g) ? 0 : 1);
export const displayWidth = (text: string): number =>
  graphemes(text).reduce((sum, g) => sum + graphemeWidth(g), 0);
const pad = (text: string, width: number) =>
  text + " ".repeat(Math.max(0, width - displayWidth(text)));

const labelWidth = (channels: Channel[]) => Math.max(...channels.map((c) => displayWidth(c.label)));
const cellWidth = (names: string[]) => Math.max(...names.map(displayWidth), 4) + 2;

function clip(text: string, max: number): string {
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

export function createRenderer(out: Output, color: boolean) {
  const paint = (style: Style, text: string) =>
    color ? styleText(style, text, { validateStream: false }) : text;
  const columns = () => out.columns || 80;

  /** Prints `rows` once and returns a function that rewrites the whole block in place. Rows must never wrap. */
  function block(rows: string[]) {
    const draw = (redraw: boolean) =>
      out.write(
        `${redraw ? `\x1b[${rows.length}A` : ""}${rows.map((r) => `\r\x1b[2K${r}\n`).join("")}`,
      );
    draw(false);
    return () => draw(true);
  }

  /** One row, clipped to the terminal so it never wraps. */
  function line(result: CheckResult, width: number): string {
    const look = LOOK[result.status];
    const status = probable(result) ? "probably available" : result.status;
    // Links are listed in full under the table (see `evidence`), so the row keeps its room for the note.
    const detail = result.note ?? "";
    const used = 2 + 1 + 1 + width + 1 + STATUS_WIDTH + 1;
    return `  ${paint(look.style, look.mark)} ${pad(result.label, width)} ${paint(look.style, status.padEnd(STATUS_WIDTH))} ${paint("dim", clip(detail, columns() - used - 1))}`;
  }

  /** One name: a row per channel with its status and evidence, in a stable order. */
  function liveTable(channels: Channel[]) {
    const width = labelWidth(channels);
    const rows = channels.map(
      (c) => `  ${paint("dim", "·")} ${pad(c.label, width)} ${paint("dim", "checking…")}`,
    );
    const redraw = block(rows);
    return (_name: string, result: CheckResult) => {
      rows[channels.findIndex((c) => c.id === result.channel)] = line(result, width);
      redraw();
    };
  }

  /** How many names fit across the terminal in the grid. */
  function gridFits(channels: Channel[], names: string[]): number {
    return Math.max(1, Math.floor((columns() - labelWidth(channels) - 4) / cellWidth(names)));
  }

  /** Several names: channels down, names across, one mark per cell. */
  function liveGrid(channels: Channel[], names: string[]) {
    const width = labelWidth(channels);
    const cell = cellWidth(names);
    const shown = names.slice(0, gridFits(channels, names));
    // `plain` is the visible width, since color codes take no space on screen.
    const cells = channels.map(() => shown.map(() => ({ text: paint("dim", "·"), plain: 1 })));
    const row = (i: number) =>
      `  ${pad(channels[i]!.label, width)}  ${cells[i]!.map((c) => c.text + " ".repeat(cell - c.plain)).join("")}`;
    const rows = [
      `  ${" ".repeat(width)}  ${shown.map((n) => pad(n, cell)).join("")}`,
      ...channels.map((_, i) => row(i)),
    ];
    const redraw = block(rows);
    return (name: string, result: CheckResult) => {
      const col = shown.indexOf(name);
      const i = channels.findIndex((c) => c.id === result.channel);
      if (col < 0 || i < 0) return;
      const look = LOOK[result.status];
      const mark = `${look.mark}${probable(result) ? "*" : ""}`;
      cells[i]![col] = { text: paint(look.style, mark), plain: mark.length };
      rows[i + 1] = row(i);
      redraw();
    };
  }

  function gridFooter(reports: Report[], channels: Channel[]): string {
    const names = reports.map((r) => r.name);
    const shown = gridFits(channels, names);
    const cell = cellWidth(names);
    const counts = reports
      .slice(0, shown)
      .map((r) => `${r.results.filter(free).length}/${r.results.length}`.padEnd(cell))
      .join("");
    const legend = ORDER.map((s) => `${paint(LOOK[s].style, LOOK[s].mark)} ${s}`).join("  ");
    const hidden = reports.length - shown;
    return [
      `  ${"free".padEnd(labelWidth(channels))}  ${counts}`,
      "",
      `  ${legend}  ${paint("dim", "* probably")}`,
      ...(hidden > 0 ? [`  ${paint("yellow", `${hidden} more did not fit; use --json`)}`] : []),
      `  ${paint("dim", "Check one name at a time for the details behind each mark.")}`,
    ].join("\n");
  }

  /** Full, unclipped links for every channel that is not free, printed once the table is final. */
  function evidence(results: CheckResult[]): string {
    const linked = results.filter((r) => !free(r) && r.url);
    if (!linked.length) return "";
    const width = Math.max(...linked.map((r) => displayWidth(r.label)));
    return `\n${linked.map((r) => `  ${pad(r.label, width)}  ${paint("dim", r.url!)}`).join("\n")}\n`;
  }

  function summary(results: CheckResult[]): string {
    const counts = new Map<Status, number>();
    for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return ORDER.filter((s) => counts.has(s))
      .map((s) => paint(LOOK[s].style, `${counts.get(s)} ${s}`))
      .join(paint("dim", " · "));
  }

  return { liveTable, liveGrid, gridFooter, evidence, summary };
}
