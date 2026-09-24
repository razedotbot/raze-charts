// Finance scene: named marks in a frozen paint order, split across the two
// canvas layers (see layers.ts). Each mark reuses the existing Canvas paint
// functions, so a layer paints exactly the pixels the single-canvas frame did.

import { drawPriceSeries } from "./paint/candles";
import { drawVolume } from "./paint/volume";
import { drawGrid, drawSeparators } from "./paint/grid";
import { drawOverlayStudies, drawSubPanes } from "./paint/studies";
import { drawShapes, drawDraft } from "./paint/shapes";
import { drawMarks, drawMarkTooltip } from "./paint/marks";
import { drawPriceAxis, drawTimeAxis } from "./paint/axes";
import { drawLastPrice } from "./paint/lastPrice";
import { drawCrosshair } from "./paint/crosshair";
import { drawLegend } from "./paint/legend";
import { drawSessionBreaks } from "./paint/session";
import { drawAxisChrome, drawCompare, drawTimeNavigator, drawTimescaleMarks } from "./paint/chrome";
import { drawTrading } from "./paint/trading";
import { drawAxisTags } from "./paint/axisTags";
import type { FinanceLayerId } from "./layers";
import type { FinanceView } from "./paint/view";

export type FinanceMarkKind =
  | "grid"
  | "volume"
  | "series"
  | "overlayStudies"
  | "shapes"
  | "draft"
  | "barMarks"
  | "priceAxis"
  | "subPanes"
  | "timeAxis"
  | "axisChrome"
  | "lastPrice"
  | "trading"
  | "axisTags"
  | "crosshair"
  | "legend"
  | "markTooltip"
  | "separators";

/**
 * Marks per layer, in paint order. The main layer ends with the axis-tag pass
 * so queued pills sit above both axes; the overlay repeats the pass for tags
 * its own painters queue (for example the crosshair's).
 */
export const FINANCE_LAYER_ORDER: Readonly<Record<FinanceLayerId, readonly FinanceMarkKind[]>> = Object.freeze({
  main: Object.freeze<FinanceMarkKind[]>([
    "grid",
    "volume",
    "series",
    "overlayStudies",
    "shapes",
    "barMarks",
    "priceAxis",
    "subPanes",
    "timeAxis",
    "lastPrice",
    "trading",
    "axisTags",
    "separators",
  ]),
  overlay: Object.freeze<FinanceMarkKind[]>([
    "draft",
    "axisChrome",
    "crosshair",
    "axisTags",
    "legend",
    "markTooltip",
  ]),
});

/** Every mark in single-canvas order: the main layer, then the overlay above it. */
export const FINANCE_PAINT_ORDER: readonly FinanceMarkKind[] = Object.freeze([
  ...FINANCE_LAYER_ORDER.main,
  ...FINANCE_LAYER_ORDER.overlay.filter((kind) => kind !== "axisTags"),
]);

/** The layer a mark paints on (the axis-tag pass runs on both). */
export function financeMarkLayer(kind: FinanceMarkKind): FinanceLayerId {
  return FINANCE_LAYER_ORDER.main.includes(kind) ? "main" : "overlay";
}

export function paintFinanceMark(
  kind: FinanceMarkKind,
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  priceTicks: number[],
  timeTicks: { index: number; time: number }[],
): void {
  switch (kind) {
    case "grid":
      drawGrid(ctx, v, priceTicks, timeTicks);
      drawSessionBreaks(ctx, v);
      break;
    case "volume":
      drawVolume(ctx, v);
      break;
    case "series":
      drawPriceSeries(ctx, v);
      drawCompare(ctx, v);
      break;
    case "overlayStudies":
      drawOverlayStudies(ctx, v);
      break;
    case "shapes":
      drawShapes(ctx, v);
      break;
    case "draft":
      // On the single canvas the draft painted below the axes, which hid any
      // part of it outside the plot. The overlay paints above the axes, so
      // the draft is clipped to the main plot instead.
      ctx.save();
      ctx.beginPath();
      ctx.rect(v.plotL, v.plotT, v.plotW, v.plotH);
      ctx.clip();
      drawDraft(ctx, v);
      ctx.restore();
      break;
    case "barMarks":
      drawMarks(ctx, v);
      break;
    case "priceAxis":
      drawPriceAxis(ctx, v, priceTicks);
      break;
    case "subPanes":
      drawSubPanes(ctx, v, timeTicks);
      break;
    case "timeAxis":
      drawTimeAxis(ctx, v, timeTicks);
      drawTimescaleMarks(ctx, v);
      drawTimeNavigator(ctx, v);
      break;
    case "axisChrome":
      drawAxisChrome(ctx, v);
      break;
    case "lastPrice":
      drawLastPrice(ctx, v);
      break;
    case "trading":
      drawTrading(ctx, v);
      break;
    case "axisTags":
      drawAxisTags(ctx, v);
      break;
    case "crosshair":
      drawCrosshair(ctx, v);
      break;
    case "legend":
      drawLegend(ctx, v);
      break;
    case "markTooltip":
      drawMarkTooltip(ctx, v);
      break;
    case "separators":
      drawSeparators(ctx, v);
      break;
  }
}

/** Paint one layer's marks into `ctx`. */
export function paintFinanceLayer(
  layer: FinanceLayerId,
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  priceTicks: number[],
  timeTicks: { index: number; time: number }[],
): void {
  for (const kind of FINANCE_LAYER_ORDER[layer]) {
    paintFinanceMark(kind, ctx, v, priceTicks, timeTicks);
  }
}

/**
 * Paint the whole scene into one context (screenshots, exports, single-canvas
 * hosts): the main layer, then the overlay with its own axis-tag queue. As on
 * the overlay canvas, the overlay pass may read the hit lists the main pass
 * filled but never adds to them (the draft ghost is not a drawing).
 */
export function paintFinanceScene(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  priceTicks: number[],
  timeTicks: { index: number; time: number }[],
): void {
  paintFinanceLayer("main", ctx, v, priceTicks, timeTicks);
  paintFinanceLayer("overlay", ctx, { ...v, axisTags: [], shapeScreen: [] }, priceTicks, timeTicks);
}
