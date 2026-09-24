// TradingView-style broker overlays: linked risk/reward zones plus interactive
// order, position, stop-loss, and take-profit lines.

import type { StoredTradingLine } from "../../core/TradingStore";
import { formatAxisPrice, yForPrice } from "../plotScale";
import { dashedHLine, fillDeviceRect, snapRect, strokeRectInside, withBitmapSpace } from "./pixel";
import type { FinanceView } from "./view";

/** Fill a CSS box whose edges land on whole device pixels (pixel.ts). */
function fillBox(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
): void {
  withBitmapSpace(ctx, v.dpr, (s) => {
    ctx.fillStyle = fill;
    fillDeviceRect(s, snapRect(s, x, y, w, h));
  });
}

const LINE_DASH: Readonly<Record<number, readonly number[]>> = { 1: [2, 3], 2: [6, 4] };

function riskRewardZones(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const groups = new Map<string, StoredTradingLine[]>();
  for (const line of v.trading.list()) {
    if (!line.groupId) continue;
    const list = groups.get(line.groupId) ?? [];
    list.push(line);
    groups.set(line.groupId, list);
  }
  for (const lines of groups.values()) {
    const entry = lines.find((line) => line.kind === "position");
    if (!entry) continue;
    const stop = lines.find((line) => line.kind === "stop-loss");
    const target = lines.find((line) => line.kind === "take-profit");
    const x = v.plotL + Math.max(0, v.plotW * 0.48);
    const w = v.plotL + v.plotW - x;
    const entryY = yForPrice(v, entry.price);
    ctx.save();
    if (stop) {
      const stopY = yForPrice(v, stop.price);
      ctx.globalAlpha = 0.08;
      fillBox(ctx, v, x, Math.min(entryY, stopY), w, Math.abs(stopY - entryY), "#ef5350");
    }
    if (target) {
      const targetY = yForPrice(v, target.price);
      ctx.globalAlpha = 0.08;
      fillBox(ctx, v, x, Math.min(entryY, targetY), w, Math.abs(targetY - entryY), "#26a69a");
    }
    if (stop && target) {
      const risk = Math.abs(entry.price - stop.price);
      const reward = Math.abs(target.price - entry.price);
      if (risk > 0) {
        const label = `R:R 1:${(reward / risk).toFixed(2)}`;
        ctx.globalAlpha = 0.85;
        ctx.font = `600 10px ${v.fontFamily}`;
        const tw = ctx.measureText(label).width;
        fillBox(ctx, v, x + w - tw - 13, entryY - 9, tw + 9, 18, v.context.theme.paneBackground);
        ctx.fillStyle = v.context.theme.scaleText;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, x + w - tw - 9, entryY);
      }
    }
    ctx.restore();
  }
}

function lineBodyText(v: FinanceView, line: StoredTradingLine): string {
  const side = line.side === "buy" ? "BUY" : "SELL";
  let pnl = "";
  if (line.kind === "position") {
    const last = v.context.bars[v.context.bars.length - 1]?.close;
    const amount = Number(line.quantity);
    if (last != null && Number.isFinite(amount) && amount !== 0) {
      const value = (last - line.price) * (line.side === "buy" ? 1 : -1) * amount;
      pnl = `  P&L ${value >= 0 ? "+" : ""}${v.context.formatPrice(value, v.context.symbolInfo?.pricescale ?? 100)}`;
    }
  }
  return `${side}  ${line.text}${pnl}`;
}

export function drawTrading(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  v.tradingScreen.length = 0;
  if (!v.trading.list().length) return;
  riskRewardZones(ctx, v);
  const pricescale = v.context.symbolInfo?.pricescale ?? 100;
  const axisX = v.plotL + v.plotW;

  for (const line of v.trading.list()) {
    const y = yForPrice(v, line.price);
    if (y < v.plotT - 24 || y > v.plotT + v.plotH + 24) continue;
    const selected = v.selectedTradingLineId === line.id;
    const price = formatAxisPrice(v, line.price, pricescale);
    const bodyText = lineBodyText(v, line);
    const bodyX = v.plotL + 8;
    const bodyH = 20;
    ctx.save();
    const lineWidth = Number.isFinite(line.lineWidth) && line.lineWidth > 0 ? line.lineWidth : 1;
    withBitmapSpace(ctx, v.dpr, (s) => {
      ctx.fillStyle = line.lineColor;
      dashedHLine(s, y, v.plotL, axisX, selected ? lineWidth + 1.5 : lineWidth, LINE_DASH[line.lineStyle] ?? []);
    });

    ctx.font = `600 10px ${v.fontFamily}`;
    const bodyW = Math.min(v.plotW - 60, ctx.measureText(bodyText).width + 14);
    fillBox(ctx, v, bodyX, y - bodyH / 2, bodyW, bodyH, line.bodyBackgroundColor);
    ctx.fillStyle = line.bodyTextColor;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.beginPath();
    ctx.rect(bodyX + 5, y - bodyH / 2, Math.max(1, bodyW - 10), bodyH);
    ctx.clip();
    ctx.fillText(bodyText, bodyX + 7, y);
    ctx.restore();

    let cancelX = bodyX + bodyW + 3;
    if (line.quantity) {
      const quantityW = ctx.measureText(line.quantity).width + 12;
      fillBox(ctx, v, cancelX, y - bodyH / 2, quantityW, bodyH, line.quantityBackgroundColor);
      withBitmapSpace(ctx, v.dpr, (s) => {
        ctx.fillStyle = line.lineColor;
        strokeRectInside(s, cancelX, y - bodyH / 2, quantityW, bodyH);
      });
      ctx.fillStyle = line.quantityTextColor;
      ctx.textAlign = "center";
      ctx.fillText(line.quantity, cancelX + quantityW / 2, y);
      cancelX += quantityW + 3;
    }
    if (line.status === "working") {
      fillBox(ctx, v, cancelX, y - bodyH / 2, bodyH, bodyH, line.cancelButtonBackgroundColor);
      ctx.strokeStyle = line.cancelButtonIconColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cancelX + 6, y - 4);
      ctx.lineTo(cancelX + 14, y + 4);
      ctx.moveTo(cancelX + 14, y - 4);
      ctx.lineTo(cancelX + 6, y + 4);
      ctx.stroke();
      v.tradingScreen.push({ line, y, x1: cancelX, x2: cancelX + bodyH, hit: "cancel" });
    }
    v.tradingScreen.push({ line, y, x1: v.plotL, x2: axisX, hit: "body" });

    const axisW = Math.max(1, v.cssWidth - axisX);
    fillBox(ctx, v, axisX, y - 10, axisW, 20, line.lineColor);
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 10px ${v.fontFamily}`;
    ctx.textAlign = "center";
    ctx.fillText(price, axisX + axisW / 2, y);
    ctx.restore();
  }
}
