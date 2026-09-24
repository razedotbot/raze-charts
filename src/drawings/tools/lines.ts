// Straight-line tools: trend line, ray and extended line. One implementation
// with TradingView's extendLeft/extendRight; every variant paints and
// hit-tests exactly the segment it draws, clipped to the plot.

import type { DrawingGeometry } from "../types";
import {
  type AnyState,
  applyStroke,
  BODY,
  clipLine,
  distToSegment,
  hitAnchor,
  reachOf,
  type Segment,
  strokeFields,
  type ToolDef,
} from "./common";

/** The painted segment: anchors clipped to the plot, extended where requested. */
export function lineSegment(drawing: AnyState, geometry: DrawingGeometry): Segment | null {
  const [a, b] = geometry.anchors;
  return a && b ? clipLine(a, b, geometry.plot, drawing.props.extendLeft === true, drawing.props.extendRight === true) : null;
}

function lineTool(id: string, title: string, icon: string, extendLeft: boolean, extendRight: boolean): ToolDef {
  return {
    id,
    title,
    icon,
    group: "lines",
    anchors: 2,
    props: {
      ...strokeFields(),
      extendLeft: { type: "boolean", title: "Extend left", default: extendLeft },
      extendRight: { type: "boolean", title: "Extend right", default: extendRight },
    },
    paint(ctx, drawing, geometry, env) {
      const segment = lineSegment(drawing, geometry);
      if (!segment) return;
      applyStroke(ctx, drawing.props, env);
      ctx.beginPath();
      ctx.moveTo(segment[0].x, segment[0].y);
      ctx.lineTo(segment[1].x, segment[1].y);
      ctx.stroke();
    },
    hitTest(point, drawing, geometry, _env, tolerance) {
      const segment = lineSegment(drawing, geometry);
      return hitAnchor(point, geometry.anchors, tolerance)
        ?? (segment && distToSegment(point, segment) <= reachOf(tolerance, drawing.props) ? BODY : null);
    },
  };
}

export const trendLineTool = lineTool(
  "trend_line",
  "Trend line",
  `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 14L8 8L11 11L15 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="15" cy="4" r="1.4" fill="currentColor"/><circle cx="3" cy="14" r="1.4" fill="currentColor"/></svg>`,
  false,
  false,
);

export const rayTool = lineTool(
  "ray",
  "Ray",
  `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 14L15 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="3" cy="14" r="1.4" fill="currentColor"/></svg>`,
  false,
  true,
);

export const extendedLineTool: ToolDef = {
  ...lineTool(
    "extended_line",
    "Extended line",
    `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 15L16 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="3 2"/></svg>`,
    true,
    true,
  ),
  aliases: ["extended"],
};
