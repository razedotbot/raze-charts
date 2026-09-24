// Rectangle: two opposite corners, a border and an optional fill honouring
// TradingView's backgroundColor / fillBackground / transparency. A filled
// interior is part of the hit area because it is part of what is painted.

import type { DrawingEnv } from "../types";
import {
  type AnyState,
  applyStroke,
  BODY,
  colorOr,
  crisp,
  hitAnchor,
  inRect,
  lineColorOf,
  opacityOf,
  reachOf,
  rectFrom,
  strokeFields,
  type ToolDef,
} from "./common";

/**
 * Fill colour and opacity, or null when unfilled. An empty backgroundColor
 * follows the border colour at 12%; `transparency` (0-100) applies on top.
 */
export function rectangleFill(drawing: AnyState, env: DrawingEnv): { color: string; opacity: number } | null {
  const p = drawing.props;
  const own = colorOr(p.backgroundColor, "");
  const opacity = opacityOf(p.transparency, 0) * (own ? 1 : 0.12);
  return p.fillBackground === false || opacity <= 0 ? null : { color: own || lineColorOf(p, env), opacity };
}

export const rectangleTool: ToolDef = {
  id: "rectangle",
  title: "Rectangle",
  icon: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="3.5" y="4.5" width="11" height="9" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>`,
  group: "shapes",
  anchors: 2,
  props: {
    ...strokeFields(),
    backgroundColor: { type: "color", title: "Background", default: "" },
    fillBackground: { type: "boolean", title: "Fill background", default: true },
    transparency: { type: "number", title: "Transparency", default: 0, min: 0, max: 100 },
  },

  paint(ctx, drawing, { anchors: [a, b] }, env) {
    if (!a || !b) return;
    const box = rectFrom(a, b);
    const fill = rectangleFill(drawing, env);
    if (fill) {
      ctx.globalAlpha *= fill.opacity;
      ctx.fillStyle = fill.color;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.globalAlpha /= fill.opacity;
    }
    const width = applyStroke(ctx, drawing.props, env);
    const x = crisp(box.x, width);
    const y = crisp(box.y, width);
    ctx.strokeRect(x, y, crisp(box.x + box.w, width) - x, crisp(box.y + box.h, width) - y);
  },

  hitTest(point, drawing, { anchors, plot }, env, tolerance) {
    const [a, b] = anchors;
    if (!a || !b) return null;
    const box = rectFrom(a, b);
    const reach = reachOf(tolerance, drawing.props);
    const inner = { x: box.x + reach, y: box.y + reach, w: box.w - 2 * reach, h: box.h - 2 * reach };
    const onEdge = inRect(point, box, reach) && (inner.w < 0 || inner.h < 0 || !inRect(point, inner));
    return hitAnchor(point, anchors, tolerance)
      ?? (inRect(point, plot) && (onEdge || (rectangleFill(drawing, env) && inRect(point, box))) ? BODY : null);
  },
};
