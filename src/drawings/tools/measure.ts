// Measure (TradingView's date_and_price_range): a shaded box between two
// anchors and a label with the price change (symbol-formatted), the
// percentage, and the bar count with a humanised span. The label sits on a
// theme backdrop outside the box so it never covers the measured candles.

import { roundRect } from "../../engine/paint/primitives";
import type { Rect } from "../../engine/paint/view";
import type { DrawingEnv, DrawingGeometry } from "../types";
import {
  type AnyState,
  applyStroke,
  BODY,
  distToSegment,
  hitAnchor,
  inRect,
  lineColorOf,
  measurer,
  opacityOf,
  priceOf,
  reachOf,
  rectFrom,
  strokeFields,
  type ToolDef,
} from "./common";

const FONT_SIZE = 11;
const LINE = 15;
const PAD = 6;

/** "+1.23", "−0.00000012": the sign, then the symbol formatter on the magnitude. */
function signed(value: number, format: (value: number) => string, suffix = ""): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${format(Math.abs(value))}${suffix}`;
}

/** The label lines: price change with percentage, then bars and span. */
export function measureLabel(drawing: AnyState, env: DrawingEnv): string[] {
  const [p0, p1] = drawing.points;
  const first = priceOf(drawing, 0);
  const second = priceOf(drawing, 1);
  if (!p0 || !p1 || first === null || second === null) return [];
  const change = second - first;
  const x0 = env.timeToX(p0.time);
  const x1 = env.timeToX(p1.time);
  const bars = x0 === null || x1 === null || !(env.barSpacing > 0) ? 0 : Math.round((x1 - x0) / env.barSpacing);
  return [
    `${signed(change, env.formatPrice)} (${signed(first ? (change / Math.abs(first)) * 100 : 0, (v) => v.toFixed(2), "%")})`,
    env.formatDuration(bars, Math.abs(p1.time - p0.time)),
  ];
}

/** Box between the anchors and the label rect, placed below a fall and above a rise, kept in the plot. */
function layout(drawing: AnyState, { anchors: [a, b], plot }: DrawingGeometry, env: DrawingEnv, ctx?: CanvasRenderingContext2D) {
  if (!a || !b) return null;
  const box = rectFrom(a, b);
  const lines = measureLabel(drawing, env);
  const measure = measurer(`${FONT_SIZE}px ${env.fontFamily}`, FONT_SIZE, ctx);
  const w = Math.ceil(Math.max(0, ...lines.map(measure))) + PAD * 3;
  const h = lines.length * LINE + PAD * 2;
  const below = box.y + box.h + PAD;
  const above = box.y - PAD - h;
  const preferred = b.y >= a.y ? below : above;
  const y = preferred + h > plot.y + plot.h ? above : preferred < plot.y ? below : preferred;
  const x = Math.max(plot.x + 2, Math.min(plot.x + plot.w - w - 2, box.x + box.w / 2 - w / 2));
  const label: Rect = { x, y: Math.max(plot.y + 2, Math.min(plot.y + plot.h - h - 2, y)), w, h };
  return { a, b, box, lines, label };
}

export const measureTool: ToolDef = {
  id: "measure",
  title: "Measure",
  icon: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 14H15M3 14V11M15 14V11M9 14V6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  group: "measure",
  aliases: ["date_and_price_range"],
  anchors: 2,
  props: {
    ...strokeFields(2),
    fillBackground: { type: "boolean", title: "Background", default: true },
    transparency: { type: "number", title: "Background transparency", default: 90, min: 0, max: 100 },
  },

  paint(ctx, drawing, geometry, env) {
    const l = layout(drawing, geometry, env, ctx);
    if (!l) return;
    const p = drawing.props;
    const color = lineColorOf(p, env);
    const alpha = ctx.globalAlpha;
    if (p.fillBackground !== false) {
      ctx.globalAlpha = alpha * opacityOf(p.transparency, 90);
      ctx.fillStyle = color;
      ctx.fillRect(l.box.x, l.box.y, l.box.w, l.box.h);
      ctx.globalAlpha = alpha;
    }
    applyStroke(ctx, p, env, 2, color);
    ctx.beginPath();
    ctx.moveTo(l.a.x, l.a.y);
    ctx.lineTo(l.b.x, l.b.y);
    ctx.stroke();
    if (!l.lines.length) return;
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.fillStyle = env.theme.labelBackground;
    roundRect(ctx, l.label.x, l.label.y, l.label.w, l.label.h, 4);
    ctx.fill();
    ctx.stroke();
    ctx.font = `${FONT_SIZE}px ${env.fontFamily}`;
    ctx.fillStyle = env.theme.labelText;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    l.lines.forEach((line, i) => ctx.fillText(line, l.label.x + l.label.w / 2, l.label.y + PAD + LINE * (i + 0.5)));
  },

  hitTest(point, drawing, geometry, env, tolerance) {
    const l = layout(drawing, geometry, env);
    if (!l) return null;
    const hit = distToSegment(point, [l.a, l.b]) <= reachOf(tolerance, drawing.props)
      || (drawing.props.fillBackground !== false && inRect(point, l.box))
      || (l.lines.length > 0 && inRect(point, l.label));
    return hitAnchor(point, geometry.anchors, tolerance) ?? (hit && inRect(point, geometry.plot) ? BODY : null);
  },
};
