import { CANDLE_MAX_WIDTH, VOLUME_FRACTION } from "../layout";
import { barSpacing, xForIndex } from "../plotScale";
import type { FinanceView } from "./view";

export function drawVolume(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const mode = v.context.volumeMode ?? "overlay";
  if (mode === "hidden") return;
  const bars = v.context.bars;
  if (!bars.length) return;
  const t = v.context.theme;
  const { from, to } = v.visibleRange;
  const start = Math.max(0, Math.floor(from) - 1);
  const end = Math.min(bars.length - 1, Math.ceil(to) + 1);

  let maxVol = 0;
  for (let i = start; i <= end; i++) {
    const vol = bars[i]?.volume ?? 0;
    if (vol > maxVol) maxVol = vol;
  }
  if (maxVol <= 0) return;

  const pane = mode === "pane" ? v.volumePane : null;
  const volH = pane ? pane.h : v.plotH * VOLUME_FRACTION;
  const baseY = pane ? pane.top + pane.h : v.plotT + v.plotH;
  const topClip = pane ? pane.top : baseY - volH;
  const spacing = barSpacing(v);
  const w = Math.max(1, Math.min(CANDLE_MAX_WIDTH, spacing * 0.74));

  ctx.save();
  if (pane) {
    ctx.fillStyle = t.paneBackground;
    ctx.fillRect(v.plotL, pane.top, v.plotW, pane.h);
  }
  ctx.beginPath();
  ctx.rect(v.plotL, topClip, v.plotW, volH);
  ctx.clip();
  for (let i = start; i <= end; i++) {
    const b = bars[i];
    if (!b || !b.volume) continue;
    const up = b.close >= b.open;
    const h = (b.volume / maxVol) * volH;
    const x = xForIndex(v, i);
    ctx.fillStyle = up ? t.volUp : t.volDown;
    ctx.fillRect(Math.round(x - w / 2), Math.round(baseY - h), Math.round(w), Math.round(h));
  }
  ctx.restore();
}
