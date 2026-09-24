// Mouse hover feedback without a drag: hit-testing, the pointer cursor and
// the trading-line / timescale-mark tooltip, plus the reset when the pointer
// leaves.

import type { StoredTradingLine } from "../../core/TradingStore";
import { timePriceAt } from "./coords";
import { hitTestAt, hoveredShapePart } from "./hitTest";
import { HANDLERS } from "./registry";
import { hideCanvasTooltip, showCanvasTooltip } from "./tooltip";
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
  const previousMark = host.hoverTimescaleMark;
  hitTestAt(host, x, y, zone, 1);
  const tradingLine = host.hoverTradingLineId ? host.trading.get(host.hoverTradingLineId) : undefined;
  const mark = host.hoverTimescaleMark;
  if (mark) {
    const hit = host.timescaleMarkScreen.find((candidate) => candidate.mark === mark);
    const lines = Array.isArray(mark.tooltip) ? mark.tooltip : [String(mark.tooltip ?? "")];
    showCanvasTooltip(host, lines.filter(Boolean).join("\n") || String(mark.label ?? ""), hit?.x ?? x, hit ? hit.y - hit.r : y);
  } else if (tradingLine) {
    const text = host.hoverTradingHit === "cancel"
      ? tradingLine.cancelTooltip
      : [tradingLine.tooltip, tradingLine.modifyTooltip].filter(Boolean).join(". ");
    showCanvasTooltip(host, text, x, y);
  } else {
    hideCanvasTooltip(host);
  }
  if (mark !== previousMark) host.requestPaint();
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
  if (host.hoverTimescaleMark) return "pointer";
  if (zone.inPriceAxis) return "ns-resize";
  if (zone.inTimeAxis) return "ew-resize";
  if (host.hoverTradingHit === "cancel") return "pointer";
  if (tradingLine) return tradingLine.editable ? "ns-resize" : "pointer";
  if (host.hoverShapeId) {
    const part = hoveredShapePart(host);
    if (part?.cursor) return part.cursor;
    if (host.shapes.get(host.hoverShapeId as never)?.shape === "horizontal_line") return "ns-resize";
    return part?.kind === "anchor" ? "pointer" : "move";
  }
  if (host.context.drawingTool !== "cursor") return "crosshair";
  return host.hoverMark ? "pointer" : "crosshair";
}

/** Clear hover state when the mouse leaves the canvas. */
export function leaveHover(host: GestureHost, dragging: boolean): void {
  host.crosshair.active = false;
  host.hoverMark = null;
  host.hoverTimescaleMark = null;
  host.hoverTradingLineId = null;
  host.hoverTradingHit = null;
  hideCanvasTooltip(host);
  host.context.crosshairMoved.fire({ unixTime: 0, price: 0, active: false });
  if (!dragging) host.canvas.style.cursor = "default";
  host.requestPaint();
}
