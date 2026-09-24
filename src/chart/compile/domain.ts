// Domains: viewport windowing, X scale-type inference, data-driven domain
// validation, and the Cartesian X/Y scales. Heatmap scales live in ./heatmap.

import { extent, scaleBand, scaleLinear, scaleLog, scaleTime, type AnyScale, type BandScale } from "../scales";
import { ChartCompileError } from "./errors";
import { isBuiltinKind, isBuiltinMark, isPluginMark, type BarChartMark, type CartesianChartMark, type ChartMark } from "./marks";
import type { BarPlan } from "./cartesian";
import { asNumber, finiteBounds, isBandCategory, readChannel, stackKey, unique } from "./shared";
import type {
  ChartSpec,
  ChartViewport,
  MarkDomainContribution,
  PlotRect,
  XScaleKind,
  XScaleSpec,
} from "./types";

export function isQuantitativeViewportX(
  x: NonNullable<ChartViewport["x"]>,
): x is readonly [number | Date, number | Date] {
  return x.length === 2 && Number.isFinite(asNumber(x[0])) && Number.isFinite(asNumber(x[1]));
}

function rowXValue(mark: ChartMark, row: unknown): unknown {
  if (isPluginMark(mark) || mark.kind === "ruleY" || mark.kind === "pie") return undefined;
  const x = "x" in mark ? mark.x : undefined;
  if (x == null) return undefined;
  return readChannel(row as never, x as never);
}

function windowMarkData(mark: ChartMark, viewport: ChartViewport | undefined): readonly unknown[] {
  if (!viewport?.x) return mark.data;
  const xWin = viewport.x;
  if (isQuantitativeViewportX(xWin)) {
    const lo = Math.min(asNumber(xWin[0]), asNumber(xWin[1]));
    const hi = Math.max(asNumber(xWin[0]), asNumber(xWin[1]));
    const values = mark.data.map((row) => asNumber(rowXValue(mark, row)));
    const keep = new Set<number>();
    for (let i = 0; i < values.length; i++) {
      const x = values[i]!;
      if (Number.isFinite(x) && x >= lo && x <= hi) keep.add(i);
    }
    if (mark.kind === "line" || mark.kind === "area") {
      const indices = Array.from(keep).sort((a, b) => a - b);
      if (indices.length) {
        const first = indices[0]!;
        const last = indices[indices.length - 1]!;
        if (first > 0 && Number.isFinite(values[first - 1])) keep.add(first - 1);
        if (last < values.length - 1 && Number.isFinite(values[last + 1])) keep.add(last + 1);
      }
    }
    return mark.data.filter((_, index) => keep.has(index));
  }
  const allowed = new Set(xWin.map(String));
  return mark.data.filter((row) => {
    const x = rowXValue(mark, row);
    return x == null || !isBandCategory(x) || allowed.has(String(x));
  });
}

/**
 * True when the marks' x values are Dates: every Cartesian mark (hidden ones
 * included) votes with its first x value, and gaps (null, objects) do not
 * vote, as in collectDomainValues. One value per mark keeps pan and zoom
 * compiles from rescanning the data.
 */
function marksHaveDateX(marks: readonly ChartMark[]): boolean {
  let dates = false;
  for (const mark of marks) {
    if (!isBuiltinMark(mark) || !(mark.kind === "line" || mark.kind === "area" || mark.kind === "bar" || mark.kind === "point")) continue;
    for (const row of mark.data) {
      const x = rowXValue(mark, row);
      if (x instanceof Date) {
        dates = true;
        break;
      }
      if (isBandCategory(x)) return false;
    }
  }
  return dates;
}

/**
 * Apply the viewport to already legend-filtered marks: rows outside the X
 * window are dropped before geometry, and the window becomes the scale domain.
 * Returns the input spec unchanged when there is nothing to window.
 */
export function windowChartSpec(spec: ChartSpec, visibleMarks: readonly ChartMark[]): ChartSpec {
  let marks = visibleMarks;
  const viewport = spec.viewport;
  if (!viewport?.x && !viewport?.y && marks === spec.marks) return spec;
  // The scale type comes from the whole data set, before windowing: a window
  // must never turn a Date axis into a linear one (or guess from magnitude).
  const windowXType = viewport?.x && isQuantitativeViewportX(viewport.x)
    ? spec.scales?.x?.type ?? (viewport.x.some((end) => end instanceof Date) || marksHaveDateX(spec.marks) ? "time" : undefined)
    : undefined;
  marks = marks.map((mark) => ({ ...mark, data: windowMarkData(mark, viewport) }));
  const scales = { ...spec.scales };
  if (viewport?.x) {
    if (isQuantitativeViewportX(viewport.x)) {
      const lo = Math.min(asNumber(viewport.x[0]), asNumber(viewport.x[1]));
      const hi = Math.max(asNumber(viewport.x[0]), asNumber(viewport.x[1]));
      scales.x = {
        ...scales.x,
        ...(windowXType ? { type: windowXType } : {}),
        domain: [lo, hi],
      } as XScaleSpec;
    } else {
      scales.x = {
        type: "band",
        ...(spec.scales?.x?.type === "band" ? spec.scales.x : {}),
        domain: [...viewport.x],
      };
    }
  }
  if (viewport?.y) {
    const yLo = Math.min(viewport.y[0], viewport.y[1]);
    const yHi = Math.max(viewport.y[0], viewport.y[1]);
    scales.y = { ...scales.y, domain: [yLo, yHi] };
  }
  return { ...spec, marks, scales };
}

export interface DomainValues {
  xValues: unknown[];
  yValues: number[];
}

/** Raw X categories/values and finite Y values contributed by every Cartesian source. */
export function collectDomainValues(
  spec: ChartSpec,
  cartesianMarks: readonly CartesianChartMark[],
  pluginDomains: ReadonlyMap<ChartMark, MarkDomainContribution>,
): DomainValues {
  const xValues: unknown[] = [];
  const yValues: number[] = [];
  for (const m of cartesianMarks) {
    for (const row of m.data) {
      const x = readChannel(row as never, m.x as never);
      // Nullable/object category accessors represent gaps, not anonymous bands.
      if (!isBandCategory(x) && !(x instanceof Date)) continue;
      xValues.push(x);
      const y = asNumber(readChannel(row as never, m.y as never));
      if (Number.isFinite(y)) yValues.push(y);
      if (m.kind === "area" && m.y0 != null) {
        const y0 = asNumber(readChannel(row as never, m.y0 as never));
        if (Number.isFinite(y0)) yValues.push(y0);
      }
    }
  }
  for (const contribution of pluginDomains.values()) {
    if (contribution.x) {
      for (const value of contribution.x) xValues.push(value);
    }
    if (contribution.y) {
      for (const value of contribution.y) {
        if (Number.isFinite(value)) yValues.push(value);
      }
    }
  }
  for (const m of spec.marks.filter((mark) => isBuiltinKind(mark, "ruleY"))) {
    for (const row of m.data) {
      const y = asNumber(readChannel(row as never, m.y as never));
      if (Number.isFinite(y)) yValues.push(y);
    }
  }
  for (const m of spec.marks.filter((mark) => isBuiltinKind(mark, "ruleX"))) {
    for (const row of m.data) {
      const x = readChannel(row as never, m.x as never);
      if (isBandCategory(x) || x instanceof Date) xValues.push(x);
    }
  }
  return { xValues, yValues };
}

/** Explicit scales.x.type, else time for Dates, band for categories, linear otherwise. */
export function inferXType(spec: ChartSpec, xValues: readonly unknown[]): XScaleKind {
  const explicitXType = spec.scales?.x?.type;
  const configuredXDomain = spec.scales?.x?.domain as readonly unknown[] | undefined;
  const configuredDomainIsQuantitative = configuredXDomain?.length === 2
    && configuredXDomain.every((value) => Number.isFinite(asNumber(value)));
  const xIsNumeric = xValues.length > 0 && xValues.every((value) => Number.isFinite(asNumber(value)));
  const xIsTime = xValues.length > 0 && xValues.every((value) => value instanceof Date);
  return explicitXType ?? (
    xIsTime ? "time" : !xIsNumeric && !configuredDomainIsQuantitative ? "band" : "linear"
  );
}

/** Stacked bars extend the Y domain by their positive and negative totals per slot. */
export function appendStackExtents(spec: ChartSpec, xType: XScaleKind, yValues: number[]): void {
  const stackTotals = new Map<string, { positive: number; negative: number }>();
  for (const m of spec.marks.filter((mark): mark is BarChartMark => isBuiltinKind(mark, "bar") && !!mark.stackId)) {
    for (const row of m.data) {
      const rawX = readChannel(row as never, m.x as never);
      const y = asNumber(readChannel(row as never, m.y as never));
      const validX = xType === "band" ? isBandCategory(rawX) : Number.isFinite(asNumber(rawX));
      if (!validX || !Number.isFinite(y)) continue;
      const key = stackKey(m.stackId!, rawX, xType !== "band");
      const total = stackTotals.get(key) ?? { positive: 0, negative: 0 };
      if (y >= 0) total.positive += y;
      else total.negative += y;
      stackTotals.set(key, total);
    }
  }
  for (const total of stackTotals.values()) yValues.push(total.positive, total.negative);
}

export interface CartesianDomainInput extends DomainValues {
  xType: XScaleKind;
  cartesianMarks: readonly CartesianChartMark[];
  pluginDomains: ReadonlyMap<ChartMark, MarkDomainContribution>;
  hasBar: boolean;
  hasArea: boolean;
}

/** Reject data that cannot be represented by the resolved Cartesian scales. */
export function validateCartesianDomain(spec: ChartSpec, input: CartesianDomainInput): void {
  const { xType, xValues, yValues, cartesianMarks, pluginDomains, hasBar, hasArea } = input;
  const configuredXDomain = spec.scales?.x?.domain as readonly unknown[] | undefined;
  if (xType !== "band" && xValues.some((value) => !Number.isFinite(asNumber(value)))) {
    throw new ChartCompileError(
      "E_SCALE_DOMAIN",
      `scales.x.type "${xType}" requires numeric or Date-compatible x values. Use type "band" for categories.`,
    );
  }
  if (xType !== "band" && configuredXDomain !== undefined) {
    if (configuredXDomain.length !== 2 || !configuredXDomain.every((value) => Number.isFinite(asNumber(value)))) {
      throw new ChartCompileError(
        "E_SCALE_DOMAIN",
        "A quantitative scales.x.domain must contain exactly two finite number or Date endpoints.",
      );
    }
  }
  if (xType === "band" && configuredXDomain !== undefined) {
    for (const category of configuredXDomain) {
      if ((typeof category !== "string" && typeof category !== "number") || (typeof category === "number" && !Number.isFinite(category))) {
        throw new ChartCompileError(
          "E_SCALE_DOMAIN",
          `A band scales.x.domain contains an invalid category (${String(category)}).`,
        );
      }
    }
    for (const mark of cartesianMarks) {
      for (const row of mark.data) {
        const category = readChannel(row as never, mark.x as never);
        if (isBandCategory(category) && !configuredXDomain.includes(category)) {
          throw new ChartCompileError(
            "E_SCALE_DOMAIN",
            `scales.x.domain does not contain category ${JSON.stringify(category)} used by a ${mark.kind} mark.`,
          );
        }
      }
    }
    for (const contribution of pluginDomains.values()) {
      for (const category of contribution.x ?? []) {
        if (isBandCategory(category) && !configuredXDomain.includes(category)) {
          throw new ChartCompileError(
            "E_SCALE_DOMAIN",
            `scales.x.domain does not contain category ${JSON.stringify(category)} contributed by a plugin.`,
          );
        }
      }
    }
  }
  if (xType === "band" && spec.scales?.x?.nice !== undefined) {
    throw new ChartCompileError("E_SCALE_TYPE", "scales.x.nice is not supported when the inferred scale is band.");
  }
  if (xType !== "band" && spec.scales?.x?.padding !== undefined) {
    throw new ChartCompileError("E_SCALE_TYPE", "scales.x.padding requires a band scale or categorical data.");
  }
  if (
    xType === "log"
    && xValues.some((value) => Number.isFinite(asNumber(value)) && asNumber(value) <= 0)
  ) {
    throw new ChartCompileError("E_SCALE_DOMAIN", "A log x scale requires every finite x value to be greater than zero.");
  }
  if (spec.scales?.y?.type === "log") {
    if (hasBar || hasArea) {
      throw new ChartCompileError(
        "E_SCALE_TYPE",
        "Bar and area marks require a zero baseline and cannot use a log y scale. Use line/point marks or a linear y scale.",
      );
    }
    if (yValues.some((value) => value <= 0)) {
      throw new ChartCompileError("E_SCALE_DOMAIN", "A log y scale requires every finite y value to be greater than zero.");
    }
  }
}

export interface CartesianXScaleInput {
  xType: XScaleKind;
  xValues: readonly unknown[];
  plot: PlotRect;
  bars: BarPlan;
  hasArea: boolean;
}

/**
 * Band X scales by the compile's X values. Every layout pass asks for the
 * X scale of a new plot, but a band domain does not depend on the plot, and
 * building one indexes every category: later passes of the same compile
 * (xValues is collected afresh per compile) move the first scale's range.
 */
const bandXScales = new WeakMap<readonly unknown[], BandScale<string | number>>();

/** Band, log, time, or linear X scale. Bars pad the domain by half a slot. */
export function cartesianXScale(spec: ChartSpec, input: CartesianXScaleInput): AnyScale {
  const { xType, xValues, plot, bars, hasArea } = input;
  const hasBar = bars.marks.length > 0;
  if (xType === "band") {
    const range: [number, number] = [plot.x, plot.x + plot.w];
    let scale = bandXScales.get(xValues);
    if (scale) {
      scale.range = range;
      return scale;
    }
    const domain = (spec.scales?.x?.domain as (string | number)[] | undefined) ?? unique(xValues.map((v) => v as string | number));
    const pad = spec.scales?.x?.padding ?? (bars.groupCount > 1 ? 0.22 : bars.isHist ? 0.14 : 0.26);
    scale = scaleBand({ domain, range, padding: pad });
    bandXScales.set(xValues, scale);
    return scale;
  }
  const xs = xValues.map(asNumber).filter(Number.isFinite);
  const configured = spec.scales?.x?.domain as readonly unknown[] | undefined;
  const raw = configured
    ? [asNumber(configured[0]), asNumber(configured[1])] as [number, number]
    : undefined;
  let lo: number;
  let hi: number;
  if (raw) {
    lo = raw[0];
    hi = raw[1];
  } else {
    const dataBounds = finiteBounds(xs);
    const dataLo = dataBounds?.[0] ?? (xType === "log" ? 1 : 0);
    const dataHi = dataBounds?.[1] ?? (xType === "log" ? 10 : 1);
    const span = dataHi - dataLo;
    if (hasBar) {
      const barXs = unique(bars.marks.flatMap((mark) => mark.data
        .map((row) => asNumber(readChannel(row as never, mark.x as never)))
        .filter(Number.isFinite))).sort((a, b) => a - b);
      if (xType === "log") {
        let ratio = 2;
        for (let index = 1; index < barXs.length; index++) {
          const candidate = barXs[index]! / barXs[index - 1]!;
          if (candidate > 1 && candidate < ratio) ratio = candidate;
        }
        const factor = Math.sqrt(ratio);
        const firstBar = barXs[0] ?? dataLo;
        const lastBar = barXs[barXs.length - 1] ?? Math.max(dataHi, firstBar);
        const lowerBar = firstBar / factor || firstBar;
        const upperBar = Number.isFinite(lastBar * factor) ? lastBar * factor : lastBar;
        lo = Math.min(dataLo, lowerBar);
        hi = Math.max(dataHi, upperBar);
      } else {
        let spacing = Infinity;
        if (barXs.length === 1) {
          const value = barXs[0]!;
          const half = xType === "time" ? 86_400_000 : Math.max(Math.abs(value) * 0.1, 1);
          spacing = half * 2;
        } else {
          for (let index = 1; index < barXs.length; index++) {
            const candidate = barXs[index]! - barXs[index - 1]!;
            if (candidate > 0 && candidate < spacing) spacing = candidate;
          }
        }
        if (!Number.isFinite(spacing)) spacing = span || (xType === "time" ? 172_800_000 : 2);
        const firstBar = barXs[0] ?? dataLo;
        const lastBar = barXs[barXs.length - 1] ?? dataHi;
        lo = Math.min(dataLo, firstBar - spacing / 2);
        hi = Math.max(dataHi, lastBar + spacing / 2);
      }
    } else {
      if (dataLo === dataHi) {
        if (xType === "log") {
          lo = dataLo;
          hi = dataHi;
        } else {
          const pad = xType === "time" ? 86_400_000 : Math.max(Math.abs(dataLo) * 0.06, 1);
          lo = dataLo - pad;
          hi = dataHi + pad;
        }
      } else {
        const pad = hasArea ? 0 : span * 0.06;
        lo = dataLo - pad;
        hi = dataHi + pad;
      }
    }
  }
  const xRange: [number, number] = [plot.x, plot.x + plot.w];
  if (xType === "log") {
    return scaleLog({ domain: [lo, hi], range: xRange });
  }
  if (xType === "time") {
    return scaleTime({ domain: [lo, hi], range: xRange });
  }
  return scaleLinear({ domain: [lo, hi], range: xRange, nice: spec.scales?.x?.nice ?? false });
}

export interface CartesianYScaleInput {
  yValues: readonly number[];
  plot: PlotRect;
  /** Bars, areas, or a plugin requesting includeZero anchor the domain at zero. */
  includeZero: boolean;
}

/** Log or (optionally nice) linear Y scale; zero-anchored charts pad only the top. */
export function cartesianYScale(spec: ChartSpec, input: CartesianYScaleInput): AnyScale {
  const { yValues, plot, includeZero } = input;
  if (spec.scales?.y?.type === "log") {
    const configured = spec.scales.y.domain as readonly unknown[] | undefined;
    const bounds = configured
      ? [asNumber(configured[0]), asNumber(configured[1])]
      : (finiteBounds(yValues) ?? [1, 10]);
    return scaleLog({
      domain: [bounds[0]!, bounds[1]!],
      range: [plot.y + plot.h, plot.y],
    });
  }
  const configured = spec.scales?.y?.domain as readonly unknown[] | undefined;
  const raw = configured
    ? [asNumber(configured[0]), asNumber(configured[1])] as [number, number]
    : undefined;
  let yLo: number;
  let yHi: number;
  if (raw) {
    yLo = raw[0];
    yHi = raw[1];
  } else {
    let ext = extent(yValues);
    if (includeZero) ext = [Math.min(0, ext[0]), Math.max(0, ext[1])];
    const span = (ext[1] - ext[0]) || 1;
    const pad = includeZero ? span * 0.06 : span * 0.1;
    yLo = includeZero ? Math.min(0, ext[0]) : ext[0] - pad;
    yHi = ext[1] + pad;
  }
  return scaleLinear({
    domain: [yLo, yHi],
    range: [plot.y + plot.h, plot.y],
    nice: spec.scales?.y?.nice ?? includeZero,
  });
}
