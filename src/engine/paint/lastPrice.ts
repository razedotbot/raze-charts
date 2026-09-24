import { formatAxisPrice, yForPrice } from "../plotScale";
import { dashedHLine, withBitmapSpace } from "./pixel";
import { drawAxisTag } from "./primitives";
import type { FinanceView } from "./view";

const PRICE_LINE_DASH = [3, 3] as const;
const PRICE_LINE_ALPHA = 0.85;

/**
 * Last-price line and axis pill. Any finite close is shown, including zero
 * and negative prices; a log scale cannot place a close at or below zero, so
 * the line and pill are omitted there.
 */
export function drawLastPrice(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  // Heikin-Ashi tags the plotted (HA) close like TradingView, unless
  // `mainSeriesProperties.haStyle.showRealLastPrice` asks for the real one.
  const showReal = v.context.options.overrides?.["mainSeriesProperties.haStyle.showRealLastPrice"] === true;
  const bars = !showReal && v.seriesBars.length === v.context.bars.length ? v.seriesBars : v.context.bars;
  const last = bars[bars.length - 1];
  if (!last || !Number.isFinite(last.close)) return;
  if (v.logScale && !(last.close > 0)) return;
  const t = v.context.theme;
  const price = last.close;
  const up = last.close >= last.open;
  const color = up ? t.candleUp : t.candleDown;
  const pricescale = v.context.symbolInfo?.pricescale ?? 100;
  const y = yForPrice(v, price);

  if (y >= v.plotT && y <= v.plotT + v.plotH) {
    withBitmapSpace(ctx, v.dpr, (s) => {
      ctx.fillStyle = color;
      ctx.globalAlpha = PRICE_LINE_ALPHA;
      dashedHLine(s, y, v.plotL, v.plotL + v.plotW, 1, PRICE_LINE_DASH);
    });
  }
  const cy = Math.max(v.plotT + 8, Math.min(v.plotT + v.plotH - 8, y));
  drawAxisTag(ctx, v, cy, formatAxisPrice(v, price, pricescale), color, "#10100e", true);
}
