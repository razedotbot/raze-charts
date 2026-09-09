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
