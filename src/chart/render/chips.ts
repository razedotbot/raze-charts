// Axis chips: last-value chips on the value axis (SVG and Canvas share one
// placement pass) and the crosshair chip labels shown by mounted charts.

import type { CompiledChart } from "../compile/types";
import { chartColorWithOpacity, readableTextColor } from "../theme";
import type { PointerTarget } from "./pointer";
import { formatSceneX, formatSceneY } from "./pointer";
import { esc, hair, traceRoundRect } from "./primitives";

export const CHIP_HEIGHT = 15;
/** Vertical distance between stacked chips: the chip plus a 1px gap. */
const CHIP_PITCH = CHIP_HEIGHT + 1;

/** Width of the value-axis gutter right of the plot. */
export function valueAxisWidth(c: CompiledChart): number {
  return Math.max(44, c.width - c.plot.x - c.plot.w);
}

/** Summary chip standing in for last-value chips that do not fit. */
export interface ChipOverflow {
  top: number;
  /** Number of series whose chips were dropped. */
  count: number;
  label: string;
}

export interface LastValueChipLayout {
  /** Top edge of each chip in `c.lastValues` order; null when the chip was dropped. */
  tops: (number | null)[];
  overflow: ChipOverflow | null;
}

/**
 * Place last-value chips on the value axis without overlaps. Chips start
 * centred on their value and clamped to the plot, then a forward pass pushes
 * colliding chips down and a backward pass bumps the stack up from the plot
 * bottom. When more chips exist than fit, the first series keep theirs and
 * the rest collapse into one `…+N` chip placed near the dropped values; when
 * only one chip fits, that chip is the summary. O(n log n), and it always
 * terminates.
 */
export function layoutLastValueChips(c: CompiledChart): LastValueChipLayout {
  const { plot } = c;
  const count = c.lastValues.length;
  const tops: (number | null)[] = new Array<number | null>(count).fill(null);
  if (!count) return { tops, overflow: null };
  const minTop = plot.y;
  const maxTop = Math.max(minTop, plot.y + plot.h - CHIP_HEIGHT);
  const capacity = Math.max(1, Math.floor((maxTop - minTop) / CHIP_PITCH) + 1);
  const wanted = c.lastValues.map((value) => {
    const top = value.y - CHIP_HEIGHT / 2;
    return Number.isFinite(top) ? Math.max(minTop, Math.min(maxTop, top)) : maxTop;
  });

  // Keep every chip when they fit; otherwise the leading series plus a summary.
  const keep = count <= capacity ? count : capacity - 1;
  const dropped = count - keep;
  const items: { key: number; want: number }[] = [];
  for (let i = 0; i < keep; i++) items.push({ key: i, want: wanted[i]! });
  if (dropped > 0) {
    let sum = 0;
    for (let i = keep; i < count; i++) sum += wanted[i]!;
    items.push({ key: -1, want: sum / dropped });
  }
  items.sort((a, b) => a.want - b.want || a.key - b.key);

  const placed = items.map((item) => item.want);
  for (let i = 1; i < placed.length; i++) placed[i] = Math.max(placed[i]!, placed[i - 1]! + CHIP_PITCH);
  placed[placed.length - 1] = Math.min(placed[placed.length - 1]!, maxTop);
  for (let i = placed.length - 2; i >= 0; i--) placed[i] = Math.min(placed[i]!, placed[i + 1]! - CHIP_PITCH);
  placed[0] = Math.max(placed[0]!, minTop);
  for (let i = 1; i < placed.length; i++) placed[i] = Math.max(placed[i]!, placed[i - 1]! + CHIP_PITCH);

  let overflow: ChipOverflow | null = null;
  items.forEach((item, index) => {
    if (item.key >= 0) tops[item.key] = placed[index]!;
    else overflow = { top: placed[index]!, count: dropped, label: `…+${dropped}` };
  });
  return { tops, overflow };
}

function chipSvg(
  x: number, y: number, w: number, h: number,
  bg: string, fg: string, label: string, anchor: "end" | "start",
): string {
  const tx = anchor === "end" ? x + w - 6 : x + 6;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2.5" fill="${esc(bg)}" /><text x="${tx}" y="${y + h / 2 + 0.5}" text-anchor="${anchor}" dominant-baseline="middle" font-size="10" font-weight="600" fill="${esc(fg)}">${esc(label)}</text>`;
}

/** Dashed value levels plus their chips. Polar and heatmap scenes have none. */
export function lastValuesSvg(c: CompiledChart): string {
  if (c.polar || c.heatmap) return "";
  const { plot, theme } = c;
  const axisW = valueAxisWidth(c);
  const { tops, overflow } = layoutLastValueChips(c);
  const parts = c.lastValues.map((lv, index) => {
    const yy = hair(lv.y);
    const top = tops[index];
    const dash = lv.dash === false
      ? ""
      : `<line x1="${plot.x}" x2="${plot.x + plot.w}" y1="${yy}" y2="${yy}" stroke="${esc(lv.color)}" stroke-dasharray="3.5 3" stroke-opacity="0.8" />`;
    const chip = top == null
      ? ""
      : chipSvg(plot.x + plot.w + 3, top, axisW - 6, CHIP_HEIGHT, lv.color, readableTextColor(lv.color, theme), lv.label, "end");
    return `${dash}${chip}`;
  });
  if (overflow) {
    parts.push(chipSvg(plot.x + plot.w + 3, overflow.top, axisW - 6, CHIP_HEIGHT, theme.chipBg, readableTextColor(theme.chipBg, theme), overflow.label, "end"));
  }
  return parts.join("");
}

function paintChipCanvas(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  background: string,
  foreground: string,
  label: string,
  font: string,
): void {
  ctx.beginPath();
  traceRoundRect(ctx, x, y, w, h, 2.5);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.fillStyle = foreground;
  ctx.font = `600 10px ${font}`;
  ctx.textAlign = "end";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w - 6, y + h / 2 + 0.5);
}

export function paintLastValuesCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  if (c.polar || c.heatmap) return;
  const { plot, theme } = c;
  const axisWidth = valueAxisWidth(c);
  const { tops, overflow } = layoutLastValueChips(c);
  c.lastValues.forEach((value, index) => {
    if (value.dash !== false) {
      ctx.beginPath();
      ctx.moveTo(plot.x, hair(value.y));
      ctx.lineTo(plot.x + plot.w, hair(value.y));
      ctx.strokeStyle = chartColorWithOpacity(value.color, 0.8);
      ctx.lineWidth = 1;
      ctx.setLineDash([3.5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const top = tops[index];
    if (top == null) return;
    paintChipCanvas(ctx, plot.x + plot.w + 3, top, axisWidth - 6, CHIP_HEIGHT, value.color, readableTextColor(value.color, theme), value.label, theme.font);
  });
  if (overflow) {
    paintChipCanvas(ctx, plot.x + plot.w + 3, overflow.top, axisWidth - 6, CHIP_HEIGHT, theme.chipBg, readableTextColor(theme.chipBg, theme), overflow.label, theme.font);
  }
}

/** Value-axis crosshair chip text, from the target's structured value. */
export function crosshairValueLabel(c: CompiledChart, target: PointerTarget): string {
  if (c.yScale.kind === "band") return target.yCategory === undefined ? "" : formatSceneY(c, target.yCategory);
  return target.yValue === undefined ? "" : formatSceneY(c, target.yValue);
}

/** Category/time-axis crosshair chip text: the hovered datum's x, never the nearest tick. */
export function crosshairCategoryLabel(c: CompiledChart, target: PointerTarget): string {
  return target.xValue === undefined ? "" : formatSceneX(c, target.xValue);
}
