// compileChart(): the orchestration pipeline from a ChartDefinition to a
// renderer-neutral CompiledChart. Each stage lives in its own module:
//
//   validate -> legend (series ids, hidden series) -> domain (viewport window)
//   -> plugin domains -> legend band (top margin) -> format (value formatters)
//   -> axes (measured margins, plot, domain/heatmap scales and ticks, repeated
//   until the labels fit) -> cartesian/polar/heatmap/plugin marks
//   -> legend rows and layout

import type { BandScale } from "../scales";
import { SCENE_CONTRACT_VERSION, type SceneHoverSample } from "../sceneTypes";
import { resolveChartTheme, type DashboardTheme } from "../theme";
import { layoutAxes, resolveMargin, type AxisScales } from "./axes";
import { compileBar, compileLineArea, compilePoint, compileRuleX, compileRuleY, createBarState, planBars } from "./cartesian";
import { createMarkContext } from "./context";
import {
  appendStackExtents,
  cartesianXScale,
  cartesianYScale,
  collectDomainValues,
  inferXType,
  validateCartesianDomain,
  windowChartSpec,
} from "./domain";
import { ChartCompileError } from "./errors";
import { axisFormatters } from "./format";
import { compileHeatmap, heatmapColorLabels, heatmapLayout, heatmapValues } from "./heatmap";
import {
  growTopMargin,
  layoutLegend,
  legendEntries,
  markSeries,
  mergeLegendRows,
  planTopLegend,
  recordLegendToggles,
  resolveLegendPlacement,
  resolveSeries,
  seriesLegendRow,
  stampLegendRow,
  type LegendRowDraft,
  type SeriesInfo,
} from "./legend";
import { isBuiltinKind, isBuiltinMark, isPluginMark, type CartesianChartMark, type ChartMark, type PluginChartMark } from "./marks";
import type { MarkCompileContext } from "./context";
import { compilePluginMark, resolvePluginDomains } from "./plugin";
import { compilePie, compileRadar, createRadarState, pieLegendRows } from "./polar";
import { asNumber, isRecord, isRuntimeArray, readChannel } from "./shared";
import type { ChartDefinition, CompiledChart, HoverSample } from "./types";
import { validateChartSpec } from "./validate";

export function compileChart(definition: ChartDefinition, size: { width: number; height: number }): CompiledChart {
  return compilePass(definition, size, null);
}

/**
 * One compile. The top legend band is planned before any mark compiles, from
 * preview rows that count each plugin mark as one row. When the rows the
 * marks actually produce need a different number of wrapped lines, a second
 * pass plans the band from those rows, so plugin rows never spill onto the plot.
 */
function compilePass(
  definition: ChartDefinition,
  size: { width: number; height: number },
  plannedRows: readonly LegendRowDraft[] | null,
): CompiledChart {
  if (!definition || typeof definition.spec !== "function") {
    throw new ChartCompileError("E_CHART_SPEC", "compileChart() requires a definition created by defineChart().");
  }
  if (!isRecord(size) || typeof size.width !== "number" || typeof size.height !== "number") {
    throw new ChartCompileError("E_CHART_SIZE", "compileChart() requires numeric width and height.");
  }
  const inputSpec = definition.spec(size);
  if (!inputSpec || !isRuntimeArray(inputSpec.marks)) {
    throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.marks must be an array.");
  }
  const width = inputSpec.width ?? size.width;
  const height = inputSpec.height ?? size.height;
  validateChartSpec(inputSpec, width, height);
  const polarPreview = inputSpec.marks.some((m) => m.kind === "pie" || m.kind === "radar");
  const heatmapPreview = inputSpec.marks.some((m) => m.kind === "heatmap");
  if (inputSpec.viewport && (polarPreview || heatmapPreview)) {
    throw new ChartCompileError("E_CHART_SPEC", "viewport is supported on Cartesian charts only.");
  }
  const sourceRows = inputSpec.marks.reduce((total, mark) => total + mark.data.length, 0);
  // Every compiled scene owns its theme. Exported presets are immutable
  // inputs, never shared mutable runtime state.
  const theme: DashboardTheme = { ...resolveChartTheme(inputSpec.theme) };
  // Series identity (ids, names, palette colours) comes from the input marks,
  // so hiding a series never renames, recolours, or re-keys another one.
  const seriesTable = resolveSeries(inputSpec, theme);
  const visibleSeries = seriesTable.series.filter((series) => !series.hidden);
  const spec = windowChartSpec(
    inputSpec,
    visibleSeries.length === inputSpec.marks.length ? inputSpec.marks : visibleSeries.map((series) => series.mark),
  );
  const visibleRows = spec.marks.reduce((total, mark) => total + mark.data.length, 0);
  // The chart family follows the input marks as well: hiding every radar or
  // pie series leaves an empty polar chart, not a Cartesian one.
  const polar = inputSpec.marks.some((m) => m.kind === "pie" || m.kind === "radar");
  const heatmap = spec.marks.some((m) => m.kind === "heatmap");
  const isPie = inputSpec.marks.some((m) => m.kind === "pie");
  const hideLegend = spec.legend === false;
  const pieHasLegendRows = isPie && inputSpec.marks.some((mark) => mark.kind === "pie" && mark.data.length > 0);
  const hasBar = spec.marks.some((m) => m.kind === "bar");
  const hasArea = spec.marks.some((m) => m.kind === "area");
  const bars = planBars(spec.marks);
  const pluginDomains = resolvePluginDomains(spec.marks);
  const legendPlacement = resolveLegendPlacement(hideLegend, isPie);

  const baseMargin = resolveMargin(spec, { polar, isPie, heatmap, hideLegend, pieHasLegendRows, isHist: bars.isHist });
  // A wrapping top legend grows the top margin one row at a time.
  const legendBand = planTopLegend(
    legendPlacement === "top" ? plannedRows ?? previewLegendRows(seriesTable.series) : [],
    spec, width, height, baseMargin, theme.font,
  );
  const topMargin = growTopMargin(baseMargin, legendBand, spec);

  const cartesianMarks = spec.marks.filter((mark): mark is CartesianChartMark => (
    isBuiltinMark(mark) && (mark.kind === "line" || mark.kind === "area" || mark.kind === "bar" || mark.kind === "point")
  ));
  const { xValues, yValues } = collectDomainValues(spec, cartesianMarks, pluginDomains);
  const xType = inferXType(spec, xValues);
  // A polar chart has no Cartesian series: its values print at the precision
  // of its radar or pie data.
  const formatters = axisFormatters(spec, xType, { xValues, yValues: polar ? polarValues(spec.marks) : yValues, yBand: heatmap });
  appendStackExtents(spec, xType, yValues);
  if (!heatmap) {
    validateCartesianDomain(spec, { xType, xValues, yValues, cartesianMarks, pluginDomains, hasBar, hasArea });
  }

  // Margins are measured from the tick labels, so scales are built per layout pass.
  const hm = heatmap ? spec.marks.find((mark) => isBuiltinKind(mark, "heatmap")) : undefined;
  // Colour domain and value format, read from the data once per compile.
  const heat = hm && heatmapValues(hm);
  const includeZero = hasBar || hasArea || Array.from(pluginDomains.values()).some((domain) => domain.includeZero);
  const { margin, plot, xScale, yScale, xTicks, yTicks, axes } = layoutAxes({
    spec, width, height, margin: topMargin, xType, heatmap, polar, font: theme.font, formatters,
    colorLabels: heat && heatmapColorLabels(heat),
    scales: (area, areaMargin): AxisScales => (hm
      ? heatmapLayout(spec, hm, areaMargin, area)
      : {
        plot: area,
        xScale: cartesianXScale(spec, { xType, xValues, plot: area, bars, hasArea }),
        yScale: cartesianYScale(spec, { yValues, plot: area, includeZero }),
      }),
  });

  const ctx = createMarkContext({ spec, width, height, plot, theme, xScale, yScale, xType, ...formatters });
  const barState = createBarState(ctx, bars);
  const radarState = createRadarState(spec.marks);
  let visibleIndex = 0;

  for (const series of seriesTable.series) {
    if (series.hidden) {
      // Hidden series keep their legend rows so a toggle can bring them back.
      if (series.mark.kind === "pie") {
        for (const row of pieLegendRows(ctx, series, seriesTable.isHidden)) ctx.legend.push(row);
      } else if (isPluginMark(series.mark)) {
        for (const row of hiddenPluginRows(ctx, series)) ctx.legend.push(row);
      } else {
        const row = seriesLegendRow(series);
        if (row) ctx.legend.push(row);
      }
      continue;
    }
    const m = spec.marks[visibleIndex++]!;
    const ms = markSeries(series, m.data);
    if (isPluginMark(m)) {
      const legendStart = ctx.legend.length;
      const sampleStart = ctx.samples.length;
      compilePluginMark(ctx, m, ms.name, ms.color);
      for (let k = legendStart; k < ctx.legend.length; k++) ctx.legend[k] = stampLegendRow(ctx.legend[k]!, ms);
      for (let k = sampleStart; k < ctx.samples.length; k++) {
        ctx.samples[k] = pluginHoverSample(ctx, ctx.samples[k]!, ms);
      }
      continue;
    }
    const row = seriesLegendRow(ms);
    if (row) ctx.legend.push(row);
    if (m.kind === "line" || m.kind === "area") compileLineArea(ctx, m, ms);
    else if (m.kind === "point") compilePoint(ctx, m, ms);
    else if (m.kind === "ruleY") compileRuleY(ctx, m, ms);
    else if (m.kind === "ruleX") compileRuleX(ctx, m, ms);
    else if (m.kind === "bar") compileBar(ctx, m, ms, barState);
    else if (m.kind === "heatmap") compileHeatmap(ctx, m, heat!);
    else if (m.kind === "pie") compilePie(ctx, m, ms, seriesTable.isHidden);
    else if (m.kind === "radar") compileRadar(ctx, m, ms, radarState);
  }

  const { nodes, samples } = ctx;
  const legendRows = hideLegend ? [] : mergeLegendRows(ctx.legend.map((item) => item as LegendRowDraft));
  const explicitTop = spec.margin?.top !== undefined;
  if (plannedRows === null && legendPlacement === "top" && !explicitTop) {
    const needed = planTopLegend(legendRows, spec, width, height, baseMargin, theme.font);
    if (Math.max(1, needed.lines) !== Math.max(1, legendBand.lines)) return compilePass(definition, size, legendRows);
  }
  const scene: CompiledChart = {
    width, height, margin, plot,
    xScale, yScale, xTicks, yTicks,
    grid: heatmap ? spec.grid === true : spec.grid !== false,
    legend: legendEntries(legendRows),
    legendPlacement,
    legendLayout: layoutLegend(legendRows, {
      placement: legendPlacement, width, height, plot, margin, font: theme.font,
      // Never more lines than the band reserved above the plot.
      maxLines: explicitTop ? legendBand.maxLines : Math.max(1, legendBand.lines),
    }),
    contractVersion: SCENE_CONTRACT_VERSION,
    formatters: {
      x: formatters.formatX,
      y: formatters.formatY,
      ...(heat ? { color: (value: unknown): string => (typeof value === "number" ? heat.format(value) : String(value ?? "")) } : {}),
    },
    axes,
    hoverSamples: samples as SceneHoverSample[],
    nodes,
    tooltip: spec.tooltip !== false,
    ariaLabel: spec.ariaLabel?.trim() || "Chart",
    ariaDescription: spec.ariaDescription?.trim() ?? "",
    polar,
    heatmap,
    colorBar: ctx.colorBar,
    theme,
    lastValues: ctx.lastValues,
    samples,
    viewport: inputSpec.viewport ?? null,
    diagnostics: {
      sourceRows,
      visibleRows,
      renderedNodes: nodes.length,
      hoverSamples: samples.length,
      decimatedPoints: ctx.decimatedPoints,
    },
  };
  recordLegendToggles(scene, legendRows, seriesTable.series);
  return scene;
}

/** Every radar value and pie slice value, for the polar value formatter's data precision. */
function polarValues(marks: readonly ChartMark[]): number[] {
  const values: number[] = [];
  for (const mark of marks) {
    const accessor = isBuiltinKind(mark, "radar") ? mark.y : isBuiltinKind(mark, "pie") ? mark.valueKey : undefined;
    if (accessor === undefined) continue;
    for (const row of mark.data) {
      const value = asNumber(readChannel(row as never, accessor as never));
      if (Number.isFinite(value)) values.push(value);
    }
  }
  return values;
}

/** Rows the top legend will show, known before any mark compiles (plugins count as one row). */
function previewLegendRows(series: readonly SeriesInfo[]): LegendRowDraft[] {
  const rows: LegendRowDraft[] = [];
  for (const entry of series) {
    const row = seriesLegendRow(entry);
    if (row) rows.push(row);
  }
  return mergeLegendRows(rows);
}

/**
 * A hidden plugin keeps the legend rows it shows while visible, so toggling it
 * never reshapes the legend. Its output is compiled against the visible
 * series' scales and only the rows are kept; if that fails, it falls back to
 * one series row.
 */
function hiddenPluginRows(ctx: MarkCompileContext, s: SeriesInfo): LegendRowDraft[] {
  const scratch: MarkCompileContext = { ...ctx, nodes: [], legend: [], samples: [], lastValues: [] };
  try {
    compilePluginMark(scratch, s.mark as PluginChartMark, s.name, s.color);
  } catch {
    const row = seriesLegendRow(s);
    return row ? [row] : [];
  }
  return scratch.legend.map((row) => stampLegendRow(row, s));
}

/** Data-space x at a plugin sample's pixel: the nearest category on band scales, a Date on time scales. */
function pluginXValue(ctx: MarkCompileContext, px: number): unknown {
  const scale = ctx.xScale;
  if (scale.kind === "band") {
    const band = scale as BandScale<string | number>;
    const half = band.bandwidth() / 2;
    let best: string | number | undefined;
    let bestDistance = Infinity;
    for (const value of band.domain) {
      const distance = Math.abs(band.start(value) + half - px);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = value;
      }
    }
    return best;
  }
  const value = scale.invert(px);
  return ctx.xType === "time" ? new Date(value) : value;
}

/**
 * Structured fields for a plugin's hover sample, recovered from its pixel
 * position. Plugins report no source row, so `index` is -1 and `datum` is undefined.
 */
function pluginHoverSample(ctx: MarkCompileContext, sample: HoverSample, s: SeriesInfo): SceneHoverSample {
  return {
    ...sample,
    seriesId: s.id,
    markIndex: s.markIndex,
    index: -1,
    datum: undefined,
    xValue: pluginXValue(ctx, sample.x),
    yValue: ctx.yScale.kind === "linear" ? ctx.yScale.invert(sample.y) : null,
  };
}
