// compileChart(): the orchestration pipeline from a ChartDefinition to a
// renderer-neutral CompiledChart. Each stage lives in its own module:
//
//   validate -> legend (hidden series) -> domain (viewport window)
//   -> plugin domains -> axes (margins, plot) -> domain/heatmap (scales)
//   -> axes (ticks) -> cartesian/polar/heatmap/plugin marks -> legend rows

import type { AnyScale } from "../scales";
import type { CompiledSceneV2Fields } from "../sceneTypes";
import { resolveChartTheme, type DashboardTheme } from "../theme";
import { buildTicks, plotArea, resolveMargin } from "./axes";
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
import { compileHeatmap, heatmapLayout } from "./heatmap";
import {
  filterHiddenSeries,
  finalizeLegend,
  markSeriesName,
  pushSeriesLegend,
  resolveLegendPlacement,
  seriesColor,
} from "./legend";
import { isBuiltinKind, isBuiltinMark, isPluginMark, type CartesianChartMark, type ChartMark } from "./marks";
import { compilePluginMark, resolvePluginDomains } from "./plugin";
import { compilePie, compileRadar, createRadarState } from "./polar";
import { isRecord, isRuntimeArray } from "./shared";
import type { ChartDefinition, CompiledChart, HoverSample, SceneNode } from "./types";
import { validateChartSpec } from "./validate";

export function compileChart(definition: ChartDefinition, size: { width: number; height: number }): CompiledChart {
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
  const visibleMarks = filterHiddenSeries(inputSpec);
  const spec = windowChartSpec(inputSpec, visibleMarks);
  const visibleRows = spec.marks.reduce((total, mark) => total + mark.data.length, 0);
  // Every compiled scene owns its theme. Exported presets are immutable
  // inputs, never shared mutable runtime state.
  const theme: DashboardTheme = { ...resolveChartTheme(spec.theme) };
  const polar = spec.marks.some((m) => m.kind === "pie" || m.kind === "radar");
  const heatmap = spec.marks.some((m) => m.kind === "heatmap");
  const isPie = spec.marks.some((m) => m.kind === "pie");
  const isRadar = spec.marks.some((m) => m.kind === "radar");
  const hideLegend = spec.legend === false;
  const pieHasLegendRows = isPie && spec.marks.some((mark) => mark.kind === "pie" && mark.data.length > 0);
  const hasBar = spec.marks.some((m) => m.kind === "bar");
  const hasArea = spec.marks.some((m) => m.kind === "area");
  const bars = planBars(spec.marks);
  const pluginDomains = resolvePluginDomains(spec.marks);

  const margin = resolveMargin(spec, { polar, isPie, heatmap, hideLegend, pieHasLegendRows, isHist: bars.isHist });
  let plot = plotArea(width, height, margin);

  const cartesianMarks = spec.marks.filter((mark): mark is CartesianChartMark => (
    isBuiltinMark(mark) && (mark.kind === "line" || mark.kind === "area" || mark.kind === "bar" || mark.kind === "point")
  ));
  const { xValues, yValues } = collectDomainValues(spec, cartesianMarks, pluginDomains);
  const xType = inferXType(spec, xValues);
  const formatters = axisFormatters(spec, xType);
  appendStackExtents(spec, xType, yValues);
  if (!heatmap) {
    validateCartesianDomain(spec, { xType, xValues, yValues, cartesianMarks, pluginDomains, hasBar, hasArea });
  }

  let xScale: AnyScale;
  let yScale: AnyScale;
  if (heatmap) {
    const hm = spec.marks.find((mark) => isBuiltinKind(mark, "heatmap"))!;
    ({ plot, xScale, yScale } = heatmapLayout(spec, hm, margin, plot));
  } else {
    xScale = cartesianXScale(spec, { xType, xValues, plot, bars, hasArea });
    const includeZero = hasBar || hasArea || Array.from(pluginDomains.values()).some((domain) => domain.includeZero);
    yScale = cartesianYScale(spec, { yValues, plot, includeZero });
  }

  const { xTicks, yTicks } = buildTicks(xScale, yScale, plot, xType, heatmap, formatters);

  const ctx = createMarkContext({ spec, width, height, plot, theme, xScale, yScale, xType, ...formatters });
  const barState = createBarState(ctx, bars);
  const radarState = createRadarState(spec.marks);
  let colorI = 0;
  const sourceIndex = new Map(inputSpec.marks.map((mark, index) => [mark, index] as const));

  for (let k = 0; k < spec.marks.length; k++) {
    const m = spec.marks[k]!;
    const color = seriesColor(m, colorI++, theme);
    const name = markSeriesName(m);
    if (isPluginMark(m)) {
      compilePluginMark(ctx, m, name, color);
      continue;
    }
    const firstSample = ctx.samples.length;
    const firstNode = ctx.nodes.length;
    pushSeriesLegend(ctx, m, name, color);
    if (m.kind === "line" || m.kind === "area") compileLineArea(ctx, m, name, color);
    else if (m.kind === "point") compilePoint(ctx, m, name);
    else if (m.kind === "ruleY") compileRuleY(ctx, m, name, color);
    else if (m.kind === "ruleX") compileRuleX(ctx, m, name, color);
    else if (m.kind === "bar") compileBar(ctx, m, name, color, barState);
    else if (m.kind === "heatmap") compileHeatmap(ctx, m);
    else if (m.kind === "pie") compilePie(ctx, m, name);
    else if (m.kind === "radar") compileRadar(ctx, m, name, color, radarState);
    const source = visibleMarks[k] ?? m;
    stampMarkIdentity(ctx.samples, firstSample, ctx.nodes, firstNode, source, sourceIndex.get(source) ?? k);
  }

  const { nodes, samples } = ctx;
  const scene: CompiledChart & CompiledSceneV2Fields = {
    width, height, margin, plot,
    xScale, yScale, xTicks, yTicks,
    grid: heatmap ? spec.grid === true : spec.grid !== false,
    legend: finalizeLegend(ctx.legend, hideLegend),
    legendPlacement: resolveLegendPlacement(hideLegend, isPie, isRadar),
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
    formatters: { x: formatters.formatX, y: formatters.formatY },
  };
  return scene;
}

/**
 * Give a mark's hover samples, and the nodes that answer pointer events
 * without a sample (bars, heatmap cells, pie slices), their series identity
 * and source row index, so onTooltip/onSelect payloads agree across marks.
 */
function stampMarkIdentity(
  samples: HoverSample[], fromSample: number, nodes: SceneNode[], fromNode: number, source: ChartMark, markIndex: number,
): void {
  const explicitId = (source as { id?: unknown }).id;
  const seriesId = typeof explicitId === "string" && explicitId ? explicitId : `mark-${markIndex}`;
  stampRows(samples, fromSample, source.data, seriesId, markIndex, () => true);
  stampRows(nodes, fromNode, source.data, seriesId, markIndex, (node) => node.role === "bar" || node.role === "heat" || node.role === "slice");
}

/**
 * Items are emitted in row order and the viewport window keeps row order, so
 * one forward identity walk over the source rows resolves every index.
 *
 * TODO(W2-13, perf-native-viewport-index): the walk starts at row 0, so a
 * narrow window at the end of a large mark costs O(rows before the window).
 * That is below the O(n) windowing today; once windowing binary-searches,
 * have windowChartSpec report each window's source offset and start there.
 */
function stampRows<T extends { datum?: unknown; seriesId?: string; markIndex?: number; index?: number }>(
  items: T[], from: number, rows: readonly unknown[], seriesId: string, markIndex: number, include: (item: T) => boolean,
): void {
  let cursor = 0;
  for (let i = from; i < items.length; i++) {
    const item = items[i]!;
    if (!include(item)) continue;
    item.seriesId = seriesId;
    item.markIndex = markIndex;
    if (cursor < 0 || !("datum" in item)) continue;
    let at = cursor;
    while (at < rows.length && rows[at] !== item.datum) at++;
    if (at === rows.length) {
      cursor = -1;
      continue;
    }
    item.index = at;
    cursor = at;
  }
}
