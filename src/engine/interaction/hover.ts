// Mouse hover feedback without a drag: hit-testing, the pointer cursor and
// the trading-line tooltip, plus the reset when the pointer leaves.

import type { StoredTradingLine } from "../../core/TradingStore";
import { timePriceAt } from "./coords";
import { hitTestAt } from "./hitTest";
import { HANDLERS } from "./registry";
import type { GestureHost, PointerInput } from "./types";

/** Move the mouse crosshair and publish it (layout sync and consumers). */
export function trackCrosshair(host: GestureHost, { x, y, zone }: PointerInput): void {
  const active = x >= host.plotL && x <= host.plotL + host.plotW && y >= host.plotT && y <= zone.contentBottom;
  host.crosshair = { x, y, active };
  const tp = timePriceAt(host, x, y);
  host.context.crosshairMoved.fire({ unixTime: tp.unixTime, price: tp.price, active });
}

export function updateHover(host: GestureHost, input: PointerInput): void {
  const { x, y, zone } = input;
  hitTestAt(host, x, y, zone, 1);
  const tradingLine = host.hoverTradingLineId ? host.trading.get(host.hoverTradingLineId) : undefined;
  host.canvas.title = tradingLine
    ? host.hoverTradingHit === "cancel" ? tradingLine.cancelTooltip : `${tradingLine.tooltip}. ${tradingLine.modifyTooltip}`
    : "";
  let cursor: string | null | void = null;
  for (const handler of HANDLERS) {
    cursor = handler.cursor?.(host, input);
    if (cursor) break;
  }
  host.canvas.style.cursor = cursor || builtinCursor(host, input, tradingLine);
}

function builtinCursor(
  host: GestureHost,
  { zone }: PointerInput,
  tradingLine: StoredTradingLine | undefined,
): string {
  if (zone.inPriceAxis) return "ns-resize";
  if (zone.inTimeAxis) return "ew-resize";
  if (host.hoverTradingHit === "cancel") return "pointer";
  if (tradingLine) return tradingLine.editable ? "ns-resize" : "pointer";
  if (host.hoverShapeId) {
    return host.shapes.get(host.hoverShapeId as never)?.shape === "horizontal_line" ? "ns-resize" : "move";
  }
  if (host.context.drawingTool !== "cursor") return "crosshair";
  return host.hoverMark ? "pointer" : "crosshair";
}

/** Clear hover state when the mouse leaves the canvas. */
export function leaveHover(host: GestureHost, dragging: boolean): void {
  host.crosshair.active = false;
  host.hoverMark = null;
  host.hoverTradingLineId = null;
  host.hoverTradingHit = null;
  host.canvas.title = "";
  host.context.crosshairMoved.fire({ unixTime: 0, price: 0, active: false });
  if (!dragging) host.canvas.style.cursor = "default";
  host.requestPaint();
}
