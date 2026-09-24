// Hover hit-testing: resolves which timescale mark, trading line, mark or
// drawing sits under a canvas point and records it on the host for handlers
// and painters. Drawings are tested topmost-first (the one the user sees on
// top wins) and report which part was hit: an anchor, the body or a label.

import type { DrawingHit } from "../../drawings/types";
import { hitComplexShape, pointXY } from "../paint/shapes";
import type { FinanceView, ShapeHit } from "../paint/view";
import type { GestureHost, PointerZone } from "./types";

const BODY: DrawingHit = { kind: "body" };
const LABEL: DrawingHit = { kind: "label" };
const parts = new WeakMap<GestureHost, DrawingHit>();

/** The part of `host.hoverShapeId` found by the last hit test. */
export function hoveredShapePart(host: GestureHost): DrawingHit | null {
  return (host.hoverShapeId && parts.get(host)) || null;
}

/** Painted drawings ordered topmost first: larger `z`, then later paint order. */
export function topmostFirst(list: readonly ShapeHit[]): ShapeHit[] {
  return list
    .map((hit, order) => ({ hit, order }))
    .sort((a, b) => (b.hit.z ?? 0) - (a.hit.z ?? 0) || b.order - a.order)
    .map(({ hit }) => hit);
}

/** Built-in geometry test used until a painter supplies `ShapeHit.hitTest`. */
function fallbackHit(view: FinanceView, { shape, y: sy }: ShapeHit, x: number, y: number, tolMul: number): DrawingHit | null {
  if (shape.shape === "horizontal_line") {
    return Math.abs(sy - y) <= 4 * tolMul && x <= view.plotL + view.plotW ? BODY : null;
  }
  if (!hitComplexShape(view, shape, x, y, tolMul)) return null;
  let index = -1;
  let best = 6 * tolMul;
  shape.points.forEach((point, i) => {
    const p = pointXY(view, point);
    const d = p ? Math.hypot(p.x - x, p.y - y) : Infinity;
    if (d <= best) {
      best = d;
      index = i;
    }
  });
  if (index >= 0 && shape.shape !== "vertical_line") return { kind: "anchor", index };
  return shape.shape === "text" ? LABEL : BODY;
}

/** `tolMul` widens every tolerance (2 for touch, 1 for mouse). */
export function hitTestAt(host: GestureHost, x: number, y: number, zone: PointerZone, tolMul: number): void {
  host.hoverShapeId = null;
  host.hoverTradingLineId = null;
  host.hoverTradingHit = null;
  host.hoverMark = null;
  host.hoverTimescaleMark = null;
  for (const m of host.timescaleMarkScreen ?? []) {
    if (Math.hypot(x - m.x, y - m.y) <= m.r + 2 * tolMul) {
      host.hoverTimescaleMark = m.mark;
      return;
    }
  }
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
  for (const hit of topmostFirst(host.shapeScreen)) {
    const { shape } = hit;
    if (shape.lock || shape.disableSelection) continue;
    const part = hit.hitTest ? hit.hitTest({ x, y }, 5 * tolMul) : fallbackHit(view, hit, x, y, tolMul);
    if (part) {
      host.hoverShapeId = shape.id as unknown as string;
      parts.set(host, part);
      break;
    }
  }
}
