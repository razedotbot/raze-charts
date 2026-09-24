// Pure anchored-placement math: preferred side, flip when it does not fit,
// shift along the cross axis to stay inside the viewport, and the maximum
// height available on the chosen side (so long lists scroll instead of
// clipping).

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";
export type Placement = `${Side}-${Align}` | Side;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface PositionOptions {
  placement?: Placement;
  /** Gap between anchor and floating element. */
  gap?: number;
  /** Minimum distance from the viewport edges. */
  margin?: number;
  /** `rtl` mirrors start/end alignment. */
  direction?: "ltr" | "rtl";
}

export interface Position {
  left: number;
  top: number;
  side: Side;
  align: Align;
  /** Height available on the chosen side; apply as `max-height`. */
  maxHeight: number;
  /** Width available on the chosen side; apply as `max-width`. */
  maxWidth: number;
}

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

function parse(placement: Placement): [Side, Align] {
  const [side, align] = placement.split("-") as [Side, Align | undefined];
  return [side, align ?? "center"];
}

function space(side: Side, anchor: Box, viewport: Size, gap: number, margin: number): number {
  switch (side) {
    case "top": return anchor.top - gap - margin;
    case "bottom": return viewport.height - (anchor.top + anchor.height) - gap - margin;
    case "left": return anchor.left - gap - margin;
    case "right": return viewport.width - (anchor.left + anchor.width) - gap - margin;
  }
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(max, Math.max(min, value));
}

/** Compute the viewport position of a floating box next to `anchor`. */
export function computePosition(anchor: Box, floating: Size, viewport: Size, options: PositionOptions = {}): Position {
  const gap = options.gap ?? 4;
  const margin = options.margin ?? 8;
  let [side, align] = parse(options.placement ?? "bottom-start");
  if (options.direction === "rtl" && align !== "center") align = align === "start" ? "end" : "start";
  if (options.direction === "rtl" && (side === "left" || side === "right")) side = OPPOSITE[side];

  const vertical = side === "top" || side === "bottom";
  const need = vertical ? floating.height : floating.width;
  const here = space(side, anchor, viewport, gap, margin);
  const there = space(OPPOSITE[side], anchor, viewport, gap, margin);
  if (need > here && there > here) side = OPPOSITE[side];

  const available = Math.max(0, space(side, anchor, viewport, gap, margin));
  let left: number;
  let top: number;
  if (vertical) {
    top = side === "bottom" ? anchor.top + anchor.height + gap : anchor.top - gap - Math.min(floating.height, available);
    left = align === "start"
      ? anchor.left
      : align === "end"
        ? anchor.left + anchor.width - floating.width
        : anchor.left + (anchor.width - floating.width) / 2;
    left = clamp(left, margin, viewport.width - margin - floating.width);
  } else {
    left = side === "right" ? anchor.left + anchor.width + gap : anchor.left - gap - Math.min(floating.width, available);
    top = align === "start"
      ? anchor.top
      : align === "end"
        ? anchor.top + anchor.height - floating.height
        : anchor.top + (anchor.height - floating.height) / 2;
    top = clamp(top, margin, viewport.height - margin - floating.height);
  }
  return {
    left: Math.round(left),
    top: Math.round(top),
    side,
    align,
    maxHeight: Math.max(0, Math.floor(vertical ? available : viewport.height - margin * 2)),
    maxWidth: Math.max(0, Math.floor(vertical ? viewport.width - margin * 2 : available)),
  };
}
