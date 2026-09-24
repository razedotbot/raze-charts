// Curve geometry shared by the compiler: the same monotone/step/linear
// interpolation the renderers draw, flattened to polylines where a shape must
// be closed as a polygon (ranged areas) yet still follow the series curve.

import type { ChartCurve, ScenePoint } from "./types";

/**
 * Fritsch-Carlson monotone tangents: no Catmull overshoot on peaks. Mirrors
 * the renderers' monotone path exactly, so a flattened curve lies on the
 * stroked one.
 */
export function monotoneTangents(pts: readonly ScenePoint[]): number[] {
  const n = pts.length;
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1]!.x - pts[i]!.x;
    m[i] = dx === 0 ? 0 : (pts[i + 1]!.y - pts[i]!.y) / dx;
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) {
    t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2;
  }
  t[n - 1] = m[n - 2]!;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(m[i]!) < 1e-12) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const sum = a * a + b * b;
    if (sum > 9) {
      const factor = 3 / Math.sqrt(sum);
      t[i] = factor * a * m[i]!;
      t[i + 1] = factor * b * m[i]!;
    }
  }
  return t;
}

/** Largest cubic subdivision per segment; keeps pathological inputs bounded. */
const MAX_SUBDIVISIONS = 48;

/**
 * Flatten a series polyline into points that trace `curve` within `tolerance`
 * pixels. Linear curves, and polylines shorter than three points (which every
 * renderer draws straight), are returned as-is.
 */
export function flattenCurve(
  pts: readonly ScenePoint[],
  curve: ChartCurve | undefined,
  tolerance = 0.25,
): ScenePoint[] {
  if (curve === "linear" || pts.length < 3) return pts.slice();
  if (curve === "step") {
    const out: ScenePoint[] = [pts[0]!];
    for (let i = 1; i < pts.length; i++) {
      out.push({ x: pts[i]!.x, y: pts[i - 1]!.y }, pts[i]!);
    }
    return out;
  }
  const t = monotoneTangents(pts);
  const out: ScenePoint[] = [pts[0]!];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i]!;
    const p3 = pts[i + 1]!;
    const h = p3.x - p0.x;
    const c1 = { x: p0.x + h / 3, y: p0.y + t[i]! * h / 3 };
    const c2 = { x: p3.x - h / 3, y: p3.y - t[i + 1]! * h / 3 };
    // Wang's bound: uniform steps whose chords stay within `tolerance`.
    const ddx = Math.max(Math.abs(p0.x - 2 * c1.x + c2.x), Math.abs(c1.x - 2 * c2.x + p3.x));
    const ddy = Math.max(Math.abs(p0.y - 2 * c1.y + c2.y), Math.abs(c1.y - 2 * c2.y + p3.y));
    const steps = Math.min(
      MAX_SUBDIVISIONS,
      Math.max(1, Math.ceil(Math.sqrt((0.75 * Math.hypot(ddx, ddy)) / tolerance))),
    );
    for (let step = 1; step < steps; step++) {
      const u = step / steps;
      const v = 1 - u;
      const a = v * v * v;
      const b = 3 * v * v * u;
      const c = 3 * v * u * u;
      const d = u * u * u;
      out.push({
        x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
        y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
      });
    }
    out.push(p3);
  }
  return out;
}
