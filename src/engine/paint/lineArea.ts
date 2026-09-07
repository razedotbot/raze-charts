import { xForIndex, yForPrice } from "../plotScale";
import type { FinanceView } from "./view";

export function drawLineArea(ctx: CanvasRenderingContext2D, v: FinanceView, fill: boolean): void {
  const bars = v.seriesBars;
  if (!bars.length) return;
  const t = v.context.theme;
  const { from, to } = v.visibleRange;
  const start = Math.max(0, Math.floor(from) - 1);
  const end = Math.min(bars.length - 1, Math.ceil(to) + 1);
  const color = t.lineColor ?? t.candleUp;

  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, v.plotT, v.plotW, v.plotH);
  ctx.clip();

  ctx.beginPath();
  let started = false;
  let firstX = 0;
  let lastX = 0;
  for (let i = start; i <= end; i++) {
    const b = bars[i];
    if (!b || !(b.close > 0)) {
      started = false;
      continue;
    }
    const x = xForIndex(v, i);
    const y = yForPrice(v, b.close);
    if (!started) {
      ctx.moveTo(x, y);
      firstX = x;
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
    lastX = x;
  }
  if (fill && started) {
    ctx.lineTo(lastX, v.plotT + v.plotH);
    ctx.lineTo(firstX, v.plotT + v.plotH);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.18;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    started = false;
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b || !(b.close > 0)) { started = false; continue; }
      const x = xForIndex(v, i);
      const y = yForPrice(v, b.close);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
}
