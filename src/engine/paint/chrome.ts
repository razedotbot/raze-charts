import { TIME_AXIS_H } from "../layout";
import { resolutionToMs } from "../../util/resolution";
import { TimeIndex } from "../../data/TimeIndex";
import { xForIndex, yForPrice } from "../plotScale";
import { timeAxisTopOf } from "./primitives";
import type { FinanceView } from "./view";

export function drawTimescaleMarks(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const marks = v.context.timescaleMarks;
  const bars = v.context.bars;
  if (!marks.length || !bars.length) return;
  const timeIndex = new TimeIndex(bars, resolutionToMs(v.context.resolution));
  const top = timeAxisTopOf(v);
  ctx.save();
  ctx.font = `9px ${v.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const mark of marks) {
    const logical = timeIndex.indexAt(mark.time * 1000);
    if (logical == null) continue;
    const x = xForIndex(v, logical);
    if (x < v.plotL + 8 || x > v.plotL + v.plotW - 8) continue;
    ctx.fillStyle = typeof mark.color === "string" ? mark.color : v.context.theme.scaleText;
    ctx.fillText(String(mark.label).slice(0, 3), x, top + 1);
  }
  ctx.restore();
}

export function drawAxisChrome(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  if (!v.context.features.has("timezone_display") && !v.context.features.has("countdown")) return;
  const t = v.context.theme;
  const top = timeAxisTopOf(v);
  const tz = v.context.options.timezone === "exchange"
    ? (v.context.symbolInfo?.timezone ?? "Etc/UTC")
    : (v.context.options.timezone || v.context.symbolInfo?.timezone || "Etc/UTC");
  const bars = v.context.bars;
  const last = bars[bars.length - 1];
  let countdown = "";
  if (v.context.features.has("countdown") && last) {
    const step = resolutionToMs(v.context.resolution);
    const remain = Math.max(0, last.time + step - Date.now());
    const sec = Math.floor(remain / 1000);
    const mm = Math.floor(sec / 60);
    const ss = sec % 60;
    countdown = `${mm}:${String(ss).padStart(2, "0")}`;
  }
  ctx.save();
  ctx.font = `10px ${v.fontFamily}`;
  ctx.fillStyle = t.scaleText;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = 0.75;
  const label = countdown ? `${tz}  ${countdown}` : String(tz);
  ctx.fillText(label, v.plotL + v.plotW - 6, top + TIME_AXIS_H / 2);
  ctx.restore();
}

export function drawCompare(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const series = v.context.compare;
  if (!series.length) return;
  const bars = v.context.bars;
  if (!bars.length) return;
  const timeIndex = new TimeIndex(bars, resolutionToMs(v.context.resolution));
  const { from, to } = v.visibleRange;
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, v.plotT, v.plotW, v.plotH);
  ctx.clip();
  for (const item of series) {
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let drawing = false;
    for (const bar of item.bars) {
      const logical = timeIndex.indexAt(bar.time);
      if (logical == null || logical < from - 1 || logical > to + 1) {
        drawing = false;
        continue;
      }
      const x = xForIndex(v, logical);
      const y = yForPrice(v, bar.close);
      if (!drawing) { ctx.moveTo(x, y); drawing = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function drawTimeNavigator(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  if (!v.context.features.has("time_navigator")) return;
  const bars = v.context.bars;
  if (bars.length < 2) return;
  const t = v.context.theme;
  const h = 28;
  const top = timeAxisTopOf(v) - h;
  if (top < v.plotT + 40) return;
  let min = Infinity;
  let max = -Infinity;
  for (const bar of bars) {
    if (bar.close < min) min = bar.close;
    if (bar.close > max) max = bar.close;
  }
  if (!Number.isFinite(min) || min === max) return;
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = t.scaleBackground;
  ctx.fillRect(v.plotL, top, v.plotW, h);
  ctx.beginPath();
  for (let i = 0; i < bars.length; i++) {
    const x = v.plotL + (i / Math.max(1, bars.length - 1)) * v.plotW;
    const y = top + 2 + (1 - (bars[i]!.close - min) / (max - min)) * (h - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = t.lineColor ?? t.candleUp;
  ctx.lineWidth = 1;
  ctx.stroke();
  const n = bars.length;
  const left = v.plotL + (Math.max(0, v.visibleRange.from) / Math.max(1, n - 1)) * v.plotW;
  const right = v.plotL + (Math.min(n - 1, v.visibleRange.to) / Math.max(1, n - 1)) * v.plotW;
  ctx.fillStyle = "rgba(102,216,158,0.16)";
  ctx.fillRect(left, top, Math.max(2, right - left), h);
  ctx.restore();
}
