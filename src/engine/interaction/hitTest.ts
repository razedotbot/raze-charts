// Hover hit-testing: resolves which trading line, mark or drawing sits under
// a canvas point and records it on the host for handlers and painters.

import { hitComplexShape } from "../paint/shapes";
import type { GestureHost, PointerZone } from "./types";

/** `tolMul` widens every tolerance (2 for touch, 1 for mouse). */
export function hitTestAt(host: GestureHost, x: number, y: number, zone: PointerZone, tolMul: number): void {
  host.hoverShapeId = null;
  host.hoverTradingLineId = null;
  host.hoverTradingHit = null;
  host.hoverMark = null;
  if (zone.inPriceAxis || zone.inTimeAxis || y > host.plotT + host.plotH) return;
  for (const hit of host.tradingScreen) {
    if (x >= hit.x1 && x <= hit.x2 && Math.abs(hit.y - y) <= 7 * tolMul) {
      host.hoverTradingLineId = hit.line.id;
      host.hoverTradingHit = hit.hit;
      break;
    }
  }
  for (const m of host.markScreen) {
    const dx = x - m.x;
    const dy = y - m.y;
    const r = m.r + 2 * tolMul;
    if (dx * dx + dy * dy <= r * r) {
      host.hoverMark = m.mark;
      break;
    }
  }
  if (host.hoverMark || host.hoverTradingLineId) return;
  const view = host.financeView();
  for (const { shape, y: sy } of host.shapeScreen) {
    if (shape.lock || shape.disableSelection) continue;
    if (shape.shape === "horizontal_line") {
      if (Math.abs(sy - y) <= 4 * tolMul && x <= host.plotL + host.plotW) {
        host.hoverShapeId = shape.id as unknown as string;
        break;
      }
    } else if (hitComplexShape(view, shape, x, y, tolMul)) {
      host.hoverShapeId = shape.id as unknown as string;
      break;
    }
  }
}
