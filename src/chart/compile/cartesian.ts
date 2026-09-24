// Cartesian mark compilers: line/area (with gap segments and decimation),
// point, ruleY, ruleX, and grouped/stacked bars.

import { mixHex } from "../theme";
import type { BandScale } from "../scales";
import type { SceneHoverSample } from "../sceneTypes";
import type { MarkCompileContext } from "./context";
import { flattenCurve } from "./curve";
import { decimateSegments, type SeriesSegment } from "./decimate";
import { estimateTextWidth, type MarkSeries } from "./legend";
import {
  isBuiltinKind,
  type AreaChartMark,
  type BarChartMark,
  type ChartMark,
  type LineChartMark,
  type PointChartMark,
  type RuleLabelPosition,
  type RuleXChartMark,
  type RuleYChartMark,
} from "./marks";
import { asNumber, readChannel, stackKey, unique } from "./shared";
import type { HoverSample, SceneNode, ScenePoint } from "./types";

/** Default scatter radius: one constant size, so size never encodes data by accident. */
export const DEFAULT_POINT_RADIUS = 3;
/** Bars shorter than this get a transparent hit proxy so they stay hoverable. */
const MIN_BAR_HIT = 6;
const RULE_LABEL_FONT = 9;

/** A structured hover sample: pixel position plus the datum it came from. */
export function sceneSample(
  s: MarkSeries,
  kind: HoverSample["kind"],
  point: ScenePoint,
  color: string,
  tip: string,
  row: { index: number; datum: unknown; xValue: unknown; yValue: number },
): SceneHoverSample {
  return {
    x: point.x,
    y: point.y,
    series: s.name,
    color,
    tip,
    kind,
    seriesId: s.id,
    markIndex: s.markIndex,
    index: s.sourceIndex(row.index),
    datum: row.datum,
    xValue: row.xValue,
    yValue: Number.isFinite(row.yValue) ? row.yValue : null,
  };
}

export function compileLineArea(ctx: MarkCompileContext, m: LineChartMark | AreaChartMark, s: MarkSeries): void {
  const { spec, plot, theme, yScale, nodes, samples, lastValues, formatX, formatY } = ctx;
  const { name, color } = s;
  // Segments carry row indexes, so decimation keeps each point's source row.
  const rawSegments: SeriesSegment<number>[] = [];
  let segment: SeriesSegment<number> = { points: [], rows: [] };
  for (let index = 0; index < m.data.length; index++) {
    const row = m.data[index];
    const x = ctx.mapX(row, m);
    const y = ctx.mapY(row, m);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (segment.points.length) rawSegments.push(segment);
      segment = { points: [], rows: [] };
      continue;
    }
    segment.points.push({ x, y });
    segment.rows.push(index);
  }
  if (segment.points.length) rawSegments.push(segment);
  const rawFinalSegment = rawSegments[rawSegments.length - 1];

  const requested = spec.performance?.maxRenderedPoints;
  const seriesLimit = requested !== undefined
    ? Math.max(1, Math.floor(requested))
    : Math.max(1, Math.floor(plot.w * 2));
  const validPointCount = rawSegments.reduce((total, item) => total + item.points.length, 0);
  let segments = rawSegments;
  if (spec.performance?.decimation !== "none" && validPointCount > seriesLimit) {
    segments = decimateSegments(rawSegments, seriesLimit);
    const renderedPointCount = segments.reduce((total, item) => total + item.points.length, 0);
    ctx.decimatedPoints += validPointCount - renderedPointCount;
  }

  const curve = m.curve ?? "monotone";
  const strokeWidth = m.strokeWidth ?? (m.dashed ? 1.15 : 1.85);
  for (const current of segments) {
    const { points: pts, rows } = current;
    if (m.kind === "area" && pts.length) {
      const mappedZero = yScale.kind === "linear" ? yScale.map(0) : plot.y + plot.h;
      const baseline = Math.max(plot.y, Math.min(plot.y + plot.h, mappedZero));
      if (m.y0) {
        const lower: ScenePoint[] = [];
        for (let i = 0; i < pts.length; i++) {
          const y0 = asNumber(readChannel(m.data[rows[i]!] as never, m.y0 as never));
          const y = Number.isFinite(y0) && yScale.kind === "linear" ? yScale.map(y0) : baseline;
          lower.push({ x: pts[i]!.x, y });
        }
        // Both edges follow the mark's curve (the lower one traced in
        // reverse), so the band meets its strokes with no slivers.
        nodes.push({
          type: "area",
          points: [...flattenCurve(pts, curve), ...flattenCurve(lower, curve).reverse()],
          fill: m.fill || color,
          fillOpacity: m.fillOpacity ?? 0.28,
          stroke: "none",
          series: name,
          hit: false,
          role: "ranged-area",
          curve: "linear",
        });
        if (m.stroke0) {
          nodes.push({
            type: "line",
            points: lower,
            stroke: m.stroke0 === true ? color : m.stroke0,
            strokeWidth,
            fill: "none",
            dashed: m.dashed,
            series: name,
            hit: false,
            role: "ranged-lower",
            curve,
          });
        }
      } else {
        nodes.push({
          type: "area",
          points: [
            { x: pts[0]!.x, y: baseline },
            ...pts,
            { x: pts[pts.length - 1]!.x, y: baseline },
          ],
          fill: m.fill || color,
          fillOpacity: m.fillOpacity ?? 0.28,
          stroke: "none",
          series: name,
          hit: false,
          role: "area",
          curve,
        });
      }
    }
    nodes.push({
      type: "line",
      points: pts,
      stroke: color,
      strokeWidth,
      fill: "none",
      dashed: m.dashed,
      series: name,
      hit: true,
      role: "line",
      curve,
    });
    for (let i = 0; i < pts.length; i++) {
      const index = rows[i]!;
      const row = m.data[index];
      const xv = readChannel(row as never, m.x as never);
      const yv = asNumber(readChannel(row as never, m.y as never));
      const tip = `${name}\n${formatX(xv)}   ${formatY(yv)}`;
      if (pts.length === 1) {
        nodes.push({
          type: "circle",
          x: pts[0]!.x,
          y: pts[0]!.y,
          r: 2.6,
          fill: color,
          stroke: theme.background,
          strokeWidth: 1.2,
          datum: row,
          series: name,
          tip,
          role: "point",
        });
      }
      samples.push(sceneSample(s, "line", pts[i]!, color, tip, { index, datum: row, xValue: xv, yValue: yv }));
    }
  }

  // Presentation budgets may choose extrema over the final sample. The
  // last-value chip and endpoint still describe the actual source tail.
  const lastPt = rawFinalSegment?.points[rawFinalSegment.points.length - 1];
  const lastIndex = rawFinalSegment?.rows[rawFinalSegment.rows.length - 1];
  const lastRow = lastIndex === undefined ? undefined : m.data[lastIndex];
  if (lastPt && lastRow != null && m.lastValue !== false) {
    lastValues.push({
      y: lastPt.y,
      label: formatY(asNumber(readChannel(lastRow as never, m.y as never))),
      color,
      dash: true,
    });
    nodes.push({
      type: "circle",
      x: lastPt.x,
      y: lastPt.y,
      r: 3.4,
      fill: color,
      stroke: theme.background,
      strokeWidth: 1.6,
      datum: lastRow,
      series: name,
      hit: false,
      role: "endpoint",
    });
  }
}

export function compilePoint(ctx: MarkCompileContext, m: PointChartMark, s: MarkSeries): void {
  const { nodes, samples, formatX, formatY } = ctx;
  // Points paint in the series colour at one radius, exactly like their
  // legend swatch. Colour and size encodings are explicit channels, not defaults.
  const fill = m.fill || s.color;
  const r = m.r ?? DEFAULT_POINT_RADIUS;
  for (let index = 0; index < m.data.length; index++) {
    const row = m.data[index];
    const x = ctx.mapX(row, m);
    const y = ctx.mapY(row, m);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const rawX = readChannel(row as never, m.x as never);
    const yv = asNumber(readChannel(row as never, m.y as never));
    const tip = `${s.name}\n${formatX(rawX)}   ·   ${formatY(yv)}`;
    nodes.push({
      type: "circle",
      x, y, r,
      fill,
      fillOpacity: m.fillOpacity ?? 0.78,
      stroke: "none",
      datum: row,
      series: s.name,
      tip,
      role: "point",
    });
    samples.push(sceneSample(s, "point", { x, y }, fill, tip, { index, datum: row, xValue: rawX, yValue: yv }));
  }
}

/**
 * Rule label text: an explicit `label`, else the formatted value, prefixed by
 * the series name only when the author named the rule. `label: false` hides it.
 */
function ruleLabel(m: RuleYChartMark | RuleXChartMark, value: string): string | null {
  if (m.label === false) return null;
  if (typeof m.label === "string") return m.label;
  return typeof m.name === "string" && m.name.trim() ? `${m.name}  ${value}` : value;
}

function ruleText(
  x: number, y: number, label: string, anchor: "start" | "middle" | "end", fill: string,
): SceneNode {
  return { type: "text", x, y, label, fill, fontSize: RULE_LABEL_FONT, anchor, hit: false, clip: true, role: "rule-label" };
}

export function compileRuleY(ctx: MarkCompileContext, m: RuleYChartMark, s: MarkSeries): void {
  const { plot, nodes, lastValues, formatY } = ctx;
  const stroke = m.stroke || s.color;
  const position: RuleLabelPosition = m.labelPosition ?? "start";
  for (const row of m.data) {
    const y = ctx.mapY(row, m);
    if (!Number.isFinite(y)) continue;
    const value = formatY(asNumber(readChannel(row as never, m.y as never)));
    nodes.push({
      type: "rule",
      x: plot.x, y, x2: plot.x + plot.w, y2: y,
      stroke,
      strokeWidth: m.strokeWidth ?? 1,
      dashed: m.dashed !== false,
      series: s.name,
      hit: false,
      role: "rule",
    });
    const label = ruleLabel(m, value);
    if (label) {
      // Above the rule, or below it when the rule hugs the plot top.
      const ly = y - 7 < plot.y + 5 ? y + 8 : y - 7;
      const lx = position === "end" ? plot.x + plot.w - 6 : position === "middle" ? plot.x + plot.w / 2 : plot.x + 6;
      nodes.push(ruleText(lx, ly, label, position, stroke));
    }
    lastValues.push({ y, label: value, color: stroke, dash: false });
  }
}

export function compileRuleX(ctx: MarkCompileContext, m: RuleXChartMark, s: MarkSeries): void {
  const { plot, nodes, formatX } = ctx;
  const stroke = m.stroke || s.color;
  const position: RuleLabelPosition = m.labelPosition ?? "start";
  for (const row of m.data) {
    const xv = readChannel(row as never, m.x as never);
    const x = ctx.mapXValue(xv);
    if (!Number.isFinite(x)) continue;
    nodes.push({
      type: "rule",
      x, y: plot.y, x2: x, y2: plot.y + plot.h,
      stroke,
      strokeWidth: m.strokeWidth ?? 1,
      dashed: m.dashed !== false,
      series: s.name,
      hit: false,
      role: "rule",
    });
    const label = ruleLabel(m, formatX(xv));
    if (label) {
      // Right of the rule, or left of it when the label would leave the plot.
      const flip = x + 6 + estimateTextWidth(label, RULE_LABEL_FONT, ctx.theme.font) > plot.x + plot.w;
      const ly = position === "end" ? plot.y + plot.h - 8 : position === "middle" ? plot.y + plot.h / 2 : plot.y + 12;
      nodes.push(ruleText(flip ? x - 6 : x + 6, ly, label, flip ? "end" : "start", stroke));
    }
  }
}

/** Bar grouping: one slot per unstacked mark and per distinct stackId. */
export interface BarPlan {
  marks: BarChartMark[];
  groupByMark: Map<ChartMark, number>;
  /** Number of side-by-side slots per category (at least 1). */
  groupCount: number;
  /** A single unstacked bar mark reads as a histogram. */
  isHist: boolean;
}

export function planBars(marks: readonly ChartMark[]): BarPlan {
  const barMarks = marks.filter((mark) => isBuiltinKind(mark, "bar"));
  const groupByMark = new Map<ChartMark, number>();
  const groupByStack = new Map<string, number>();
  let barGroupCount = 0;
  for (const mark of barMarks) {
    if (mark.stackId) {
      let group = groupByStack.get(mark.stackId);
      if (group == null) {
        group = barGroupCount++;
        groupByStack.set(mark.stackId, group);
      }
      groupByMark.set(mark, group);
    } else {
      groupByMark.set(mark, barGroupCount++);
    }
  }
  return {
    marks: barMarks,
    groupByMark,
    groupCount: Math.max(1, barGroupCount),
    isHist: barMarks.length === 1 && !barMarks[0]!.stackId,
  };
}

/** Per-mark bar state shared across marks of one compile. */
export interface BarState {
  plan: BarPlan;
  /** Running positive/negative totals per stack slot. */
  stackCursor: Map<string, { positive: number; negative: number }>;
  /** Width of one category cluster on a quantitative X scale. */
  numericClusterWidth: number;
}

export function createBarState(ctx: MarkCompileContext, plan: BarPlan): BarState {
  const { plot, xScale } = ctx;
  let numericBarClusterWidth = Math.max(2, plot.w * 0.62);
  if (plan.marks.length > 0 && xScale.kind !== "band") {
    const positions = unique(plan.marks.flatMap((mark) => mark.data
      .map((row) => xScale.map(asNumber(readChannel(row as never, mark.x as never))))
      .filter(Number.isFinite))).sort((a, b) => a - b);
    if (positions.length > 1) {
      let spacing = Infinity;
      for (let index = 1; index < positions.length; index++) {
        const candidate = positions[index]! - positions[index - 1]!;
        if (candidate > 0 && candidate < spacing) spacing = candidate;
      }
      if (Number.isFinite(spacing)) numericBarClusterWidth = Math.max(2, spacing * 0.62);
    }
  }
  return { plan, stackCursor: new Map(), numericClusterWidth: numericBarClusterWidth };
}

function groupBarSlot(
  start: number, end: number, groupIndex: number, nGroup: number, gap: number,
): { x: number; w: number } {
  const a = Math.round(start);
  const b = Math.round(end);
  const avail = Math.max(1, b - a);
  if (nGroup <= 1) return { x: a, w: avail };
  const barW = Math.max(1, Math.floor((avail - gap * (nGroup - 1)) / nGroup));
  const used = barW * nGroup + gap * (nGroup - 1);
  const ox = a + Math.floor((avail - used) / 2);
  return { x: ox + groupIndex * (barW + gap), w: barW };
}

/**
 * Whole-pixel vertical extent of a bar between `y1` (base) and `y2` (value).
 * A zero or sub-pixel value paints nothing (height 0) unless `minBarHeight`
 * asks for a stub, which grows away from the base.
 */
function barExtent(y1: number, y2: number, value: number, minBarHeight: number): { top: number; h: number } {
  let top = Math.round(Math.min(y1, y2));
  let bottom = Math.round(Math.max(y1, y2));
  const min = Math.round(minBarHeight);
  if (value !== 0 && bottom - top < min) {
    const base = Math.round(y1);
    if (y2 <= y1) {
      top = base - min;
      bottom = base;
    } else {
      top = base;
      bottom = base + min;
    }
  }
  return { top, h: bottom - top };
}

export function compileBar(ctx: MarkCompileContext, m: BarChartMark, s: MarkSeries, bars: BarState): void {
  const { xScale, yScale, xType, theme, nodes, lastValues, formatX, formatY } = ctx;
  const { name, color } = s;
  const stacked = !!m.stackId;
  const groupIndex = bars.plan.groupByMark.get(m) ?? 0;
  const nGroup = bars.plan.groupCount;
  const innerGap = nGroup > 1 ? 3 : 0;
  let lastBarEndpointY: number | null = null;
  let lastBarValue: number | null = null;
  const nRows = m.data.length;
  for (let ri = 0; ri < nRows; ri++) {
    const row = m.data[ri]!;
    const rawX = readChannel(row as never, m.x as never);
    const yv = asNumber(readChannel(row as never, m.y as never));
    if (!Number.isFinite(yv)) continue;
    const mappedBarX = xScale.kind === "band"
      ? (xScale as BandScale<string | number>).start(rawX as string | number)
      : xScale.map(asNumber(rawX));
    if (!Number.isFinite(mappedBarX)) continue;
    const key = stackKey(m.stackId ?? "", rawX, xType !== "band");
    const cursor = bars.stackCursor.get(key) ?? { positive: 0, negative: 0 };
    const base = stacked ? (yv >= 0 ? cursor.positive : cursor.negative) : 0;
    if (stacked) {
      if (yv >= 0) cursor.positive = base + yv;
      else cursor.negative = base + yv;
      bars.stackCursor.set(key, cursor);
    }
    const y1 = yScale.map(base);
    const y2 = yScale.map(stacked ? base + yv : yv);
    const slot = xScale.kind === "band"
      ? groupBarSlot(mappedBarX, mappedBarX + (xScale as BandScale<string | number>).bandwidth(), groupIndex, nGroup, innerGap)
      : groupBarSlot(
        mappedBarX - bars.numericClusterWidth / 2,
        mappedBarX + bars.numericClusterWidth / 2,
        groupIndex,
        nGroup,
        innerGap,
      );
    const x = Math.round(slot.x);
    const w = Math.max(1, Math.round(slot.x + slot.w) - x);
    const { top, h } = barExtent(y1, y2, yv, m.minBarHeight ?? 0);
    const tFade = nRows <= 1 ? 1 : ri / (nRows - 1);
    // Early bars fade toward the pane itself, so the fade reads on light and dark themes alike.
    const fill = m.fade
      ? mixHex(theme.background, m.fill || color, 0.22 + 0.78 * tFade)
      : (m.fill || color);
    const tip = `${name}\n${formatX(rawX)}   ${formatY(yv)}`;
    const proxied = h < MIN_BAR_HIT;
    nodes.push({
      type: "rect",
      x, y: top, w, h,
      fill,
      stroke: "none",
      corner: stacked ? "all" : (yv >= 0 ? "top" : "bottom"),
      valueY: y2,
      datum: row,
      series: name,
      tip,
      role: "bar",
      highlight: !stacked,
      ...(proxied ? { hit: false } : {}),
    });
    if (proxied) {
      // A zero or hairline bar paints (almost) nothing but must stay
      // hoverable: an invisible hit band straddles its value.
      const mid = top + h / 2;
      const hitTop = Math.min(top, Math.round(mid - MIN_BAR_HIT / 2));
      nodes.push({
        type: "rect",
        x, y: hitTop, w, h: Math.max(top + h, hitTop + MIN_BAR_HIT) - hitTop,
        fill,
        fillOpacity: 0,
        stroke: "none",
        corner: "none",
        valueY: y2,
        datum: row,
        series: name,
        tip,
        role: "bar",
        highlight: false,
      });
    }
    lastBarEndpointY = y2;
    lastBarValue = yv;
  }
  if (m.lastValue === true && lastBarEndpointY != null && lastBarValue != null) {
    lastValues.push({
      y: lastBarEndpointY,
      label: formatY(lastBarValue),
      color: m.fill || color,
      dash: true,
    });
  }
}
