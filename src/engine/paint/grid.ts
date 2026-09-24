import { xForIndex, yForPrice } from "../plotScale";
import { hLineRect, pathDeviceRect, vLineRect, withBitmapSpace } from "./pixel";
import type { FinanceView } from "./view";

// Grid lines and pane separators are hairlines painted in device pixels, so
// they stay one full-intensity run at fractional DPRs (pixel.ts).

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  priceTicks: number[],
  timeTicks: { index: number; time: number }[],
): void {
  const t = v.context.theme;
  const top = v.plotT;
  const bottom = v.plotT + v.plotH;
  const left = v.plotL;
  const right = v.plotL + v.plotW;
  withBitmapSpace(ctx, v.dpr, (s) => {
    // One path per colour: overlapping lines never double their alpha.
    ctx.fillStyle = t.horzGrid;
    ctx.beginPath();
    for (const p of priceTicks) {
      const y = yForPrice(v, p);
      if (!(y >= top && y <= bottom)) continue;
      pathDeviceRect(s, hLineRect(s, y, left, right));
    }
    ctx.fill();
    ctx.fillStyle = t.vertGrid;
    ctx.beginPath();
    for (const tk of timeTicks) {
      const x = xForIndex(v, tk.index);
      if (!(x >= left && x <= right)) continue;
      pathDeviceRect(s, vLineRect(s, x, top, bottom));
    }
    ctx.fill();
  });
}

export function drawSeparators(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const t = v.context.theme;
  const last = v.subPanes[v.subPanes.length - 1];
  const axisTop = last ? last.top + last.h : v.plotT + v.plotH;
  withBitmapSpace(ctx, v.dpr, (s) => {
    ctx.fillStyle = t.scaleLine;
    ctx.beginPath();
    pathDeviceRect(s, vLineRect(s, v.plotL + v.plotW, 0, axisTop));
    pathDeviceRect(s, hLineRect(s, v.plotT + v.plotH, 0, v.cssWidth));
    for (const p of v.subPanes) pathDeviceRect(s, hLineRect(s, p.top + p.h, 0, v.cssWidth));
    ctx.fill();
  });
}
