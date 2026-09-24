// Geometry and styling primitives shared by the SVG and Canvas renderers:
// escaping, pixel snapping, curve and arc paths, rounded bars, and shading.

import type { ChartCurve, SceneNode } from "../compile/types";
import { formatChartColor, parseChartColor } from "../theme";

export const TAU = Math.PI * 2;

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

export function round(n: number): string {
  return n.toFixed(2);
}

/** Center a 1px stroke on the pixel grid. */
export function hair(n: number): number {
  return Math.round(n) + 0.5;
}

/** Fritsch–Carlson monotone cubic. No Catmull overshoot on peaks. */
function monotoneTangents(pts: readonly { x: number; y: number }[]): number[] {
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

function monotonePath(pts: readonly { x: number; y: number }[]): string {
  if (!pts.length) return "";
  if (pts.length === 1) return `M${round(pts[0]!.x)} ${round(pts[0]!.y)}`;
  if (pts.length === 2) {
    return `M${round(pts[0]!.x)} ${round(pts[0]!.y)} L${round(pts[1]!.x)} ${round(pts[1]!.y)}`;
  }
  const t = monotoneTangents(pts);
  let d = `M${round(pts[0]!.x)} ${round(pts[0]!.y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const h = p1.x - p0.x;
    const c1x = p0.x + h / 3;
    const c1y = p0.y + t[i]! * h / 3;
    const c2x = p1.x - h / 3;
    const c2y = p1.y - t[i + 1]! * h / 3;
    d += ` C${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(p1.x)} ${round(p1.y)}`;
  }
  return d;
}

/** SVG path data for a series polyline in the requested curve. */
export function seriesPath(pts: readonly { x: number; y: number }[], curve: ChartCurve | undefined): string {
  if (!pts.length) return "";
  if (curve === "linear" || pts.length < 3) {
    return pts.map((p, i) => `${i ? "L" : "M"}${round(p.x)} ${round(p.y)}`).join(" ");
  }
  if (curve === "step") {
    let d = `M${round(pts[0]!.x)} ${round(pts[0]!.y)}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L${round(pts[i]!.x)} ${round(pts[i - 1]!.y)} L${round(pts[i]!.x)} ${round(pts[i]!.y)}`;
    }
    return d;
  }
  return monotonePath(pts);
}

/** Canvas equivalent of seriesPath(); appends to the current path. */
export function traceSeries(ctx: CanvasRenderingContext2D, pts: readonly { x: number; y: number }[], curve: ChartCurve | undefined): void {
  if (!pts.length) return;
  if (curve === "linear" || pts.length < 3) {
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    return;
  }
  if (curve === "step") {
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i]!.x, pts[i - 1]!.y);
      ctx.lineTo(pts[i]!.x, pts[i]!.y);
    }
    return;
  }
  traceMonotone(ctx, pts);
}

function traceMonotone(ctx: CanvasRenderingContext2D, pts: readonly { x: number; y: number }[]): void {
  if (!pts.length) return;
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  if (pts.length === 1) return;
  if (pts.length === 2) {
    ctx.lineTo(pts[1]!.x, pts[1]!.y);
    return;
  }
  const t = monotoneTangents(pts);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const h = p1.x - p0.x;
    ctx.bezierCurveTo(
      p0.x + h / 3,
      p0.y + t[i]! * h / 3,
      p1.x - h / 3,
      p1.y - t[i + 1]! * h / 3,
      p1.x,
      p1.y,
    );
  }
}

/** Arc sweep clamped to [0, TAU]. */
export function arcSweep(n: SceneNode): number {
  return Math.max(0, Math.min(TAU, (n.endAngle ?? 0) - (n.startAngle ?? 0)));
}

export function arcPath(n: SceneNode): string {
  const cx = n.x ?? 0;
  const cy = n.y ?? 0;
  const r = n.r ?? 0;
  const inner = n.innerR ?? 0;
  const a0 = n.startAngle ?? 0;
  const sweep = arcSweep(n);
  if (r <= 0 || sweep <= 1e-9) return "";
  const a1 = a0 + sweep;
  const large = sweep > Math.PI ? 1 : 0;
  const x0 = cx + Math.cos(a0) * r;
  const y0 = cy + Math.sin(a0) * r;
  const x1 = cx + Math.cos(a1) * r;
  const y1 = cy + Math.sin(a1) * r;
  const full = sweep >= TAU - 1e-9;
  const mx = cx + Math.cos(a0 + Math.PI) * r;
  const my = cy + Math.sin(a0 + Math.PI) * r;
  if (inner <= 0 && full) {
    return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 1 1 ${mx} ${my} A ${r} ${r} 0 1 1 ${x1} ${y1} Z`;
  }
  if (inner <= 0) {
    return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
  }
  const ix0 = cx + Math.cos(a0) * inner;
  const iy0 = cy + Math.sin(a0) * inner;
  const ix1 = cx + Math.cos(a1) * inner;
  const iy1 = cy + Math.sin(a1) * inner;
  if (full) {
    const imx = cx + Math.cos(a0 + Math.PI) * inner;
    const imy = cy + Math.sin(a0 + Math.PI) * inner;
    return `M ${x0} ${y0} A ${r} ${r} 0 1 1 ${mx} ${my} A ${r} ${r} 0 1 1 ${x1} ${y1} L ${ix1} ${iy1} A ${inner} ${inner} 0 1 0 ${imx} ${imy} A ${inner} ${inner} 0 1 0 ${ix0} ${iy0} Z`;
  }
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${large} 0 ${ix0} ${iy0} Z`;
}

/** Canvas path for an arc or donut slice; false when there is nothing to draw. */
export function traceArcNode(ctx: CanvasRenderingContext2D, n: SceneNode): boolean {
  const cx = n.x ?? 0;
  const cy = n.y ?? 0;
  const outer = n.r ?? 0;
  const inner = Math.max(0, n.innerR ?? 0);
  const start = n.startAngle ?? 0;
  const sweep = arcSweep(n);
  if (outer <= 0 || sweep <= 1e-9) return false;
  const end = start + sweep;
  ctx.beginPath();
  if (inner <= 0) {
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(start) * outer, cy + Math.sin(start) * outer);
    ctx.arc(cx, cy, outer, start, end, false);
  } else {
    ctx.moveTo(cx + Math.cos(start) * outer, cy + Math.sin(start) * outer);
    ctx.arc(cx, cy, outer, start, end, false);
    ctx.lineTo(cx + Math.cos(end) * inner, cy + Math.sin(end) * inner);
    ctx.arc(cx, cy, inner, end, start, true);
  }
  ctx.closePath();
  return true;
}

export function roundTopRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, Math.max(0, h));
  if (rr < 0.5) {
    return `M${round(x)} ${round(y)} h${round(w)} v${round(h)} h${round(-w)} Z`;
  }
  return `M${round(x)} ${round(y + h)} L${round(x)} ${round(y + rr)} Q${round(x)} ${round(y)} ${round(x + rr)} ${round(y)} L${round(x + w - rr)} ${round(y)} Q${round(x + w)} ${round(y)} ${round(x + w)} ${round(y + rr)} L${round(x + w)} ${round(y + h)} Z`;
}

export function roundBottomRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, Math.max(0, h));
  if (rr < 0.5) {
    return `M${round(x)} ${round(y)} h${round(w)} v${round(h)} h${round(-w)} Z`;
  }
  return `M${round(x)} ${round(y)} L${round(x + w)} ${round(y)} L${round(x + w)} ${round(y + h - rr)} Q${round(x + w)} ${round(y + h)} ${round(x + w - rr)} ${round(y + h)} L${round(x + rr)} ${round(y + h)} Q${round(x)} ${round(y + h)} ${round(x)} ${round(y + h - rr)} Z`;
}

export function traceRoundTopRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, Math.max(0, h));
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + radius);
  if (radius >= 0.5) ctx.quadraticCurveTo(x, y, x + radius, y);
  else ctx.lineTo(x, y);
  ctx.lineTo(x + w - radius, y);
  if (radius >= 0.5) ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  else ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

export function traceRoundBottomRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, Math.max(0, h));
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - radius);
  if (radius >= 0.5) ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  else ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + radius, y + h);
  if (radius >= 0.5) ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  else ctx.lineTo(x, y + h);
  ctx.closePath();
}

export function traceRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** Blend toward the warm highlight used for bar sheen. */
export function lift(color: string, t: number): string {
  const parsed = parseChartColor(color);
  if (!parsed) return color;
  const u = Math.max(0, Math.min(1, t));
  return formatChartColor({
    r: parsed.r + (244 - parsed.r) * u,
    g: parsed.g + (238 - parsed.g) * u,
    b: parsed.b + (225 - parsed.b) * u,
    a: parsed.a,
  });
}

/** Darken toward black for the bar gradient foot. */
export function shade(color: string, t: number): string {
  const parsed = parseChartColor(color);
  if (!parsed) return color;
  const u = Math.max(0, Math.min(1, t));
  return formatChartColor({
    r: parsed.r * (1 - u),
    g: parsed.g * (1 - u),
    b: parsed.b * (1 - u),
    a: parsed.a,
  });
}

/** Offset/opacity-factor stops for the vertical area fill, identical in SVG and Canvas. */
export const AREA_GRADIENT_STOPS = Object.freeze([
  [0, 1],
  [0.18, 0.72],
  [0.48, 0.28],
  [0.78, 2 / 21],
  [1, 0],
] as const);

export function normalizedOpacity(value: number | undefined, fallback: number): number {
  const opacity = value ?? fallback;
  return Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : fallback;
}

export function svgOpacity(value: number): string {
  return String(Number(value.toFixed(4)));
}
