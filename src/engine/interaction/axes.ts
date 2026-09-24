// Axis drags: vertical drag on the price axis stretches the price range around
// its centre; horizontal drag on the time axis stretches the bar span.

import { MAX_BAR_SPACING, MIN_BAR_SPACING } from "../layout";
import { fromDisplay } from "../plotScale";
import { emitViewport } from "./coords";
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
    const previousAutoScale = ctx.autoScalePrice;
    const previousPriceRange = ctx.priceRange ? { ...ctx.priceRange } : null;
    ctx.autoScalePrice = false;
    const s = h.plotScale();
    ctx.priceRange = { min: fromDisplay(s, startMin), max: fromDisplay(s, startMax) };
    return {
      kind: "priceScale",
      move(_x, y) {
        const factor = Math.min(20, Math.max(0.05, 1 + (y - startY) / (h.plotH * 0.5)));
        const center = (startMin + startMax) / 2;
        const half = ((startMax - startMin) / 2) * factor;
        const scale = h.plotScale();
        ctx.autoScalePrice = false;
        ctx.priceRange = { min: fromDisplay(scale, center - half), max: fromDisplay(scale, center + half) };
      },
      cancel() {
        ctx.autoScalePrice = previousAutoScale;
        ctx.priceRange = previousPriceRange ? { ...previousPriceRange } : null;
      },
    };
  },
};

export const timeAxisHandler: InteractionHandler = {
  id: "time-axis",
  priority: 500,
  pointerDown(h, { x, zone }) {
    if (!zone.inTimeAxis) return;
    const ctx = h.context;
    const startX = x;
    const { from: startFrom, to: startTo } = ctx.visibleRange;
    return {
      kind: "timeScale",
      move(x) {
        const factor = Math.min(20, Math.max(0.05, 1 - (x - startX) / (h.plotW * 0.5)));
        const minSpan = h.plotW / MAX_BAR_SPACING;
        const maxSpan = Math.max(h.plotW / MIN_BAR_SPACING, startTo - startFrom);
        const newSpan = Math.min(maxSpan, Math.max(minSpan, (startTo - startFrom) * factor));
        ctx.visibleRange = { from: startTo - newSpan, to: startTo };
        void h.data.maybeLoadMoreHistory();
        emitViewport(h);
      },
      cancel() {
        ctx.visibleRange = { from: startFrom, to: startTo };
        emitViewport(h);
      },
    };
  },
};
