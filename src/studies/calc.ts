// Pure study calculators over OHLC bars. Values align 1:1 with `bars` indices;
// leading warm-up samples are `null`.
//
// Missing data: a non-finite sample (NaN, ±Infinity, or a bar field that is
// not a number) is a gap. It emits `null` and is left out of every window and
// recurrence, exactly as if that bar did not exist, so one bad bar from a feed
// never poisons the rest of the history. Zero and negative prices are ordinary
// values (spreads, basis, P&L series, WTI in April 2020).

import type { Bar } from "../types/charting_library";
import type { StudySource } from "./types";
import { DAY_MS, civilFromDays, getTimeZone, type TimeZone } from "../util/time/zone";

type Series = (number | null)[];

function nulls(length: number): Series {
  return new Array<number | null>(length).fill(null);
}

/** Window length as a positive integer, or 0 when the length is unusable. */
function period(length: number): number {
  const value = Math.floor(length);
  return Number.isFinite(value) && value >= 1 ? value : 0;
}

/**
 * Run `kernel` over the finite samples only and scatter each series it returns
 * back onto the original indices; gap indices stay `null`. Series without
 * gaps (the common case) go straight to the kernel with no copies.
 */
function overFinite(values: readonly number[], kernel: (finite: number[]) => readonly Series[]): Series[] {
  const n = values.length;
  let gaps = 0;
  for (let i = 0; i < n; i++) if (!Number.isFinite(values[i])) gaps++;
  if (gaps === 0) return [...kernel(values as number[])];
  const finite: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    const value = values[i]!;
    if (!Number.isFinite(value)) continue;
    finite.push(value);
    index.push(i);
  }
  return kernel(finite).map((inner) => {
    const out = nulls(n);
    for (let j = 0; j < inner.length; j++) out[index[j]!] = inner[j]!;
    return out;
  });
}

// ── Sources ─────────────────────────────────────────────────────────────────

function num(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

/**
 * One bar's value for a price source. Non-numeric fields read as NaN (a gap).
 * `volume` treats a missing field as a gap too, so a feed without volume does
 * not plot a flat zero line.
 */
export function sourceValue(bar: Bar, source: StudySource = "close"): number {
  const high = num(bar.high);
  const low = num(bar.low);
  const close = num(bar.close);
  switch (source) {
    case "open": return num(bar.open);
    case "high": return high;
    case "low": return low;
    case "hl2": return (high + low) / 2;
    case "hlc3": return (high + low + close) / 3;
    case "ohlc4": return (num(bar.open) + high + low + close) / 4;
    case "hlcc4": return (high + low + 2 * close) / 4;
    case "volume": return num(bar.volume);
    default: return close;
  }
}

/** Source values for every bar (`close` by default). Gaps are NaN. */
export function sourceValues(bars: readonly Bar[], source: StudySource = "close"): number[] {
  const out = new Array<number>(bars.length);
  for (let i = 0; i < bars.length; i++) out[i] = sourceValue(bars[i]!, source);
  return out;
}

/**
 * Closing prices, unchanged: zero and negative closes are real values and a
 * non-numeric close is NaN (a gap every kernel skips).
 */
export function closesFromBars(bars: Bar[]): number[] {
  return sourceValues(bars, "close");
}

/**
 * Shift a series by `offset` bars, TradingView-style: a positive offset moves
 * the plot right (later bars), a negative one left. Samples shifted past
 * either end are dropped; the vacated end is `null`.
 */
export function offsetSeries(values: (number | null)[], offset: number): (number | null)[] {
  const shift = Math.trunc(offset);
  if (!shift || !Number.isFinite(shift)) return values;
  const n = values.length;
  const out = nulls(n);
  for (let i = Math.max(0, -shift); i < n && i + shift < n; i++) out[i + shift] = values[i]!;
  return out;
}

// ── Rolling window ──────────────────────────────────────────────────────────

interface Moments {
  mean: Series;
  /** Present for `spread: "dev"`. */
  dev: Series | null;
  /** mean ± multiplier·dev, present when `spread` is a multiplier. */
  upper: Series | null;
  lower: Series | null;
}

/**
 * M2 below this fraction of the rounding budget means the sliding update has
 * cancelled (a spike or an old price level just left the window): recompute.
 * Rounding since the last exact pass is a few ulps of the budget, so M2 stays
 * within ~1e-10 relative of the two-pass value. Ordinary series keep
 * budget/M2 below ~1e3 between resyncs, so this only fires on real cancellation.
 */
const CANCELLATION = 1e-5;

/** Rounding error of `total + value` (Neumaier), to carry alongside the sum. */
function roundoff(total: number, value: number): number {
  const next = total + value;
  return Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
}

/**
 * Rolling mean and population standard deviation of every full window, in
 * one O(n) pass over gap-free samples.
 *
 * The mean slides a Neumaier-compensated window sum, adding the new sample
 * and subtracting the old one separately so a spike entering and leaving
 * cancels exactly; SMA and the Bollinger basis share it bit for bit.
 *
 * The spread slides the sum of squared deviations by the exact identity
 * M2' = M2 + (x - y)(x - mean' + y - mean) on samples taken relative to a
 * shift (the window's first sample at the last exact pass), so a level far
 * from zero (BTC at 60 000 with cent ticks) does not cancel, while `budget`
 * bounds the rounding those updates made. The window is recomputed exactly
 * (corrected two-pass) when M2 cancels against that budget, which recovers
 * the bands the moment a bad print or an old price level leaves the window,
 * and every max(256, 8·len) windows regardless, at an amortised cost of at
 * most 1/4 of a pass. A flat window reads exactly 0.
 */
function rollingMoments(xs: number[], len: number, spread: "none" | "dev" | number): Moments {
  const n = xs.length;
  const mean = nulls(n);
  const withDev = spread !== "none";
  const k = typeof spread === "number" ? spread : 0;
  const dev = spread === "dev" ? nulls(n) : null;
  const upper = typeof spread === "number" ? nulls(n) : null;
  const lower = typeof spread === "number" ? nulls(n) : null;
  let total = 0; // Σx over the window…
  let carry = 0; // …and its Neumaier compensation
  const resync = Math.max(256, len * 8);
  let shift = 0;
  let sum = 0; // Σ(x - shift) over the window…
  let sumCarry = 0; // …and its compensation
  let m = 0; // window mean - shift
  let m2 = 0;
  let budget = 0;
  let sinceExact = resync;
  for (let i = 0; i < len - 1 && i < n; i++) {
    carry += roundoff(total, xs[i]!);
    total += xs[i]!;
  }
  // Branch-free window: add the entering sample before the outputs and
  // subtract the leaving one after them (keeps this loop as fast as a plain sum).
  for (let i = len - 1; i < n; i++) {
    const x = xs[i]!;
    carry += roundoff(total, x);
    total += x;
    const basis = (total + carry) / len;
    mean[i] = basis;
    const leaving = xs[i - len + 1]!;
    carry += roundoff(total, -leaving);
    total -= leaving;
    if (!withDev) continue;
    if (sinceExact < resync) {
      const xv = x - shift;
      const yv = xs[i - len]! - shift;
      const step = xv - yv;
      const previous = m;
      sumCarry += roundoff(sum, step);
      sum += step;
      m = (sum + sumCarry) / len;
      m2 += step * (xv - m + yv - previous);
      const size = Math.abs(xv) + Math.abs(yv);
      budget += size * (size + Math.abs(m) + Math.abs(previous));
      sinceExact++;
    }
    if (sinceExact >= resync || m2 < budget * CANCELLATION) {
      const first = i - len + 1;
      shift = xs[first]!;
      sum = 0;
      sumCarry = 0;
      for (let j = first + 1; j <= i; j++) sum += xs[j]! - shift;
      m = sum / len;
      let squares = 0;
      let residual = 0;
      for (let j = first; j <= i; j++) {
        const d = xs[j]! - shift - m;
        squares += d * d;
        residual += d;
      }
      m2 = Math.max(0, squares - (residual * residual) / len);
      budget = 0;
      sinceExact = 0;
    }
    const d = Math.sqrt(m2 / len);
    if (dev) dev[i] = d;
    if (upper && lower) {
      upper[i] = basis + k * d;
      lower[i] = basis - k * d;
    }
  }
  return { mean, dev, upper, lower };
}

// ── Moving averages ─────────────────────────────────────────────────────────

/** Simple moving average: O(n) for any window; the compensated window sum never drifts, even past a bad print. */
export function sma(closes: number[], length: number): (number | null)[] {
  const len = period(length);
  if (!len) return nulls(closes.length);
  return overFinite(closes, (xs) => [rollingMoments(xs, len, "none").mean] as const)[0]!;
}

/** TradingView-style EMA: seeded with the SMA of the first `length` samples. */
export function ema(closes: number[], length: number): (number | null)[] {
  const len = period(length);
  if (!len) return nulls(closes.length);
  return overFinite(closes, (xs) => {
    const out = nulls(xs.length);
    if (xs.length < len) return [out] as const;
    let sum = 0;
    for (let i = 0; i < len; i++) sum += xs[i]!;
    let prev = sum / len;
    out[len - 1] = prev;
    const k = 2 / (len + 1);
    for (let i = len; i < xs.length; i++) {
      prev = xs[i]! * k + prev * (1 - k);
      out[i] = prev;
    }
    return [out] as const;
  })[0]!;
}

// ── RSI ─────────────────────────────────────────────────────────────────────

/** RSI together with the Wilder averages behind it (for incremental updates). */
export interface RsiState {
  rsi: (number | null)[];
  avgGain: (number | null)[];
  avgLoss: (number | null)[];
}

function rsiOf(avgGain: number, avgLoss: number): number {
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Wilder RSI plus its smoothed gain/loss averages, aligned with `closes`.
 * Gaps are skipped: the change across a gap is measured from the last finite
 * close.
 */
export function rsiState(closes: number[], length: number): RsiState {
  return wilderRsi(closes, length, true);
}

function wilderRsi(closes: number[], length: number, withState: boolean): RsiState {
  const len = period(length);
  const n = closes.length;
  if (!len) return { rsi: nulls(n), avgGain: nulls(n), avgLoss: nulls(n) };
  const [values, gains, losses] = overFinite(closes, (xs) => {
    const out = nulls(xs.length);
    const g = withState ? nulls(xs.length) : out;
    const l = withState ? nulls(xs.length) : out;
    if (xs.length < len + 1) return [out, g, l] as const;
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= len; i++) {
      const d = xs[i]! - xs[i - 1]!;
      if (d >= 0) avgGain += d;
      else avgLoss -= d;
    }
    avgGain /= len;
    avgLoss /= len;
    if (withState) {
      g[len] = avgGain;
      l[len] = avgLoss;
    }
    out[len] = rsiOf(avgGain, avgLoss);
    for (let i = len + 1; i < xs.length; i++) {
      const d = xs[i]! - xs[i - 1]!;
      avgGain = (avgGain * (len - 1) + (d > 0 ? d : 0)) / len;
      avgLoss = (avgLoss * (len - 1) + (d < 0 ? -d : 0)) / len;
      if (withState) {
        g[i] = avgGain;
        l[i] = avgLoss;
      }
      out[i] = rsiOf(avgGain, avgLoss);
    }
    return withState ? [out, g, l] as const : [out] as const;
  });
  return { rsi: values!, avgGain: gains ?? [], avgLoss: losses ?? [] };
}

/** RSI (Wilder). Returns 0–100. */
export function rsi(closes: number[], length: number): (number | null)[] {
  return wilderRsi(closes, length, false).rsi;
}

// ── Volatility ──────────────────────────────────────────────────────────────

/** Rolling population standard deviation (TradingView's `ta.stdev`), O(n) for any window. */
export function stdev(closes: number[], length: number): (number | null)[] {
  const len = period(length);
  if (len < 2) return nulls(closes.length);
  return overFinite(closes, (xs) => [rollingMoments(xs, len, "dev").dev!] as const)[0]!;
}

/** Bollinger Bands: SMA basis ± `multiplier` population standard deviations, one O(n) pass. */
export function bollinger(
  closes: number[],
  length: number,
  multiplier = 2,
): { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const len = period(length);
  if (len < 2) {
    // A one-bar window has no spread: the bands collapse onto the basis.
    const mid = sma(closes, length);
    return { mid, upper: mid.slice(), lower: mid.slice() };
  }
  const [mid, upper, lower] = overFinite(closes, (xs) => {
    const bands = rollingMoments(xs, len, multiplier);
    return [bands.mean, bands.upper!, bands.lower!] as const;
  });
  return { mid: mid!, upper: upper!, lower: lower! };
}

// ── MACD ────────────────────────────────────────────────────────────────────

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine: Series = closes.map((_, i) => {
    const a = fastEma[i];
    const b = slowEma[i];
    return a == null || b == null ? null : a - b;
  });
  // The signal EMA runs over the defined MACD samples only (warm-up and gaps
  // are skipped), so it seeds `signal` samples after the MACD line starts.
  const signalLine = ema(macdLine.map((value) => value ?? Number.NaN), signal);
  const hist: Series = macdLine.map((value, i) => {
    const s = signalLine[i];
    return value == null || s == null ? null : value - s;
  });
  return { macd: macdLine, signal: signalLine, hist };
}

// ── VWAP ────────────────────────────────────────────────────────────────────

/** When a VWAP accumulation restarts. */
export type VwapAnchor = "session" | "week" | "month" | "quarter" | "year";

export interface VwapOptions {
  /** Reset period. Default `session`: every trading day at the session start. */
  anchor?: VwapAnchor;
  /** IANA zone the session is defined in (the symbol's `timezone`). Default UTC. */
  timezone?: string;
  /**
   * TradingView session string (`0930-1600`, `1700-1600`, `0930-1200,1300-1600:23456`,
   * `24x7`). The trading day starts at its first segment's start; a segment that
   * ends at or before its start runs overnight into the next calendar day.
   * Default `24x7` (midnight to midnight).
   */
  session?: string;
  /** Price averaged against volume. Default `hlc3`, the typical price. */
  source?: StudySource;
}

/** Start of the trading day in minutes after local midnight, and whether it runs overnight. */
export interface SessionStart {
  minutes: number;
  overnight: boolean;
}

const SESSION_SEGMENT = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/;

/**
 * Parse where a TradingView session string starts its trading day.
 * Returns null for an unparseable string.
 */
export function parseSessionStart(session: string | undefined | null): SessionStart | null {
  const text = (session ?? "").trim();
  if (!text || /^24x7$/i.test(text)) return { minutes: 0, overnight: false };
  const first = text.split(/[|,]/)[0]!.split(":")[0]!.trim();
  const match = SESSION_SEGMENT.exec(first);
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start >= 24 * 60 || end > 24 * 60) return null;
  // "0000-0000" and "0000-2400" are whole days; "1700-1600" spans midnight.
  return { minutes: start, overnight: start > 0 && end <= start };
}

/**
 * Trading-day number (days since 1970-01-01, local calendar) of an instant, for
 * a session that starts `start.minutes` after local midnight. An overnight
 * session belongs to the day it ends on, as exchanges date it.
 */
function tradingDay(zone: TimeZone, time: number, start: SessionStart): number {
  const wall = zone.fixedOffset === null ? zone.toWall(time) : time + zone.fixedOffset;
  const day = Math.floor((wall - start.minutes * 60_000) / DAY_MS);
  return start.overnight ? day + 1 : day;
}

function anchorKey(day: number, anchor: VwapAnchor): number {
  switch (anchor) {
    case "week":
      // 1970-01-01 was a Thursday; weeks start on Monday like TradingView's.
      return Math.floor((day + 3) / 7);
    case "month":
    case "quarter":
    case "year": {
      const { year, month } = civilFromDays(day);
      if (anchor === "year") return year;
      return anchor === "month" ? year * 12 + month : year * 4 + Math.floor((month - 1) / 3);
    }
    default:
      return day;
  }
}

/**
 * Anchored volume-weighted average price. The accumulation resets at the start
 * of each anchor period, measured in the symbol's session and time zone, so a
 * session that crosses UTC midnight (ASX, CME Globex) stays continuous. A bar
 * with no volume carries the running VWAP; a bar whose price or volume is not
 * finite is a gap (`null`) and does not touch the accumulation.
 */
export function vwap(bars: Bar[], options: VwapOptions = {}): (number | null)[] {
  const out = nulls(bars.length);
  const anchor = options.anchor ?? "session";
  const zone = getTimeZone(options.timezone);
  const start = parseSessionStart(options.session);
  if (!start) {
    throw new RangeError(
      `[raze-charts] unrecognised session "${options.session}"; use TradingView's HHMM-HHMM form, for example "0930-1600" or "24x7"`,
    );
  }
  const source = options.source ?? "hlc3";
  let pv = 0;
  let vol = 0;
  let current = Number.NaN;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const key = anchorKey(tradingDay(zone, bar.time, start), anchor);
    if (key !== current) {
      pv = 0;
      vol = 0;
      current = key;
    }
    const price = sourceValue(bar, source);
    const volume = bar.volume ?? 0;
    if (!Number.isFinite(price) || !Number.isFinite(volume) || volume < 0) continue;
    pv += price * volume;
    vol += volume;
    if (vol > 0) out[i] = pv / vol;
  }
  return out;
}
