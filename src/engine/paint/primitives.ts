import { TIME_AXIS_H } from "../layout";
import { isLightColor } from "../../core/theme";
import { alignToDevice, contextPixelRatio } from "./pixel";
import type { FinanceView } from "./view";

/** Build a rounded-rect path (caller fills/strokes). */
export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  const anyCtx = ctx as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
  if (typeof anyCtx.roundRect === "function") {
    anyCtx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Rounded price-axis pill (crosshair value, last price, shape levels). */
export function drawAxisTag(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  y: number,
  text: string,
  bg: string,
  fg: string,
  bold = false,
  clampTop = v.plotT,
  clampBot = v.plotT + v.plotH,
): void {
  const x0 = v.plotL + v.plotW;
  const h = 16;
  // Straight pill edges land on whole device pixels (crisp at fractional DPR).
  const ratio = contextPixelRatio(ctx, v.dpr);
  const top = alignToDevice(Math.max(clampTop, Math.min(clampBot - h, y - h / 2)), ratio.v);
  const left = alignToDevice(x0 + 3, ratio.h);
  const right = alignToDevice(x0 + v.priceAxisW - 2, ratio.h);
  ctx.fillStyle = bg;
  roundRect(ctx, left, top, right - left, h, 3);
  ctx.fill();
  ctx.font = `${bold ? "600 " : ""}11px ${v.fontFamily}`;
  ctx.fillStyle = fg;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x0 + v.priceAxisW - 7, top + h / 2 + 0.5);
}

export function timeAxisTopOf(v: FinanceView): number {
  const last = v.subPanes[v.subPanes.length - 1];
  if (last) return last.top + last.h;
  if (v.volumePane) return v.volumePane.top + v.volumePane.h;
  return v.plotT + v.plotH;
}

export function timeAxisHeight(): number {
  return TIME_AXIS_H;
}

export function neutralPill(v: FinanceView): { bg: string; fg: string } {
  return isLightColor(v.context.theme.paneBackground)
    ? { bg: "#131722", fg: "#ffffff" }
    : { bg: "#3a3833", fg: "#f4eee1" };
}
