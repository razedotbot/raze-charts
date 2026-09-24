// Coordinate mapping shared by every interaction handler: client pixels to
// canvas pixels, canvas pixels to (time, price), and axis/plot zones.

import { TimeIndex } from "../../data/TimeIndex";
import { resolutionToMs } from "../../util/resolution";
import { timeAxisTop } from "../layout";
import { indexForX, priceForY } from "../plotScale";
import type { GestureHost, PointerZone } from "./types";

/** Client coordinates of a mouse/pointer event in canvas CSS pixels. */
export function pointerXY(host: GestureHost, e: MouseEvent): { x: number; y: number } {
  const rect = host.canvas.getBoundingClientRect();
  const rw = rect.width || 1;
  const rh = rect.height || 1;
  const cw = host.engine.cssWidth || host.canvas.clientWidth || 1;
  const ch = host.engine.cssHeight || host.canvas.clientHeight || 1;
  return {
    x: (e.clientX - rect.left) * (cw / rw),
    y: (e.clientY - rect.top) * (ch / rh),
  };
}

/**
 * Unix time (seconds) and price under a canvas point. The time snaps to the
 * nearest bar centre (so anchors sit on a candle, not between two) unless
 * `raze.snap_drawings_to_bars` is false. With the magnet on, the point snaps
 * to the nearest bar in the data and to that bar's closest OHLC price.
 */
export function timePriceAt(host: GestureHost, x: number, y: number): { unixTime: number; price: number } {
  const s = host.plotScale();
  const { bars, magnet, options, resolution } = host.context;
  const price = priceForY(s, y);
  if (!bars.length) return { unixTime: 0, price };
  let idx = indexForX(s, x);
  if (magnet) {
    const bar = bars[Math.max(0, Math.min(bars.length - 1, Math.round(idx)))]!;
    let best = bar.close;
    for (const candidate of [bar.open, bar.high, bar.low]) {
      if (Math.abs(price - candidate) < Math.abs(price - best)) best = candidate;
    }
    return { unixTime: bar.time / 1000, price: best };
  }
  if (options?.raze?.snap_drawings_to_bars !== false) idx = Math.round(idx);
  const timeIndex = new TimeIndex(bars, resolutionToMs(resolution));
  return { unixTime: (timeIndex.timeAt(idx) ?? 0) / 1000, price };
}

export function zoneAt(host: GestureHost, x: number, y: number): PointerZone {
  const right = host.plotL + host.plotW;
  const bottom = host.plotT + host.plotH;
  const contentBottom = timeAxisTop(host.plotT, host.plotH, host.subPanes, host.volumePane);
  return {
    inPriceAxis: x > right && y < bottom,
    inTimeAxis: y >= contentBottom && x < right,
    inPlot: x <= right && y >= host.plotT && y <= bottom,
    contentBottom,
  };
}
