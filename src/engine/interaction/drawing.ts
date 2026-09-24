// Drawing interactions: placing a new drawing point by point with the active
// tool (the text tool opens the inline editor), and selecting, dragging,
// re-editing, cancelling and deleting existing drawings.
//
// A drag on an anchor moves that anchor; a drag on the body or a label moves
// every anchor by the same whole-bar and price delta. Movement inside the
// drag slop (3 px mouse, 6 px touch) is a click: it fires `click`, leaves the
// points untouched and adds no undo entry. A drag fires `move` at most once
// per frame and commits one `points_changed` and one undo entry.

import type { StoredShape } from "../../core/ShapeStore";
import type { DrawingHit } from "../../drawings/types";
import { t } from "../../i18n";
import type { ShapePoint } from "../../types/charting_library";
import { openInlineTextEditor, type InlineTextEditorHandle } from "../../ui/InlineTextEditor";
import { TimeIndex } from "../../data/TimeIndex";
import { resolutionToMs } from "../../util/resolution";
import { neededPoints, pointXY } from "../paint/shapes";
import { barSpacing, fromDisplay, toDisplay } from "../plotScale";
import { timePriceAt } from "./coords";
import { hoveredShapePart } from "./hitTest";
import type { DragSession, GestureHost, InteractionHandler } from "./types";

/** A double-click this soon after placing a draft point belongs to the drafting clicks. */
const DRAFT_DBLCLICK_MS = 600;
const lastDraftPointAt = new WeakMap<GestureHost, number>();

/** The text editor a host has scheduled or open. Callbacks from a session no longer listed here are dropped. */
interface TextEditing {
  timer?: number;
  editor?: InlineTextEditorHandle;
}
const textEditing = new WeakMap<GestureHost, TextEditing>();

function textSession(h: GestureHost): TextEditing {
  let session = textEditing.get(h);
  if (!session) textEditing.set(h, (session = {}));
  return session;
}

/**
 * Teardown: drop a scheduled text editor and discard an open one without
 * creating, changing or resetting anything, so a chart destroyed mid-edit
 * never writes into its torn-down stores or calls back into the widget.
 */
export function cancelTextEditing(h: GestureHost): void {
  const session = textEditing.get(h);
  if (!session) return;
  textEditing.delete(h);
  window.clearTimeout(session.timer);
  session.editor?.cancel();
}

/** Places draft points while a drawing tool is armed; Escape cancels everything. */
export const drawingDraftHandler: InteractionHandler = {
  id: "drawing-draft",
  priority: 100,
  pointerDown(h, { x, y, zone }) {
    const tool = h.context.drawingTool;
    if (tool === "cursor" || !zone.inPlot || zone.inPriceAxis || zone.inTimeAxis) return;
    if (tool !== "text") lastDraftPointAt.set(h, performance.now());
    const tp = timePriceAt(h, x, y);
    const point: ShapePoint = { time: tp.unixTime, price: tp.price };
    if (!h.draft || h.draft.tool !== tool) {
      h.draft = { tool, points: [point] };
    } else {
      h.draft.points.push(point);
    }
    if (h.draft.points.length >= neededPoints(tool)) finishDraft(h, x, y);
    h.requestPaint();
    return true;
  },
  dblClick(h, { zone }) {
    // Rapid clicks that place anchors must not refit the chart.
    if (!zone.inPlot || zone.inPriceAxis || zone.inTimeAxis) return;
    const recent = performance.now() - (lastDraftPointAt.get(h) ?? -Infinity) < DRAFT_DBLCLICK_MS;
    lastDraftPointAt.delete(h);
    return h.context.drawingTool !== "cursor" || recent;
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

function finishDraft(h: GestureHost, x: number, y: number): void {
  if (!h.draft) return;
  const { tool, points } = h.draft;
  h.draft = null;
  const resetTool = (): void => {
    if (h.context.stayInDrawingMode) return;
    h.context.drawingTool = "cursor";
    h.onToolDone?.("cursor");
  };
  const create = (text: string): void => {
    const theme = h.context.theme;
    void h.shapes.createPoints(points, {
      shape: tool,
      text,
      lock: false,
      overrides: {
        linecolor: theme.drawingDefault ?? (tool === "fib_retracement" ? "#f5a623" : "#66d89e"),
        linewidth: 1,
        linestyle: tool === "horizontal_line" || tool === "vertical_line" ? 2 : 0,
        showPrice: tool === "horizontal_line",
      },
    }).then((id) => {
      h.context.selectedShapeId = id as unknown as string;
      h.requestPaint();
    });
  };
  if (tool === "text") {
    const anchor = pointXY(h.financeView(), points[0]!) ?? { x, y };
    // Open after this press finishes: the browser focuses the canvas on the
    // mousedown that follows pointerdown, which would blur (commit) the editor.
    const session = textSession(h);
    window.clearTimeout(session.timer);
    session.timer = window.setTimeout(() => {
      session.timer = undefined;
      editText(h, anchor, "", 12, (text) => {
        if (text?.trim()) create(text);
        resetTool();
      });
    }, 0);
  } else {
    if (tool !== "measure") create("");
    resetTool();
  }
  h.requestPaint();
}

/** Open the inline editor over the chart; `done` receives the text, or null when cancelled. */
function editText(h: GestureHost, at: { x: number; y: number }, value: string, fontSize: number, done: (text: string | null) => void): void {
  const parent = h.context.overlayHost;
  if (!parent) {
    if (h.canvas.isConnected) console.warn("[raze-charts] text editing needs a mounted chart overlay; nothing was edited.");
    return done(null);
  }
  const session = textSession(h);
  let editor: InlineTextEditorHandle | undefined;
  const finish = (text: string | null): void => {
    // cancelTextEditing (teardown) removed the session: drop the result.
    if (textEditing.get(h) !== session) return;
    if (session.editor === editor) session.editor = undefined;
    done(text);
    h.requestPaint();
  };
  // Opening first commits an editor already open in this overlay; its `finish` runs before this assignment.
  session.editor = editor = openInlineTextEditor({
    parent,
    x: at.x,
    y: at.y,
    value,
    fontSize,
    fontFamily: h.context.fontFamily,
    label: t("drawing.text.editor", "Drawing text"),
    placeholder: t("drawing.text.placeholder", "Text"),
    returnFocus: h.canvas,
    onCommit: finish,
    onCancel: () => finish(null),
  });
}

/** Re-edit a drawing's text in place: one undo entry and `properties_changed`. */
function editShapeText(h: GestureHost, { id, points, overrides, text: value }: StoredShape): void {
  const at = pointXY(h.financeView(), points[0]!);
  const size = overrides.fontsize;
  if (at) editText(h, at, value, typeof size === "number" ? size : 12, (text) => {
    const shape = h.shapes.get(id);
    if (!shape || !text?.trim() || text === shape.text) return;
    const before = h.shapes.capture(id);
    shape.text = text;
    h.shapes.commitUpdate(id, before);
  });
}

/** Selects the hovered drawing and drags its anchor or body; Delete removes the selection. */
export const drawingEditHandler: InteractionHandler = {
  id: "drawing-edit",
  priority: 300,
  pointerDown(h, { x, y, pointerType }) {
    const id = h.hoverShapeId;
    const part = hoveredShapePart(h);
    if (!id || !part) return;
    h.context.selectedShapeId = id;
    h.context.selectedTradingLineId = null;
    h.requestPaint();
    return shapeDrag(h, id, part, x, y, pointerType === "touch" ? 6 : 3);
  },
  dblClick(h) {
    const id = h.hoverShapeId;
    const shape = id ? h.shapes.get(id as never) : undefined;
    if (!shape) return;
    h.context.selectedShapeId = id;
    if (shape.shape === "text" || (shape.text && hoveredShapePart(h)?.kind === "label")) editShapeText(h, shape);
    h.requestPaint();
    return true;
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

function shapeDrag(h: GestureHost, id: string, part: DrawingHit, x0: number, y0: number, slop: number): DragSession {
  const before = h.shapes.capture(id as never);
  let dragging = false;
  let moveQueued = false;
  const fireMove = (): void => {
    if (moveQueued) return;
    moveQueued = true;
    h.context.drawingEvent.fire(id, "move");
    window.requestAnimationFrame(() => {
      moveQueued = false;
    });
  };
  return {
    kind: "shape",
    move(x, y) {
      const shape = h.shapes.get(id as never);
      if (!shape || !before) return;
      if (!dragging && Math.hypot(x - x0, y - y0) <= slop) return;
      dragging = true;
      // A horizontal line is one price: it follows the pointer (and the magnet).
      const anchor = part.kind === "anchor" ? part.index : shape.shape === "horizontal_line" ? 0 : -1;
      if (anchor >= 0) {
        const point = shape.points[anchor];
        if (!point) return;
        const tp = timePriceAt(h, x, y);
        point.price = tp.price;
        if (shape.shape !== "horizontal_line") point.time = tp.unixTime;
      } else {
        shape.points = moveBody(h, shape, before.points, x - x0, y - y0);
      }
      h.requestPaint();
      fireMove();
    },
    commit() {
      if (dragging) h.shapes.commitUpdate(id as never, before);
      else h.context.drawingEvent.fire(id, "click");
    },
    cancel() {
      // Put the captured points back in place: no drawing_event, no undo entry.
      // A press still inside the slop moved nothing, so there is nothing to undo.
      const shape = h.shapes.get(id as never);
      if (!dragging || !shape || !before) return false;
      shape.points = before.points.map((point) => ({ ...point }));
      h.requestPaint();
      return true;
    },
  };
}

/** Every anchor shifted by the same bar delta (whole bars unless free placement) and display-price delta. */
function moveBody(h: GestureHost, shape: StoredShape, start: readonly ShapePoint[], dx: number, dy: number): ShapePoint[] {
  const s = h.plotScale();
  const { bars, resolution, options } = h.context;
  const rawBars = dx / barSpacing(s);
  const dBars = options?.raze?.snap_drawings_to_bars === false ? rawBars : Math.round(rawBars);
  const dDisplay = (-dy / s.plotH) * (s.priceMax - s.priceMin);
  const timeIndex = new TimeIndex(bars, resolutionToMs(resolution));
  return start.map((point) => {
    const next = { ...point };
    const index = shape.shape === "horizontal_line" ? null : timeIndex.indexAt(point.time * 1000);
    const time = index === null ? null : timeIndex.timeAt(index + dBars);
    if (time !== null) next.time = time / 1000;
    if (typeof point.price === "number" && shape.shape !== "vertical_line") {
      next.price = fromDisplay(s, toDisplay(s, point.price) + dDisplay);
    }
    return next;
  });
}
