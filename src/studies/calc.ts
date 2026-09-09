// Pure study calculators over OHLC bars. Values align 1:1 with `bars` indices;
// leading warm-up samples are `null`.

import type { Bar } from "../types/charting_library";

export function sma(closes: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (length < 1 || closes.length < length) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!;
    if (i >= length) sum -= closes[i - length]!;
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

/** Wilder/TradingView-style EMA: seed with SMA of first `length` closes. */
export function ema(closes: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (length < 1 || closes.length < length) return out;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += closes[i]!;
  let prev = sum / length;
  out[length - 1] = prev;
  const k = 2 / (length + 1);
  for (let i = length; i < closes.length; i++) {
    prev = closes[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI (Wilder). Returns 0–100. */
export function rsi(closes: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (length < 1 || closes.length < length + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= length;
  avgLoss /= length;
  out[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = length + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function stdev(closes: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (length < 2) return out;
  for (let i = length - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) sum += closes[j]!;
    const mean = sum / length;
    let acc = 0;
    for (let j = i - length + 1; j <= i; j++) {
      const d = closes[j]! - mean;
      acc += d * d;
    }
    out[i] = Math.sqrt(acc / length);
  }
  return out;
}

export function bollinger(
  closes: number[],
  length: number,
  multiplier = 2,
): { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const mid = sma(closes, length);
  const dev = stdev(closes, length);
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    const m = mid[i];
    const d = dev[i];
    if (m == null || d == null) continue;
    upper[i] = m + multiplier * d;
    lower[i] = m - multiplier * d;
  }
  return { mid, upper, lower };
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine: (number | null)[] = closes.map((_, i) => {
    const a = fastEma[i];
    const b = slowEma[i];
    return a == null || b == null ? null : a - b;
  });
  const compact: number[] = [];
  const compactIndex: number[] = [];
  for (let i = 0; i < macdLine.length; i++) {
    const value = macdLine[i];
    if (value == null) continue;
    compact.push(value);
    compactIndex.push(i);
  }
  const signalCompact = ema(compact, signal);
  const signalLine: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 0; i < compact.length; i++) {
    signalLine[compactIndex[i]!] = signalCompact[i] ?? null;
  }
  const hist: (number | null)[] = macdLine.map((value, i) => {
    const s = signalLine[i];
    return value == null || s == null ? null : value - s;
  });
  return { macd: macdLine, signal: signalLine, hist };
}

export function vwap(bars: Bar[]): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let pv = 0;
  let vol = 0;
  let sessionDay = Number.NaN;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const day = Math.floor(bar.time / 86_400_000);
    if (day !== sessionDay) {
      pv = 0;
      vol = 0;
      sessionDay = day;
    }
    const typical = (bar.high + bar.low + bar.close) / 3;
    const volume = bar.volume ?? 0;
    pv += typical * volume;
    vol += volume;
    out[i] = vol > 0 ? pv / vol : typical;
  }
  return out;
}

export function closesFromBars(bars: Bar[]): number[] {
  return bars.map((b) => (b.close > 0 ? b.close : b.open));
}
