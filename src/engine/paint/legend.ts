import { formatPrice, formatVolume } from "../../util/format";
import { indexForX } from "../plotScale";
import type { FinanceView } from "./view";

export function drawLegend(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  if (!v.context.features.has("legend_widget")) return;
  const bars = v.context.bars;
  if (!bars.length) return;
  const idx = v.crosshair.active
    ? Math.max(0, Math.min(bars.length - 1, Math.round(indexForX(v, v.crosshair.x))))
    : bars.length - 1;
  const bar = bars[idx];
  if (!bar) return;
  const pricescale = v.context.symbolInfo?.pricescale ?? 100;
  const t = v.context.theme;
  const up = bar.close >= bar.open;
  const col = up ? t.candleUp : t.candleDown;

  const dim = t.scaleText;
  const f = (val: number): string => formatPrice(val, pricescale);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let x = 10;
  const y = 19;
  ctx.font = `12px ${v.fontFamily}`;
  const seg = (label: string, value: string): void => {
    ctx.fillStyle = dim;
    ctx.fillText(label, x, y);
    x += ctx.measureText(label).width + 3;
    ctx.fillStyle = col;
    ctx.fillText(value, x, y);
    x += ctx.measureText(value).width + 9;
  };
  const compactLegend = v.plotW < 420;
  if (!compactLegend) {
    seg("O", f(bar.open));
    seg("H", f(bar.high));
    seg("L", f(bar.low));
  }
  seg("C", f(bar.close));
  if (bar.open > 0) {
    const abs = bar.close - bar.open;
    const pct = (abs / bar.open) * 100;
    const sign = abs >= 0 ? "+" : "-";
    const chgStr = `${sign}${formatPrice(Math.abs(abs), pricescale)} (${sign}${Math.abs(pct).toFixed(2)}%)`;
    ctx.fillStyle = col;
    ctx.fillText(chgStr, x, y);
    x += ctx.measureText(chgStr).width + 12;
  }
  for (const s of v.studies.list()) {
    const val = s.values[idx];
    if (val == null || !Number.isFinite(val)) continue;
    const label = `${s.name}${s.length}`;
    const value = s.def.formatValue
      ? s.def.formatValue(val)
      : s.def.pane === "pane"
        ? val.toFixed(1)
        : f(val);
    ctx.fillStyle = dim;
    ctx.fillText(label, x, y);
    x += ctx.measureText(label).width + 3;
    ctx.fillStyle = s.color;
    ctx.fillText(value, x, y);
    x += ctx.measureText(value).width + 9;
  }
  if (bar.volume) {
    ctx.fillStyle = dim;
    ctx.font = `11px ${v.fontFamily}`;
    ctx.fillText(`Vol ${formatVolume(bar.volume)}`, 10, 35);
  }
}
