// Price/time scale math for the finance widget (bar-index x, display-space y).

import type { Bar, LibrarySymbolInfo } from "../types/charting_library";
import type { IndexRange } from "../core/context";
import {
  MAX_PRICE_DECIMALS,
  builtinPriceFormatLocale,
  decimalsFromPricescale,
  formatPrice,
  formatPriceFixed,
  type PriceFormatFn,
} from "../util/format";
import { parseResolution } from "../util/resolution";
import { MAX_BAR_SPACING } from "./layout";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const SEC = 1000, MIN_MS = 60_000, HR = 3_600_000, DAY_MS = 86_400_000;
export const NICE_TIME_STEPS = [
  SEC, 5 * SEC, 15 * SEC, 30 * SEC,
  MIN_MS, 5 * MIN_MS, 15 * MIN_MS, 30 * MIN_MS,
  HR, 2 * HR, 3 * HR, 6 * HR, 12 * HR,
  DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS, 90 * DAY_MS, 365 * DAY_MS,
];

export interface PlotScale {
  plotL: number;
  plotT: number;
  plotW: number;
  plotH: number;
  priceMin: number;
  priceMax: number;
  pctBase: number;
  visibleRange: IndexRange;
  percentScale: boolean;
  logScale: boolean;
  /**
   * Log scale was requested, but the visible data (or the manual price range)
   * reaches zero or below, so the scale maps prices linearly instead. Copy it
   * from {@link autoFitPriceRange}'s result; absent means `false`.
   */
  logFallback?: boolean;
}

/** `true` when prices map through log10 (log requested, not overridden by percent or the fallback). */
export function isLogScale(s: PlotScale): boolean {
  return s.logScale && !s.percentScale && !s.logFallback;
}

export function barSpacing(s: PlotScale): number {
  const span = s.visibleRange.to - s.visibleRange.from;
  if (span <= 0) return MAX_BAR_SPACING;
  return s.plotW / span;
}

export function xForIndex(s: PlotScale, i: number): number {
  return s.plotL + (i - s.visibleRange.from + 0.5) * barSpacing(s);
}

export function indexForX(s: PlotScale, x: number): number {
  return s.visibleRange.from + (x - s.plotL) / barSpacing(s) - 0.5;
}

function hasPercentBase(s: PlotScale): boolean {
  return s.pctBase !== 0 && Number.isFinite(s.pctBase);
}

export function toDisplay(s: PlotScale, price: number): number {
  if (s.percentScale) {
    // Divide by |base| so a negative base (spreads, P&L) keeps "up is up".
    return hasPercentBase(s) ? ((price - s.pctBase) / Math.abs(s.pctBase)) * 100 : 0;
  }
  if (isLogScale(s)) {
    return price > 0 ? Math.log10(price) : Math.log10(Number.MIN_VALUE);
  }
  return price;
}

export function fromDisplay(s: PlotScale, d: number): number {
  if (s.percentScale) {
    return hasPercentBase(s) ? s.pctBase + Math.abs(s.pctBase) * (d / 100) : 0;
  }
  if (isLogScale(s)) {
    return Math.pow(10, d);
  }
  return d;
}

export function yForPrice(s: PlotScale, p: number): number {
  const d = toDisplay(s, p);
  const r = s.priceMax - s.priceMin || 1;
  return s.plotT + (s.priceMax - d) / r * s.plotH;
}

export function priceForY(s: PlotScale, y: number): number {
  const r = s.priceMax - s.priceMin || 1;
  const d = s.priceMax - (y - s.plotT) / s.plotH * r;
  return fromDisplay(s, d);
}

// ── Price axis grid ─────────────────────────────────────────────────────────
//
// One "grid" per scale state decides the tick prices and the single fixed
// precision every label on the axis uses (ticks, crosshair, last-price and
// order tags), so one column never mixes "0.0000182" with "0.00001738".
//
// - Ticks are multiples of the symbol's min tick (`minmov / pricescale`), so
//   a 0.25-tick future never shows 4,500.10. Labels round to the min tick.
// - When fewer than two tradable prices are visible (a zoomed-in axis, or a
//   feed whose pricescale is coarser than its prices), ticks fall back to
//   plain 1/2/5 steps and the label precision rises to fit the step, so the
//   labels stay distinct instead of all reading "0.00".
// - Log scale picks decade-aware round prices (1, 2, 5 × 10ⁿ and finer
//   subdivisions) at least LOG_TICK_MIN_SPACING px apart.

/** Target pixel spacing that sets the linear tick count (`plotH / 56`). */
const LINEAR_TICK_SPACING = 56;
/** Minimum pixel distance between two log-scale ticks. */
export const LOG_TICK_MIN_SPACING = 40;
/** Most ticks a single log gap may be split into before the search stops. */
const LOG_TICK_MAX_CANDIDATES = 4096;

type ScaleWithPriceFormat = PlotScale & {
  context?: {
    formatPrice?: PriceFormatFn;
    symbolInfo?: Pick<LibrarySymbolInfo, "pricescale" | "minmov"> | null;
  };
};

/** How the price axis formats labels for one scale state. */
export interface PriceAxisFormat {
  /** Fraction digits shared by every label on the axis. */
  readonly decimals: number;
  /** Smallest price increment, `minmov / pricescale`. */
  readonly minTick: number;
  /** `true` when ticks sit on the min-tick grid and labels round to it. */
  readonly aligned: boolean;
}

/** A price-axis tick with its label in the axis' shared precision. */
export interface PriceTickMark {
  readonly price: number;
  readonly label: string;
}

interface PriceGrid extends PriceAxisFormat {
  readonly ticks: readonly number[];
  // Cache key: the scale state the grid was built for.
  readonly priceMin: number;
  readonly priceMax: number;
  readonly plotH: number;
  readonly pctBase: number;
  readonly mode: number;
  readonly pricescale: number;
  readonly minmov: number;
}

const MODE_LINEAR = 0, MODE_LOG = 1, MODE_PERCENT = 2;

const grids = new WeakMap<PlotScale, PriceGrid>();

function scaleMode(s: PlotScale): number {
  return s.percentScale ? MODE_PERCENT : isLogScale(s) ? MODE_LOG : MODE_LINEAR;
}

/** Symbol tick size for a scale: the caller's pricescale, minmov from the symbol when it matches. */
function symbolTick(s: PlotScale, pricescale?: number): { pricescale: number; minmov: number } {
  const info = (s as ScaleWithPriceFormat).context?.symbolInfo;
  let ps = pricescale ?? info?.pricescale ?? 100;
  if (!(ps > 0) || !Number.isFinite(ps)) ps = 1;
  const mm = info && info.pricescale === ps ? info.minmov : 1;
  return { pricescale: ps, minmov: mm > 0 && Number.isFinite(mm) ? mm : 1 };
}

function priceGrid(s: PlotScale, pricescale?: number): PriceGrid {
  const tick = symbolTick(s, pricescale);
  const mode = scaleMode(s);
  const hit = grids.get(s);
  if (
    hit &&
    hit.priceMin === s.priceMin &&
    hit.priceMax === s.priceMax &&
    hit.plotH === s.plotH &&
    hit.pctBase === s.pctBase &&
    hit.mode === mode &&
    hit.pricescale === tick.pricescale &&
    hit.minmov === tick.minmov
  ) {
    return hit;
  }
  const grid = buildPriceGrid(s, mode, tick.pricescale, tick.minmov);
  grids.set(s, grid);
  return grid;
}

/** `mantissa × 10^exponent` as the double nearest the decimal value. */
function scaledInt(mantissa: number, exponent: number): number {
  return exponent >= 0 ? mantissa * Math.pow(10, exponent) : mantissa / Math.pow(10, -exponent);
}

/** Fraction digits needed to print `x` exactly, or `null` beyond `MAX_PRICE_DECIMALS`. */
function decimalsNeeded(x: number): number | null {
  if (!Number.isFinite(x)) return null;
  const a = Math.abs(x);
  for (let d = 0; d <= MAX_PRICE_DECIMALS; d++) {
    const scaled = a * Math.pow(10, d);
    if (Math.abs(scaled - Math.round(scaled)) <= 1e-9 * Math.max(1, scaled)) return d;
  }
  return null;
}

/** `Math.ceil` that treats a quotient within float noise of an integer as that integer. */
function ceilUnits(q: number): number {
  const whole = Math.round(q);
  return Math.abs(q - whole) <= 1e-9 * Math.max(1, Math.abs(q)) ? whole : Math.ceil(q);
}

/** `true` when `step` is a whole multiple of `minTick`. */
function isMultipleOf(step: number, minTick: number): boolean {
  const units = step / minTick;
  const whole = Math.round(units);
  return whole >= 1 && Math.abs(units - whole) <= 1e-9 * Math.max(1, units);
}

/** Largest 1/2/5 × 10ⁿ step not above `raw`. */
function niceStep(raw: number): { mantissa: number; exponent: number } {
  const exponent = Math.floor(Math.log10(Math.max(raw, 1e-300)));
  const norm = raw / Math.pow(10, exponent);
  return { mantissa: norm >= 5 ? 5 : norm >= 2 ? 2 : 1, exponent };
}

function buildPriceGrid(s: PlotScale, mode: number, pricescale: number, minmov: number): PriceGrid {
  const base = decimalsFromPricescale(pricescale);
  const minTick = minmov / pricescale;
  const key = {
    priceMin: s.priceMin, priceMax: s.priceMax, plotH: s.plotH, pctBase: s.pctBase,
    mode, pricescale, minmov,
  };
  const lo = s.priceMin, hi = s.priceMax;
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi) || !(s.plotH > 0)) {
    return { ...key, ticks: [], decimals: base, minTick, aligned: true };
  }

  if (mode === MODE_PERCENT) {
    // Percent ticks are round percentages; labels are formatted as "+x.xx%".
    const target = Math.max(2, Math.floor(s.plotH / LINEAR_TICK_SPACING));
    const { mantissa, exponent } = niceStep((hi - lo) / target);
    const step = scaledInt(mantissa, exponent);
    const ticks: number[] = [];
    for (let k = Math.ceil(lo / step); k * step <= hi; k++) ticks.push(fromDisplay(s, scaledInt(k * mantissa, exponent)));
    return { ...key, ticks, decimals: base, minTick, aligned: false };
  }

  if (mode === MODE_LOG) {
    let ticks = logTicks(lo, hi, s.plotH, minTick);
    let aligned = true;
    if (ticks.length < 2) {
      ticks = logTicks(lo, hi, s.plotH, null);
      aligned = false;
    }
    let decimals = base;
    for (const t of ticks) decimals = Math.max(decimals, decimalsNeeded(t) ?? base);
    return { ...key, ticks, decimals, minTick, aligned };
  }

  const target = Math.max(2, Math.floor(s.plotH / LINEAR_TICK_SPACING));
  const nice = niceStep((hi - lo) / target);
  const niceValue = scaledInt(nice.mantissa, nice.exponent);

  // Aligned: the 1/2/5 step rounded up to a whole number of min ticks.
  const units = Math.max(1, ceilUnits(niceValue / minTick));
  const step = (units * minmov) / pricescale;
  const kFrom = Math.ceil(lo / step);
  const kTo = Math.floor(hi / step);
  if (kTo - kFrom + 1 >= 2) {
    const ticks: number[] = [];
    const stride = units * minmov;
    for (let k = kFrom; k <= kTo; k++) ticks.push((k * stride) / pricescale);
    const decimals = Math.max(base, decimalsNeeded(step) ?? base, decimalsNeeded(minTick) ?? base);
    return { ...key, ticks, decimals: Math.min(decimals, MAX_PRICE_DECIMALS), minTick, aligned: true };
  }

  // Fewer than two tradable prices fit: plain 1/2/5 steps, precision raised to match.
  const ticks: number[] = [];
  for (let k = Math.ceil(lo / niceValue); k * niceValue <= hi; k++) {
    ticks.push(scaledInt(k * nice.mantissa, nice.exponent));
  }
  const decimals = Math.min(MAX_PRICE_DECIMALS, Math.max(base, -nice.exponent));
  return { ...key, ticks, decimals, minTick, aligned: false };
}

/**
 * Decade-aware log ticks between display values `lo`..`hi` (log10 of price),
 * ascending, at least LOG_TICK_MIN_SPACING px apart.
 *
 * 1. Powers of ten, or every k-th power when decades are closer than the
 *    spacing (1e-6 / 1e-4 / 0.01 / 1 …).
 * 2. The 1-2-5 series inside each decade (1 / 2 / 5 / 10 / 20 / 50 …), when
 *    both fit.
 * 3. Each gap between kept ticks (and the plot edges) is split by the finest
 *    1, 2, 2.5 or 5 × 10ⁿ step that divides its end points and still fits,
 *    repeated because the lower part of a log gap has more room. A narrow
 *    range therefore reads 86,000 / 88,000 / 90,000 … and never 95,499.26.
 *
 * With `minTick`, only its multiples qualify.
 */
function logTicks(lo: number, hi: number, plotH: number, minTick: number | null): number[] {
  const pxPerDecade = plotH / (hi - lo);
  const spacing = LOG_TICK_MIN_SPACING;
  const tradable = (value: number): boolean => minTick === null || isMultipleOf(value, minTick);
  const px = (value: number): number => (Math.log10(value) - lo) * pxPerDecade;
  const bottom = Math.pow(10, lo), top = Math.pow(10, hi);
  const firstDecade = Math.ceil(lo), lastDecade = Math.floor(hi);

  if (pxPerDecade < spacing) {
    // Decades are closer than the minimum spacing: every k-th power of ten.
    const need = spacing / pxPerDecade;
    const mag = Math.pow(10, Math.floor(Math.log10(need)));
    const norm = need / mag;
    const stride = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const out: number[] = [];
    for (let n = Math.ceil(firstDecade / stride) * stride; n <= lastDecade; n += stride) {
      const value = scaledInt(1, n);
      if (value > 0 && Number.isFinite(value) && tradable(value)) out.push(value);
    }
    return out;
  }

  let kept: number[] = [];
  for (let n = firstDecade; n <= lastDecade; n++) {
    const value = scaledInt(1, n);
    if (tradable(value)) kept.push(value);
  }

  // The 1-2-5 series, all or nothing per decade so a decade never reads 1 / 2 / 10.
  for (let n = Math.floor(lo); n <= lastDecade; n++) {
    const extra = [scaledInt(2, n), scaledInt(5, n)].filter((v) => v >= bottom && v <= top && tradable(v));
    if (!extra.length) continue;
    const merged = [...kept, ...extra].sort((a, b) => a - b);
    let fits = true;
    for (let i = 1; i < merged.length && fits; i++) fits = px(merged[i]!) - px(merged[i - 1]!) >= spacing;
    if (fits) kept = merged;
  }

  // Split every gap with the finest regular step that fits, until stable.
  for (let pass = 0; pass < 8; pass++) {
    const next: number[] = [];
    let changed = false;
    for (let i = 0; i <= kept.length; i++) {
      const a = i > 0 ? kept[i - 1]! : null;
      const b = i < kept.length ? kept[i]! : null;
      const inner = splitLogGap(a, b, bottom, top, px, spacing, tradable);
      if (inner.length) changed = true;
      for (const v of inner) next.push(v);
      if (b !== null) next.push(b);
    }
    kept = next;
    if (!changed) break;
  }
  return kept;
}

/** Step mantissas tried per power of ten, coarse to fine: 5, 2.5, 2, 1 (as integer × 10^shift). */
const LOG_SPLIT_STEPS: readonly (readonly [number, number])[] = [[5, 0], [25, -1], [2, 0], [1, 0]];

/**
 * Regular ticks strictly between kept ticks `a` and `b` (either may be a plot
 * edge, `null`): multiples of the finest 1/2/2.5/5 × 10ⁿ step that divides
 * both end points and keeps the tightest pair (the highest one, on a log
 * scale) at least `spacing` px apart. Empty when no step fits.
 */
function splitLogGap(
  a: number | null,
  b: number | null,
  bottom: number,
  top: number,
  px: (value: number) => number,
  spacing: number,
  tradable: (value: number) => boolean,
): number[] {
  const low = a ?? bottom, high = b ?? top;
  const width = high - low;
  if (!(width > 0)) return [];
  let best: { mantissa: number; exponent: number; kFrom: number; kTo: number } | null = null;
  const e0 = Math.floor(Math.log10(width));
  for (let e = e0; e >= e0 - 18; e--) {
    for (const [m, shift] of LOG_SPLIT_STEPS) {
      const exponent = e + shift;
      const step = scaledInt(m, exponent);
      if (!(step < width)) continue;
      if ((a !== null && !isMultipleOf(a, step)) || (b !== null && !isMultipleOf(b, step))) continue;
      if (!tradable(step)) continue;
      const kFrom = a !== null ? Math.round(a / step) + 1 : Math.ceil(low / step - 1e-9);
      const kTo = b !== null ? Math.round(b / step) - 1 : Math.floor(high / step + 1e-9);
      if (kTo < kFrom) continue;
      if (kTo - kFrom > LOG_TICK_MAX_CANDIDATES) return materialize(best);
      // Equal price steps shrink in pixels as prices rise: the highest pair is the tightest.
      const highest = scaledInt(kTo * m, exponent);
      let tightest = Infinity;
      if (b !== null) tightest = px(b) - px(highest);
      else if (kTo > kFrom) tightest = px(highest) - px(scaledInt((kTo - 1) * m, exponent));
      else if (a !== null) tightest = px(highest) - px(a);
      if (tightest < spacing) return materialize(best);
      best = { mantissa: m, exponent, kFrom, kTo };
    }
  }
  return materialize(best);

  function materialize(pick: typeof best): number[] {
    if (!pick) return [];
    const out: number[] = [];
    for (let k = pick.kFrom; k <= pick.kTo; k++) {
      const value = scaledInt(k * pick.mantissa, pick.exponent);
      if (value >= bottom && value <= top) out.push(value);
    }
    return out;
  }
}

/**
 * Round a price to the axis' min tick (when the axis is on the tick grid) in
 * integer tick units, so 4,500.10 on a 0.25 grid reads 4,500.00.
 */
function roundToMinTick(price: number, grid: PriceGrid): number {
  if (!grid.aligned) return price;
  const units = Math.round((price * grid.pricescale) / grid.minmov);
  const rounded = (units * grid.minmov) / grid.pricescale;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Label precision and min-tick alignment of the price axis for `s`. Pass the
 * same `pricescale` the axis labels use (default: the symbol's, else 100).
 */
export function priceAxisFormat(s: PlotScale, pricescale?: number): PriceAxisFormat {
  const grid = priceGrid(s, pricescale);
  return { decimals: grid.decimals, minTick: grid.minTick, aligned: grid.aligned };
}

/**
 * Format a price for the price axis (tick labels, crosshair, last-price and
 * order tags). The built-in formatter prints every label of one axis with
 * the same fixed precision, rounded to the symbol's min tick, in the widget's
 * `locale`. A custom formatter (`priceFormatterFactory` / `raze.format_price`)
 * receives the raw price and owns its digits. Percent scale prints "+x.xx%".
 */
export function formatAxisPrice(s: PlotScale, price: number, pricescale: number): string {
  if (s.percentScale) {
    let pct = toDisplay(s, price);
    if (Math.abs(pct) < 0.005) pct = 0;
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct.toFixed(2)}%`;
  }
  const format = (s as ScaleWithPriceFormat).context?.formatPrice ?? formatPrice;
  const locale = builtinPriceFormatLocale(format);
  if (locale === undefined) return format(price, pricescale);
  if (!Number.isFinite(price)) return "";
  const grid = priceGrid(s, pricescale);
  return formatPriceFixed(roundToMinTick(price, grid), grid.decimals, locale);
}

/** Tick prices for the price axis, ascending. See {@link computePriceTickMarks} for labels. */
export function computePriceTicks(s: PlotScale): number[] {
  return priceGrid(s).ticks.slice();
}

/** Tick prices with their labels, all in the axis' shared precision. */
export function computePriceTickMarks(s: PlotScale): PriceTickMark[] {
  const pricescale = symbolTick(s).pricescale;
  return priceGrid(s).ticks.map((price) => ({ price, label: formatAxisPrice(s, price, pricescale) }));
}

export function computeTimeTicks(bars: Bar[], s: PlotScale): { index: number; time: number }[] {
  if (!bars.length) return [];
  const { from, to } = s.visibleRange;
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(bars.length - 1, Math.ceil(to));
  if (end < start) return [];

  const target = Math.max(2, Math.floor(s.plotW / 110));
  const spanMs = Math.max(1, bars[end]!.time - bars[start]!.time);
  const step = NICE_TIME_STEPS.find((t) => spanMs / t <= target) ?? NICE_TIME_STEPS[NICE_TIME_STEPS.length - 1]!;

  const ticks: { index: number; time: number }[] = [];
  let lastBucket: number | null = null;
  for (let i = start; i <= end; i++) {
    const bucket = Math.floor(bars[i]!.time / step);
    if (lastBucket === null || bucket !== lastBucket) {
      ticks.push({ index: i, time: bars[i]!.time });
      lastBucket = bucket;
    }
  }
  return ticks;
}

export function formatAxisTime(ms: number, kind: string): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const intraday = kind === "seconds" || kind === "minutes" || kind === "hours";
  if (intraday) {
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) {
      return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    }
    if (kind === "seconds") {
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    }
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function formatCrosshairTime(ms: number, kind: string): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
  const intraday = kind === "seconds" || kind === "minutes" || kind === "hours";
  if (!intraday) return date;
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return kind === "seconds" ? `${date} ${hm}:${pad(d.getUTCSeconds())}` : `${date} ${hm}`;
}

export function resolutionKind(res: string): string {
  return parseResolution(res).kind;
}

/** Result of {@link autoFitPriceRange}: display-space bounds for the scale. */
export interface PriceFit {
  priceMin: number;
  priceMax: number;
  pctBase: number;
  /**
   * Log scale was requested but cannot represent the visible data (a value at
   * or below zero) or the manual range; the bounds are linear. Store it on the
   * scale as {@link PlotScale.logFallback}.
   */
  logFallback: boolean;
}

let warnedLogFallback = false;

function warnLogFallback(): void {
  if (warnedLogFallback) return;
  warnedLogFallback = true;
  console.warn(
    "[raze-charts] Log scale needs prices above zero, but the visible data or price range reaches zero or below. " +
      "The price axis is linear until the visible data is positive again; choose the normal or percent scale for " +
      "series that go negative (spreads, P&L, rates).",
  );
}

/** First finite, non-zero close in the visible range: the 0 % line of percent mode. */
function percentBase(bars: Bar[], start: number, end: number): number {
  for (let i = start; i <= end; i++) {
    const close = bars[i]?.close;
    if (close !== undefined && close !== 0 && Number.isFinite(close)) return close;
  }
  const first = bars[start] ?? bars[0];
  return first && first.close !== 0 && Number.isFinite(first.close) ? first.close : 1;
}

/**
 * Fit the price scale to the visible bars (or apply the manual range).
 *
 * Any finite price counts, including zero and negative values (spreads,
 * WTI at -37, funding rates, P&L); a bar whose close is not a finite number
 * (`null`, `NaN`, missing) is whitespace and ignored. A missing open, high or
 * low falls back to the close. Log scale uses positive data only: when the
 * visible data or the manual range reaches zero or below, the fit is linear
 * and `logFallback` is set (with a one-time console warning).
 */
export function autoFitPriceRange(
  bars: Bar[],
  s: PlotScale,
  autoScale: boolean,
  manual: { min: number; max: number } | null,
): PriceFit {
  const { from, to } = s.visibleRange;
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(bars.length - 1, Math.ceil(to));
  const pctBase = percentBase(bars, start, end);

  let bodyHi = -Infinity;
  let bodyLo = Infinity;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = start; i <= end; i++) {
    const b = bars[i];
    if (!b) continue;
    const c = b.close;
    if (!Number.isFinite(c)) continue;
    const o = Number.isFinite(b.open) ? b.open : c;
    const bH = Math.max(o, c);
    const bL = Math.min(o, c);
    if (bH > bodyHi) bodyHi = bH;
    if (bL < bodyLo) bodyLo = bL;
    const high = Number.isFinite(b.high) ? Math.max(b.high, bH) : bH;
    const low = Number.isFinite(b.low) ? Math.min(b.low, bL) : bL;
    if (high > hi) hi = high;
    if (low < lo) lo = low;
  }
  const hasData = Number.isFinite(bodyHi) && Number.isFinite(bodyLo);

  const useManual = manual !== null && !autoScale;
  const wantLog = s.logScale && !s.percentScale;
  const logFallback = wantLog && ((hasData && lo <= 0) || (useManual && !(manual.min > 0)));
  if (logFallback) warnLogFallback();
  const scale: PlotScale = { ...s, pctBase, logFallback };

  if (useManual) {
    const priceMin = toDisplay(scale, manual.min);
    let priceMax = toDisplay(scale, manual.max);
    if (priceMin >= priceMax) priceMax = priceMin + 1;
    return { priceMin, priceMax, pctBase, logFallback };
  }

  if (!hasData) {
    return { priceMin: 0, priceMax: 1, pctBase, logFallback };
  }
  // Clamp extreme wicks to one body range (or 6 % of the price level) beyond
  // the bodies so a single bad print does not flatten every candle.
  const bodyRange = bodyHi - bodyLo;
  const level = Math.max(Math.abs(bodyHi), Math.abs(bodyLo));
  const wickRoom = Math.max(bodyRange, level * 0.06);
  hi = Math.min(hi, bodyHi + wickRoom);
  lo = Math.max(lo, bodyLo - wickRoom);
  if (lo >= hi) {
    // Flat data: centre it in a band of ±1 % of its level (±1 around zero).
    if (bodyLo > 0) {
      lo = bodyLo * 0.99;
      hi = bodyHi * 1.01;
    } else {
      const half = level > 0 ? level * 0.01 : 1;
      lo = bodyLo - half;
      hi = bodyHi + half;
    }
  }
  if (isLogScale(scale)) {
    lo = Math.max(lo, hi * 1e-6, Number.MIN_VALUE);
  }
  const dHi = toDisplay(scale, hi);
  const dLo = toDisplay(scale, lo);
  const pad = (dHi - dLo) * 0.08;
  let priceMin = dLo - pad;
  let priceMax = dHi + pad;
  if (!(priceMin < priceMax)) {
    const mid = Number.isFinite(dLo) ? dLo : 0;
    priceMin = mid - 0.5;
    priceMax = mid + 0.5;
  }
  return { priceMin, priceMax, pctBase, logFallback };
}
