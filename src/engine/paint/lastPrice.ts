import { formatAxisPrice, yForPrice } from "../plotScale";
import { drawAxisTag } from "./primitives";
import type { FinanceView } from "./view";

export function drawLastPrice(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const bars = v.context.bars;
  const last = bars[bars.length - 1];
  if (!last || !(last.close > 0)) return;
  const t = v.context.theme;
  const price = last.close;
  const up = last.close >= last.open;
  const color = up ? t.candleUp : t.candleDown;
  const pricescale = v.context.symbolInfo?.pricescale ?? 100;
  const y = yForPrice(v, price);

  if (y >= v.plotT && y <= v.plotT + v.plotH) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    const yy = Math.round(y) + 0.5;
    ctx.beginPath();
    ctx.moveTo(v.plotL, yy);
    ctx.lineTo(v.plotL + v.plotW, yy);
    ctx.stroke();
    ctx.restore();
  }
  const cy = Math.max(v.plotT + 8, Math.min(v.plotT + v.plotH - 8, y));
  drawAxisTag(ctx, v, cy, formatAxisPrice(v, price, pricescale), color, "#10100e", true);
}
