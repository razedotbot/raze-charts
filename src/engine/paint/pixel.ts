// Bitmap-space painting helpers (AD-04).
//
// The engine paints with `ctx.setTransform(dpr, …)`, so a CSS-space line at
// `Math.round(x) + 0.5` with `lineWidth = 1` is only crisp at integer DPR. At
// 125 %, 150 % or 175 % scaling it lands between device pixels and becomes a
// two-pixel half-intensity smear. These helpers convert CSS geometry to whole
// device pixels instead: every edge is rounded in device space and every
// hairline is `max(1, floor(cssWidth × ratio))` device pixels thick, so an
// axis-aligned line or rectangle is a run of full-intensity pixels at any DPR.
//
// Conventions
// - A line "at CSS coordinate c" starts at device pixel `round(c × ratio)` and
//   grows by `floor((width - 1) / 2)` pixels to the left/up, so odd widths are
//   centred on that pixel. At DPR 1 this is the classic `Math.round(c) + 0.5`.
// - Rectangles round each edge independently, so rectangles that share a CSS
//   edge tile without gaps or overlaps.
// - The ratios come from the context's current transform, which is what the
//   rest of the frame paints with. A fake or non axis-aligned context falls back
//   to the view's DPR (or to CSS space when the transform rotates or skews).
//
// This module has no engine imports so the native `/chart` renderer can adopt
// it without pulling in the financial widget.

/** A rectangle in whole device pixels. */
export interface DeviceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A paint scope whose context draws in device pixels (identity transform). */
export interface BitmapSpace {
  readonly ctx: CanvasRenderingContext2D;
  /** Device pixels per CSS pixel along x. */
  readonly hpr: number;
  /** Device pixels per CSS pixel along y. */
  readonly vpr: number;
  /** Device column of a CSS x coordinate (edge-aligned, integer). */
  x(cssX: number): number;
  /** Device row of a CSS y coordinate (edge-aligned, integer). */
  y(cssY: number): number;
  /** Integer device thickness of a vertical line `cssWidth` CSS pixels wide. */
  lineW(cssWidth?: number): number;
  /** Integer device thickness of a horizontal line `cssWidth` CSS pixels tall. */
  lineH(cssWidth?: number): number;
}

interface TransformLike {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

function currentTransform(ctx: CanvasRenderingContext2D): TransformLike | null {
  const read = (ctx as Partial<CanvasRenderingContext2D>).getTransform;
  if (typeof read !== "function") return null;
  try {
    const m = read.call(ctx) as TransformLike | undefined;
    return m && Number.isFinite(m.a) && Number.isFinite(m.d) ? m : null;
  } catch {
    return null;
  }
}

/** Integer device thickness of a `cssWidth` line: at least one device pixel. */
export function deviceLineWidth(cssWidth: number, ratio: number): number {
  return Math.max(1, Math.floor(cssWidth * ratio));
}

/** First device pixel of a `width`-pixel line whose anchor pixel is `anchor`. */
export function lineStart(anchor: number, width: number): number {
  return anchor - Math.floor((width - 1) / 2);
}

class Space implements BitmapSpace {
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    readonly hpr: number,
    readonly vpr: number,
    private readonly ox: number,
    private readonly oy: number,
  ) {}

  x(cssX: number): number {
    return Math.round(cssX * this.hpr + this.ox);
  }

  y(cssY: number): number {
    return Math.round(cssY * this.vpr + this.oy);
  }

  lineW(cssWidth = 1): number {
    return deviceLineWidth(cssWidth, this.hpr);
  }

  lineH(cssWidth = 1): number {
    return deviceLineWidth(cssWidth, this.vpr);
  }
}

/**
 * Run `draw` with the context switched to device pixels. The previous state
 * (transform, clip, styles) is restored afterwards, whatever `draw` does.
 *
 * `fallbackRatio` is used when the context cannot report its transform (test
 * doubles); pass the view's `dpr`.
 */
export function withBitmapSpace<T>(
  ctx: CanvasRenderingContext2D,
  fallbackRatio: number,
  draw: (space: BitmapSpace) => T,
): T {
  const m = currentTransform(ctx);
  let space: Space;
  ctx.save();
  try {
    if (!m) {
      const ratio = Number.isFinite(fallbackRatio) && fallbackRatio > 0 ? fallbackRatio : 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      space = new Space(ctx, ratio, ratio, 0, 0);
    } else if (m.b === 0 && m.c === 0 && m.a > 0 && m.d > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      space = new Space(ctx, m.a, m.d, m.e, m.f);
    } else {
      // Rotated or skewed: pixel snapping is meaningless, so snap to the CSS
      // grid and keep the caller's transform.
      space = new Space(ctx, 1, 1, 0, 0);
    }
    return draw(space);
  } finally {
    ctx.restore();
  }
}

/** Snap a CSS rectangle to device pixels, rounding each edge independently. */
export function snapRect(s: BitmapSpace, x: number, y: number, w: number, h: number): DeviceRect {
  const x0 = s.x(Math.min(x, x + w));
  const x1 = s.x(Math.max(x, x + w));
  const y0 = s.y(Math.min(y, y + h));
  const y1 = s.y(Math.max(y, y + h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Device rectangle of a vertical line at CSS `x` from `y1` to `y2`. */
export function vLineRect(s: BitmapSpace, x: number, y1: number, y2: number, cssWidth = 1): DeviceRect {
  const w = s.lineW(cssWidth);
  const top = s.y(Math.min(y1, y2));
  const bottom = s.y(Math.max(y1, y2));
  return { x: lineStart(s.x(x), w), y: top, w, h: Math.max(0, bottom - top) };
}

/** Device rectangle of a horizontal line at CSS `y` from `x1` to `x2`. */
export function hLineRect(s: BitmapSpace, y: number, x1: number, x2: number, cssWidth = 1): DeviceRect {
  const h = s.lineH(cssWidth);
  const left = s.x(Math.min(x1, x2));
  const right = s.x(Math.max(x1, x2));
  return { x: left, y: lineStart(s.y(y), h), w: Math.max(0, right - left), h };
}

/** Fill a device rectangle with the current fill style (skips empty ones). */
export function fillDeviceRect(s: BitmapSpace, r: DeviceRect): void {
  if (r.w > 0 && r.h > 0) s.ctx.fillRect(r.x, r.y, r.w, r.h);
}

/** Append a device rectangle to the current path (batch several, then fill once). */
export function pathDeviceRect(s: BitmapSpace, r: DeviceRect): void {
  if (r.w > 0 && r.h > 0) s.ctx.rect(r.x, r.y, r.w, r.h);
}

/** Fill a crisp vertical line with the current fill style. */
export function crispVLine(s: BitmapSpace, x: number, y1: number, y2: number, cssWidth = 1): void {
  fillDeviceRect(s, vLineRect(s, x, y1, y2, cssWidth));
}

/** Fill a crisp horizontal line with the current fill style. */
export function crispHLine(s: BitmapSpace, y: number, x1: number, x2: number, cssWidth = 1): void {
  fillDeviceRect(s, hLineRect(s, y, x1, x2, cssWidth));
}

/**
 * Fill a crisp, optionally dashed, horizontal line with the current fill
 * style. `dash` alternates on/off lengths in CSS pixels, scaled to whole device
 * pixels; dashes are filled rectangles because canvas stroke dashing
 * anti-aliases dash ends at fractional DPRs.
 */
export function dashedHLine(
  s: BitmapSpace,
  y: number,
  x1: number,
  x2: number,
  cssWidth = 1,
  dash: readonly number[] = [],
): void {
  const r = hLineRect(s, y, x1, x2, cssWidth);
  if (r.w <= 0 || r.h <= 0) return;
  const pattern = dash.map((part) => Math.max(1, Math.round(part * s.hpr)));
  if (!pattern.length) {
    s.ctx.fillRect(r.x, r.y, r.w, r.h);
    return;
  }
  // An odd-length pattern repeats twice per period, like setLineDash().
  if (pattern.length % 2) pattern.push(...pattern);
  const ctx = s.ctx;
  const end = r.x + r.w;
  ctx.beginPath();
  for (let x = r.x, k = 0; x < end; x += pattern[k]!, k = (k + 1) % pattern.length) {
    if (k % 2 === 0) ctx.rect(x, r.y, Math.min(pattern[k]!, end - x), r.h);
  }
  ctx.fill();
}

/** Stroke the inside border of a CSS rectangle as crisp device-pixel bands. */
export function strokeRectInside(
  s: BitmapSpace,
  x: number,
  y: number,
  w: number,
  h: number,
  cssWidth = 1,
): void {
  fillRectBorder(s, snapRect(s, x, y, w, h), s.lineW(cssWidth), s.lineH(cssWidth));
}

/** Fill the `bw` × `bh` inside border of a device rectangle. */
export function fillRectBorder(s: BitmapSpace, r: DeviceRect, bw: number, bh: number): void {
  if (r.w <= 0 || r.h <= 0) return;
  if (r.w <= bw * 2 || r.h <= bh * 2) {
    s.ctx.fillRect(r.x, r.y, r.w, r.h);
    return;
  }
  const ctx = s.ctx;
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, bh);
  ctx.rect(r.x, r.y + r.h - bh, r.w, bh);
  ctx.rect(r.x, r.y + bh, bw, r.h - bh * 2);
  ctx.rect(r.x + r.w - bw, r.y + bh, bw, r.h - bh * 2);
  ctx.fill();
}

/** Clip to a CSS rectangle snapped to device pixels. */
export function clipToRect(s: BitmapSpace, x: number, y: number, w: number, h: number): DeviceRect {
  const r = snapRect(s, x, y, w, h);
  s.ctx.beginPath();
  s.ctx.rect(r.x, r.y, r.w, r.h);
  s.ctx.clip();
  return r;
}

/**
 * Device pixels per CSS pixel of the context's current transform (the value a
 * CSS-space painter needs to land on whole device pixels), or `fallback`.
 */
export function contextPixelRatio(ctx: CanvasRenderingContext2D, fallback: number): { h: number; v: number } {
  const m = currentTransform(ctx);
  if (m && m.b === 0 && m.c === 0 && m.a > 0 && m.d > 0) return { h: m.a, v: m.d };
  const ratio = Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
  return { h: ratio, v: ratio };
}

/**
 * Round a CSS coordinate to the nearest device-pixel boundary while staying in
 * CSS space. Use it for shapes that must stay in CSS space (text, rounded
 * pills) but whose straight edges should still be crisp.
 */
export function alignToDevice(value: number, ratio: number): number {
  return Math.round(value * ratio) / ratio;
}
