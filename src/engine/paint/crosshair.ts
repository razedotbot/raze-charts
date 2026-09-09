import { TIME_AXIS_H } from "../layout";
import { formatAxisPrice, formatCrosshairTime, indexForX, priceForY, xForIndex, yForPrice } from "../plotScale";
import { parseResolution, resolutionToMs } from "../../util/resolution";
import { TimeIndex } from "../../data/TimeIndex";
import { formatCompact } from "../../util/format";
import { drawAxisTag, neutralPill, roundRect, timeAxisTopOf } from "./primitives";
import type { FinanceView } from "./view";

export function drawCrosshair(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const synced = v.context.syncedCrosshair;
  if (!v.crosshair.active && !synced?.active) return;
  const t = v.context.theme;
  let x = v.crosshair.x;
  let y = v.crosshair.y;
  if (!v.crosshair.active && synced?.active) {
    const bars = v.context.bars;
    if (bars.length) {
      const timeIndex = new TimeIndex(bars, resolutionToMs(v.context.resolution));
      const idx = timeIndex.indexAt(synced.unixTime * 1000);
      if (idx != null) x = xForIndex(v, idx);
    }
    y = yForPrice(v, synced.price);
  }
  const contentBottom = timeAxisTopOf(v);
  if (x < v.plotL || x > v.plotL + v.plotW || y < v.plotT || y > contentBottom) return;

  const bars = v.context.bars;
  const idx = Math.round(indexForX(v, x));
  const snapBar = bars[Math.max(0, Math.min(bars.length - 1, idx))];

  const inMainPane = y <= v.plotT + v.plotH;
  ctx.save();
  ctx.strokeStyle = t.crosshair;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, v.plotT);
  ctx.lineTo(Math.round(x) + 0.5, contentBottom);
  if (inMainPane || v.subPanes.some((p) => y >= p.top && y <= p.top + p.h)) {
    ctx.moveTo(v.plotL, Math.round(y) + 0.5);
    ctx.lineTo(v.plotL + v.plotW, Math.round(y) + 0.5);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  const pill = neutralPill(v);
  const pricescale = v.context.symbolInfo?.pricescale ?? 100;
  if (t.showPriceScaleCrosshairLabel && inMainPane) {
    drawAxisTag(ctx, v, y, formatAxisPrice(v, priceForY(v, y), pricescale), pill.bg, pill.fg);
  } else if (t.showPriceScaleCrosshairLabel && !inMainPane) {
    const pane = v.subPanes.find((p) => y >= p.top && y <= p.top + p.h);
    if (pane) {
      const val = pane.max - ((y - pane.top) / Math.max(1, pane.h)) * (pane.max - pane.min);
      const label = pane.def.formatValue
        ? pane.def.formatValue(val)
        : Math.abs(val) >= 1000
          ? formatCompact(val)
          : val.toFixed(1);
      drawAxisTag(ctx, v, y, label, pill.bg, pill.fg, false, pane.top, pane.top + pane.h);
    }
  }
  if (t.showTimeScaleCrosshairLabel && snapBar && idx >= 0 && idx < bars.length) {
    const label = formatCrosshairTime(snapBar.time, parseResolution(v.context.resolution).kind);
    ctx.font = `11px ${v.fontFamily}`;
    const w = ctx.measureText(label).width + 14;
    const tx = Math.max(v.plotL, Math.min(v.plotL + v.plotW - w, x - w / 2));
    const axisTop = timeAxisTopOf(v);
    ctx.fillStyle = pill.bg;
    roundRect(ctx, tx, axisTop + 2, w, TIME_AXIS_H - 4, 3);
    ctx.fill();
    ctx.fillStyle = pill.fg;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, tx + w / 2, axisTop + TIME_AXIS_H / 2 + 0.5);
  }
}
