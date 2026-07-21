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

export function closesFromBars(bars: Bar[]): number[] {
  return bars.map((b) => (b.close > 0 ? b.close : b.open));
}
