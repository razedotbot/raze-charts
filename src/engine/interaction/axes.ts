// Axis drags: vertical drag on the price axis stretches the price range around
// its centre; horizontal drag on the time axis stretches the bar span with the
// same zoom limits as the wheel (./limits.ts).

import { fromDisplay } from "../plotScale";
import { applyRange, zoomSpan } from "./limits";
import type { InteractionHandler } from "./types";

export const priceAxisHandler: InteractionHandler = {
  id: "price-axis",
  priority: 400,
  pointerDown(h, { y, zone }) {
    if (!zone.inPriceAxis) return;
    const ctx = h.context;
    const startY = y;
    const startMin = h.priceMin;
    const startMax = h.priceMax;
    const previous = ctx.scaleState();
    const s = h.plotScale();
    ctx.setScaleMode({ priceRange: { min: fromDisplay(s, startMin), max: fromDisplay(s, startMax) } }, "axis-drag");
    return {
      kind: "priceScale",
      move(_x, y) {
        const factor = Math.min(20, Math.max(0.05, 1 + (y - startY) / (h.plotH * 0.5)));
        const center = (startMin + startMax) / 2;
        const half = ((startMax - startMin) / 2) * factor;
        const scale = h.plotScale();
        ctx.setScaleMode({ priceRange: { min: fromDisplay(scale, center - half), max: fromDisplay(scale, center + half) } }, "axis-drag");
      },
      cancel() {
        ctx.setScaleMode(
          previous.autoScale ? { autoScale: true } : { autoScale: false, priceRange: previous.priceRange && { ...previous.priceRange } },
          "cancel",
        );
      },
    };
  },
};

export const timeAxisHandler: InteractionHandler = {
  id: "time-axis",
  priority: 500,
  pointerDown(h, { x, zone }) {
    if (!zone.inTimeAxis) return;
    const startX = x;
    const start = { ...h.context.visibleRange };
    return {
      kind: "timeScale",
      move(x) {
        const factor = Math.min(20, Math.max(0.05, 1 - (x - startX) / (h.plotW * 0.5)));
        const span = zoomSpan(h, start.to - start.from, factor);
        applyRange(h, { from: start.to - span, to: start.to }, "zoom", start);
      },
      cancel: () => applyRange(h, start, "cancel"),
    };
  },
};
