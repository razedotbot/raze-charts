// Layout and axes: margins, the plot rectangle, and X/Y tick generation.

import type { AnyScale, BandScale, LinearScale } from "../scales";
import type { AxisFormatters } from "./format";
import type { AxisTick, ChartSpec, Margin, PlotRect, XScaleKind } from "./types";

export const DEFAULT_MARGIN: Margin = { top: 14, right: 56, bottom: 26, left: 10 };

export interface MarginLayout {
  polar: boolean;
  isPie: boolean;
  heatmap: boolean;
  hideLegend: boolean;
  /** A pie with rows reserves room for its right-hand legend. */
  pieHasLegendRows: boolean;
  /** A single unstacked bar mark reads as a histogram. */
  isHist: boolean;
}

/** Chart-family default margins, overridden field by field by spec.margin. */
export function resolveMargin(spec: ChartSpec, layout: MarginLayout): Margin {
  const { polar, isPie, heatmap, hideLegend, pieHasLegendRows, isHist } = layout;
  return polar
    ? isPie
      ? { top: 8, right: !hideLegend && pieHasLegendRows ? 152 : 8, bottom: 8, left: 8, ...spec.margin }
      : { top: 44, right: 28, bottom: 42, left: 28, ...spec.margin }
    : heatmap
      ? { top: 16, right: 54, bottom: 28, left: 46, ...spec.margin }
      : {
        top: hideLegend ? 12 : 28,
        right: DEFAULT_MARGIN.right,
        bottom: isHist ? 28 : DEFAULT_MARGIN.bottom,
        left: DEFAULT_MARGIN.left,
        ...spec.margin,
      };
}

export function plotArea(width: number, height: number, margin: Margin): PlotRect {
  return {
    x: margin.left,
    y: margin.top,
    w: Math.max(1, width - margin.left - margin.right),
    h: Math.max(1, height - margin.top - margin.bottom),
  };
}

export function utcTimeTicks(lo: number, hi: number, maxTicks = 5): number[] {
  const span = Math.max(1, hi - lo);
  const day = 86400000;
  const days = span / day;
  let stepDays = 1;
  if (days > 10) stepDays = 2;
  if (days > 18) stepDays = 4;
  if (days > 28) stepDays = 7;
  if (days > 50) stepDays = 14;
  if (days > 120) stepDays = 30;
  const build = (step: number): number[] => {
    const startDate = new Date(lo);
    const start = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
    const out: number[] = [];
    for (let t = start; t <= hi + step / 4; t += step) {
      if (t >= lo - step / 8 && t <= hi + step / 8) out.push(t);
    }
    return out;
  };
  let out = build(stepDays * day);
  while (out.length > maxTicks && stepDays < 60) {
    stepDays = stepDays < 7 ? 7 : stepDays < 14 ? 14 : stepDays * 2;
    out = build(stepDays * day);
  }
  if (out.length < 2) out = [lo, hi];
  return out;
}

export function thinBandTicks<T>(domain: T[], plotW: number, heatmap: boolean): T[] {
  if (heatmap || domain.length <= 2) return domain;
  const maxLabels = Math.max(2, Math.floor(plotW / 64));
  if (domain.length <= maxLabels) return domain;
  const step = Math.max(1, Math.ceil((domain.length - 1) / (maxLabels - 1)));
  const out: T[] = [];
  for (let i = 0; i < domain.length; i += step) out.push(domain[i]!);
  const last = domain[domain.length - 1]!;
  if (out[out.length - 1] !== last) {
    if (out.length >= 2 && domain.indexOf(last) - domain.indexOf(out[out.length - 1]!) < step * 0.6) {
      out[out.length - 1] = last;
    } else {
      out.push(last);
    }
  }
  return out;
}

export interface AxisTicks {
  xTicks: AxisTick[];
  yTicks: AxisTick[];
}

/** Tick values for both axes, positioned in plot space and labelled by the axis formatters. */
export function buildTicks(
  xScale: AnyScale,
  yScale: AnyScale,
  plot: PlotRect,
  xType: XScaleKind,
  heatmap: boolean,
  { formatX, formatY }: AxisFormatters,
): AxisTicks {
  const xTickBudget = Math.max(2, Math.min(5, Math.floor(plot.w / 96)));
  const yTickBudget = Math.max(2, Math.min(6, Math.floor(plot.h / 52)));
  const xTicks = xScale.kind === "band"
    ? thinBandTicks((xScale as BandScale).domain, plot.w, heatmap).map((value) => ({
      value, px: xScale.map(value), label: formatX(value),
    }))
    : (xType === "time"
      ? utcTimeTicks((xScale as LinearScale).domain[0], (xScale as LinearScale).domain[1], xTickBudget)
      : (xScale as LinearScale).ticks(xTickBudget)
    ).map((value) => ({
      value, px: xScale.map(value), label: formatX(value),
    }));

  const yTicks = yScale.kind === "band"
    ? (yScale as BandScale).domain.map((value) => ({ value, px: yScale.map(value), label: formatY(value) }))
    : (yScale as LinearScale).ticks(yTickBudget).map((value) => ({
      value, px: yScale.map(value), label: formatY(value),
    }));
  return { xTicks, yTicks };
}
