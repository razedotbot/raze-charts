import type { Mark, MarkCustomColor } from "../../types/charting_library";
import { resolutionToMs } from "../../util/resolution";
import { xForIndex, yForPrice } from "../plotScale";
import { roundRect } from "./primitives";
import type { FinanceView } from "./view";

export function drawMarks(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  v.markScreen.length = 0;
  if (!v.context.features.has("mark_on_bars")) return;
  const marks = v.context.marks;
  const bars = v.context.bars;
  if (!marks.length || !bars.length) return;

  const resMs = resolutionToMs(v.context.resolution);
  const firstT = bars[0]!.time;
  const r = 7;
  const gap = 3;
  const maxStack = 4;
  const bottomLimit = v.plotT + v.plotH - 4;
  const topLimit = v.plotT + 4;

  const byBar = new Map<number, Mark[]>();
  for (const m of marks) {
    const idx = Math.round((m.time * 1000 - firstT) / resMs);
    if (idx < 0 || idx >= bars.length) continue;
    const list = byBar.get(idx);
    if (list) list.push(m);
    else byBar.set(idx, [m]);
  }

  const indices = Array.from(byBar.keys()).sort((a, b) => a - b);
  let lastDrawnX = -Infinity;
  for (const idx of indices) {
    const x = xForIndex(v, idx);
    if (x < v.plotL - r || x > v.plotL + v.plotW + r) continue;
    if (x - lastDrawnX < 2 * r + 1) continue;
    lastDrawnX = x;

    const group = byBar.get(idx)!;
    const bar = bars[idx]!;
    const highY = yForPrice(v, bar.high);
    const stepY = 2 * r + gap;
    const shown = Math.min(group.length, maxStack);
    const minStart = topLimit + r + (shown - 1) * stepY;
    let y = Math.max(minStart, Math.min(bottomLimit - r, highY - r - 6));

    for (let k = 0; k < shown; k++) {
      const m = group[k]!;
      const isLast = k === shown - 1 && group.length > maxStack;
      const col = m.color as MarkCustomColor;
      const border = typeof col === "object" ? col.border : "#2962ff";
      const bg = typeof col === "object" ? col.background : "#2962ff";

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = border;
      ctx.stroke();

      const label = isLast ? `+${group.length - maxStack + 1}` : (m.label ? m.label.slice(0, 2) : "");
      if (label) {
        ctx.fillStyle = m.labelFontColor || "#fff";
        ctx.font = `bold ${isLast ? 8 : 9}px ${v.fontFamily}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, x, y + 0.5);
      }
      v.markScreen.push({ mark: m, x, y, r });
      y -= stepY;
    }
  }
}

export function drawMarkTooltip(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  if (!v.hoverMark) return;
  const hit = v.markScreen.find((m) => m.mark === v.hoverMark);
  if (!hit) return;
  const text = v.hoverMark.text || v.hoverMark.label || "";
  if (!text) return;
  ctx.font = `11px ${v.fontFamily}`;
  const pad = 6;
  const lines = text.split("\n").slice(0, 4);
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width), 40);
  const th = lines.length * 14 + pad * 2;
  let x = hit.x + hit.r + 8;
  let y = hit.y - th / 2;
  if (x + tw + pad * 2 > v.plotL + v.plotW) x = hit.x - hit.r - 8 - tw - pad * 2;
  if (y < v.plotT) y = v.plotT + 4;
  ctx.fillStyle = "rgba(24,22,21,0.92)";
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  roundRect(ctx, x, y, tw + pad * 2, th, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#f4eee1";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad + i * 14));
}
