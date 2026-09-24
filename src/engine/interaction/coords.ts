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

/** Unix time (seconds) and price under a canvas point; the magnet snaps to OHLC. */
export function timePriceAt(host: GestureHost, x: number, y: number): { unixTime: number; price: number } {
  const s = host.plotScale();
  const bars = host.context.bars;
  let unixTime = 0;
  let idx = 0;
  if (bars.length) {
    idx = indexForX(s, x);
    const timeIndex = new TimeIndex(bars, resolutionToMs(host.context.resolution));
    unixTime = (timeIndex.timeAt(idx) ?? 0) / 1000;
  }
  let price = priceForY(s, y);
  if (host.context.magnet && bars.length) {
    const bar = bars[Math.max(0, Math.min(bars.length - 1, Math.round(idx)))];
    if (bar) {
      let best = bar.close;
      let bestD = Math.abs(price - bar.close);
      for (const candidate of [bar.open, bar.high, bar.low]) {
        const d = Math.abs(price - candidate);
        if (d < bestD) {
          bestD = d;
          best = candidate;
        }
      }
      price = best;
    }
  }
  return { unixTime, price };
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

/** Publish the current visible range after an interactive viewport change. */
export function emitViewport(host: GestureHost): void {
  host.context.viewportChanged.fire(host.data.visibleUnixRange());
}
