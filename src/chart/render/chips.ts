// Axis chips: last-value chips on the value axis (SVG and Canvas share one
// placement pass) and the crosshair chip labels shown by mounted charts.

import type { HoverSample, CompiledChart, SceneNode } from "../compile/types";
import type { LinearScale } from "../scales";
import { chartColorWithOpacity, readableTextColor } from "../theme";
import { esc, hair, traceRoundRect } from "./primitives";

const CHIP_HEIGHT = 15;

/** Width of the value-axis gutter right of the plot. */
export function valueAxisWidth(c: CompiledChart): number {
  return Math.max(44, c.width - c.plot.x - c.plot.w);
}

/**
 * Top edge of each last-value chip, in c.lastValues order. Chips start
 * centred on their value, clamp to the plot, and step down past earlier chips.
 */
export function layoutLastValueChips(c: CompiledChart): number[] {
  const { plot } = c;
  const placed: number[] = [];
  for (const value of c.lastValues) {
    let top = Math.max(plot.y, Math.min(plot.y + plot.h - CHIP_HEIGHT, value.y - 7.5));
    while (placed.some((position) => Math.abs(position - top) < 16)) {
      top = Math.min(plot.y + plot.h - CHIP_HEIGHT, top + 16);
    }
    placed.push(top);
  }
  return placed;
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
  const tops = layoutLastValueChips(c);
  return c.lastValues.map((lv, index) => {
    const yy = hair(lv.y);
    const top = tops[index]!;
    const dash = lv.dash === false
      ? ""
      : `<line x1="${plot.x}" x2="${plot.x + plot.w}" y1="${yy}" y2="${yy}" stroke="${esc(lv.color)}" stroke-dasharray="3.5 3" stroke-opacity="0.8" />`;
    return [
      dash,
      chipSvg(plot.x + plot.w + 3, top, axisW - 6, CHIP_HEIGHT, lv.color, readableTextColor(lv.color, theme), lv.label, "end"),
    ].join("");
  }).join("");
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
  const tops = layoutLastValueChips(c);
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
    paintChipCanvas(ctx, plot.x + plot.w + 3, tops[index]!, axisWidth - 6, CHIP_HEIGHT, value.color, readableTextColor(value.color, theme), value.label, theme.font);
  });
}

function nearestLabel(ticks: { px: number; label: string }[], px: number): string {
  if (!ticks.length) return "";
  let best = ticks[0]!;
  for (const t of ticks) {
    if (Math.abs(t.px - px) < Math.abs(best.px - px)) best = t;
  }
  return best.label;
}

/** What the crosshair is anchored to while hovering. */
export interface CrosshairTarget {
  hit: SceneNode | null;
  sample: HoverSample | null;
  isBar: boolean;
  isLine: boolean;
  isPoint: boolean;
  /** Scene-space crosshair position after snapping to the target. */
  scanX: number;
  scanY: number;
  /** Raw scene-space pointer Y. */
  y: number;
}

/** Value-axis crosshair chip text. */
export function crosshairValueLabel(c: CompiledChart, target: CrosshairTarget): string {
  const { hit, sample, isBar, isLine, isPoint, scanY, y } = target;
  if (c.yScale.kind === "band") {
    return nearestLabel(c.yTicks, scanY);
  }
  if (isBar && hit?.tip) {
    const bits = hit.tip.split("\n")[1]?.trim().split(/\s{2,}/) ?? [];
    return bits[1] ?? bits[0] ?? "";
  }
  // Scene v2 value formatter: data precision (or scales.y.tickFormat).
  const format = c.formatters?.y ?? ((value: number): string => (
    Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) < 1 ? 2 : 1)
  ));
  if ((isLine || isPoint) && sample) return format((c.yScale as LinearScale).invert(sample.y));
  return format((c.yScale as LinearScale).invert(y));
}

/** Category/time-axis crosshair chip text. */
export function crosshairCategoryLabel(c: CompiledChart, target: CrosshairTarget): string {
  const { sample, isLine, isPoint, scanX } = target;
  if (isLine && sample) {
    const first = sample.tip.split("\n")[1];
    return first ? (first.trim().split(/\s{2,}/)[0] ?? nearestLabel(c.xTicks, sample.x)) : nearestLabel(c.xTicks, sample.x);
  }
  if (isPoint && sample) {
    const first = sample.tip.split("\n")[1];
    return first ? (first.trim().split("·")[0]!.trim() || nearestLabel(c.xTicks, sample.x)) : nearestLabel(c.xTicks, scanX);
  }
  return nearestLabel(c.xTicks, scanX);
}
