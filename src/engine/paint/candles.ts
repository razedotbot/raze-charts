import { CANDLE_MAX_WIDTH } from "../layout";
import { barSpacing, xForIndex, yForPrice } from "../plotScale";
import type { Bar } from "../../types/charting_library";
import { drawLineArea } from "./lineArea";
import type { FinanceView } from "./view";

export function drawCandles(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  bars: Bar[],
  hollow = false,
): void {
  if (!bars.length) return;
  const t = v.context.theme;
  const spacing = barSpacing(v);
  const bodyW = Math.max(1, Math.min(CANDLE_MAX_WIDTH, spacing * 0.74));
  const half = bodyW / 2;
  const thinBars = spacing < 4;

  const { from, to } = v.visibleRange;
  const start = Math.max(0, Math.floor(from) - 1);
  const end = Math.min(bars.length - 1, Math.ceil(to) + 1);

  for (let i = start; i <= end; i++) {
    const b = bars[i];
    if (!b) continue;
    const up = b.close >= b.open;
    const x = xForIndex(v, i);
    const yO = yForPrice(v, b.open);
    const yC = yForPrice(v, b.close);
    const yH = yForPrice(v, b.high);
    const yL = yForPrice(v, b.low > 0 ? b.low : Math.min(b.open, b.close));

    const body = up ? t.candleUp : t.candleDown;
    const wick = up ? t.wickUp : t.wickDown;
    const border = up ? t.borderUp : t.borderDown;

    ctx.strokeStyle = wick;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const cx = Math.round(x) + 0.5;
    ctx.moveTo(cx, yH);
    ctx.lineTo(cx, yL);
    ctx.stroke();

    if (thinBars) {
      ctx.strokeStyle = body;
      ctx.beginPath();
      ctx.moveTo(cx, yO);
      ctx.lineTo(cx, yC);
      ctx.stroke();
      continue;
    }

    const top = Math.min(yO, yC);
    const h = Math.max(1, Math.abs(yC - yO));
    if (hollow && up) {
      ctx.strokeStyle = border;
      ctx.strokeRect(
        Math.round(x - half) + 0.5,
        Math.round(top) + 0.5,
        Math.round(bodyW) - 1,
        Math.max(1, Math.round(h) - 1),
      );
    } else {
      ctx.fillStyle = body;
      ctx.fillRect(Math.round(x - half), Math.round(top), Math.round(bodyW), Math.round(h));
      if (bodyW >= 3) {
        ctx.strokeStyle = border;
        ctx.strokeRect(
          Math.round(x - half) + 0.5,
          Math.round(top) + 0.5,
          Math.round(bodyW) - 1,
          Math.max(1, Math.round(h) - 1),
        );
      }
    }
  }
}

export function drawOhlcBars(ctx: CanvasRenderingContext2D, v: FinanceView, bars: Bar[]): void {
  if (!bars.length) return;
  const t = v.context.theme;
  const spacing = barSpacing(v);
  const tick = Math.max(2, Math.min(8, spacing * 0.35));
  const { from, to } = v.visibleRange;
  const start = Math.max(0, Math.floor(from) - 1);
  const end = Math.min(bars.length - 1, Math.ceil(to) + 1);
  for (let i = start; i <= end; i++) {
    const b = bars[i];
    if (!b) continue;
    const up = b.close >= b.open;
    const color = up ? t.candleUp : t.candleDown;
    const x = Math.round(xForIndex(v, i)) + 0.5;
    const yO = yForPrice(v, b.open);
    const yC = yForPrice(v, b.close);
    const yH = yForPrice(v, b.high);
    const yL = yForPrice(v, b.low > 0 ? b.low : Math.min(b.open, b.close));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x, yH);
    ctx.lineTo(x, yL);
    ctx.moveTo(x - tick, yO);
    ctx.lineTo(x, yO);
    ctx.moveTo(x, yC);
    ctx.lineTo(x + tick, yC);
    ctx.stroke();
  }
}

export function drawColumns(ctx: CanvasRenderingContext2D, v: FinanceView, bars: Bar[]): void {
  if (!bars.length) return;
  const t = v.context.theme;
  const spacing = barSpacing(v);
  const w = Math.max(1, Math.min(CANDLE_MAX_WIDTH, spacing * 0.74));
  const { from, to } = v.visibleRange;
  const start = Math.max(0, Math.floor(from) - 1);
  const end = Math.min(bars.length - 1, Math.ceil(to) + 1);
  const zero = yForPrice(v, v.priceMin);
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, v.plotT, v.plotW, v.plotH);
  ctx.clip();
  for (let i = start; i <= end; i++) {
    const b = bars[i];
    if (!b) continue;
    const up = b.close >= b.open;
    const x = xForIndex(v, i);
    const y = yForPrice(v, b.close);
    ctx.fillStyle = up ? t.candleUp : t.candleDown;
    const top = Math.min(y, zero);
    ctx.fillRect(Math.round(x - w / 2), Math.round(top), Math.round(w), Math.max(1, Math.abs(y - zero)));
  }
  ctx.restore();
}

export function drawBaseline(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const bars = v.seriesBars;
  if (!bars.length) return;
  const t = v.context.theme;
  const { from, to } = v.visibleRange;
  const start = Math.max(0, Math.floor(from) - 1);
  const end = Math.min(bars.length - 1, Math.ceil(to) + 1);
  const first = bars[Math.max(0, Math.floor(from))];
  const base = first?.close ?? first?.open ?? 0;
  const yBase = yForPrice(v, base);
  const stroke = (): void => {
    ctx.beginPath();
    let started = false;
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b || !(b.close > 0)) { started = false; continue; }
      const x = xForIndex(v, i);
      const y = yForPrice(v, b.close);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, v.plotT, v.plotW, v.plotH);
  ctx.clip();
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, v.plotT, v.plotW, Math.max(0, yBase - v.plotT));
  ctx.clip();
  stroke();
  ctx.lineTo(xForIndex(v, end), yBase);
  ctx.lineTo(xForIndex(v, start), yBase);
  ctx.closePath();
  ctx.fillStyle = t.candleUp;
  ctx.globalAlpha = 0.16;
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, yBase, v.plotW, Math.max(0, v.plotT + v.plotH - yBase));
  ctx.clip();
  stroke();
  ctx.lineTo(xForIndex(v, end), yBase);
  ctx.lineTo(xForIndex(v, start), yBase);
  ctx.closePath();
  ctx.fillStyle = t.candleDown;
  ctx.globalAlpha = 0.16;
  ctx.fill();
  ctx.restore();
  ctx.restore();
  drawLineArea(ctx, v, false);
}

export function drawPriceSeries(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const style = v.context.chartStyle;
  const bars = v.seriesBars;
  if (style === "line") drawLineArea(ctx, v, false);
  else if (style === "area") drawLineArea(ctx, v, true);
  else if (style === "baseline") drawBaseline(ctx, v);
  else if (style === "columns") drawColumns(ctx, v, bars);
  else if (style === "bars") drawOhlcBars(ctx, v, bars);
  else drawCandles(ctx, v, bars, style === "hollow_candles");
}
