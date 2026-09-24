import { resolutionToMs } from "../../util/resolution";
import { TimeIndex } from "../../data/TimeIndex";
import { xForIndex } from "../plotScale";
import { resolutionKindOf, timeAxisOf } from "./axes";
import type { FinanceView } from "./view";

export function drawSessionBreaks(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  if (!v.context.features.has("session_breaks")) return;
  const bars = v.context.bars;
  if (bars.length < 2) return;
  const breaks = new TimeIndex(bars, resolutionToMs(v.context.resolution)).sessionBreaks({
    timeZone: timeAxisOf(v.context).calendarZone(resolutionKindOf(v.context)),
    from: v.visibleRange.from - 1,
    to: v.visibleRange.to + 1,
  });
  if (!breaks.length) return;
  ctx.save();
  ctx.strokeStyle = v.context.theme.vertGrid;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  for (const index of breaks) {
    const x = Math.round(xForIndex(v, index - 0.5)) + 0.5;
    if (x < v.plotL || x > v.plotL + v.plotW) continue;
    ctx.moveTo(x, v.plotT);
    ctx.lineTo(x, v.plotT + v.plotH);
  }
  ctx.stroke();
  ctx.restore();
}
