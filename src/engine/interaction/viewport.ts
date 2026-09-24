// Viewport navigation: drag to pan, wheel to zoom around the pointer,
// double-click to reset scaling, and F / + / - / arrow keys.

import { MAX_BAR_SPACING, MIN_BAR_SPACING } from "../layout";
import { barSpacing, indexForX } from "../plotScale";
import { emitViewport } from "./coords";
import type { GestureHost, InteractionHandler } from "./types";

function setRange(h: GestureHost, from: number, to: number, loadHistory: boolean): void {
  h.context.visibleRange = { from, to };
  if (loadHistory) void h.data.maybeLoadMoreHistory();
  emitViewport(h);
}

/** Lowest-priority fallback: a press that nothing else claimed clears the selection and pans. */
export const viewportHandler: InteractionHandler = {
  id: "viewport",
  priority: 1000,
  pointerDown(h, { x, y }) {
    const ctx = h.context;
    ctx.selectedShapeId = null;
    ctx.selectedTradingLineId = null;
    if (x > h.plotL + h.plotW || y > h.plotT + h.plotH) return true;
    const { from: startFrom, to: startTo } = ctx.visibleRange;
    return {
      kind: "pan",
      move(moveX) {
        const dxBars = (moveX - x) / barSpacing(h.plotScale());
        setRange(h, startFrom - dxBars, startTo - dxBars, true);
      },
      cancel: () => setRange(h, startFrom, startTo, false),
    };
  },
  wheel(h, { x }, e) {
    // A purely horizontal trackpad gesture belongs to the surrounding page;
    // treating deltaY === 0 as zoom-in made sideways scrolling unexpectedly
    // consume and magnify the chart.
    if (e.deltaY === 0) return;
    e.preventDefault();
    const { from, to } = h.context.visibleRange;
    const span = to - from;
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    const newSpan = Math.max(h.plotW / MAX_BAR_SPACING, Math.min(Math.max(h.plotW / MIN_BAR_SPACING, span), span * factor));
    const pivot = indexForX(h.plotScale(), x);
    const leftFrac = (pivot - from) / span;
    setRange(h, pivot - leftFrac * newSpan, pivot + (1 - leftFrac) * newSpan, true);
    h.requestPaint();
    return true;
  },
  dblClick(h, { zone }) {
    h.context.priceRange = null;
    h.context.autoScalePrice = true;
    if (!zone.inPriceAxis) h.fitContent();
    else h.requestPaint();
    return true;
  },
  keyDown(h, e) {
    const { from, to } = h.context.visibleRange;
    const span = to - from;
    let message: string;
    if (e.key === "f" || e.key === "F") {
      h.fitContent();
      h.engine.announce("Chart fitted to all data.");
      e.preventDefault();
      return true;
    } else if (e.key === "+" || e.key === "=") {
      setRange(h, to - Math.max(h.plotW / MAX_BAR_SPACING, span / 1.15), to, false);
      message = "Zoomed in.";
    } else if (e.key === "-" || e.key === "_") {
      setRange(h, to - Math.min(Math.max(h.plotW / MIN_BAR_SPACING, span), span * 1.15), to, true);
      message = "Zoomed out.";
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const shift = span * 0.08 * (e.key === "ArrowLeft" ? -1 : 1);
      setRange(h, from + shift, to + shift, true);
      message = e.key === "ArrowLeft" ? "Panned left." : "Panned right.";
    } else {
      return;
    }
    h.requestPaint();
    h.engine.announce(message);
    e.preventDefault();
    return true;
  },
};
