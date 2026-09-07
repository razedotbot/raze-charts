import { extent, scaleBand, scaleLinear, scaleLog, scaleTime, type AnyScale, type BandScale, type LinearScale } from "./scales";
import { CHART_PALETTE, heatFill, heatLabelColor, mixHex, rampFill, resolveChartTheme, type ChartThemeInput, type DashboardTheme } from "./theme";

export type Accessor<T> = keyof T & string | ((row: T) => unknown);

export function readChannel<T>(row: T, channel: Accessor<T> | undefined): unknown {
  if (channel == null) return undefined;
  if (typeof channel === "function") return channel(row);
  return (row as Record<string, unknown>)[channel];
}

export function asNumber(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "" && Number.isFinite(+value)) return +value;
  return NaN;
}

export type MarkKind = "line" | "area" | "bar" | "point" | "ruleY" | "pie" | "radar" | "heatmap";

export interface ChartMark {
  kind: MarkKind;
  data: readonly unknown[];
  x?: Accessor<never> | string;
  y?: Accessor<never> | string;
  y0?: Accessor<never> | string;
  name?: string;
  key?: Accessor<never> | string;
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
  r?: number;
  stackId?: string;
  innerRadius?: number;
  outerRadius?: number;
  angleKey?: string;
  valueKey?: string;
  labelKey?: string;
  /** Draw the last-value chip + dashed level. Default true for line/area. */
  lastValue?: boolean;
  dashed?: boolean;
  /** Histogram fade: later bars read as “now”. */
  fade?: boolean;
}

export function line<T>(data: readonly T[], opts: Omit<ChartMark, "kind" | "data"> & { x: Accessor<T> | string; y: Accessor<T> | string }): ChartMark {
  return { kind: "line", data, ...opts } as ChartMark;
}
export function area<T>(data: readonly T[], opts: Omit<ChartMark, "kind" | "data"> & { x: Accessor<T> | string; y: Accessor<T> | string }): ChartMark {
  return { kind: "area", data, ...opts } as ChartMark;
}
export function bar<T>(data: readonly T[], opts: Omit<ChartMark, "kind" | "data"> & { x: Accessor<T> | string; y: Accessor<T> | string }): ChartMark {
  return { kind: "bar", data, ...opts } as ChartMark;
}
export function point<T>(data: readonly T[], opts: Omit<ChartMark, "kind" | "data"> & { x: Accessor<T> | string; y: Accessor<T> | string }): ChartMark {
  return { kind: "point", data, ...opts } as ChartMark;
}
export function ruleY(values: readonly number[], opts?: Omit<ChartMark, "kind" | "data" | "x" | "y">): ChartMark {
  return { kind: "ruleY", data: values.map((y) => ({ y })), y: "y", ...opts };
}
export function pie<T>(data: readonly T[], opts: Omit<ChartMark, "kind" | "data"> & { valueKey?: Accessor<T> | string; labelKey?: Accessor<T> | string }): ChartMark {
  return { kind: "pie", data, ...opts } as ChartMark;
}
export function radar<T>(data: readonly T[], opts: Omit<ChartMark, "kind" | "data"> & { x: Accessor<T> | string; y: Accessor<T> | string }): ChartMark {
  return { kind: "radar", data, ...opts } as ChartMark;
}
export function heatmap<T>(data: readonly T[], opts: Omit<ChartMark, "kind" | "data"> & { x: Accessor<T> | string; y: Accessor<T> | string; valueKey?: Accessor<T> | string }): ChartMark {
  return { kind: "heatmap", data, ...opts } as ChartMark;
}

export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ScaleSpec {
  type?: "linear" | "band" | "time" | "log";
  nice?: boolean;
  padding?: number;
  domain?: unknown[];
}

export interface ChartSpec {
  marks: readonly ChartMark[];
  scales?: { x?: ScaleSpec; y?: ScaleSpec };
  width?: number;
  height?: number;
  margin?: Partial<Margin>;
  grid?: boolean;
  tooltip?: boolean;
  legend?: boolean;
  ariaLabel?: string;
  /** `"dark"` (default) matches the raze trading widget pane. */
  theme?: ChartThemeInput;
}

export interface ChartDefinition {
  spec(input: { width: number; height: number }): ChartSpec;
}

export function defineChart(spec: ChartSpec | ((input: { width: number; height: number }) => ChartSpec)): ChartDefinition {
  if (typeof spec === "function") return { spec };
  return { spec: () => spec };
}

const DEFAULT_MARGIN: Margin = { top: 14, right: 56, bottom: 26, left: 10 };
const PALETTE = [...CHART_PALETTE];

export interface SceneNode {
  type: "line" | "area" | "rect" | "circle" | "rule" | "arc" | "polygon" | "text";
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  w?: number;
  h?: number;
  r?: number;
  innerR?: number;
  startAngle?: number;
  endAngle?: number;
  points?: { x: number; y: number }[];
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
  dashed?: boolean;
  datum?: unknown;
  series?: string;
  label?: string;
  anchor?: "start" | "middle" | "end";
  fontSize?: number;
  corner?: "all" | "top" | "none";
  tip?: string;
  clip?: boolean;
  hit?: boolean;
  role?: string;
  idx?: number;
  highlight?: boolean;
}

export interface HoverSample {
  x: number;
  y: number;
  series: string;
  color: string;
  tip: string;
  kind: "line" | "point" | "radar";
}

export interface LastValue {
  y: number;
  label: string;
  color: string;
  dash?: boolean;
}

export interface CompiledChart {
  width: number;
  height: number;
  margin: Margin;
  plot: { x: number; y: number; w: number; h: number };
  xScale: AnyScale;
  yScale: AnyScale;
  xTicks: { value: unknown; px: number; label: string }[];
  yTicks: { value: unknown; px: number; label: string }[];
  grid: boolean;
  legend: { name: string; color: string; detail?: string }[];
  nodes: SceneNode[];
  tooltip: boolean;
  ariaLabel: string;
  polar: boolean;
  theme: DashboardTheme;
  lastValues: LastValue[];
  heatmap: boolean;
  colorBar: { min: number; max: number } | null;
  legendPlacement: "top" | "right" | "hidden";
  samples: HoverSample[];
}

function unique<T>(xs: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const k = String(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function seriesColor(mark: ChartMark, i: number): string {
  return mark.stroke || mark.fill || PALETTE[i % PALETTE.length]!;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatTick(value: unknown): string {
  if (typeof value === "number") {
    if (value > 1e11 && value < 1e14) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    }
    if (Math.abs(value) >= 1000) return value.toLocaleString("en-US");
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(Math.abs(value) < 1 ? 2 : 1);
  }
  if (value instanceof Date) {
    return `${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]}`;
  }
  return String(value ?? "");
}

function formatNum(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return Math.abs(value) >= 1000 ? value.toLocaleString("en-US") : String(value);
  if (Math.abs(value) >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return value.toFixed(Math.abs(value) < 1 ? 2 : 1);
}

function formatSigned(value: number): string {
  const body = Math.abs(value).toFixed(1);
  if (value > 0) return `+${body}`;
  if (value < 0) return `-${body}`;
  return body;
}

function snapRect(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const x1 = Math.round(x + w);
  const y1 = Math.round(y + h);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * mag;
}

function utcTimeTicks(lo: number, hi: number, maxTicks = 5): number[] {
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

function thinBandTicks<T>(domain: T[], plotW: number, heatmap: boolean): T[] {
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

function fitYAt(fit: { x: number; y: number }[], x: number): number | null {
  if (fit.length < 2) return null;
  const a = fit[0]!;
  const b = fit[fit.length - 1]!;
  const dx = b.x - a.x;
  if (Math.abs(dx) < 1e-9) return a.y;
  const t = (x - a.x) / dx;
  return a.y + t * (b.y - a.y);
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

export function compileChart(definition: ChartDefinition, size: { width: number; height: number }): CompiledChart {
  const spec = definition.spec(size);
  const theme = resolveChartTheme(spec.theme);
  const width = spec.width ?? size.width;
  const height = spec.height ?? size.height;
  const polar = spec.marks.some((m) => m.kind === "pie" || m.kind === "radar");
  const heatmap = spec.marks.some((m) => m.kind === "heatmap");
  const isPie = spec.marks.some((m) => m.kind === "pie");
  const isRadar = spec.marks.some((m) => m.kind === "radar");
  const hideLegend = spec.legend === false;
  const hasBar = spec.marks.some((m) => m.kind === "bar");
  const hasArea = spec.marks.some((m) => m.kind === "area");
  const barMarks = spec.marks.filter((m) => m.kind === "bar");
  const unstackedBars = barMarks.filter((m) => !m.stackId);
  const nUnstacked = Math.max(1, unstackedBars.length);
  const isHist = hasBar && nUnstacked === 1 && !barMarks.some((m) => m.stackId);

  const margin: Margin = polar
    ? isPie
      ? { top: 8, right: 152, bottom: 8, left: 8, ...spec.margin }
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

  let plot = {
    x: margin.left,
    y: margin.top,
    w: Math.max(1, width - margin.left - margin.right),
    h: Math.max(1, height - margin.top - margin.bottom),
  };

  const cartesianMarks = spec.marks.filter((m) => m.kind !== "pie" && m.kind !== "radar" && m.kind !== "ruleY" && m.kind !== "heatmap");

  const xValues: unknown[] = [];
  const yValues: number[] = [];
  for (const m of cartesianMarks) {
    for (const row of m.data) {
      xValues.push(readChannel(row as never, m.x as never));
      const y = asNumber(readChannel(row as never, m.y as never));
      if (Number.isFinite(y)) yValues.push(y);
    }
  }
  for (const m of spec.marks.filter((mm) => mm.kind === "ruleY")) {
    for (const row of m.data) {
      const y = asNumber(readChannel(row as never, m.y as never));
      if (Number.isFinite(y)) yValues.push(y);
    }
  }
  const stackMax = new Map<string, number>();
  for (const m of spec.marks.filter((mm) => mm.kind === "bar" && mm.stackId)) {
    for (const row of m.data) {
      const y = asNumber(readChannel(row as never, m.y as never));
      if (!Number.isFinite(y)) continue;
      const k = `${m.stackId}:${String(readChannel(row as never, m.x as never))}`;
      stackMax.set(k, (stackMax.get(k) ?? 0) + y);
    }
  }
  yValues.push(...stackMax.values());

  const xIsNumeric = xValues.length > 0 && xValues.every((v) => Number.isFinite(asNumber(v)));
  const xType = spec.scales?.x?.type ?? (xIsNumeric ? "linear" : "band");
  let xScale: AnyScale;
  let yScale: AnyScale = scaleLinear({ range: [plot.y + plot.h, plot.y] });

  if (heatmap) {
    const hm = spec.marks.find((m) => m.kind === "heatmap")!;
    const xs = unique(hm.data.map((row) => readChannel(row as never, hm.x as never) as string | number));
    const ys = unique(hm.data.map((row) => readChannel(row as never, hm.y as never) as string | number));
    const nX = Math.max(1, xs.length);
    const nY = Math.max(1, ys.length);
    const gap = 2;
    const cell = Math.max(1, Math.min(
      Math.floor((plot.w - (nX - 1) * gap) / nX),
      Math.floor((plot.h - (nY - 1) * gap) / nY),
    ));
    const gridW = nX * (cell + gap);
    const gridH = nY * (cell + gap);
    plot = {
      x: margin.left + Math.floor((plot.w - gridW) / 2),
      y: margin.top + Math.floor((plot.h - gridH) / 2),
      w: gridW,
      h: gridH,
    };
    const pad = gap / (cell + gap);
    xScale = scaleBand({
      domain: (spec.scales?.x?.domain as (string | number)[] | undefined) ?? xs,
      range: [plot.x, plot.x + plot.w],
      padding: spec.scales?.x?.padding ?? pad,
    });
    yScale = scaleBand({
      domain: (spec.scales?.y?.domain as (string | number)[] | undefined) ?? ys,
      range: [plot.y, plot.y + plot.h],
      padding: spec.scales?.y?.padding ?? pad,
    });
  } else if (xType === "band" || !xIsNumeric) {
    const domain = (spec.scales?.x?.domain as (string | number)[] | undefined) ?? unique(xValues.map((v) => v as string | number));
    const pad = spec.scales?.x?.padding ?? (nUnstacked > 1 ? 0.22 : isHist ? 0.14 : 0.26);
    xScale = scaleBand({
      domain,
      range: [plot.x, plot.x + plot.w],
      padding: pad,
    });
  } else {
    const xs = xValues.map(asNumber).filter(Number.isFinite);
    const raw = spec.scales?.x?.domain as [number, number] | undefined;
    let lo: number;
    let hi: number;
    if (raw) {
      lo = raw[0];
      hi = raw[1];
    } else {
      const ext = extent(xs);
      const span = (ext[1] - ext[0]) || 1;
      const pad = hasBar || hasArea ? 0 : span * 0.06;
      lo = ext[0] - pad;
      hi = ext[1] + pad;
    }
    const xRange: [number, number] = [plot.x, plot.x + plot.w];
    if (xType === "log") {
      xScale = scaleLog({ domain: [Math.max(lo, 1e-12), Math.max(hi, 1e-12)], range: xRange });
    } else if (xType === "time") {
      xScale = scaleTime({ domain: [lo, hi], range: xRange });
    } else {
      xScale = scaleLinear({ domain: [lo, hi], range: xRange, nice: spec.scales?.x?.nice ?? false });
    }
  }

  if (!heatmap) {
    if (spec.scales?.y?.type === "log") {
      const ys = yValues.map((v) => Math.max(v, 1e-12));
      const [lo, hi] = (spec.scales?.y?.domain as [number, number] | undefined) ?? extent(ys);
      yScale = scaleLog({
        domain: [Math.max(lo, 1e-12), Math.max(hi, 1e-12)],
        range: [plot.y + plot.h, plot.y],
      });
    } else {
      const includeZero = hasBar || hasArea;
      const raw = spec.scales?.y?.domain as [number, number] | undefined;
      let yLo: number;
      let yHi: number;
      if (raw) {
        yLo = raw[0];
        yHi = raw[1];
      } else {
        const ext = extent(includeZero ? [0, ...yValues] : yValues);
        const span = (ext[1] - ext[0]) || 1;
        const pad = includeZero ? span * 0.06 : span * 0.1;
        yLo = includeZero ? Math.min(0, ext[0]) : ext[0] - pad;
        yHi = ext[1] + pad;
      }
      yScale = scaleLinear({
        domain: [yLo, yHi],
        range: [plot.y + plot.h, plot.y],
        nice: spec.scales?.y?.nice ?? includeZero,
      });
    }
  }

  const xTickBudget = Math.max(2, Math.min(5, Math.floor(plot.w / 96)));
  const yTickBudget = Math.max(2, Math.min(6, Math.floor(plot.h / 52)));
  const xTicks = xScale.kind === "band"
    ? thinBandTicks((xScale as BandScale).domain, plot.w, heatmap).map((value) => ({
      value, px: xScale.map(value), label: formatTick(value),
    }))
    : (xType === "time"
      ? utcTimeTicks((xScale as LinearScale).domain[0], (xScale as LinearScale).domain[1], xTickBudget)
      : (xScale as LinearScale).ticks(xTickBudget)
    ).map((value) => ({
      value, px: xScale.map(value), label: formatTick(value),
    }));

  const yTicks = yScale.kind === "band"
    ? (yScale as BandScale).domain.map((value) => ({ value, px: yScale.map(value), label: formatTick(value) }))
    : (yScale as LinearScale).ticks(yTickBudget).map((value) => ({
      value, px: yScale.map(value), label: formatTick(value),
    }));

  const stackCursor = new Map<string, number>();
  const nodes: SceneNode[] = [];
  const legend: { name: string; color: string; detail?: string }[] = [];
  const lastValues: LastValue[] = [];
  const samples: HoverSample[] = [];
  let colorBar: { min: number; max: number } | null = null;
  let colorI = 0;
  let radarAxesDrawn = false;
  const radarRawMax = Math.max(
    1,
    ...spec.marks.filter((mm) => mm.kind === "radar").flatMap((mm) =>
      mm.data.map((row) => asNumber(readChannel(row as never, mm.y as never))),
    ).filter(Number.isFinite),
  );
  const radarMax = niceCeil(radarRawMax);

  const fitMark = spec.marks.find((mm) => mm.kind === "line" && mm.dashed);
  const fitPts = fitMark
    ? fitMark.data.map((row) => ({
      x: asNumber(readChannel(row as never, fitMark.x as never)),
      y: asNumber(readChannel(row as never, fitMark.y as never)),
    })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    : [];

  const mapX = (row: unknown, m: ChartMark): number => {
    const raw = readChannel(row as never, m.x as never);
    if (xScale.kind === "band") return xScale.map(raw as string);
    return xScale.map(asNumber(raw));
  };
  const mapY = (row: unknown, m: ChartMark): number => {
    const raw = readChannel(row as never, m.y as never);
    if (yScale.kind === "band") return yScale.map(raw as string);
    return yScale.map(asNumber(raw));
  };

  for (const m of spec.marks) {
    const color = seriesColor(m, colorI++);
    const name = m.name ?? (typeof m.y === "string" ? m.y : m.kind);
    if (m.kind !== "ruleY" && m.kind !== "pie" && m.kind !== "heatmap") legend.push({ name, color: m.fill || color });

    if (m.kind === "line" || m.kind === "area") {
      const pts: { x: number; y: number }[] = [];
      const rows: unknown[] = [];
      for (const row of m.data) {
        const x = mapX(row, m);
        const y = mapY(row, m);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        pts.push({ x, y });
        rows.push(row);
      }
      if (m.kind === "area" && pts.length) {
        nodes.push({
          type: "area",
          points: [
            { x: pts[0]!.x, y: plot.y + plot.h },
            ...pts,
            { x: pts[pts.length - 1]!.x, y: plot.y + plot.h },
          ],
          fill: m.fill || color,
          fillOpacity: m.fillOpacity ?? 0.28,
          stroke: "none",
          series: name,
          hit: false,
          role: "area",
        });
      }
      nodes.push({
        type: "line",
        points: pts,
        stroke: color,
        strokeWidth: m.strokeWidth ?? (m.dashed ? 1.15 : 1.85),
        fill: "none",
        dashed: m.dashed,
        series: name,
        hit: !m.dashed,
        role: m.dashed ? "fit" : "line",
      });
      if (!m.dashed) {
        for (let i = 0; i < pts.length; i++) {
          const row = rows[i];
          const xv = readChannel(row as never, m.x as never);
          const yv = asNumber(readChannel(row as never, m.y as never));
          const tip = `${name}\n${formatTick(xv)}   ${formatNum(yv)}`;
          samples.push({ x: pts[i]!.x, y: pts[i]!.y, series: name, color, tip, kind: "line" });
        }
      }
      const lastPt = pts[pts.length - 1];
      const lastRow = rows[rows.length - 1];
      if (lastPt && lastRow != null && m.lastValue !== false && !m.dashed) {
        lastValues.push({
          y: lastPt.y,
          label: formatTick(asNumber(readChannel(lastRow as never, m.y as never))),
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
    } else if (m.kind === "point") {
      const yDom = yScale.kind === "linear" ? (yScale as LinearScale).domain : [0, 1];
      const ySpan = yDom[1] - yDom[0] || 1;
      const xs = m.data.map((row) => asNumber(readChannel(row as never, m.x as never))).filter(Number.isFinite);
      const ys = m.data.map((row) => asNumber(readChannel(row as never, m.y as never))).filter(Number.isFinite);
      const [xLo, xHi] = extent(xs);
      const [yLo, yHi] = extent(ys);
      const residuals = fitPts.length >= 2
        ? m.data.map((row) => {
          const xv = asNumber(readChannel(row as never, m.x as never));
          const yv = asNumber(readChannel(row as never, m.y as never));
          const fy = fitYAt(fitPts, xv);
          return fy == null ? 0 : yv - fy;
        })
        : [];
      const mag = residuals.length ? Math.max(...residuals.map((r) => Math.abs(r)), 1e-6) : 0;
      for (const row of m.data) {
        const x = mapX(row, m);
        const y = mapY(row, m);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const xv = asNumber(readChannel(row as never, m.x as never));
        const yv = asNumber(readChannel(row as never, m.y as never));
        const yt = (yv - yLo) / ((yHi - yLo) || 1);
        const xt = (xv - xLo) / ((xHi - xLo) || 1);
        const fill = m.fill
          || (residuals.length
            ? heatFill(yv - (fitYAt(fitPts, xv) ?? yv), -mag, mag, theme)
            : rampFill((yv - yDom[0]) / ySpan, theme));
        const r = m.r ?? (2.15 + 2.5 * yt + 0.4 * xt);
        const tip = `${name}\n${formatNum(xv)}   ·   ${formatNum(yv)}`;
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
    } else if (m.kind === "ruleY") {
      for (const row of m.data) {
        const y = mapY(row, m);
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
    } else if (m.kind === "bar") {
      const stacked = !!m.stackId;
      const groupIndex = stacked ? 0 : Math.max(0, unstackedBars.indexOf(m));
      const nGroup = stacked ? 1 : nUnstacked;
      const innerGap = nGroup > 1 ? 3 : 0;
      let lastBar: SceneNode | null = null;
      const nRows = m.data.length;
      for (let ri = 0; ri < nRows; ri++) {
        const row = m.data[ri]!;
        const rawX = readChannel(row as never, m.x as never);
        const yv = asNumber(readChannel(row as never, m.y as never));
        if (!Number.isFinite(yv)) continue;
        const key = `${m.stackId ?? ""}:${String(rawX)}`;
        const base = stacked ? (stackCursor.get(key) ?? 0) : 0;
        if (stacked) stackCursor.set(key, base + yv);
        const y1 = yScale.map(stacked ? base : Math.min(0, yv));
        const y2 = yScale.map(stacked ? base + yv : yv);
        const top = Math.min(y1, y2);
        const h = Math.max(1, Math.abs(y2 - y1));
        let x: number;
        let w: number;
        if (xScale.kind === "band") {
          const xb = xScale as BandScale;
          const slot0 = xb.start(rawX as string);
          const slot1 = slot0 + xb.bandwidth();
          if (stacked) {
            const snapped = snapRect(slot0, top, xb.bandwidth(), h);
            x = snapped.x;
            w = snapped.w;
          } else {
            const slot = groupBarSlot(slot0, slot1, groupIndex, nGroup, innerGap);
            const snapped = snapRect(slot.x, top, slot.w, h);
            x = snapped.x;
            w = snapped.w;
          }
        } else {
          const bw = Math.max(2, plot.w / Math.max(1, nRows) * 0.62 / nGroup);
          const cx = xScale.map(asNumber(rawX)) - (bw * nGroup) / 2;
          const snapped = snapRect(cx + groupIndex * bw, top, bw, h);
          x = snapped.x;
          w = snapped.w;
        }
        const tFade = nRows <= 1 ? 1 : ri / (nRows - 1);
        const fill = m.fade
          ? mixHex("#1b1e20", m.fill || color, 0.22 + 0.78 * tFade)
          : (m.fill || color);
        const tip = `${name}\n${formatTick(rawX)}   ${formatNum(yv)}`;
        lastBar = {
          type: "rect",
          x, y: Math.round(top), w, h: Math.max(1, Math.round(top + h) - Math.round(top)),
          fill,
          stroke: "none",
          corner: stacked ? "all" : "top",
          datum: row,
          series: name,
          tip,
          role: "bar",
          highlight: !stacked,
        };
        nodes.push(lastBar);
      }
      if (lastBar && m.lastValue === true && lastBar.y != null) {
        lastValues.push({
          y: lastBar.y,
          label: formatTick(asNumber(readChannel(m.data[m.data.length - 1] as never, m.y as never))),
          color: m.fill || color,
          dash: true,
        });
      }
    } else if (m.kind === "heatmap") {
      const xb = xScale as BandScale;
      const yb = yScale as BandScale;
      const zs = m.data.map((row) => asNumber(readChannel(row as never, (m.valueKey ?? "value") as never)));
      let [zLo, zHi] = extent(zs);
      if (zLo < 0 && zHi > 0) {
        const mag = Math.max(Math.abs(zLo), zHi);
        zLo = -mag;
        zHi = mag;
      }
      colorBar = { min: zLo, max: zHi };
      for (const row of m.data) {
        const xv = readChannel(row as never, m.x as never);
        const yv = readChannel(row as never, m.y as never);
        const zv = asNumber(readChannel(row as never, (m.valueKey ?? "value") as never));
        if (!Number.isFinite(zv)) continue;
        const snapped = snapRect(xb.start(xv as string), yb.start(yv as string), xb.bandwidth(), yb.bandwidth());
        const fill = heatFill(zv, zLo, zHi, theme);
        const tip = `${String(yv)}  ·  ${String(xv)}\n${formatSigned(zv)}%`;
        nodes.push({
          type: "rect",
          ...snapped,
          fill,
          stroke: "none",
          corner: "none",
          datum: row,
          series: String(yv),
          label: formatSigned(zv),
          tip,
          role: "heat",
        });
        if (snapped.w >= 34 && snapped.h >= 18) {
          nodes.push({
            type: "text",
            x: snapped.x + snapped.w / 2,
            y: snapped.y + snapped.h / 2,
            label: formatSigned(zv),
            fill: heatLabelColor(fill, theme),
            fontSize: 9,
            anchor: "middle",
            hit: false,
          });
        }
      }
    } else if (m.kind === "pie") {
      const cx = plot.x + Math.round(plot.w / 2);
      const cy = plot.y + Math.round(plot.h / 2);
      const R = Math.min(plot.w, plot.h) / 2 - 6;
      const inner = m.innerRadius ?? R * 0.66;
      const vals = m.data.map((row) => Math.max(0, asNumber(readChannel(row as never, (m.valueKey ?? m.y ?? "value") as never))));
      const total = vals.reduce((a, b) => a + b, 0) || 1;
      let a0 = -Math.PI / 2;
      let topI = 0;
      vals.forEach((val, i) => { if (val > vals[topI]!) topI = i; });
      vals.forEach((val, i) => {
        const span = (val / total) * Math.PI * 2;
        const a1 = a0 + span;
        const half = Math.min(0.036, span * 0.4);
        const row = m.data[i];
        const label = String(readChannel(row as never, (m.labelKey ?? m.x ?? "name") as never) ?? i);
        const sliceColor = PALETTE[i % PALETTE.length]!;
        const pct = Math.round((val / total) * 100);
        const same = Math.abs(val - pct) < 0.51 && Math.abs(total - 100) < 0.51;
        legend.push({ name: label, color: sliceColor, detail: same ? `${pct}%` : `${pct}%  ·  ${formatNum(val)}` });
        nodes.push({
          type: "arc",
          x: cx, y: cy, r: m.outerRadius ?? R, innerR: inner,
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
      const topLabel = String(readChannel(m.data[topI] as never, (m.labelKey ?? m.x ?? "name") as never) ?? "");
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
    } else if (m.kind === "radar") {
      const cx = plot.x + plot.w / 2;
      const cy = plot.y + plot.h / 2;
      const R = Math.min(plot.w, plot.h) / 2 - 22;
      const n = m.data.length || 1;
      const maxY = radarMax;
      if (!radarAxesDrawn) {
        radarAxesDrawn = true;
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
  }

  const legendPlacement: CompiledChart["legendPlacement"] = hideLegend
    ? "hidden"
    : isPie
      ? "right"
      : isRadar
        ? "hidden"
        : "top";

  return {
    width, height, margin, plot,
    xScale, yScale, xTicks, yTicks,
    grid: heatmap ? spec.grid === true : spec.grid !== false,
    legend: hideLegend ? [] : unique(legend.map((l) => l.name)).map((n) => legend.find((l) => l.name === n)!),
    legendPlacement,
    nodes,
    tooltip: spec.tooltip !== false,
    ariaLabel: spec.ariaLabel ?? "Chart",
    polar,
    heatmap,
    colorBar,
    theme,
    lastValues,
    samples,
  };
}
