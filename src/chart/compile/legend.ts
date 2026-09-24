// Series identity and legend: names, palette colours, hidden-series
// filtering, legend rows, and legend placement.

import { chartPalette, type DashboardTheme } from "../theme";
import type { SceneOutput } from "./context";
import type { BuiltinChartMark, ChartMark } from "./marks";
import type { ChartSpec, CompiledChart, LegendEntry } from "./types";
import { unique } from "./shared";

function markStroke(mark: ChartMark): string | undefined {
  return "stroke" in mark && typeof mark.stroke === "string" ? mark.stroke : undefined;
}

export function markFill(mark: ChartMark): string | undefined {
  return "fill" in mark && typeof mark.fill === "string" ? mark.fill : undefined;
}

/** Explicit stroke, then fill, then the theme palette by mark order. */
export function seriesColor(mark: ChartMark, i: number, theme: DashboardTheme): string {
  const palette = chartPalette(theme);
  return markStroke(mark) || markFill(mark) || palette[i % palette.length]!;
}

/** Legend/tooltip/hidden-series identity: name, else a string y key, else the kind. */
export function markSeriesName(mark: ChartMark): string {
  return mark.name ?? ("y" in mark && typeof mark.y === "string" ? mark.y : mark.kind);
}

/** Marks left after spec.hiddenSeries. Returns spec.marks itself when nothing is hidden. */
export function filterHiddenSeries(spec: ChartSpec): readonly ChartMark[] {
  const hidden = new Set(spec.hiddenSeries ?? []);
  let marks = spec.marks;
  if (hidden.size) {
    marks = marks.filter((mark) => !hidden.has(markSeriesName(mark)));
  }
  return marks;
}

/** Built-in series rows. Rules, pies (per-slice rows), and heatmaps (colour bar) opt out. */
export function pushSeriesLegend(out: Pick<SceneOutput, "legend">, mark: BuiltinChartMark, name: string, color: string): void {
  if (mark.kind !== "ruleY" && mark.kind !== "ruleX" && mark.kind !== "pie" && mark.kind !== "heatmap") {
    out.legend.push({ name, color: markFill(mark) || color });
  }
}

/** First row wins for duplicate series names; a hidden legend has no rows. */
export function finalizeLegend(legend: readonly LegendEntry[], hideLegend: boolean): LegendEntry[] {
  return hideLegend ? [] : unique(legend.map((l) => l.name)).map((n) => legend.find((l) => l.name === n)!);
}

export function resolveLegendPlacement(
  hideLegend: boolean,
  isPie: boolean,
  isRadar: boolean,
): CompiledChart["legendPlacement"] {
  return hideLegend
    ? "hidden"
    : isPie
      ? "right"
    : isRadar
        ? "top"
        : "top";
}
