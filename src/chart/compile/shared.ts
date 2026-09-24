// Dependency-free helpers shared by the native compile modules.

import type { Accessor } from "./types";

export function readChannel<T>(row: T, channel: Accessor<T> | undefined): unknown {
  if (channel == null) return undefined;
  if (row == null) return undefined;
  if (typeof channel === "function") return channel(row);
  return (row as Record<string, unknown>)[channel];
}

export function asNumber(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "" && Number.isFinite(+value)) return +value;
  return NaN;
}

export function unique<T>(xs: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

export function finiteBounds(values: readonly number[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

export function isBandCategory(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Unlike Array.isArray's type predicate, this runtime-only check does not
// widen an already typed readonly array to any[].
export function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

/** Identity for one stack slot; quantitative keys normalize Date/number/numeric-string. */
export function stackKey(stackId: string, value: unknown, quantitative = false): string {
  const normalized = quantitative ? asNumber(value) : value instanceof Date ? value.getTime() : value;
  const scalar = normalized == null || typeof normalized !== "object"
    ? normalized
    : String(normalized);
  return JSON.stringify([stackId, quantitative ? "number" : value instanceof Date ? "date" : typeof normalized, scalar]);
}

/** Snap a rectangle to whole pixels while keeping at least one pixel of extent. */
export function snapRect(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const x1 = Math.round(x + w);
  const y1 = Math.round(y + h);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
