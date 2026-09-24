// Canvas renderer: paints the same compiled scene and chrome as ./svg.

import type { CompiledChart, SceneNode } from "../compile/types";
import { chartColorWithOpacity, heatFill, type DashboardTheme } from "../theme";
import { paintLastValuesCanvas, valueAxisWidth } from "./chips";
import { paintLegendCanvas } from "./legend";
import { X_TICK_FONT_SIZE, placeXTickLabels } from "./ticks";
import {
  AREA_GRADIENT_STOPS,
  TAU,
  hair,
  lift,
  normalizedOpacity,
  shade,
  traceArcNode,
  traceRoundBottomRect,
  traceRoundRect,
  traceRoundTopRect,
  traceSeries,
} from "./primitives";

function paintNodeCanvas(ctx: CanvasRenderingContext2D, n: SceneNode, theme: DashboardTheme): void {
  const fill = n.fill ?? "none";
  const stroke = n.stroke ?? "none";
  if (n.type === "line" && n.points?.length) {
    if (stroke === "none") return;
    ctx.beginPath();
    traceSeries(ctx, n.points, n.curve);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = n.strokeWidth ?? 1;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash(n.dashed ? [4.5, 3.5] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  if (n.type === "area" && n.points && n.points.length >= 3) {
    ctx.beginPath();
    if (n.role === "ranged-area") {
      traceSeries(ctx, n.points, "linear");
      ctx.closePath();
    } else {
      const middle = n.points.slice(1, -1);
      if (!middle.length) return;
      const baseline = n.points[0]!.y;
      traceSeries(ctx, middle, n.curve);
      const last = middle[middle.length - 1]!;
      const first = middle[0]!;
      ctx.lineTo(last.x, baseline);
      ctx.lineTo(first.x, baseline);
      ctx.closePath();
    }
    if (fill !== "none") {
      let top = n.points[0]!.y;
      let bottom = n.points[0]!.y;
      for (const point of n.points) {
        top = Math.min(top, point.y);
        bottom = Math.max(bottom, point.y);
      }
      const gradient = ctx.createLinearGradient(0, top, 0, Math.max(top + 1, bottom));
      const opacity = normalizedOpacity(n.fillOpacity, 0.42);
      for (const [offset, factor] of AREA_GRADIENT_STOPS) {
        gradient.addColorStop(offset, chartColorWithOpacity(fill, opacity * factor));
      }
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    if (stroke !== "none") {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = n.strokeWidth ?? 1;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }
    return;
  }
  if (n.type === "polygon" && n.points?.length) {
    ctx.beginPath();
    n.points.forEach((point, i) => i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
    ctx.closePath();
    if (fill !== "none") {
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = n.fillOpacity ?? 1;
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.globalAlpha = alpha;
    }
    if (stroke !== "none") {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = n.strokeWidth ?? 1;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }
    return;
  }
  if (n.type === "rect") {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const w = Math.max(0, n.w ?? 0);
    const h = Math.max(0, n.h ?? 0);
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = n.fillOpacity ?? 1;
    ctx.beginPath();
    if (n.corner === "top") traceRoundTopRect(ctx, x, y, w, h, Math.min(2.5, w / 2, h));
    else if (n.corner === "bottom") traceRoundBottomRect(ctx, x, y, w, h, Math.min(2.5, w / 2, h));
    else if (n.corner === "none" || n.role === "heat") ctx.rect(x, y, w, h);
    else traceRoundRect(ctx, x, y, w, h, Math.min(2.5, w / 2, h / 2));
    if (fill !== "none") {
      if (n.corner === "top" || n.corner === "bottom") {
        const gradient = ctx.createLinearGradient(0, y, 0, y + Math.max(1, h));
        gradient.addColorStop(0, n.corner === "bottom" ? shade(fill, 0.14) : lift(fill, 0.22));
        gradient.addColorStop(0.38, fill);
        gradient.addColorStop(1, n.corner === "bottom" ? lift(fill, 0.22) : shade(fill, 0.14));
        ctx.fillStyle = gradient;
      } else {
        ctx.fillStyle = fill;
      }
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    if (stroke !== "none") {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = n.strokeWidth ?? 1;
      ctx.stroke();
    }
    if ((n.corner === "top" || n.corner === "bottom") && h >= 6 && w >= 4) {
      const radius = Math.min(2.5, w / 2, h);
      const sheenY = n.corner === "bottom" ? y + h : y;
      ctx.beginPath();
      ctx.moveTo(x + radius + 0.5, hair(sheenY));
      ctx.lineTo(x + w - radius - 0.5, hair(sheenY));
      ctx.strokeStyle = "rgba(244,238,225,0.28)";
      ctx.lineWidth = 1;
      ctx.lineCap = "round";
      ctx.stroke();
    }
    return;
  }
  if (n.type === "circle") {
    ctx.beginPath();
    ctx.arc(n.x ?? 0, n.y ?? 0, n.r ?? 3, 0, TAU);
    if (fill !== "none") {
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = n.fillOpacity ?? 1;
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.globalAlpha = alpha;
    }
    if (stroke !== "none") {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = n.strokeWidth ?? 1;
      ctx.stroke();
    }
    return;
  }
  if (n.type === "rule") {
    if (stroke === "none") return;
    ctx.beginPath();
    ctx.moveTo(hair(n.x ?? 0), hair(n.y ?? 0));
    ctx.lineTo(hair(n.x2 ?? 0), hair(n.y2 ?? 0));
    ctx.strokeStyle = stroke;
    ctx.setLineDash(n.dashed === false ? [] : [3.5, 3]);
    ctx.lineWidth = n.strokeWidth ?? 1;
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  if (n.type === "arc") {
    if (!traceArcNode(ctx, n)) return;
    if (fill !== "none") {
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = n.fillOpacity ?? 1;
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.globalAlpha = alpha;
    }
    if (stroke !== "none") {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = n.strokeWidth ?? 1;
      ctx.stroke();
    }
    return;
  }
  if (n.type === "text" && n.label) {
    const size = n.fontSize ?? 11;
    ctx.fillStyle = n.fill || theme.muted;
    ctx.font = `${size >= 18 ? "600 " : ""}${size}px ${theme.font}`;
    ctx.textAlign = n.anchor === "middle" ? "center" : (n.anchor ?? "start");
    ctx.textBaseline = "middle";
    ctx.fillText(n.label, n.x ?? 0, n.y ?? 0);
  }
}

function paintAxesCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  if (c.polar) return;
  const { plot, theme, width, height } = c;
  const axisWidth = valueAxisWidth(c);
  if (!c.heatmap) {
    ctx.fillStyle = theme.background;
    ctx.fillRect(plot.x + plot.w, 0, axisWidth, height);
  }
  ctx.beginPath();
  ctx.moveTo(hair(c.heatmap ? plot.x : plot.x + plot.w), plot.y);
  ctx.lineTo(hair(c.heatmap ? plot.x : plot.x + plot.w), plot.y + plot.h);
  ctx.strokeStyle = theme.axis;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.font = `9px ${theme.font}`;
  ctx.fillStyle = theme.muted;
  ctx.textBaseline = "middle";
  ctx.textAlign = "end";
  for (const tick of c.yTicks) ctx.fillText(tick.label, c.heatmap ? plot.x - 8 : width - 7, tick.px);

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, plot.y + plot.h, width, Math.max(0, height - plot.y - plot.h));
  ctx.beginPath();
  ctx.moveTo(c.heatmap ? plot.x : 0, hair(plot.y + plot.h));
  ctx.lineTo(c.heatmap ? plot.x + plot.w : width, hair(plot.y + plot.h));
  ctx.strokeStyle = theme.axis;
  ctx.stroke();
  ctx.font = `${X_TICK_FONT_SIZE}px ${theme.font}`;
  ctx.fillStyle = theme.muted;
  ctx.textBaseline = "alphabetic";
  for (const tick of placeXTickLabels(c)) {
    ctx.textAlign = tick.anchor === "start" ? "left" : tick.anchor === "end" ? "right" : "center";
    if (tick.rotation) {
      ctx.save();
      ctx.translate(tick.x, tick.y);
      ctx.rotate((tick.rotation * Math.PI) / 180);
      ctx.fillText(tick.label, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(tick.label, tick.x, tick.y);
    }
  }
}

function paintColorBarCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  if (!c.colorBar || c.polar) return;
  const { plot, theme } = c;
  const x = plot.x + plot.w + 10;
  const y = plot.y;
  const w = 7;
  const h = plot.h;
  const { min, max } = c.colorBar;
  const gradient = ctx.createLinearGradient(0, y + h, 0, y);
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    gradient.addColorStop(t, heatFill(min + (max - min) * t, min, max, theme));
  }
  ctx.beginPath();
  traceRoundRect(ctx, x, y, w, h, 1);
  ctx.fillStyle = gradient;
  ctx.fill();
  const format = (value: number): string => value.toFixed(Math.abs(value) < 10 ? 1 : 0);
  ctx.font = `9px ${theme.font}`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = "start";
  ctx.textBaseline = "top";
  ctx.fillText(format(max), x + w + 5, y + 1);
  if (min < 0 && max > 0) {
    ctx.textBaseline = "middle";
    ctx.fillText("0", x + w + 5, y + h * (max / (max - min)));
  }
  ctx.textBaseline = "alphabetic";
  ctx.fillText(format(min), x + w + 5, y + h - 1);
}

/** Paint the same compiled scene and chrome as the SVG renderer. */
export function paintChartCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  const { theme, plot } = c;
  ctx.save();
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, c.width, c.height);
  paintLegendCanvas(ctx, c);
  if (c.grid && !c.polar) {
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (const tick of c.yTicks) {
      ctx.beginPath();
      ctx.moveTo(plot.x, hair(tick.px));
      ctx.lineTo(plot.x + plot.w, hair(tick.px));
      ctx.stroke();
    }
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  for (const node of c.nodes) if (node.clip !== false) paintNodeCanvas(ctx, node, theme);
  ctx.restore();
  for (const node of c.nodes) if (node.clip === false) paintNodeCanvas(ctx, node, theme);
  paintAxesCanvas(ctx, c);
  paintLastValuesCanvas(ctx, c);
  paintColorBarCanvas(ctx, c);
  ctx.restore();
}
