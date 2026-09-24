// X tick label placement shared by the SVG and Canvas renderers. Labels are
// centred on their tick, except that the first and last labels are anchored
// to the chart edge when centring would push them outside the chart. Scene v2
// ticks carry the compiler's measured anchor and rotation, which win.

import type { CompiledChart } from "../compile/types";
import type { CompiledSceneV2Fields } from "../sceneTypes";

export interface PlacedTickLabel {
  label: string;
  /** Tick position in scene space (what the pan preview moves with). */
  px: number;
  /** Text anchor x after edge anchoring. */
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  /** Degrees; 0 or negative (counter-clockwise). */
  rotation: number;
  /**
   * Text baseline. Rotated labels hang from the axis by their middle, pivoting
   * on (px, plot bottom + 8), as the compiler measured their bottom margin.
   */
  baseline: "alphabetic" | "middle";
}

/** Distance kept between an edge-anchored label and the chart edge. */
const EDGE_INSET = 2;
/** X tick label font size, shared with the renderers. */
export const X_TICK_FONT_SIZE = 9;
/** Advance of one monospace glyph at the tick font size (0.6em). */
const GLYPH_ADVANCE = X_TICK_FONT_SIZE * 0.6;

/** Estimated rendered width of a tick label. */
export function estimateLabelWidth(label: string): number {
  return label.length * GLYPH_ADVANCE;
}

/**
 * Anchor for a label centred at `px` in a chart `width` wide: `start` pinned
 * to the left edge, `end` pinned to the right edge, or `middle` on the tick.
 * An edge-anchored label stays inside the chart whatever its real width.
 */
export function edgeAnchor(px: number, labelWidth: number, width: number): { x: number; anchor: PlacedTickLabel["anchor"] } {
  const half = labelWidth / 2;
  const overflowsLeft = px - half < EDGE_INSET;
  const overflowsRight = px + half > width - EDGE_INSET;
  if (overflowsLeft && overflowsRight) return { x: width / 2, anchor: "middle" };
  if (overflowsLeft) return { x: EDGE_INSET, anchor: "start" };
  if (overflowsRight) return { x: width - EDGE_INSET, anchor: "end" };
  return { x: px, anchor: "middle" };
}

/** X tick labels with their final anchor, position, and rotation. */
export function placeXTickLabels(c: CompiledChart): PlacedTickLabel[] {
  const y = c.plot.y + c.plot.h + 14;
  const measured = (c as CompiledChart & CompiledSceneV2Fields).axes?.x?.ticks;
  if (measured?.length) {
    return measured.map((tick) => ({
      label: tick.label,
      px: tick.px,
      x: tick.px,
      y: tick.rotation ? c.plot.y + c.plot.h + 8 : y,
      anchor: tick.anchor,
      rotation: tick.rotation,
      baseline: tick.rotation ? "middle" : "alphabetic",
    }));
  }
  return c.xTicks.map((tick) => {
    const { x, anchor } = edgeAnchor(tick.px, estimateLabelWidth(tick.label), c.width);
    return { label: tick.label, px: tick.px, x, y, anchor, rotation: 0, baseline: "alphabetic" };
  });
}
