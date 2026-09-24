import { asNumber, type ChartViewport } from "./defineChart";

export interface ViewportHandle {
  setViewport(viewport: ChartViewport | null): void;
}

export const RANGE_PRESETS = ["1D", "1W", "1M", "3M", "YTD", "ALL"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export function isQuantitativeViewportX(
  x: NonNullable<ChartViewport["x"]>,
): x is readonly [number | Date, number | Date] {
  return x.length === 2 && x.every((value) => Number.isFinite(asNumber(value)));
}

export function quantitativeRange(x: readonly [number | Date, number | Date]): [number, number] {
  const a = asNumber(x[0]);
  const b = asNumber(x[1]);
  return a <= b ? [a, b] : [b, a];
}

export function viewportFromPreset(
  preset: RangePreset,
  extent: readonly [number, number],
  now?: number,
): ChartViewport {
  const lo = Math.min(extent[0], extent[1]);
  const hi = Math.max(extent[0], extent[1]);
  if (preset === "ALL" || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    return { x: [lo, hi] };
  }
  const span = hi - lo;
  const unixMs = hi > 1e11 || lo > 1e11;
  const unixSec = !unixMs && hi > 1e9 && lo > 1e9;
  const end = now != null && Number.isFinite(now) && now >= lo && now <= hi ? now : hi;
  const clamp = (from: number, to: number): ChartViewport => {
    const left = Math.max(lo, Math.min(from, to));
    const right = Math.min(hi, Math.max(from, to));
    return left < right ? { x: [left, right] } : { x: [lo, hi] };
  };
  if (!unixMs && !unixSec) {
    const fractions: Record<Exclude<RangePreset, "ALL">, number> = {
      "1D": 1 / 365,
      "1W": 7 / 365,
      "1M": 30 / 365,
      "3M": 90 / 365,
      YTD: 0.5,
    };
    const width = Math.max(span * fractions[preset], span * 0.02);
    return clamp(hi - width, hi);
  }
  const day = unixSec ? 86_400 : 86_400_000;
  if (preset === "1D") return clamp(end - day, end);
  if (preset === "1W") return clamp(end - 7 * day, end);
  if (preset === "1M") return clamp(end - 30 * day, end);
  if (preset === "3M") return clamp(end - 90 * day, end);
  const yearStart = unixSec
    ? Math.floor(Date.UTC(new Date(end * 1000).getUTCFullYear(), 0, 1) / 1000)
    : Date.UTC(new Date(end).getUTCFullYear(), 0, 1);
  return clamp(yearStart, end);
}

/** True when a preset actually narrows the current extent (ALL always stays). */
export function presetZoomsIn(preset: RangePreset, extent: readonly [number, number]): boolean {
  if (preset === "ALL") return true;
  const next = viewportFromPreset(preset, extent);
  if (!next.x || !isQuantitativeViewportX(next.x)) return false;
  const [from, to] = quantitativeRange(next.x);
  const lo = Math.min(extent[0], extent[1]);
  const hi = Math.max(extent[0], extent[1]);
  const full = hi - lo;
  return full > 0 && to - from < full * 0.98;
}

export interface ViewportGroup {
  add(handle: ViewportHandle): () => void;
  setViewport(viewport: ChartViewport | null): void;
  getViewport(): ChartViewport | null;
}

/** Host-owned controller that keeps several mounted charts on the same X window. */
export function createViewportGroup(): ViewportGroup {
  const handles = new Set<ViewportHandle>();
  let current: ChartViewport | null = null;
  return {
    add(handle) {
      handles.add(handle);
      if (current) handle.setViewport(current);
      return () => {
        handles.delete(handle);
      };
    },
    setViewport(viewport) {
      current = viewport;
      for (const handle of handles) handle.setViewport(viewport);
    },
    getViewport() {
      return current;
    },
  };
}

/**
 * Limits for interactive X zoom and pan on a quantitative axis, in data units
 * (milliseconds for time axes).
 */
export interface XWindowLimits {
  /** Full data extent the window may cover. */
  readonly extent: readonly [number, number];
  /** Narrowest window; zooming in stops here. */
  readonly minSpan: number;
  /** Widest window; zooming out stops here. */
  readonly maxSpan: number;
  /** Keep the window inside `extent` (`panBounds: "data"`). */
  readonly bounded: boolean;
}

function orderedWindow(range: readonly [number, number]): [number, number] {
  return range[0] <= range[1] ? [range[0], range[1]] : [range[1], range[0]];
}

/**
 * Clamp a window to the limits: its span to [minSpan, maxSpan] around its
 * centre, then (when bounded) shifted inside the extent. A window at least as
 * wide as a bounded extent becomes exactly the extent, so zooming out always
 * recovers the full data.
 */
export function clampXWindow(range: readonly [number, number], limits: XWindowLimits): [number, number] {
  let [lo, hi] = orderedWindow(range);
  const minSpan = Math.max(0, limits.minSpan);
  const maxSpan = Math.max(minSpan, limits.maxSpan);
  const span = hi - lo;
  if (!(span >= minSpan && span <= maxSpan)) {
    const next = Math.min(maxSpan, Math.max(minSpan, Number.isFinite(span) ? span : maxSpan));
    const centre = Number.isFinite(lo + hi) ? (lo + hi) / 2 : (limits.extent[0] + limits.extent[1]) / 2;
    lo = centre - next / 2;
    hi = centre + next / 2;
  }
  if (!limits.bounded) return [lo, hi];
  const [extLo, extHi] = orderedWindow(limits.extent);
  if (hi - lo >= extHi - extLo) return [extLo, extHi];
  if (lo < extLo) return [extLo, extLo + (hi - lo)];
  if (hi > extHi) return [extHi - (hi - lo), extHi];
  return [lo, hi];
}

/**
 * Zoom a window by `factor` (<1 zooms in) around `anchor`, which keeps its
 * relative position unless a limit or the data bounds move it.
 */
export function zoomXWindow(
  range: readonly [number, number],
  anchor: number,
  factor: number,
  limits: XWindowLimits,
): [number, number] {
  const [lo, hi] = orderedWindow(range);
  const span = hi - lo;
  if (!(span > 0) || !(factor > 0) || !Number.isFinite(factor)) return clampXWindow([lo, hi], limits);
  const minSpan = Math.max(0, limits.minSpan);
  const maxSpan = Math.max(minSpan, limits.maxSpan);
  const target = Math.min(maxSpan, Math.max(minSpan, span * factor));
  const applied = target / span;
  const pivot = Number.isFinite(anchor) ? Math.min(hi, Math.max(lo, anchor)) : (lo + hi) / 2;
  const nextLo = pivot - (pivot - lo) * applied;
  return clampXWindow([nextLo, nextLo + target], limits);
}

/** Shift a window by `delta` (in the limits' units), keeping its span within the limits and the data bounds. */
export function panXWindow(range: readonly [number, number], delta: number, limits: XWindowLimits): [number, number] {
  const [lo, hi] = orderedWindow(range);
  const shift = Number.isFinite(delta) ? delta : 0;
  return clampXWindow([lo + shift, hi + shift], limits);
}
