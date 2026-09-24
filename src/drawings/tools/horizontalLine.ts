// Horizontal line: one price anchor across the whole plot, an optional
// right-aligned text label and a price-axis tag (showPrice). The tag is queued
// through env.pushAxisTag so the axis-overlay pass paints it after the price
// axis instead of underneath it.

import type { ScreenPoint } from "../../engine/paint/view";
import type { DrawingEnv, DrawingGeometry } from "../types";
import {
  type AnyState,
  applyStroke,
  type BuiltinEnv,
  colorOr,
  crisp,
  hitAnchor,
  inRect,
  lineColorOf,
  measurer,
  num,
  priceOf,
  reachOf,
  readableTextOn,
  strokeFields,
  type ToolDef,
} from "./common";

function lineY(drawing: AnyState, env: DrawingEnv): number | null {
  const price = priceOf(drawing, 0);
  return price === null ? null : env.priceToY(price);
}

/** Label layout: the stacked y from the runtime, the font and the text box. */
function label(drawing: AnyState, env: BuiltinEnv, y: number, ctx?: CanvasRenderingContext2D) {
  const p = drawing.props;
  const size = Math.max(6, num(p.fontsize, 11));
  const font = `${p.italic === true ? "italic " : ""}${p.bold === true ? "bold " : ""}${size}px ${env.fontFamily}`;
  const labelY = env.horizontalLabelY?.get(drawing.id) ?? y;
  const baseline = Math.round(labelY) - 3;
  const width = measurer(font, size, ctx)(drawing.text);
  const right = env.plot.x + env.plot.w - 6;
  return { font, labelY, baseline, right, box: { x: right - width - 2, y: baseline - size, w: width + 4, h: size + 4 } };
}

/** The single handle: at the anchor's time, kept inside the plot. */
function handle(drawing: AnyState, geometry: DrawingGeometry, env: DrawingEnv): ScreenPoint | null {
  const y = lineY(drawing, env);
  const { x, w } = geometry.plot;
  const at = geometry.anchors[0]?.x ?? x + w / 2;
  return y === null ? null : { x: Math.max(x + 8, Math.min(x + w - 8, at)), y };
}

export const horizontalLineTool: ToolDef = {
  id: "horizontal_line",
  title: "Horizontal line",
  icon: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 9H16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M9 5V13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.35"/></svg>`,
  group: "lines",
  anchors: 1,
  text: true,
  props: {
    ...strokeFields(),
    showPrice: { type: "boolean", title: "Price label", default: true },
    textcolor: { type: "color", title: "Text color", default: "", group: "text" },
    fontsize: { type: "number", title: "Font size", default: 11, min: 6, max: 72, group: "text" },
    bold: { type: "boolean", title: "Bold", default: false, group: "text" },
    italic: { type: "boolean", title: "Italic", default: false, group: "text" },
  },

  paint(ctx, drawing, _geometry, env) {
    const y = lineY(drawing, env);
    if (y === null) return;
    const p = drawing.props;
    const color = lineColorOf(p, env);
    const { x, y: top, w, h } = env.plot;
    const yy = crisp(y, applyStroke(ctx, p, env));
    ctx.beginPath();
    ctx.moveTo(x, yy);
    ctx.lineTo(x + w, yy);
    ctx.stroke();

    if (drawing.text) {
      const l = label(drawing, env, y, ctx);
      ctx.font = l.font;
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      if (Math.abs(l.labelY - y) > 2) {
        // Pushed down by the stacking pass: a backdrop keeps it from reading as another line's label.
        ctx.fillStyle = env.theme.labelBackground;
        ctx.fillRect(l.box.x, l.box.y, l.box.w, l.box.h);
      }
      ctx.fillStyle = colorOr(p.textcolor, color);
      ctx.fillText(drawing.text, l.right, l.baseline);
    }

    if (p.showPrice !== false && y >= top && y <= top + h) {
      const format = (env as BuiltinEnv).formatAxisPrice ?? env.formatPrice;
      env.pushAxisTag({ axis: "price", coord: y, text: format(priceOf(drawing, 0)!), background: color, color: readableTextOn(color) });
    }
  },

  hitTest(point, drawing, geometry, env, tolerance) {
    const y = lineY(drawing, env);
    if (y === null || !inRect(point, geometry.plot, tolerance)) return null;
    if (hitAnchor(point, [handle(drawing, geometry, env)], tolerance)) return { kind: "anchor", index: 0, cursor: "ns-resize" };
    if (drawing.text && inRect(point, label(drawing, env, y).box)) return { kind: "label", cursor: "ns-resize" };
    return Math.abs(point.y - y) <= reachOf(tolerance, drawing.props) ? { kind: "body", cursor: "ns-resize" } : null;
  },

  handles(drawing, geometry, env) {
    const h = handle(drawing, geometry, env);
    return h ? [h] : [];
  },

  constrain: ({ point, points, index }) => ({ ...point, time: points[index]?.time ?? point.time }),
};
