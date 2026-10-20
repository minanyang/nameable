import { styleText } from "node:util";
import type { Channel, CheckResult, Status } from "@nameable/core";

type Style = Parameters<typeof styleText>[0];

const LOOK: Record<Status, { mark: string; style: Style }> = {
  available: { mark: "✓", style: "green" },
  reclaimable: { mark: "↺", style: "cyan" },
  taken: { mark: "✗", style: "red" },
  unavailable: { mark: "⊘", style: "red" },
  unknown: { mark: "?", style: "yellow" },
};

const paint = (style: Style, text: string) => styleText(style, text, { stream: process.stdout });

const STATUS_WIDTH = 18;

function clip(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** One row, clipped to `columns` so it never wraps (a wrapped row would break the live redraw). */
export function line(result: CheckResult, width: number, columns = Infinity): string {
  const look = LOOK[result.status];
  const status = result.status === "available" && result.certainty === "probable" ? "probably available" : result.status;
  const detail = [result.note, result.status === "taken" ? result.url : undefined].filter(Boolean).join(" · ");
  const used = 2 + 1 + 1 + width + 1 + STATUS_WIDTH + 1;
  return `  ${paint(look.style, look.mark)} ${result.label.padEnd(width)} ${paint(look.style, status.padEnd(STATUS_WIDTH))} ${paint("dim", clip(detail, columns - used - 1))}`;
}

/**
 * Draws one row per channel and redraws the whole block as results arrive,
 * so rows keep a stable order while the slowest channel is still running.
 */
export function liveTable(channels: Channel[]) {
  const width = Math.max(...channels.map((c) => c.label.length));
  const out = process.stdout;
  const rows = channels.map((c) => `  ${paint("dim", "·")} ${c.label.padEnd(width)} ${paint("dim", "checking…")}`);
  const draw = (redraw: boolean) => {
    out.write(`${redraw ? `\x1b[${rows.length}A` : ""}${rows.map((r) => `\r\x1b[2K${r}\n`).join("")}`);
  };
  draw(false);
  return (result: CheckResult) => {
    rows[channels.findIndex((c) => c.id === result.channel)] = line(result, width, out.columns || 80);
    draw(true);
  };
}

export function summary(results: CheckResult[]): string {
  const counts = new Map<Status, number>();
  for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const order: Status[] = ["available", "reclaimable", "taken", "unavailable", "unknown"];
  return order
    .filter((s) => counts.has(s))
    .map((s) => paint(LOOK[s].style, `${counts.get(s)} ${s}`))
    .join(paint("dim", " · "));
}
