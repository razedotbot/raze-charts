import { xForIndex, yForPrice } from "../plotScale";
import type { FinanceView } from "./view";

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  priceTicks: number[],
  timeTicks: { index: number; time: number }[],
): void {
  const t = v.context.theme;
  ctx.lineWidth = 1;
  ctx.strokeStyle = t.horzGrid;
  ctx.beginPath();
  for (const p of priceTicks) {
    const y = Math.round(yForPrice(v, p)) + 0.5;
    if (y < v.plotT || y > v.plotT + v.plotH) continue;
    ctx.moveTo(v.plotL, y);
    ctx.lineTo(v.plotL + v.plotW, y);
  }
  ctx.stroke();
  ctx.strokeStyle = t.vertGrid;
  ctx.beginPath();
  for (const tk of timeTicks) {
    const x = Math.round(xForIndex(v, tk.index)) + 0.5;
    if (x < v.plotL || x > v.plotL + v.plotW) continue;
    ctx.moveTo(x, v.plotT);
    ctx.lineTo(x, v.plotT + v.plotH);
  }
  ctx.stroke();
}

export function drawSeparators(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const t = v.context.theme;
  const last = v.subPanes[v.subPanes.length - 1];
  const axisTop = last ? last.top + last.h : v.plotT + v.plotH;
  ctx.strokeStyle = t.scaleLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(v.plotL + v.plotW + 0.5, 0);
  ctx.lineTo(v.plotL + v.plotW + 0.5, axisTop);
  ctx.moveTo(0, v.plotT + v.plotH + 0.5);
  ctx.lineTo(v.cssWidth, v.plotT + v.plotH + 0.5);
  for (const p of v.subPanes) {
    ctx.moveTo(0, p.top + p.h + 0.5);
    ctx.lineTo(v.cssWidth, p.top + p.h + 0.5);
  }
  ctx.stroke();
}
