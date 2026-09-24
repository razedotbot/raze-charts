// Viewport navigation: drag to pan, wheel to zoom around the pointer,
// double-click to reset scaling, and F / + / - / arrow keys. Every write goes
// through ./limits.ts, so pan bounds and zoom limits are the same for each.

import type { IndexRange } from "../../core/context";
import { t } from "../../i18n";
import { barSpacing } from "../plotScale";
import { applyRange, zoomSpan } from "./limits";
import type { GestureHost, InteractionHandler } from "./types";
import { wheelZoomFactor } from "./wheel";

/**
 * Zoom by `factor` (> 1 zooms out) keeping the bar under plot fraction `fx`
 * (0 = left edge, 1 = right edge) at the same screen position.
 */
export function zoomAround(h: GestureHost, fx: number, factor: number, reason: "zoom" | "keyboard" | "pinch", start?: IndexRange): void {
  const { from, to } = start ?? h.context.visibleRange;
  const span = to - from;
  if (!(span > 0)) return;
  const next = zoomSpan(h, span, factor);
  const left = from + fx * (span - next);
  applyRange(h, { from: left, to: left + next }, reason, start);
}

const unchanged = (h: GestureHost, from: number, to: number): boolean =>
  h.context.visibleRange.from === from && h.context.visibleRange.to === to;

/** Lowest-priority fallback: a press that nothing else claimed clears the selection and pans. */
export const viewportHandler: InteractionHandler = {
  id: "viewport",
  priority: 1000,
  pointerDown(h, { x, y }) {
    const ctx = h.context;
    ctx.selectedShapeId = null;
    ctx.selectedTradingLineId = null;
    if (x > h.plotL + h.plotW || y > h.plotT + h.plotH) return true;
    const start = { ...ctx.visibleRange };
    return {
      kind: "pan",
      move(moveX) {
        const dxBars = (moveX - x) / barSpacing(h.plotScale());
        applyRange(h, { from: start.from - dxBars, to: start.to - dxBars }, "pan", start);
      },
      cancel: () => applyRange(h, start, "cancel"),
    };
  },
  wheel(h, { x }, e) {
    // A purely horizontal trackpad gesture belongs to the surrounding page;
    // treating deltaY === 0 as zoom-in made sideways scrolling unexpectedly
    // consume and magnify the chart.
    if (e.deltaY === 0) return;
    e.preventDefault();
    zoomAround(h, (x - h.plotL) / h.plotW, wheelZoomFactor(e, h.plotH), "zoom");
    return true;
  },
  dblClick(h, { zone }) {
    h.context.setScaleMode({ autoScale: true }, "axis-reset");
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
      message = "Chart fitted to all data.";
    } else if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_") {
      const zoomIn = e.key === "+" || e.key === "=";
      zoomAround(h, 1, zoomIn ? 1 / 1.15 : 1.15, "keyboard");
      message = unchanged(h, from, to)
        ? t("chart.announce.zoomLimit", "Zoom limit reached.")
        : zoomIn ? "Zoomed in." : "Zoomed out.";
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const left = e.key === "ArrowLeft";
      const shift = span * 0.08 * (left ? -1 : 1);
      applyRange(h, { from: from + shift, to: to + shift }, "keyboard");
      message = !unchanged(h, from, to) ? left ? "Panned left." : "Panned right."
        : left ? t("chart.announce.dataStart", "Start of the data.") : t("chart.announce.dataEnd", "End of the data.");
    } else {
      return;
    }
    h.requestPaint();
    h.engine.announce(message);
    e.preventDefault();
    return true;
  },
};
