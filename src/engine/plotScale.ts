// Price/time scale math for the finance widget (bar-index x, display-space y).

import type { Bar } from "../types/charting_library";
import type { IndexRange } from "../core/context";
import { formatPrice } from "../util/format";
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

export function toDisplay(s: PlotScale, price: number): number {
  if (s.percentScale) {
    return s.pctBase > 0 ? ((price - s.pctBase) / s.pctBase) * 100 : 0;
  }
  if (s.logScale) {
    return price > 0 ? Math.log10(price) : Math.log10(Number.MIN_VALUE);
  }
  return price;
}

export function fromDisplay(s: PlotScale, d: number): number {
  if (s.percentScale) {
    return s.pctBase * (1 + d / 100);
  }
  if (s.logScale) {
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

type ScaleWithPriceFormat = PlotScale & {
  context?: { formatPrice?: (value: number, pricescale: number) => string };
};

export function formatAxisPrice(s: PlotScale, price: number, pricescale: number): string {
  if (s.percentScale) {
    const pct = toDisplay(s, price);
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct.toFixed(2)}%`;
  }
  const format = (s as ScaleWithPriceFormat).context?.formatPrice ?? formatPrice;
  return format(price, pricescale);
}

export function computePriceTicks(s: PlotScale): number[] {
  const target = Math.max(2, Math.floor(s.plotH / 56));
  const range = s.priceMax - s.priceMin;
  if (range <= 0) return [];
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-12))));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const first = Math.ceil(s.priceMin / step) * step;
  const ticks: number[] = [];
  for (let d = first; d <= s.priceMax; d += step) {
    ticks.push(fromDisplay(s, d));
  }
  return ticks;
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

export function autoFitPriceRange(
  bars: Bar[],
  s: PlotScale,
  autoScale: boolean,
  manual: { min: number; max: number } | null,
): { priceMin: number; priceMax: number; pctBase: number } {
  const { from, to } = s.visibleRange;
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(bars.length - 1, Math.ceil(to));
  const baseBar = bars[start] ?? bars[0];
  const pctBase = baseBar && baseBar.close > 0 ? baseBar.close : 1;
  const scale: PlotScale = { ...s, pctBase };

  if (manual && !autoScale) {
    let priceMin = toDisplay(scale, manual.min);
    let priceMax = toDisplay(scale, manual.max);
    if (priceMin >= priceMax) priceMax = priceMin + 1;
    return { priceMin, priceMax, pctBase };
  }

  let bodyHi = -Infinity;
  let bodyLo = Infinity;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = start; i <= end; i++) {
    const b = bars[i];
    if (!b) continue;
    const c = b.close > 0 ? b.close : b.open;
    const bH = Math.max(b.open, c);
    const bL = Math.min(b.open, c);
    if (bH > bodyHi) bodyHi = bH;
    if (bL > 0 && bL < bodyLo) bodyLo = bL;
    if (b.high > hi) hi = b.high;
    const low = b.low > 0 ? b.low : bL;
    if (low > 0 && low < lo) lo = low;
  }
  if (!Number.isFinite(bodyHi) || !Number.isFinite(bodyLo) || bodyHi <= 0) {
    return { priceMin: 0, priceMax: 1, pctBase };
  }
  const bodyRange = Math.max(0, bodyHi - bodyLo);
  const wickRoom = Math.max(bodyRange, bodyHi * 0.06);
  hi = Math.min(hi, bodyHi + wickRoom);
  lo = Math.max(Math.max(0, bodyLo - wickRoom), Number.isFinite(lo) ? lo : bodyLo);
  if (lo >= hi) {
    lo = bodyLo * 0.99;
    hi = bodyHi * 1.01;
  }
  if (scale.logScale) {
    lo = Math.max(lo, hi * 1e-6, Number.MIN_VALUE);
  }
  const dHi = toDisplay(scale, hi);
  const dLo = toDisplay(scale, lo);
  const pad = (dHi - dLo) * 0.08;
  let priceMin = dLo - pad;
  let priceMax = dHi + pad;
  if (priceMin >= priceMax) priceMax = priceMin + 1;
  return { priceMin, priceMax, pctBase };
}
