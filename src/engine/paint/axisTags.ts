// Axis-overlay pass: paints the label pills painters queued on
// `FinanceView.axisTags` after the axes, so an axis background can never hide
// them (the hidden horizontal-line price tag bug). Tags are de-collided per
// axis: higher-priority tags keep their exact position and paint last, lower
// ones slide to the nearest free slot inside their band.

import { TIME_AXIS_H } from "../layout";
import { drawAxisTag, roundRect, timeAxisTopOf } from "./primitives";
import { AXIS_TAG_PRIORITY, type AxisTag, type FinanceView } from "./view";

/** Height of a price-axis pill (matches drawAxisTag). */
export const PRICE_TAG_HEIGHT = 16;
/** Minimum gap between two de-collided pills, CSS px. */
export const AXIS_TAG_GAP = 1;

/** Where the pass placed a tag: `start` is the top (price) or left (time) edge, CSS px. */
export interface PlacedAxisTag {
  tag: AxisTag;
  priority: number;
  start: number;
  size: number;
}

export function axisTagPriority(tag: AxisTag): number {
  return Number.isFinite(tag.priority) ? tag.priority! : AXIS_TAG_PRIORITY[tag.source.kind] ?? 0;
}

/**
 * De-collide one axis. `size(tag)` is the pill extent along the axis and
 * `band(tag)` the interval it must stay inside. Returns the placements in
 * paint order (lowest priority first, so the most important pill is on top).
 */
export function layoutAxisTags(
  tags: readonly AxisTag[],
  size: (tag: AxisTag) => number,
  band: (tag: AxisTag) => { start: number; end: number },
): PlacedAxisTag[] {
  const ranked = tags
    .map((tag, order) => ({ tag, order, priority: axisTagPriority(tag) }))
    .sort((a, b) => b.priority - a.priority || a.order - b.order);
  const placed: PlacedAxisTag[] = [];
  for (const { tag, priority } of ranked) {
    const extent = size(tag);
    const { start: lo, end: hi } = band(tag);
    const clampStart = (value: number): number => Math.max(lo, Math.min(hi - extent, value));
    const desired = clampStart(tag.coord - extent / 2);
    const fits = (start: number): boolean =>
      start >= lo - 1e-6
      && start + extent <= hi + 1e-6
      && placed.every((p) => start + extent + AXIS_TAG_GAP <= p.start || start >= p.start + p.size + AXIS_TAG_GAP);
    let best = desired;
    if (!fits(desired)) {
      let bestDistance = Infinity;
      for (const p of placed) {
        for (const candidate of [p.start - extent - AXIS_TAG_GAP, p.start + p.size + AXIS_TAG_GAP]) {
          const distance = Math.abs(candidate - desired);
          if (distance < bestDistance && fits(candidate)) {
            best = candidate;
            bestDistance = distance;
          }
        }
      }
      // No free slot: keep the exact position and let the higher-priority
      // pill paint over it rather than hiding the lower one entirely.
    }
    placed.push({ tag, priority, start: best, size: extent });
  }
  return placed.reverse();
}

/** Paint every queued tag of `v` (or `tags`) on the price and time axes. */
export function drawAxisTags(ctx: CanvasRenderingContext2D, v: FinanceView, tags: readonly AxisTag[] = v.axisTags): void {
  if (!tags.length) return;
  const price = tags.filter((tag) => tag.axis === "price");
  const time = tags.filter((tag) => tag.axis === "time");
  if (price.length) {
    const defaultBand = { start: v.plotT, end: v.plotT + v.plotH };
    for (const placed of layoutAxisTags(price, () => PRICE_TAG_HEIGHT, (tag) => tag.clamp ?? defaultBand)) {
      const { tag, start } = placed;
      drawAxisTag(ctx, v, start + PRICE_TAG_HEIGHT / 2, tag.text, tag.background, tag.color, tag.bold, start, start + PRICE_TAG_HEIGHT);
    }
  }
  if (time.length) {
    const defaultBand = { start: v.plotL, end: v.plotL + v.plotW };
    ctx.save();
    ctx.font = `11px ${v.fontFamily}`;
    const widths = new Map(time.map((tag) => [tag, ctx.measureText(tag.text).width + 14]));
    const axisTop = timeAxisTopOf(v);
    for (const { tag, start, size } of layoutAxisTags(time, (tag) => widths.get(tag)!, (tag) => tag.clamp ?? defaultBand)) {
      ctx.fillStyle = tag.background;
      roundRect(ctx, start, axisTop + 2, size, TIME_AXIS_H - 4, 3);
      ctx.fill();
      ctx.font = `${tag.bold ? "600 " : ""}11px ${v.fontFamily}`;
      ctx.fillStyle = tag.color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tag.text, start + size / 2, axisTop + TIME_AXIS_H / 2 + 0.5);
    }
    ctx.restore();
  }
}
