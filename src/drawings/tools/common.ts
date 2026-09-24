// Shared geometry, styling and hit-testing helpers for the built-in drawing
// tools. Everything here is CSS-pixel math over the DrawingToolDefinition
// contract (../types.ts); tools never reach into engine internals.

import { isLightColor } from "../../core/theme";
import type { Rect, ScreenPoint } from "../../engine/paint/view";
import type {
  DrawingEnv,
  DrawingHit,
  DrawingLineStyle,
  DrawingPaintEnv,
  DrawingState,
} from "../types";

/**
 * Engine-provided extras visible only to the built-in tools. Host tools see the
 * plain contract; built-ins degrade gracefully when an extra is absent (for
 * example when a tool is painted by a synthetic test view).
 */
export interface BuiltinEnvExtras {
  /** Price formatted exactly like the price axis (percent/log aware). */
  readonly formatAxisPrice?: (price: number) => string;
  /** Stacked label positions for horizontal lines (id -> label y). */
  readonly horizontalLabelY?: ReadonlyMap<string, number>;
}

export type BuiltinEnv = DrawingEnv & BuiltinEnvExtras;
export type BuiltinPaintEnv = DrawingPaintEnv & BuiltinEnvExtras;
export type Props = Readonly<Record<string, unknown>>;
export type AnyState = DrawingState<Props>;
/** Built-ins are typed with erased props and coerce every value they read. */
export type { RegisteredDrawingTool as ToolDef } from "../registry";

// ── Shared property fields ──────────────────────────────────────────────────

/** Stroke fields shared by every line-based tool; empty colour = theme default. */
export function strokeFields(style: DrawingLineStyle = 0) {
  return {
    linecolor: { type: "color", title: "Line color", default: "" },
    linewidth: { type: "lineWidth", title: "Line width", default: 1 },
    linestyle: { type: "lineStyle", title: "Line style", default: style },
  } as const;
}

// ── Props and colours ───────────────────────────────────────────────────────

/** A colour prop, or the fallback when it is empty/unset ("auto"). */
export function colorOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** Stroke colour: `linecolor`, then legacy `color`, then the theme default. */
export function lineColorOf(props: Props, env: DrawingEnv): string {
  return colorOr(props.linecolor, colorOr(props.color, env.theme.drawingDefault));
}

/** Text colour with >= 4.5:1 contrast on a solid pill of `background`. */
export function readableTextOn(background: string): string {
  return isLightColor(background) ? "#131722" : "#ffffff";
}

/** Finite numeric prop, else the fallback. */
export function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Opacity for a TradingView `transparency` prop (0 opaque .. 100 invisible). */
export function opacityOf(transparency: unknown, fallback: number): number {
  return 1 - Math.min(100, Math.max(0, num(transparency, fallback))) / 100;
}

/** Stroke width (TradingView 1-4; any positive width up to 16 here). */
export function widthOf(props: Props): number {
  const width = num(props.linewidth, 1);
  return width > 0 ? Math.min(width, 16) : 1;
}

/** Price of a data-space anchor, or null for a missing/non-finite price. */
export function priceOf(drawing: AnyState, index: number): number | null {
  const price = drawing.points[index]?.price;
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

// ── Stroke styles ───────────────────────────────────────────────────────────

/** TradingView line styles: 0 solid, 1 dotted, 2 dashed, 3 large dashed, 4 sparse dotted. */
const DASHES = [[], [2, 3], [5, 4], [8, 6], [2, 8]];

/** Dash pattern for a line style, scaled by width so thick dotted lines still read as dots. */
export function dashPattern(style: unknown, width = 1, fallback = 0): number[] {
  const pattern = DASHES[typeof style === "number" && DASHES[style] ? style : fallback]!;
  return pattern.map((length) => length * Math.max(1, width));
}

/** Apply a drawing's stroke colour, width and dash (`linestyle`, or `style` when unset). */
export function applyStroke(ctx: CanvasRenderingContext2D, props: Props, env: DrawingEnv, style = 0, color = lineColorOf(props, env)): number {
  const width = widthOf(props);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashPattern(props.linestyle, width, style));
  return width;
}

/** Snap a coordinate so a stroke of `width` covers whole device pixels. */
export function crisp(value: number, width = 1): number {
  return Math.round(width) % 2 ? Math.round(value) + 0.5 : Math.round(value);
}

// ── Geometry ────────────────────────────────────────────────────────────────

export type Segment = readonly [ScreenPoint, ScreenPoint];

/**
 * Clip the line through `a` and `b` to `rect` (Liang-Barsky). t = 0 is `a` and
 * t = 1 is `b`; `extendStart`/`extendEnd` make either end infinite (a ray or a
 * full line). Returns null when nothing lies inside, so rays and extended
 * lines always reach the plot edges instead of stopping after a fixed length.
 */
export function clipLine(a: ScreenPoint, b: ScreenPoint, rect: Rect, extendStart = false, extendEnd = false): Segment | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = extendStart ? -Infinity : 0;
  let t1 = extendEnd ? Infinity : 1;
  const edges: [number, number][] = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.w - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.h - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
    } else if (p < 0) {
      t0 = Math.max(t0, q / p);
    } else {
      t1 = Math.min(t1, q / p);
    }
  }
  if (t0 > t1 || !Number.isFinite(t0 - t1)) return null;
  return [{ x: a.x + t0 * dx, y: a.y + t0 * dy }, { x: a.x + t1 * dx, y: a.y + t1 * dy }];
}

/** Whether `p` is inside `r` grown by `pad` on every side. */
export function inRect(p: ScreenPoint, r: Rect, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

/** Normalised rectangle spanned by two points. */
export function rectFrom(a: ScreenPoint, b: ScreenPoint): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** Distance from `p` to the segment `a`-`b`. */
export function distToSegment(p: ScreenPoint, [a, b]: Segment): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Line tolerance: the requested tolerance plus half the stroke. */
export function reachOf(tolerance: number, props: Props): number {
  return tolerance + widthOf(props) / 2;
}

export const BODY: DrawingHit = Object.freeze({ kind: "body", cursor: "move" });

/**
 * Anchor hit shared by every tool: the closest handle within the tolerance
 * plus 2px of slop, since handles are drawn larger than lines.
 */
export function hitAnchor(point: ScreenPoint, handles: readonly (ScreenPoint | null)[], tolerance: number): DrawingHit | null {
  let best = -1;
  let bestDistance = tolerance + 2;
  handles.forEach((handle, index) => {
    const d = handle ? Math.hypot(handle.x - point.x, handle.y - point.y) : Infinity;
    if (d <= bestDistance) {
      best = index;
      bestDistance = d;
    }
  });
  return best < 0 ? null : { kind: "anchor", index: best, cursor: "move" };
}

// ── Text ────────────────────────────────────────────────────────────────────

let scratch: CanvasRenderingContext2D | null | undefined;

/**
 * Width of `text` in `font`. Uses the paint context when given and otherwise a
 * detached canvas (hit-testing runs between frames), falling back to an
 * average glyph width where the DOM has no canvas, so hit boxes still follow
 * the text in headless environments.
 */
export function measurer(font: string, fontSize: number, ctx?: CanvasRenderingContext2D): (text: string) => number {
  if (!ctx && scratch === undefined) {
    try {
      scratch = document.createElement("canvas").getContext("2d");
    } catch {
      scratch = null;
    }
  }
  const target = ctx ?? scratch;
  if (target) target.font = font;
  return (text) => {
    const width = target?.measureText(text).width;
    return Number.isFinite(width) ? width! : text.length * fontSize * 0.6;
  };
}

/**
 * Display lines: hard breaks on `\n`, then greedy word wrapping when `wrap`
 * is set (a word wider than the wrap width breaks by glyph).
 */
export function wrapText(text: string, measure: (text: string) => number, wrap: number | null): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const token of wrap ? paragraph.split(/(\s+)/) : [paragraph]) {
      if (!wrap || measure(line + token) <= wrap) {
        line += token;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = "";
      if (!token.trim()) continue;
      for (const glyph of token) {
        if (line && measure(line + glyph) > wrap) {
          lines.push(line);
          line = "";
        }
        line += glyph;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
