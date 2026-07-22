// Heikin-Ashi transform of a bar series (pure, no side effects).

import type { Bar } from "../types/charting_library";

export function heikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  let prevOpen = 0;
  let prevClose = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = i === 0 ? (b.open + b.close) / 2 : (prevOpen + prevClose) / 2;
    const high = Math.max(b.high, open, close);
    const low = Math.min(b.low > 0 ? b.low : Math.min(open, close), open, close);
    out.push({ time: b.time, open, high, low, close, volume: b.volume });
    prevOpen = open;
    prevClose = close;
  }
  return out;
}
