// Finance scene: named marks in the frozen paint order. Each mark reuses the
// existing Canvas paint functions so pixels stay identical.

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
  | "lastPrice"
  | "trading"
  | "crosshair"
  | "legend"
  | "markTooltip"
  | "separators";

export const FINANCE_PAINT_ORDER: readonly FinanceMarkKind[] = [
  "grid",
  "volume",
  "series",
  "overlayStudies",
  "shapes",
  "draft",
  "barMarks",
  "priceAxis",
  "subPanes",
  "timeAxis",
  "lastPrice",
  "trading",
  "crosshair",
  "legend",
  "markTooltip",
  "separators",
];

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
      drawDraft(ctx, v);
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
      drawAxisChrome(ctx, v);
      drawTimeNavigator(ctx, v);
      break;
    case "lastPrice":
      drawLastPrice(ctx, v);
      break;
    case "trading":
      drawTrading(ctx, v);
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

export function paintFinanceScene(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  priceTicks: number[],
  timeTicks: { index: number; time: number }[],
): void {
  for (const kind of FINANCE_PAINT_ORDER) {
    paintFinanceMark(kind, ctx, v, priceTicks, timeTicks);
  }
}
