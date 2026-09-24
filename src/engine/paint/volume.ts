import { VOLUME_FRACTION } from "../layout";
import { barSpacing, xForIndex } from "../plotScale";
import { bodyLeft, candleColumns, wickColumn } from "./candles";
import { clipToRect, fillDeviceRect, snapRect, withBitmapSpace } from "./pixel";
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
    if (Number.isFinite(vol) && vol > maxVol) maxVol = vol;
  }
  if (maxVol <= 0) return;

  const pane = mode === "pane" ? v.volumePane : null;
  const volH = pane ? pane.h : v.plotH * VOLUME_FRACTION;
  const baseY = pane ? pane.top + pane.h : v.plotT + v.plotH;
  const topClip = pane ? pane.top : baseY - volH;

  withBitmapSpace(ctx, v.dpr, (s) => {
    if (pane) {
      ctx.fillStyle = t.paneBackground;
      fillDeviceRect(s, snapRect(s, v.plotL, pane.top, v.plotW, pane.h));
    }
    const clip = clipToRect(s, v.plotL, topClip, v.plotW, volH);
    // Volume columns share the candle bodies' device geometry, so each one
    // lines up exactly under its candle. Thin (wick-only) candles would leave
    // hairline columns, so there a column fills its slot minus a hairline gap.
    const cols = candleColumns(barSpacing(v), s.hpr);
    const width = cols.thin ? Math.max(cols.wickW, cols.slot - cols.wickW) : cols.bodyW;
    const inset = Math.floor((width - cols.wickW) / 2);
    const base = clip.y + clip.h;
    const minRows = s.lineH(1);
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      const vol = b?.volume;
      if (!b || !vol || !(vol > 0) || !Number.isFinite(vol)) continue;
      const up = b.close >= b.open;
      // A positive volume is never rounded away to nothing.
      const top = Math.min(base - minRows, s.y(baseY - (vol / maxVol) * volH));
      ctx.fillStyle = up ? t.volUp : t.volDown;
      const left = cols.thin ? wickColumn(s, cols, xForIndex(v, i)) - inset : bodyLeft(s, cols, xForIndex(v, i));
      ctx.fillRect(left, top, width, base - top);
    }
  });
}
