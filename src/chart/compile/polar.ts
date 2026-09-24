// Polar mark compilers: pie/donut slices and radar series with shared axes.

import { chartPalette } from "../theme";
import type { MarkCompileContext } from "./context";
import { formatNum } from "./format";
import { isBuiltinKind, type ChartMark, type PieChartMark, type RadarChartMark } from "./marks";
import { asNumber, readChannel } from "./shared";

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * mag;
}

export function compilePie(ctx: MarkCompileContext, m: PieChartMark, name: string): void {
  const { plot, theme, nodes, legend } = ctx;
  const cx = plot.x + Math.round(plot.w / 2);
  const cy = plot.y + Math.round(plot.h / 2);
  const R = Math.max(1, Math.min(plot.w, plot.h) / 2 - 6);
  const outer = Math.min(R, m.outerRadius ?? R);
  const inner = Math.min(outer, m.innerRadius ?? outer * 0.66);
  const vals = m.data.map((row) => {
    const value = asNumber(readChannel(row as never, m.valueKey as never));
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  });
  const total = vals.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    for (let index = 0; index < m.data.length; index++) {
      const row = m.data[index];
      const label = String(readChannel(row as never, m.labelKey as never) ?? index);
      const palette = chartPalette(theme);
      legend.push({ name: label, color: palette[index % palette.length]!, detail: "0%" });
    }
    nodes.push({
      type: "text",
      x: cx,
      y: cy,
      label: "No data",
      fill: theme.muted,
      fontSize: 11,
      anchor: "middle",
      hit: false,
      role: "hole",
    });
    return;
  }
  let a0 = -Math.PI / 2;
  let topI = 0;
  vals.forEach((val, i) => { if (val > vals[topI]!) topI = i; });
  vals.forEach((val, i) => {
    const span = (val / total) * Math.PI * 2;
    const a1 = a0 + span;
    const half = Math.min(0.036, span * 0.4);
    const row = m.data[i];
    const label = String(readChannel(row as never, m.labelKey as never) ?? i);
    const palette = chartPalette(theme);
    const sliceColor = palette[i % palette.length]!;
    const pct = Math.round((val / total) * 100);
    const same = Math.abs(val - pct) < 0.51 && Math.abs(total - 100) < 0.51;
    legend.push({ name: label, color: sliceColor, detail: same ? `${pct}%` : `${pct}%  ·  ${formatNum(val)}` });
    if (span <= 0) {
      a0 = a1;
      return;
    }
    nodes.push({
      type: "arc",
      x: cx, y: cy, r: outer, innerR: inner,
      startAngle: a0 + half, endAngle: a1 - half,
      fill: sliceColor,
      stroke: "none",
      datum: row,
      series: label,
      label: `${label}  ${pct}%`,
      tip: `${label}\n${pct}%`,
      role: "slice",
      idx: i,
    });
    a0 = a1;
  });
  const topLabel = String(readChannel(m.data[topI] as never, m.labelKey as never) ?? topI);
  const topPct = Math.round((vals[topI]! / total) * 100);
  nodes.push({
    type: "text",
    x: cx, y: cy - 7,
    label: `${topPct}%`,
    fill: theme.text,
    fontSize: 20,
    anchor: "middle",
    series: name,
    hit: false,
    role: "hole",
  });
  nodes.push({
    type: "text",
    x: cx, y: cy + 12,
    label: topLabel,
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
  name: string,
  color: string,
  radar: RadarState,
): void {
  const { plot, theme, nodes, samples } = ctx;
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
        label: formatNum(maxY * frac),
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
    const axis = String(readChannel(row as never, m.x as never) ?? i);
    const yv = asNumber(readChannel(row as never, m.y as never));
    const tip = `${name}\n${axis}   ${formatNum(yv)}`;
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
    samples.push({ x: p.x, y: p.y, series: name, color, tip, kind: "radar" });
  });
}
