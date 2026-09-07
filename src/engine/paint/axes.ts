import { PRICE_AXIS_W_MAX, PRICE_AXIS_W_MIN, TIME_AXIS_H } from "../layout";
import { formatAxisPrice, formatAxisTime, fromDisplay, xForIndex, yForPrice } from "../plotScale";
import { parseResolution } from "../../util/resolution";
import { timeAxisTopOf } from "./primitives";
import type { FinanceView } from "./view";

export function adjustPriceAxisWidth(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  ticks: number[],
): number {
  const pricescale = v.context.symbolInfo?.pricescale ?? 100;
  ctx.font = `11px ${v.fontFamily}`;
  let widest = 0;
  const consider = (val: number): void => {
    const w = ctx.measureText(formatAxisPrice(v, val, pricescale)).width;
    if (w > widest) widest = w;
  };
  for (const p of ticks) consider(p);
  consider(fromDisplay(v, v.priceMax));
  consider(fromDisplay(v, v.priceMin));
  const last = v.context.bars[v.context.bars.length - 1];
  if (last) consider(last.close);
  return Math.round(Math.max(PRICE_AXIS_W_MIN, Math.min(PRICE_AXIS_W_MAX, widest + 16)));
}

export function drawPriceAxis(ctx: CanvasRenderingContext2D, v: FinanceView, ticks: number[]): void {
  const t = v.context.theme;
  const pricescale = v.context.symbolInfo?.pricescale ?? 100;
  ctx.fillStyle = t.scaleBackground;
  ctx.fillRect(v.plotL + v.plotW, 0, v.priceAxisW, v.cssHeight);
  ctx.fillStyle = t.scaleText;
  ctx.font = `11px ${v.fontFamily}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const rightEdge = v.plotL + v.plotW + v.priceAxisW - 7;
  for (const p of ticks) {
    const y = yForPrice(v, p);
    if (y < v.plotT + 6 || y > v.plotT + v.plotH - 2) continue;
    ctx.fillText(formatAxisPrice(v, p, pricescale), rightEdge, y);
  }
}

export function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  ticks: { index: number; time: number }[],
): void {
  const t = v.context.theme;
  const top = timeAxisTopOf(v);
  ctx.fillStyle = t.scaleBackground;
  ctx.fillRect(0, top, v.cssWidth, TIME_AXIS_H);
  ctx.fillStyle = t.scaleText;
  ctx.font = `11px ${v.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const y = top + TIME_AXIS_H / 2;
  const kind = parseResolution(v.context.resolution).kind;
  for (const tk of ticks) {
    const x = xForIndex(v, tk.index);
    if (x < v.plotL + 18 || x > v.plotL + v.plotW - 18) continue;
    ctx.fillText(formatAxisTime(tk.time, kind), x, y);
  }
}
