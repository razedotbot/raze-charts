// Vertical line: one time anchor spanning the full plot height.

import type { DrawingGeometry } from "../types";
import { applyStroke, crisp, hitAnchor, inRect, reachOf, strokeFields, type ToolDef } from "./common";

/** The single handle sits halfway down the plot, on the line. */
function handles(_drawing: unknown, { anchors, plot }: DrawingGeometry) {
  return anchors[0] ? [{ x: anchors[0].x, y: plot.y + plot.h / 2 }] : [];
}

export const verticalLineTool: ToolDef = {
  id: "vertical_line",
  title: "Vertical line",
  icon: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 2V16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M5 9H13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.35"/></svg>`,
  group: "lines",
  anchors: 1,
  props: strokeFields(),

  paint(ctx, drawing, { anchors, plot }, env) {
    if (!anchors[0]) return;
    const x = crisp(anchors[0].x, applyStroke(ctx, drawing.props, env));
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
  },

  hitTest(point, drawing, geometry, _env, tolerance) {
    const x = geometry.anchors[0]?.x;
    if (x === undefined || !inRect(point, geometry.plot)) return null;
    if (hitAnchor(point, handles(drawing, geometry), tolerance)) return { kind: "anchor", index: 0, cursor: "ew-resize" };
    return Math.abs(point.x - x) <= reachOf(tolerance, drawing.props) ? { kind: "body", cursor: "ew-resize" } : null;
  },

  handles,

  constrain: ({ point, points, index }) => ({ ...point, price: points[index]?.price ?? point.price }),
};
