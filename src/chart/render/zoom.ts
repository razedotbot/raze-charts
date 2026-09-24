// Zoom and pan limits for mounted charts: option validation, the default
// minimum span (three data points), and axis transforms so zoom anchors stay
// under the pointer on log X axes too.

import { isBuiltinMark } from "../compile/marks";
import { asNumber, readChannel } from "../compile/shared";
import type { ChartSpec, CompiledChart } from "../compile/types";
import type { LinearScale } from "../scales";
import type { XWindowLimits } from "../viewport";
import type { MountInteraction, ResolvedInteraction } from "./types";

/** Rows per mark inspected when estimating the data spacing. */
const STEP_SAMPLE_ROWS = 4096;

function fail(message: string): never {
  throw new TypeError(`[@razedotbot/charts] mountChart: ${message}`);
}

function positiveSpan(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`interaction.zoom.${name} must be a finite number greater than 0 (X data units; milliseconds on time axes). Received ${String(value)}.`);
  }
  return value;
}

/** Defaults plus validation for `MountChartOptions.interaction`; throws with guidance on bad input. */
export function resolveInteraction(raw: boolean | MountInteraction | undefined): ResolvedInteraction {
  const off: ResolvedInteraction = { brush: false, zoom: false, pan: false, navigator: false, rangePresets: false, panBounds: "data" };
  if (raw === false) return off;
  if (raw === true || raw == null) return { ...off, brush: true, zoom: true, pan: true };
  if (typeof raw !== "object") fail(`interaction must be a boolean or an object. Received ${typeof raw}.`);
  const panBounds = raw.panBounds ?? "data";
  if (panBounds !== "data" && panBounds !== "none") {
    fail(`interaction.panBounds must be "data" or "none". Received ${JSON.stringify(panBounds)}.`);
  }
  const zoom = raw.zoom ?? true;
  if (typeof zoom !== "boolean" && (zoom === null || typeof zoom !== "object")) {
    fail(`interaction.zoom must be a boolean or { minSpan?, maxSpan? }. Received ${String(zoom)}.`);
  }
  const minSpan = typeof zoom === "object" ? positiveSpan(zoom.minSpan, "minSpan") : undefined;
  const maxSpan = typeof zoom === "object" ? positiveSpan(zoom.maxSpan, "maxSpan") : undefined;
  if (minSpan !== undefined && maxSpan !== undefined && minSpan > maxSpan) {
    fail(`interaction.zoom.minSpan (${minSpan}) must not exceed maxSpan (${maxSpan}).`);
  }
  return {
    brush: raw.brush ?? true,
    zoom: zoom !== false,
    pan: raw.pan ?? true,
    navigator: raw.navigator ?? false,
    rangePresets: raw.rangePresets ?? false,
    panBounds,
    ...(minSpan !== undefined ? { minSpan } : {}),
    ...(maxSpan !== undefined ? { maxSpan } : {}),
  };
}

/**
 * Typical distance between neighbouring X values of the quantitative marks:
 * the median gap over the first rows of each mark, or null when unknown.
 */
export function estimateDataStep(spec: ChartSpec | null): number | null {
  if (!spec) return null;
  const gaps: number[] = [];
  for (const mark of spec.marks) {
    if (!isBuiltinMark(mark)) continue;
    if (mark.kind !== "line" && mark.kind !== "area" && mark.kind !== "point" && mark.kind !== "bar") continue;
    const rows = mark.data;
    const limit = Math.min(rows.length, STEP_SAMPLE_ROWS);
    let previous = NaN;
    for (let i = 0; i < limit; i++) {
      const value = asNumber(readChannel(rows[i] as never, mark.x as never));
      if (!Number.isFinite(value)) continue;
      const gap = Math.abs(value - previous);
      if (gap > 0) gaps.push(gap);
      previous = value;
    }
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * Limits for the live scene: the full data extent, `minSpan` (option, else
 * three data points, else two plot pixels of the full extent), `maxSpan`
 * (option, else the full extent), and whether windows stay inside the data.
 */
export function resolveWindowLimits(
  scene: CompiledChart,
  extent: readonly [number, number] | null,
  flags: ResolvedInteraction,
  spec: ChartSpec | null,
  cachedStep?: { spec: ChartSpec | null; step: number | null },
): XWindowLimits | null {
  if (scene.polar || scene.heatmap || scene.xScale.kind !== "linear") return null;
  const domain = scene.xScale.domain;
  const source = extent ?? [domain[0], domain[1]];
  const lo = Math.min(source[0], source[1]);
  const hi = Math.max(source[0], source[1]);
  const full = hi - lo;
  if (!Number.isFinite(full) || full <= 0) return null;
  const step = cachedStep && cachedStep.spec === spec ? cachedStep.step : estimateDataStep(spec);
  const precisionFloor = Math.max(Math.abs(lo), Math.abs(hi), full) * 1e-12;
  const fallbackMin = step != null ? step * 2 : (full * 2) / Math.max(1, scene.plot.w);
  const maxSpan = flags.maxSpan ?? full;
  const minSpan = Math.min(maxSpan, Math.max(precisionFloor, flags.minSpan ?? fallbackMin));
  return { extent: [lo, hi], minSpan, maxSpan, bounded: flags.panBounds === "data" };
}

export interface AxisTransform {
  /** Data value to a space where the axis is linear. */
  to(value: number): number;
  from(value: number): number;
  readonly linear: boolean;
}

const IDENTITY: AxisTransform = { to: (value) => value, from: (value) => value, linear: true };
const LOG10: AxisTransform = { to: (value) => Math.log10(value), from: (value) => Math.pow(10, value), linear: false };

/** Linear for linear and time axes, log10 for log axes. */
export function axisTransform(scale: LinearScale): AxisTransform {
  const [d0, d1] = scale.domain;
  if (!(d0 > 0 && d1 > 0) || d0 === d1) return IDENTITY;
  const [r0, r1] = scale.range;
  const midpoint = scale.map((d0 + d1) / 2);
  return Math.abs(midpoint - (r0 + r1) / 2) <= Math.max(1e-6, Math.abs(r1 - r0) * 1e-9) ? IDENTITY : LOG10;
}
