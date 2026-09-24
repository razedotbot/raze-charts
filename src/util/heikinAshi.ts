// Heikin-Ashi transform of a bar series (pure, no side effects).
//
// Any finite price is valid, including zero and negative values. A bar whose
// close is not a finite number is whitespace: it is passed through unchanged
// (so indices stay aligned with the source) and does not seed the next bar.

import type { Bar } from "../types/charting_library";

export function heikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  let started = false;
  let prevOpen = 0;
  let prevClose = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const c = b.close;
    if (!Number.isFinite(c)) {
      out.push({ ...b });
      continue;
    }
    const o = Number.isFinite(b.open) ? b.open : c;
    const h = Number.isFinite(b.high) ? b.high : Math.max(o, c);
    const l = Number.isFinite(b.low) ? b.low : Math.min(o, c);
    const close = (o + h + l + c) / 4;
    const open = started ? (prevOpen + prevClose) / 2 : (o + c) / 2;
    const high = Math.max(h, open, close);
    const low = Math.min(l, open, close);
    out.push({ time: b.time, open, high, low, close, volume: b.volume });
    started = true;
    prevOpen = open;
    prevClose = close;
  }
  return out;
}
