import { xForIndex, yForPrice } from "../plotScale";
import { clipToRect, deviceLineWidth, lineStart, withBitmapSpace, type BitmapSpace } from "./pixel";
import type { FinanceView } from "./view";

/**
 * Main-series line width in CSS pixels: TradingView's default
 * `mainSeriesProperties.lineStyle.linewidth`. Like every other line it is
 * `max(1, floor(width × dpr))` device pixels, so 2 at DPR 1 and 1.25, 3 at
 * 1.5 and 1.75, 4 at 2 and 6 at 3 (1.6 to 2 CSS pixels).
 */
const SERIES_LINE_WIDTH = 2;
const AREA_ALPHA = 0.18;

/**
 * Line and area styles, painted in device pixels. Vertices snap to the centre
 * of the line's device-pixel run, so flat stretches are crisp full-intensity
 * rows at any DPR and vertical steps line up with the candle columns.
 *
 * Any finite close is plotted, including zero and negative prices (spreads,
 * P&L, rates); only a log scale skips closes at or below zero. Non-finite
 * closes (whitespace bars) break the line.
 */
export function drawLineArea(ctx: CanvasRenderingContext2D, v: FinanceView, fill: boolean): void {
  const bars = v.seriesBars;
  if (!bars.length) return;
  const t = v.context.theme;
  const { from, to } = v.visibleRange;
  const start = Math.max(0, Math.floor(from) - 1);
  const end = Math.min(bars.length - 1, Math.ceil(to) + 1);
  const color = t.lineColor ?? t.candleUp;

  withBitmapSpace(ctx, v.dpr, (s) => {
    const clip = clipToRect(s, v.plotL, v.plotT, v.plotW, v.plotH);
    const lw = deviceLineWidth(SERIES_LINE_WIDTH, Math.min(s.hpr, s.vpr));
    const cx = (x: number): number => lineStart(s.x(x), lw) + lw / 2;
    const cy = (y: number): number => lineStart(s.y(y), lw) + lw / 2;
    const trace = (closeRuns: boolean): void => {
      ctx.beginPath();
      let runStart = NaN;
      let lastX = NaN;
      const closeRun = (): void => {
        if (!closeRuns || !Number.isFinite(runStart)) return;
        ctx.lineTo(lastX, clip.y + clip.h);
        ctx.lineTo(runStart, clip.y + clip.h);
        ctx.closePath();
      };
      for (let i = start; i <= end; i++) {
        const b = bars[i];
        if (!b || !Number.isFinite(b.close) || (v.logScale && !(b.close > 0))) {
          closeRun();
          runStart = NaN;
          continue;
        }
        const x = cx(xForIndex(v, i));
        const y = cy(yForPrice(v, b.close));
        if (!Number.isFinite(runStart)) {
          ctx.moveTo(x, y);
          runStart = x;
        } else {
          ctx.lineTo(x, y);
        }
        lastX = x;
      }
      closeRun();
    };

    if (fill) {
      trace(true);
      ctx.fillStyle = color;
      ctx.globalAlpha = AREA_ALPHA;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    trace(false);
    strokeLine(s, color, lw);
  });
}

function strokeLine(s: BitmapSpace, color: string, lw: number): void {
  const ctx = s.ctx;
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";
  ctx.stroke();
}
