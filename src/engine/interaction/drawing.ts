// Drawing interactions: placing a new drawing point by point with the active
// tool, and selecting, dragging, cancelling and deleting existing drawings.

import type { ShapePoint } from "../../types/charting_library";
import { neededPoints, pointXY } from "../paint/shapes";
import { timePriceAt } from "./coords";
import type { DragSession, GestureHost, InteractionHandler } from "./types";

/** Places draft points while a drawing tool is armed; Escape cancels everything. */
export const drawingDraftHandler: InteractionHandler = {
  id: "drawing-draft",
  priority: 100,
  pointerDown(h, { x, y, zone }) {
    const tool = h.context.drawingTool;
    if (tool === "cursor" || !zone.inPlot || zone.inPriceAxis || zone.inTimeAxis) return;
    const tp = timePriceAt(h, x, y);
    const point: ShapePoint = { time: tp.unixTime, price: tp.price };
    if (!h.draft || h.draft.tool !== tool) {
      h.draft = { tool, points: [point] };
    } else {
      h.draft.points.push(point);
    }
    if (h.draft.points.length >= neededPoints(tool)) finishDraft(h);
    h.requestPaint();
    return true;
  },
  keyDown(h, e) {
    if (e.key !== "Escape") return;
    h.draft = null;
    h.context.drawingTool = "cursor";
    h.context.selectedShapeId = null;
    h.context.selectedTradingLineId = null;
    h.onToolDone?.("cursor");
    h.requestPaint();
    h.engine.announce("Drawing cancelled.");
    e.preventDefault();
    return true;
  },
};

function finishDraft(h: GestureHost): void {
  if (!h.draft) return;
  const { tool, points } = h.draft;
  h.draft = null;
  const stay = h.context.stayInDrawingMode;
  const resetTool = (): void => {
    if (stay) return;
    h.context.drawingTool = "cursor";
    h.onToolDone?.("cursor");
  };
  if (tool === "measure") {
    resetTool();
    h.requestPaint();
    return;
  }
  let text = "";
  if (tool === "text") {
    text = window.prompt("Label text", "Note") ?? "";
    if (!text.trim()) {
      resetTool();
      h.requestPaint();
      return;
    }
  }
  const defaults: Record<string, unknown> = {
    linecolor: tool === "fib_retracement" ? "#f5a623" : "#66d89e",
    linewidth: 1,
    linestyle: tool === "horizontal_line" || tool === "vertical_line" ? 2 : 0,
    showPrice: tool === "horizontal_line",
  };
  void h.shapes.createPoints(points, {
    shape: tool,
    text,
    lock: false,
    overrides: defaults,
  }).then((id) => {
    h.context.selectedShapeId = id as unknown as string;
  });
  resetTool();
  h.requestPaint();
}

/** Selects the hovered drawing and drags its nearest anchor; Delete removes the selection. */
export const drawingEditHandler: InteractionHandler = {
  id: "drawing-edit",
  priority: 300,
  pointerDown(h, { x, y }) {
    const id = h.hoverShapeId;
    if (!id) return;
    const shape = h.shapes.get(id as never);
    let pointIndex = 0;
    if (shape && shape.shape !== "horizontal_line") {
      const view = h.financeView();
      let best = Infinity;
      shape.points.forEach((point, index) => {
        const p = pointXY(view, point);
        if (!p) return;
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < best) {
          best = d;
          pointIndex = index;
        }
      });
    }
    h.context.selectedShapeId = id;
    h.context.selectedTradingLineId = null;
    return shapeDrag(h, id, pointIndex);
  },
  keyDown(h, e) {
    if ((e.key !== "Delete" && e.key !== "Backspace") || !h.context.selectedShapeId) return;
    h.shapes.remove(h.context.selectedShapeId as never);
    h.requestPaint();
    h.engine.announce("Selected drawing removed.");
    e.preventDefault();
    return true;
  },
};

function shapeDrag(h: GestureHost, id: string, pointIndex: number): DragSession {
  const before = h.shapes.capture(id as never);
  return {
    kind: "shape",
    move(x, y) {
      const shape = h.shapes.get(id as never);
      const point = shape?.points[pointIndex];
      if (!shape || !point) return;
      const tp = timePriceAt(h, x, y);
      point.price = tp.price;
      if (shape.shape !== "horizontal_line") point.time = tp.unixTime;
    },
    commit: () => h.shapes.commitUpdate(id as never, before),
    cancel() {
      if (before) h.shapes.restore(before);
    },
  };
}
