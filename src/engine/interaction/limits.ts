// One viewport policy for every interactive range writer (drag, wheel, pinch,
// time-axis drag, keyboard):
//   - zoom limits: the span stays between plotW / MAX_BAR_SPACING and
//     plotW / time_scale.min_bar_spacing, and a zoom-out never shrinks a span
//     that another writer (ALL preset, setVisibleRange) left above the limit;
//   - pan bounds: at least min(3 bars, 10% of the span) stays inside the plot,
//     and time_scale.fix_left_edge / fix_right_edge pin the data edges.

import type { ChartingLibraryWidgetOptions } from "../../types/charting_library";
import type { IndexRange, ViewportChangeReason } from "../../core/context";
import { MAX_BAR_SPACING, MIN_BAR_SPACING } from "../layout";
import type { GestureHost } from "./types";

export interface TimeScalePolicy {
  readonly minBarSpacing: number;
  readonly fixLeftEdge: boolean;
  readonly fixRightEdge: boolean;
}

const DEFAULT_POLICY: TimeScalePolicy = { minBarSpacing: MIN_BAR_SPACING, fixLeftEdge: false, fixRightEdge: false };
const policies = new WeakMap<object, TimeScalePolicy>();

/** Validated `time_scale` options; each invalid key warns once per options object. */
export function timeScalePolicy(options: ChartingLibraryWidgetOptions | undefined): TimeScalePolicy {
  const raw: unknown = options?.time_scale;
  if (!options || raw === undefined) return DEFAULT_POLICY;
  let policy = policies.get(options);
  if (policy) return policy;
  const next = { ...DEFAULT_POLICY };
  const entries = raw && typeof raw === "object" ? Object.entries(raw) : [["", raw]];
  for (const [key, value] of entries) {
    let expected = "";
    if (key === "min_bar_spacing") {
      if (typeof value === "number" && value > 0 && value <= MAX_BAR_SPACING) next.minBarSpacing = value;
      else expected = `px in (0, ${MAX_BAR_SPACING}]`;
    } else if (key === "fix_left_edge" || key === "fix_right_edge") {
      if (typeof value === "boolean") next[key === "fix_left_edge" ? "fixLeftEdge" : "fixRightEdge"] = value;
      else expected = "a boolean";
    } else {
      expected = key ? "one of min_bar_spacing, fix_left_edge, fix_right_edge" : "an object";
    }
    if (expected) console.warn(`[raze-charts] time_scale${key && "."}${key}: expected ${expected}; ignored ${JSON.stringify(value)}.`);
  }
  policy = next;
  policies.set(options, policy);
  return policy;
}

/** Narrowest and widest span (in bars) the plot may show. */
export function spanLimits(h: GestureHost): { min: number; max: number } {
  const min = h.plotW / MAX_BAR_SPACING;
  return { min, max: Math.max(min, h.plotW / timeScalePolicy(h.context.options).minBarSpacing) };
}

/**
 * Apply a zoom factor (> 1 zooms out) inside the limits. The result is
 * monotonic: zooming out never shrinks the span and zooming in never grows
 * it, even when the starting span already lies outside the limits.
 */
export function zoomSpan(h: GestureHost, span: number, factor: number): number {
  const limits = spanLimits(h);
  if (factor > 1) return Math.max(span, Math.min(limits.max, span * factor));
  if (factor < 1) return Math.min(span, Math.max(limits.min, span * factor));
  return span;
}

/** Shift that brings `range` inside the pan bounds (0 when it already is). */
function boundsShift(range: IndexRange, bars: number, policy: TimeScalePolicy): number {
  if (bars <= 0) return 0;
  const { from, to } = range;
  // Bar i's centre is on screen while from - 0.5 <= i <= to - 0.5.
  const keep = Math.min(bars, 3, Math.max(1, Math.ceil((to - from) * 0.1)));
  let shift = 0;
  if (from > bars - keep + 0.5) shift = bars - keep + 0.5 - from;
  else if (to < keep - 0.5) shift = keep - 0.5 - to;
  if (policy.fixRightEdge && to + shift > bars) shift = bars - to;
  if (policy.fixLeftEdge && from + shift < 0) shift = -from;
  return shift;
}

/**
 * Keep `next` inside the pan bounds. When `previous` was already out of
 * bounds on the same side (a host set it), moves back toward the data are
 * allowed and moves further out are held, so nothing snaps.
 */
export function clampRange(h: GestureHost, next: IndexRange, previous: IndexRange = h.context.visibleRange): IndexRange {
  const policy = timeScalePolicy(h.context.options);
  const bars = h.context.bars.length;
  const shift = boundsShift(next, bars, policy);
  if (!shift) return next;
  const before = boundsShift(previous, bars, policy);
  const allowed = Math.sign(before) === Math.sign(shift) ? shift - before : shift;
  if (Math.sign(allowed) !== Math.sign(shift)) return next;
  return { from: next.from + allowed, to: next.to + allowed };
}

/**
 * Clamp, write through the reason-tagged setter, and page in history when the
 * left edge nears. Returns whether the viewport changed, so a cancelled pan
 * that never moved reports that it had nothing to restore.
 */
export function applyRange(h: GestureHost, next: IndexRange, reason: ViewportChangeReason, previous?: IndexRange): boolean {
  const range = reason === "cancel" ? next : clampRange(h, next, previous);
  const changed = h.context.setViewport(range, reason);
  if (changed && reason !== "cancel") void h.data.maybeLoadMoreHistory();
  return changed;
}
