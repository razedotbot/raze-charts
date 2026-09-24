// Cartesian mark compilers: line/area (with gap segments and decimation),
// point, ruleY, ruleX, and grouped/stacked bars.

import { mixHex, rampFill } from "../theme";
import type { BandScale, LinearScale } from "../scales";
import { extent } from "../scales";
import type { MarkCompileContext } from "./context";
import { decimateSegments, type SeriesSegment } from "./decimate";
import { formatNum } from "./format";
import {
  isBuiltinKind,
  type AreaChartMark,
  type BarChartMark,
  type ChartMark,
  type LineChartMark,
  type PointChartMark,
  type RuleXChartMark,
  type RuleYChartMark,
} from "./marks";
import { asNumber, readChannel, snapRect, stackKey, unique } from "./shared";
import type { SceneNode } from "./types";

export function compileLineArea(ctx: MarkCompileContext, m: LineChartMark | AreaChartMark, name: string, color: string): void {
  const { spec, plot, theme, yScale, nodes, samples, lastValues, formatX } = ctx;
  const rawSegments: SeriesSegment<unknown>[] = [];
  let segment: SeriesSegment<unknown> = { points: [], rows: [] };
  for (const row of m.data) {
    const x = ctx.mapX(row, m);
    const y = ctx.mapY(row, m);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (segment.points.length) rawSegments.push(segment);
      segment = { points: [], rows: [] };
      continue;
    }
    segment.points.push({ x, y });
    segment.rows.push(row);
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

  for (const current of segments) {
    const { points: pts, rows } = current;
    const curve = m.curve ?? "monotone";
    if (m.kind === "area" && pts.length) {
      const mappedZero = yScale.kind === "linear" ? yScale.map(0) : plot.y + plot.h;
      const baseline = Math.max(plot.y, Math.min(plot.y + plot.h, mappedZero));
      if (m.y0) {
        const lower: { x: number; y: number }[] = [];
        for (let i = 0; i < pts.length; i++) {
          const y0 = asNumber(readChannel(rows[i] as never, m.y0 as never));
          const y = Number.isFinite(y0) && yScale.kind === "linear" ? yScale.map(y0) : baseline;
          lower.push({ x: pts[i]!.x, y });
        }
        nodes.push({
          type: "area",
          points: [...pts, ...lower.slice().reverse()],
          fill: m.fill || color,
          fillOpacity: m.fillOpacity ?? 0.28,
          stroke: "none",
          series: name,
          hit: false,
          role: "ranged-area",
          curve: "linear",
        });
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
      strokeWidth: m.strokeWidth ?? (m.dashed ? 1.15 : 1.85),
      fill: "none",
      dashed: m.dashed,
      series: name,
      hit: true,
      role: "line",
      curve,
    });
    if (pts.length === 1) {
      const row = rows[0];
      const xv = readChannel(row as never, m.x as never);
      const yv = asNumber(readChannel(row as never, m.y as never));
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
        tip: `${name}\n${formatX(xv)}   ${formatNum(yv)}`,
        role: "point",
      });
    }
    for (let i = 0; i < pts.length; i++) {
      const row = rows[i];
      const xv = readChannel(row as never, m.x as never);
      const yv = asNumber(readChannel(row as never, m.y as never));
      const tip = `${name}\n${formatX(xv)}   ${formatNum(yv)}`;
      samples.push({ x: pts[i]!.x, y: pts[i]!.y, series: name, color, tip, kind: "line" });
    }
  }

  // Presentation budgets may choose extrema over the final sample. The
  // last-value chip and endpoint still describe the actual source tail.
  const lastPt = rawFinalSegment?.points[rawFinalSegment.points.length - 1];
  const lastRow = rawFinalSegment?.rows[rawFinalSegment.rows.length - 1];
  if (lastPt && lastRow != null && m.lastValue !== false) {
    lastValues.push({
      y: lastPt.y,
      label: formatNum(asNumber(readChannel(lastRow as never, m.y as never))),
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

export function compilePoint(ctx: MarkCompileContext, m: PointChartMark, name: string): void {
  const { plot, theme, yScale, nodes, samples, formatX } = ctx;
  const yDom = yScale.kind === "linear" ? (yScale as LinearScale).domain : [0, 1];
  const ySpan = yDom[1]! - yDom[0]! || 1;
  const xs = m.data.map((row) => asNumber(readChannel(row as never, m.x as never))).filter(Number.isFinite);
  const ys = m.data.map((row) => asNumber(readChannel(row as never, m.y as never))).filter(Number.isFinite);
  const [xLo, xHi] = extent(xs);
  const [yLo, yHi] = extent(ys);
  for (const row of m.data) {
    const x = ctx.mapX(row, m);
    const y = ctx.mapY(row, m);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const rawX = readChannel(row as never, m.x as never);
    const xv = asNumber(rawX);
    const yv = asNumber(readChannel(row as never, m.y as never));
    const yt = (yv - yLo) / ((yHi - yLo) || 1);
    const xt = Number.isFinite(xv)
      ? (xv - xLo) / ((xHi - xLo) || 1)
      : (x - plot.x) / (plot.w || 1);
    const fill = m.fill
      || rampFill((yv - yDom[0]!) / ySpan, theme);
    const requestedRadius = m.r ?? (2.15 + 2.5 * yt + 0.4 * xt);
    const r = Number.isFinite(requestedRadius) ? Math.max(0, requestedRadius) : 3;
    const tip = `${name}\n${formatX(rawX)}   ·   ${formatNum(yv)}`;
    nodes.push({
      type: "circle",
      x, y, r,
      fill,
      fillOpacity: m.fillOpacity ?? 0.78,
      stroke: "none",
      datum: row,
      series: name,
      tip,
      role: "point",
    });
    samples.push({ x, y, series: name, color: fill, tip, kind: "point" });
  }
}

export function compileRuleY(ctx: MarkCompileContext, m: RuleYChartMark, name: string, color: string): void {
  const { plot, theme, nodes, lastValues } = ctx;
  for (const row of m.data) {
    const y = ctx.mapY(row, m);
    if (!Number.isFinite(y)) continue;
    const yv = asNumber(readChannel(row as never, m.y as never));
    nodes.push({
      type: "rule",
      x: plot.x, y, x2: plot.x + plot.w, y2: y,
      stroke: m.stroke || color,
      strokeWidth: m.strokeWidth ?? 1,
      dashed: true,
      series: name,
      hit: false,
      role: "rule",
    });
    nodes.push({
      type: "text",
      x: plot.x + 6,
      y: y - 7,
      label: `${name}  ${formatNum(yv)}`,
      fill: m.stroke || theme.gold,
      fontSize: 9,
      anchor: "start",
      hit: false,
      clip: true,
    });
    lastValues.push({
      y,
      label: formatNum(yv),
      color: m.stroke || color,
      dash: false,
    });
  }
}

export function compileRuleX(ctx: MarkCompileContext, m: RuleXChartMark, name: string, color: string): void {
  const { plot, theme, nodes, formatX } = ctx;
  for (const row of m.data) {
    const x = ctx.mapXValue(readChannel(row as never, m.x as never));
    if (!Number.isFinite(x)) continue;
    const xv = readChannel(row as never, m.x as never);
    nodes.push({
      type: "rule",
      x, y: plot.y, x2: x, y2: plot.y + plot.h,
      stroke: m.stroke || color,
      strokeWidth: m.strokeWidth ?? 1,
      dashed: true,
      series: name,
      hit: false,
      role: "rule",
    });
    nodes.push({
      type: "text",
      x: x + 6,
      y: plot.y + 12,
      label: `${name}  ${formatX(xv)}`,
      fill: m.stroke || theme.gold,
      fontSize: 9,
      anchor: "start",
      hit: false,
      clip: true,
    });
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

export function compileBar(ctx: MarkCompileContext, m: BarChartMark, name: string, color: string, bars: BarState): void {
  const { xScale, yScale, xType, nodes, lastValues, formatX } = ctx;
  const stacked = !!m.stackId;
  const groupIndex = bars.plan.groupByMark.get(m) ?? 0;
  const nGroup = bars.plan.groupCount;
  const innerGap = nGroup > 1 ? 3 : 0;
  let lastBar: SceneNode | null = null;
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
    const top = Math.min(y1, y2);
    const h = Math.max(1, Math.abs(y2 - y1));
    let x: number;
    let w: number;
    if (xScale.kind === "band") {
      const xb = xScale as BandScale<string | number>;
      const slot0 = mappedBarX;
      const slot1 = slot0 + xb.bandwidth();
      const slot = groupBarSlot(slot0, slot1, groupIndex, nGroup, innerGap);
      const snapped = snapRect(slot.x, top, slot.w, h);
      x = snapped.x;
      w = snapped.w;
    } else {
      const center = mappedBarX;
      const slot = groupBarSlot(
        center - bars.numericClusterWidth / 2,
        center + bars.numericClusterWidth / 2,
        groupIndex,
        nGroup,
        innerGap,
      );
      const snapped = snapRect(slot.x, top, slot.w, h);
      x = snapped.x;
      w = snapped.w;
    }
    const tFade = nRows <= 1 ? 1 : ri / (nRows - 1);
    const fill = m.fade
      ? mixHex("#1b1e20", m.fill || color, 0.22 + 0.78 * tFade)
      : (m.fill || color);
    const tip = `${name}\n${formatX(rawX)}   ${formatNum(yv)}`;
    lastBar = {
      type: "rect",
      x, y: Math.round(top), w, h: Math.max(1, Math.round(top + h) - Math.round(top)),
      fill,
      stroke: "none",
      corner: stacked ? "all" : (yv >= 0 ? "top" : "bottom"),
      valueY: y2,
      datum: row,
      series: name,
      tip,
      role: "bar",
      highlight: !stacked,
    };
    nodes.push(lastBar);
    lastBarEndpointY = y2;
    lastBarValue = yv;
  }
  if (lastBar && m.lastValue === true && lastBarEndpointY != null && lastBarValue != null) {
    lastValues.push({
      y: lastBarEndpointY,
      label: formatNum(lastBarValue),
      color: m.fill || color,
      dash: true,
    });
  }
}
