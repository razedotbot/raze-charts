// Polar mark compilers: pie/donut slices and radar series with shared axes.

import { chartPalette } from "../theme";
import type { MarkCompileContext } from "./context";
import { pieSliceIds, seriesKeys, type LegendRowDraft, type MarkSeries, type SeriesInfo } from "./legend";
import { isBuiltinKind, type ChartMark, type PieChartMark, type RadarChartMark } from "./marks";
import { sceneSample } from "./cartesian";
import { asNumber, readChannel } from "./shared";

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * mag;
}

interface PieSlice {
  row: unknown;
  index: number;
  label: string;
  value: number;
  color: string;
  id: string;
  hidden: boolean;
}

/** Slices in data order. Colours and ids follow the data index, so hiding a slice never recolours another. */
function pieSlices(ctx: MarkCompileContext, m: PieChartMark, s: SeriesInfo, isHidden: (key: string) => boolean): PieSlice[] {
  const palette = chartPalette(ctx.theme);
  const labels = m.data.map((row, index) => String(readChannel(row as never, m.labelKey as never) ?? index));
  const ids = pieSliceIds(s.id, labels);
  return m.data.map((row, index) => {
    const value = asNumber(readChannel(row as never, m.valueKey as never));
    const id = ids[index]!;
    const label = labels[index]!;
    return {
      row,
      index,
      label,
      value: Number.isFinite(value) ? Math.max(0, value) : 0,
      color: palette[index % palette.length]!,
      id,
      hidden: s.hidden || isHidden(id) || isHidden(label),
    };
  });
}

function sliceRows(ctx: MarkCompileContext, slices: readonly PieSlice[], s: SeriesInfo): LegendRowDraft[] {
  const total = slices.reduce((sum, slice) => sum + (slice.hidden ? 0 : slice.value), 0);
  return slices.map((slice) => {
    let detail: string;
    let shortDetail: string;
    if (slice.hidden) {
      detail = shortDetail = ctx.formatY(slice.value);
    } else {
      const pct = total > 0 ? Math.round((slice.value / total) * 100) : 0;
      const same = Math.abs(slice.value - pct) < 0.51 && Math.abs(total - 100) < 0.51;
      shortDetail = `${pct}%`;
      detail = total <= 0 || same ? shortDetail : `${pct}%  ·  ${ctx.formatY(slice.value)}`;
    }
    return {
      id: slice.id,
      name: slice.label,
      color: slice.color,
      detail,
      shortDetail,
      hidden: slice.hidden,
      markIndex: s.markIndex,
      symbol: "rect",
      // A slice is hidden by its id or label, or by hiding the whole pie.
      keys: [slice.id, slice.label, ...seriesKeys(s)],
    };
  });
}

/** Legend rows of a pie whose mark is hidden: every slice, flagged hidden. */
export function pieLegendRows(ctx: MarkCompileContext, s: SeriesInfo, isHidden: (key: string) => boolean): LegendRowDraft[] {
  const mark = s.mark as PieChartMark;
  return sliceRows(ctx, pieSlices(ctx, mark, s, isHidden), s);
}

export function compilePie(
  ctx: MarkCompileContext,
  m: PieChartMark,
  s: MarkSeries,
  isHidden: (key: string) => boolean,
): void {
  const { plot, theme, nodes, legend } = ctx;
  const cx = plot.x + Math.round(plot.w / 2);
  const cy = plot.y + Math.round(plot.h / 2);
  const R = Math.max(1, Math.min(plot.w, plot.h) / 2 - 6);
  const outer = Math.min(R, m.outerRadius ?? R);
  const inner = Math.min(outer, m.innerRadius ?? outer * 0.66);
  const slices = pieSlices(ctx, m, s, isHidden);
  for (const row of sliceRows(ctx, slices, s)) legend.push(row);
  const shown = slices.filter((slice) => !slice.hidden);
  const total = shown.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) {
    nodes.push({
      type: "text",
      x: cx,
      y: cy,
      label: slices.some((slice) => slice.hidden && slice.value > 0) ? "All slices hidden" : "No data",
      fill: theme.muted,
      fontSize: 11,
      anchor: "middle",
      hit: false,
      role: "hole",
    });
    return;
  }
  let a0 = -Math.PI / 2;
  let top = shown[0]!;
  for (const slice of shown) if (slice.value > top.value) top = slice;
  for (const slice of shown) {
    const span = (slice.value / total) * Math.PI * 2;
    const a1 = a0 + span;
    const half = Math.min(0.036, span * 0.4);
    const pct = Math.round((slice.value / total) * 100);
    if (span <= 0) {
      a0 = a1;
      continue;
    }
    nodes.push({
      type: "arc",
      x: cx, y: cy, r: outer, innerR: inner,
      startAngle: a0 + half, endAngle: a1 - half,
      fill: slice.color,
      stroke: "none",
      datum: slice.row,
      series: slice.label,
      label: `${slice.label}  ${pct}%`,
      tip: `${slice.label}\n${pct}%`,
      role: "slice",
      idx: slice.index,
    });
    a0 = a1;
  }
  nodes.push({
    type: "text",
    x: cx, y: cy - 7,
    label: `${Math.round((top.value / total) * 100)}%`,
    fill: theme.text,
    fontSize: 20,
    anchor: "middle",
    series: s.name,
    hit: false,
    role: "hole",
  });
  nodes.push({
    type: "text",
    x: cx, y: cy + 12,
    label: top.label,
    fill: theme.muted,
    fontSize: 10,
    anchor: "middle",
    hit: false,
    role: "hole",
  });
}

/** Radar series share one radial scale and one set of rings/spokes. */
export interface RadarState {
  /** Nice ceiling of the largest radar value across all series. */
  max: number;
  axesDrawn: boolean;
}

export function createRadarState(marks: readonly ChartMark[]): RadarState {
  const radarRawMax = Math.max(
    1,
    ...marks.filter((mark) => isBuiltinKind(mark, "radar")).flatMap((mm) =>
      mm.data.map((row) => asNumber(readChannel(row as never, mm.y as never))),
    ).filter(Number.isFinite),
  );
  return { max: niceCeil(radarRawMax), axesDrawn: false };
}

export function compileRadar(
  ctx: MarkCompileContext,
  m: RadarChartMark,
  s: MarkSeries,
  radar: RadarState,
): void {
  const { plot, theme, nodes, samples, formatY, formatYValue } = ctx;
  const { name, color } = s;
  const cx = plot.x + plot.w / 2;
  const cy = plot.y + plot.h / 2;
  const R = Math.max(1, Math.min(plot.w, plot.h) / 2 - 22);
  const n = m.data.length || 1;
  const maxY = radar.max;
  if (!radar.axesDrawn) {
    radar.axesDrawn = true;
    for (const frac of [0.25, 0.5, 0.75, 1]) {
      const ring: { x: number; y: number }[] = [];
      for (let i = 0; i < n; i++) {
        const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
        ring.push({ x: cx + Math.cos(ang) * R * frac, y: cy + Math.sin(ang) * R * frac });
      }
      nodes.push({
        type: "polygon",
        points: ring,
        fill: "none",
        stroke: frac === 1 ? theme.axis : theme.grid,
        strokeWidth: frac === 1 ? 1.15 : 1,
        hit: false,
        role: "ring",
      });
    }
    m.data.forEach((row, i) => {
      const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
      nodes.push({
        type: "rule",
        x: cx, y: cy,
        x2: cx + Math.cos(ang) * R, y2: cy + Math.sin(ang) * R,
        stroke: theme.grid,
        strokeWidth: 1,
        dashed: false,
        hit: false,
        role: "spoke",
      });
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const lx = cx + ca * (R + 16);
      const ly = cy + sa * (R + 16) + (Math.abs(ca) < 0.35 ? (sa < 0 ? -1 : 3) : 0);
      nodes.push({
        type: "text",
        x: lx, y: ly,
        label: String(readChannel(row as never, m.x as never) ?? i),
        fill: theme.text,
        fontSize: 10,
        anchor: Math.abs(ca) < 0.35 ? "middle" : ca > 0 ? "start" : "end",
        hit: false,
        clip: false,
      });
    });
    for (const frac of [0.5, 1]) {
      nodes.push({
        type: "text",
        x: cx + 5,
        y: cy - R * frac,
        label: formatYValue(maxY * frac),
        fill: theme.muted,
        fontSize: 8,
        anchor: "start",
        hit: false,
        clip: false,
      });
    }
  }
  const pts: { x: number; y: number }[] = [];
  m.data.forEach((row, i) => {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const yv = asNumber(readChannel(row as never, m.y as never));
    const rr = R * (Number.isFinite(yv) ? yv / maxY : 0);
    pts.push({ x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr });
  });
  nodes.push({
    type: "polygon",
    points: pts,
    fill: m.fill || color,
    fillOpacity: m.fillOpacity ?? 0.12,
    stroke: color,
    strokeWidth: m.strokeWidth ?? 1.7,
    series: name,
    hit: false,
    role: "radar",
  });
  m.data.forEach((row, i) => {
    const p = pts[i]!;
    const axis = readChannel(row as never, m.x as never);
    const yv = asNumber(readChannel(row as never, m.y as never));
    const tip = `${name}\n${String(axis ?? i)}   ${formatY(yv)}`;
    nodes.push({
      type: "circle",
      x: p.x, y: p.y, r: 2.85,
      fill: color,
      stroke: theme.background,
      strokeWidth: 1.25,
      series: name,
      tip,
      role: "vertex",
    });
    samples.push(sceneSample(s, "radar", p, color, tip, { index: i, datum: row, xValue: axis ?? i, yValue: yv }));
  });
}
