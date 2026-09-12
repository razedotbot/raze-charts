import { formatAxisPrice, indexForX, priceForY, xForIndex, yForPrice } from "../plotScale";
import { resolutionToMs } from "../../util/resolution";
import { TimeIndex } from "../../data/TimeIndex";
import type { ShapePoint } from "../../types/charting_library";
import type { StoredShape } from "../../core/ShapeStore";
import type { DrawingTool } from "../../core/context";
import { drawAxisTag } from "./primitives";
import type { FinanceView } from "./view";

export function pointXY(
  v: FinanceView,
  p: ShapePoint,
  timeIndex = new TimeIndex(v.context.bars, resolutionToMs(v.context.resolution)),
): { x: number; y: number } | null {
  const idx = timeIndex.indexAt(p.time * 1000);
  if (idx === null) return null;
  const price = typeof p.price === "number" && Number.isFinite(p.price) ? p.price : v.priceMin;
  return { x: xForIndex(v, idx), y: yForPrice(v, price) };
}

export function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = "#181615";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.rect(x - 3.5, y - 3.5, 7, 7);
  ctx.fill();
  ctx.stroke();
}

export function drawComplexShape(ctx: CanvasRenderingContext2D, v: FinanceView, s: StoredShape): void {
  const o = s.overrides;
  const color = (o.linecolor as string) ?? (o.color as string) ?? "#2962ff";
  const width = (o.linewidth as number) ?? 1;
  const selected = v.selectedShapeId === (s.id as unknown as string);
  const timeIndex = new TimeIndex(v.context.bars, resolutionToMs(v.context.resolution));
  const pts = s.points.map((p) => pointXY(v, p, timeIndex)).filter(Boolean) as { x: number; y: number }[];

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = selected ? width + 0.75 : width;

  if (s.shape === "trend_line" && pts.length >= 2) {
    const a = pts[0]!;
    const b = pts[1]!;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    drawHandle(ctx, a.x, a.y, color);
    drawHandle(ctx, b.x, b.y, color);
    v.shapeScreen.push({ shape: s, y: (a.y + b.y) / 2, hit: "body" });
  } else if ((s.shape === "ray" || s.shape === "extended_line") && pts.length >= 2) {
    const a = pts[0]!;
    const b = pts[1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = (dx / len) * 4000;
    const uy = (dy / len) * 4000;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plotL, v.plotT, v.plotW, v.plotH);
    ctx.clip();
    ctx.beginPath();
    if (s.shape === "extended_line") ctx.moveTo(a.x - ux, a.y - uy);
    else ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x + ux, b.y + uy);
    ctx.stroke();
    ctx.restore();
    drawHandle(ctx, a.x, a.y, color);
    drawHandle(ctx, b.x, b.y, color);
    v.shapeScreen.push({ shape: s, y: (a.y + b.y) / 2, hit: "body" });
  } else if (s.shape === "vertical_line" && pts.length >= 1) {
    const x = Math.round(pts[0]!.x) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, v.plotT);
    ctx.lineTo(x, v.plotT + v.plotH);
    ctx.stroke();
    drawHandle(ctx, pts[0]!.x, v.plotT + v.plotH / 2, color);
    v.shapeScreen.push({ shape: s, y: v.plotT + v.plotH / 2, hit: "body" });
  } else if (s.shape === "measure" && pts.length >= 2) {
    const a = pts[0]!;
    const b = pts[1]!;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    const p0 = s.points[0];
    const p1 = s.points[1];
    if (p0 && p1 && typeof p0.price === "number" && typeof p1.price === "number") {
      const dPrice = p1.price - p0.price;
      const dTime = p1.time - p0.time;
      const pct = p0.price !== 0 ? (dPrice / p0.price) * 100 : 0;
      const label = `${dPrice >= 0 ? "+" : ""}${dPrice.toFixed(2)}  ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%  ${Math.round(dTime / 60)}m`;
      ctx.font = `11px ${v.fontFamily}`;
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.fillText(label, (a.x + b.x) / 2, (a.y + b.y) / 2 - 8);
    }
    drawHandle(ctx, a.x, a.y, color);
    drawHandle(ctx, b.x, b.y, color);
    v.shapeScreen.push({ shape: s, y: (a.y + b.y) / 2, hit: "body" });
  } else if (s.shape === "rectangle" && pts.length >= 2) {
    const a = pts[0]!;
    const b = pts[1]!;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    ctx.globalAlpha = 0.12;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    drawHandle(ctx, a.x, a.y, color);
    drawHandle(ctx, b.x, b.y, color);
    v.shapeScreen.push({ shape: s, y: y + h / 2, hit: "body" });
  } else if (s.shape === "fib_retracement" && pts.length >= 2) {
    const a = pts[0]!;
    const b = pts[1]!;
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const top = Math.min(a.y, b.y);
    const bot = Math.max(a.y, b.y);
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, v.plotL + v.plotW - 4);
    const pricescale = v.context.symbolInfo?.pricescale ?? 100;
    ctx.font = `10px ${v.fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    for (const lv of levels) {
      const y = a.y + (b.y - a.y) * lv;
      const yy = Math.round(y) + 0.5;
      ctx.globalAlpha = lv === 0 || lv === 1 ? 0.9 : 0.55;
      ctx.setLineDash(lv === 0.5 ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(left, yy);
      ctx.lineTo(right, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.85;
      ctx.fillText(`${(lv * 100).toFixed(1)}%  ${formatAxisPrice(v, priceForY(v, y), pricescale)}`, left + 4, yy - 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(Math.round(a.x) + 0.5, top);
    ctx.lineTo(Math.round(a.x) + 0.5, bot);
    ctx.stroke();
    ctx.globalAlpha = 1;
    drawHandle(ctx, a.x, a.y, color);
    drawHandle(ctx, b.x, b.y, color);
    v.shapeScreen.push({ shape: s, y: (a.y + b.y) / 2, hit: "body" });
  } else if (s.shape === "text" && pts.length >= 1) {
    const a = pts[0]!;
    const label = s.text || "Text";
    ctx.font = `12px ${v.fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(24,22,21,0.75)";
    ctx.fillRect(a.x - 2, a.y - 14, tw + 6, 16);
    ctx.fillStyle = color;
    ctx.fillText(label, a.x, a.y);
    drawHandle(ctx, a.x, a.y, color);
    v.shapeScreen.push({ shape: s, y: a.y, hit: "body" });
  }
  ctx.restore();
}

export function drawShapes(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  v.shapeScreen.length = 0;
  const pricescale = v.context.symbolInfo?.pricescale ?? 100;
  const hLines: { shape: StoredShape; price: number; y: number; labelY: number }[] = [];

  for (const s of v.shapes.list()) {
    if (s.hidden) continue;
    if (s.shape === "horizontal_line") {
      const price = s.points[0]?.price;
      if (typeof price !== "number" || !Number.isFinite(price)) continue;
      const y = yForPrice(v, price);
      hLines.push({ shape: s, price, y, labelY: y });
      continue;
    }
    drawComplexShape(ctx, v, s);
  }

  hLines.sort((a, b) => a.y - b.y);
  const minGap = 14;
  for (let i = 1; i < hLines.length; i++) {
    const prev = hLines[i - 1]!;
    const cur = hLines[i]!;
    if (cur.labelY - prev.labelY < minGap) {
      cur.labelY = prev.labelY + minGap;
    }
  }

  for (const h of hLines) {
    const s = h.shape;
    const y = h.y;
    if (y < v.plotT - 40 || y > v.plotT + v.plotH + 40) {
      v.shapeScreen.push({ shape: s, y, hit: "body" });
      continue;
    }
    const o = s.overrides;
    const color = (o.linecolor as string) ?? "#2962ff";
    const width = (o.linewidth as number) ?? 1;
    const style = (o.linestyle as number) ?? 0;
    const textColor = (o.textcolor as string) ?? color;
    const fontsize = (o.fontsize as number) ?? 11;
    const showPrice = o.showPrice !== false;
    const bold = o.bold === true;
    const italic = o.italic === true;
    const selected = v.selectedShapeId === (s.id as unknown as string);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? width + 0.5 : width;
    ctx.setLineDash(style === 2 ? [5, 4] : style === 1 ? [2, 3] : []);
    const yy = Math.round(y) + 0.5;
    ctx.beginPath();
    ctx.moveTo(v.plotL, yy);
    ctx.lineTo(v.plotL + v.plotW, yy);
    ctx.stroke();
    ctx.setLineDash([]);

    if (s.text) {
      ctx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontsize}px ${v.fontFamily}`;
      ctx.fillStyle = textColor;
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      const ly = Math.round(h.labelY) - 3;
      if (Math.abs(h.labelY - y) > 2) {
        const tw = ctx.measureText(s.text).width;
        ctx.fillStyle = "rgba(24,22,21,0.72)";
        ctx.fillRect(v.plotL + v.plotW - 8 - tw, ly - fontsize, tw + 4, fontsize + 4);
        ctx.fillStyle = textColor;
      }
      ctx.fillText(s.text, v.plotL + v.plotW - 6, ly);
    }

    if (showPrice) {
      drawAxisTag(ctx, v, yy - 0.5, formatAxisPrice(v, h.price, pricescale), color, "#ffffff");
    }
    ctx.restore();
    v.shapeScreen.push({ shape: s, y, hit: "body" });
  }
}

export function drawDraft(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  if (!v.draft || v.draft.points.length === 0) return;
  const tool = v.draft.tool;
  const ghost: StoredShape = {
    id: "draft" as never,
    shape: tool === "cursor" ? "trend_line" : tool,
    points: v.draft.points,
    text: tool === "text" ? "…" : "",
    lock: true,
    disableSelection: true,
    disableSave: true,
    disableUndo: true,
    showInObjectsTree: false,
    hidden: false,
    zOrder: "top",
    overrides: { linecolor: "#66d89e", linewidth: 1, linestyle: 2 },
  };
  if (v.draft.points.length === 1 && v.crosshair.active && tool !== "horizontal_line" && tool !== "text" && tool !== "vertical_line") {
    const bars = v.context.bars;
    let unixTime = 0;
    if (bars.length) {
      const timeIndex = new TimeIndex(bars, resolutionToMs(v.context.resolution));
      const idx = indexForX(v, v.crosshair.x);
      unixTime = (timeIndex.timeAt(idx) ?? 0) / 1000;
    }
    const price = priceForY(v, v.crosshair.y);
    ghost.points = [...v.draft.points, { time: unixTime, price }];
  }
  if (ghost.shape === "horizontal_line" && ghost.points[0]) {
    const y = yForPrice(v, ghost.points[0].price!);
    ctx.save();
    ctx.strokeStyle = "#66d89e";
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(v.plotL, Math.round(y) + 0.5);
    ctx.lineTo(v.plotL + v.plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (ghost.shape === "vertical_line" && ghost.points[0]) {
    const timeIndex = new TimeIndex(v.context.bars, resolutionToMs(v.context.resolution));
    const idx = timeIndex.indexAt(ghost.points[0].time * 1000);
    if (idx != null) {
      const x = Math.round(xForIndex(v, idx)) + 0.5;
      ctx.save();
      ctx.strokeStyle = "#66d89e";
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, v.plotT);
      ctx.lineTo(x, v.plotT + v.plotH);
      ctx.stroke();
      ctx.restore();
    }
    return;
  }
  drawComplexShape(ctx, v, ghost);
}

export function distToSegment(
  px: number,
  py: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  return Math.hypot(px - qx, py - qy);
}

export function hitComplexShape(v: FinanceView, shape: StoredShape, x: number, y: number, tolMul = 1): boolean {
  const timeIndex = new TimeIndex(v.context.bars, resolutionToMs(v.context.resolution));
  const pts = shape.points.map((p) => pointXY(v, p, timeIndex)).filter(Boolean) as { x: number; y: number }[];
  if (pts.length === 0) return false;
  for (const p of pts) {
    if (Math.abs(p.x - x) <= 6 * tolMul && Math.abs(p.y - y) <= 6 * tolMul) return true;
  }
  if (shape.shape === "trend_line" && pts.length >= 2) {
    return distToSegment(x, y, pts[0]!, pts[1]!) <= 5 * tolMul;
  }
  if ((shape.shape === "ray" || shape.shape === "extended_line" || shape.shape === "measure") && pts.length >= 2) {
    return distToSegment(x, y, pts[0]!, pts[1]!) <= 6 * tolMul;
  }
  if (shape.shape === "vertical_line" && pts[0]) {
    return Math.abs(pts[0].x - x) <= 5 * tolMul;
  }
  if (shape.shape === "rectangle" && pts.length >= 2) {
    const a = pts[0]!;
    const b = pts[1]!;
    const l = Math.min(a.x, b.x);
    const r = Math.max(a.x, b.x);
    const t = Math.min(a.y, b.y);
    const bot = Math.max(a.y, b.y);
    const tol = 4 * tolMul;
    const nearEdge =
      (Math.abs(x - l) <= tol || Math.abs(x - r) <= tol) && y >= t - tol && y <= bot + tol
      || (Math.abs(y - t) <= tol || Math.abs(y - bot) <= tol) && x >= l - tol && x <= r + tol;
    return nearEdge;
  }
  if (shape.shape === "fib_retracement" && pts.length >= 2) {
    return distToSegment(x, y, pts[0]!, pts[1]!) <= 6 * tolMul;
  }
  if (shape.shape === "text" && pts[0]) {
    return Math.abs(pts[0].x - x) <= 20 * tolMul && Math.abs(pts[0].y - y) <= 12 * tolMul;
  }
  return false;
}

export function neededPoints(tool: DrawingTool): number {
  if (tool === "horizontal_line" || tool === "text" || tool === "vertical_line") return 1;
  if (
    tool === "trend_line"
    || tool === "rectangle"
    || tool === "fib_retracement"
    || tool === "ray"
    || tool === "extended_line"
    || tool === "measure"
  ) return 2;
  return 0;
}
