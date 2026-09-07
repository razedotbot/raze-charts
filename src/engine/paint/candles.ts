import { CANDLE_MAX_WIDTH } from "../layout";
import { barSpacing, xForIndex, yForPrice } from "../plotScale";
import type { Bar } from "../../types/charting_library";
import type { FinanceView } from "./view";

export function drawCandles(ctx: CanvasRenderingContext2D, v: FinanceView, bars: Bar[]): void {
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
    ctx.fillStyle = body;
    ctx.fillRect(Math.round(x - half), Math.round(top), Math.round(bodyW), Math.round(h));
    if (bodyW >= 3) {
      ctx.strokeStyle = border;
      ctx.strokeRect(Math.round(x - half) + 0.5, Math.round(top) + 0.5, Math.round(bodyW) - 1, Math.max(1, Math.round(h) - 1));
    }
  }
}
