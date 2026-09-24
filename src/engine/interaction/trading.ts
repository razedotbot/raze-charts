// Trading-line interactions: select, drag or modify an order/position line,
// cancel it from its cancel button or Delete, and nudge it by tick with arrows.

import { timePriceAt } from "./coords";
import type { DragSession, GestureHost, InteractionHandler } from "./types";

export const tradingHandler: InteractionHandler = {
  id: "trading",
  priority: 200,
  pointerDown(h) {
    const id = h.hoverTradingLineId;
    if (!id) return;
    const line = h.trading.get(id);
    if (h.hoverTradingHit === "cancel") {
      h.trading.cancel(id);
      h.engine.announce(`${line?.text ?? "Trading line"} cancelled.`);
      return true;
    }
    h.context.selectedShapeId = null;
    h.context.selectedTradingLineId = id;
    let session: DragSession | true = true;
    if (line?.editable) session = tradingDrag(h, line.id, line.price);
    else h.trading.modify(id);
    h.requestPaint();
    return session;
  },
  dblClick(h, _input, e) {
    if (!h.hoverTradingLineId || h.hoverTradingHit !== "body") return;
    h.trading.modify(h.hoverTradingLineId);
    e.preventDefault();
    return true;
  },
  keyDown(h, e) {
    const id = h.context.selectedTradingLineId;
    if (!id) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      h.trading.cancel(id);
      h.engine.announce("Selected trading order cancelled.");
      e.preventDefault();
      return true;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const line = h.trading.get(id);
    if (line?.editable) {
      const info = h.context.symbolInfo;
      const tick = (info?.minmov ?? 1) / (info?.pricescale ?? 100);
      const direction = e.key === "ArrowUp" ? 1 : -1;
      const price = line.price + direction * tick * (e.shiftKey ? 10 : 1);
      const committed = h.trading.move(line.id, price, "moved", "keyboard");
      h.engine.announce(`${line.text} moved to ${h.context.formatPrice(committed, info?.pricescale ?? 100)}.`);
      e.preventDefault();
    }
    return true;
  },
};

function tradingDrag(h: GestureHost, id: string, startPrice: number): DragSession {
  return {
    kind: "trading",
    move(x, y) {
      const line = h.trading.get(id);
      if (line?.editable) h.trading.move(line.id, timePriceAt(h, x, y).price, "moving", "drag");
    },
    commit() {
      const line = h.trading.get(id);
      if (line) h.trading.move(line.id, line.price, "moved", "drag");
    },
    cancel() {
      const line = h.trading.get(id);
      if (line) h.trading.move(line.id, startPrice, "moved", "drag");
    },
  };
}
