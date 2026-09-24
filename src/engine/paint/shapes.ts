// Drawing runtime: maps stored shapes onto their registered tool definitions
// (src/drawings/registry.ts) and paints them in store z order. Every kind,
// built-in or host-defined, takes the same path:
//
//   stored shape -> DrawingState (schema defaults + overrides)
//                -> DrawingGeometry (anchors in CSS px, the plot rect)
//                -> tool.paint(), clipped to the plot
//                -> handles, only while hovered, selected or drafting
//                -> ShapeHit { z, hitTest } against the geometry just painted
//
// Axis pills (horizontal-line prices) are queued on view.axisTags through
// env.pushAxisTag, so the axis-overlay pass paints them after the price axis.

import { barSpacing, formatAxisPrice, indexForX, priceForY, xForIndex, yForPrice } from "../plotScale";
import { resolutionToMs } from "../../util/resolution";
import { formatPrice } from "../../util/format";
import { TimeIndex } from "../../data/TimeIndex";
import type { ShapePoint } from "../../types/charting_library";
import type { StoredShape } from "../../core/ShapeStore";
import type { DrawingTool, ThemeColors } from "../../core/context";
import { DEFAULT_DRAWING_COLOR, withAlpha } from "../../core/theme";
import {
  anchorsToCommit,
  drawingToolDefaults,
  getDrawingTool,
  listDrawingTools,
  type RegisteredDrawingTool as Tool,
} from "../../drawings/registry";
import { formatBarsDuration } from "../../drawings/format";
import type { AnyState, BuiltinEnv, BuiltinPaintEnv } from "../../drawings/tools/common";
import type { DrawingGeometry, DrawingHit, DrawingInteractionState, DrawingThemeTokens } from "../../drawings/types";
import type { FinanceView, ScreenPoint } from "./view";

/** Base hit tolerance in CSS px for a mouse; touch passes tolMul = 2. */
export const DRAWING_HIT_TOLERANCE_PX = 5;

type Env = Omit<BuiltinEnv, "state">;

export function pointXY(
  v: FinanceView,
  p: ShapePoint,
  timeIndex = new TimeIndex(v.context.bars, resolutionToMs(v.context.resolution)),
): { x: number; y: number } | null {
  const idx = timeIndex.indexAt(p.time * 1000);
  if (idx === null) return null;
  const price = typeof p.price === "number" && Number.isFinite(p.price) ? p.price : v.priceMin;
  return { x: xForIndex(v, idx), y: yForPrice(v, price) };
}

/** A drawing handle: a pane-filled ring in the accent colour, larger and heavier when selected. */
export function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number, stroke: string, fill: string, selected = false): void {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.beginPath();
  ctx.arc(x, y, selected ? 4.5 : 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/** Drawing theme tokens, with the seam fallbacks for contexts built without buildTheme(). */
export function drawingThemeOf(v: FinanceView): DrawingThemeTokens {
  const theme: Partial<ThemeColors> = v.context.theme ?? {};
  const pane = theme.paneBackground ?? "#131722";
  return {
    drawingDefault: theme.drawingDefault ?? DEFAULT_DRAWING_COLOR,
    handleFill: theme.handleFill ?? pane,
    // Empty means "the drawing's own colour" (the accent ring).
    handleStroke: theme.handleStroke ?? "",
    labelBackground: theme.labelBackground ?? withAlpha(pane, 0.92),
    labelText: theme.labelText ?? theme.scaleText ?? "#d1d4dc",
    paneBackground: pane,
  };
}

/** Frame services shared by every drawing painted or hit-tested against `v`. */
function envOf(v: FinanceView, index = new TimeIndex(v.context.bars, resolutionToMs(v.context.resolution))): Env {
  const pricescale = v.context.symbolInfo?.pricescale ?? 100;
  const format = v.context.formatPrice ?? formatPrice;
  return {
    plot: { x: v.plotL, y: v.plotT, w: v.plotW, h: v.plotH },
    dpr: v.dpr || 1,
    fontFamily: v.fontFamily,
    theme: drawingThemeOf(v),
    formatPrice: (price) => format(price, pricescale),
    formatAxisPrice: (price) => formatAxisPrice(v, price, pricescale),
    formatDuration: formatBarsDuration,
    barMs: resolutionToMs(v.context.resolution),
    barSpacing: barSpacing(v),
    timeToX: (seconds) => {
      const i = index.indexAt(seconds * 1000);
      return i === null ? null : xForIndex(v, i);
    },
    priceToY: (price) => yForPrice(v, price),
    xToTime: (x) => (index.timeAt(indexForX(v, x)) ?? 0) / 1000,
    yToPrice: (y) => priceForY(v, y),
  };
}

const defaults = new WeakMap<Tool, Record<string, unknown>>();

function stateOf(shape: StoredShape, tool: Tool, z: number): AnyState {
  let props = defaults.get(tool);
  if (!props) defaults.set(tool, (props = drawingToolDefaults(tool.id)));
  return {
    id: String(shape.id),
    toolId: tool.id,
    points: shape.points,
    props: { ...props, ...shape.overrides },
    text: shape.text || "",
    z,
    locked: shape.lock === true,
    hidden: shape.hidden === true,
  };
}

function geometryOf(env: Env, points: readonly ShapePoint[], fallbackPrice: number): DrawingGeometry {
  return {
    plot: env.plot,
    anchors: points.map((p) => {
      const x = env.timeToX(p.time);
      const price = typeof p.price === "number" && Number.isFinite(p.price) ? p.price : fallbackPrice;
      return x === null ? null : { x, y: env.priceToY(price) };
    }),
  };
}

const warned = new Set<string>();

/** Warn once per key, so a broken tool or an unknown kind does not flood the console every frame. */
function warnOnce(key: string, message: string, error?: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[raze-charts] ${message}`, ...(error === undefined ? [] : [error]));
}

function hit(tool: Tool, point: ScreenPoint, state: AnyState, geometry: DrawingGeometry, env: BuiltinEnv, tolerance: number): DrawingHit | null {
  try {
    return tool.hitTest(point, state, geometry, env, tolerance) ?? null;
  } catch (error) {
    warnOnce(`hit:${tool.id}`, `drawing tool "${tool.id}" threw in hitTest(); treating it as a miss.`, error);
    return null;
  }
}

/** Paint one drawing clipped to the plot, then its handles when they should show. */
function paint(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  frame: Env,
  tool: Tool,
  state: AnyState,
  geometry: DrawingGeometry,
  interaction: DrawingInteractionState,
): BuiltinEnv {
  const env: BuiltinPaintEnv = {
    ...frame,
    state: interaction,
    pushAxisTag: (tag) => {
      v.axisTags?.push({ ...tag, source: { kind: "drawing", id: state.id } });
    },
  };
  const { theme, plot } = env;
  const p = state.props;
  const accent = [p.linecolor, p.color, p.textcolor]
    .find((c): c is string => typeof c === "string" && !!c.trim()) ?? theme.drawingDefault;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  if (interaction.selected) {
    // Selection style: a soft accent halo around everything the tool paints.
    ctx.shadowColor = withAlpha(accent, 0.45);
    ctx.shadowBlur = 4;
  }
  let handles: readonly (ScreenPoint | null)[] = [];
  try {
    tool.paint(ctx, state, geometry, env);
    if (interaction.selected || interaction.hovered || interaction.draft) {
      handles = tool.handles?.(state, geometry, env) ?? geometry.anchors;
    }
  } catch (error) {
    warnOnce(`paint:${tool.id}`, `drawing tool "${tool.id}" threw while painting; the drawing is skipped.`, error);
  }
  ctx.restore();
  ctx.setLineDash([]);
  for (const handle of handles) {
    if (handle) drawHandle(ctx, handle.x, handle.y, theme.handleStroke || accent, theme.handleFill, interaction.selected);
  }
  ctx.restore();
  return env;
}

/** Stacked label y per horizontal line: labels closer than 14px are pushed down so their text never overprints. */
function labelSlots(env: Env, shapes: readonly StoredShape[]): Map<string, number> {
  const rows = shapes
    .filter((s) => !s.hidden && Number.isFinite(s.points[0]?.price) && getDrawingTool(s.shape)?.id === "horizontal_line")
    .map((s) => ({ id: String(s.id), y: env.priceToY(s.points[0]!.price!) }))
    .sort((a, b) => a.y - b.y);
  rows.forEach((row, i) => {
    if (i && row.y - rows[i - 1]!.y < 14) row.y = rows[i - 1]!.y + 14;
  });
  return new Map(rows.map((row) => [row.id, row.y]));
}

/** Paint every visible drawing in store z order and publish their hit targets. */
export function drawShapes(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  v.shapeScreen.length = 0;
  const shapes = v.shapes.list();
  if (!shapes.length) return;
  const base = envOf(v);
  const frame: Env = { ...base, horizontalLabelY: labelSlots(base, shapes) };

  shapes.forEach((shape, z) => {
    if (shape.hidden) return;
    const tool = getDrawingTool(shape.shape);
    if (!tool) {
      warnOnce(
        `kind:${shape.shape}`,
        `drawing kind "${shape.shape}" is not registered, so it is not painted. Register it with defineDrawingTool() `
          + `or use one of: ${listDrawingTools().map((t) => t.id).join(", ")}.`,
      );
      return;
    }
    const id = String(shape.id);
    const state = stateOf(shape, tool, z);
    const geometry = geometryOf(frame, shape.points, v.priceMin);
    const env = paint(ctx, v, frame, tool, state, geometry, {
      selected: v.selectedShapeId === id,
      hovered: v.hoverShapeId === id,
      draft: false,
    });
    const anchors = geometry.anchors.filter((a): a is ScreenPoint => !!a);
    const price = shape.points[0]?.price;
    v.shapeScreen.push({
      shape,
      // Horizontal lines keep their line y: gestures match them by y proximity.
      y: tool.id === "horizontal_line" && Number.isFinite(price)
        ? frame.priceToY(price!)
        : anchors.length ? anchors.reduce((sum, a) => sum + a.y, 0) / anchors.length : frame.plot.y + frame.plot.h / 2,
      hit: "body",
      z,
      hitTest: (point, tolerance) => hit(tool, point, state, geometry, env, tolerance),
    });
  });
}

/** The in-progress drawing, painted by its own tool with the pointer as the next anchor. */
export function drawDraft(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const draft = v.draft;
  const tool = draft?.points.length ? getDrawingTool(draft.tool === "cursor" ? "trend_line" : draft.tool) : undefined;
  if (!draft || !tool) return;
  const index = new TimeIndex(v.context.bars, resolutionToMs(v.context.resolution));
  const env = envOf(v, index);
  const points = [...draft.points];
  if (v.crosshair.active && points.length < anchorsToCommit(tool.id)) {
    points.push({ time: (index.timeAt(indexForX(v, v.crosshair.x)) ?? 0) / 1000, price: priceForY(v, v.crosshair.y) });
  }
  const ghost = { id: "draft", shape: tool.id, points, text: tool.text ? "…" : "", overrides: {} } as unknown as StoredShape;
  paint(ctx, v, env, tool, stateOf(ghost, tool, Infinity), geometryOf(env, points, v.priceMin), {
    selected: false,
    hovered: false,
    draft: true,
  });
}

/**
 * Hit-test one drawing at a canvas point. Uses the geometry painted this frame
 * when there is one (so hits match the pixels exactly), else maps it afresh.
 * `tolMul` widens the tolerance (2 for touch).
 */
export function hitDrawing(v: FinanceView, shape: StoredShape, x: number, y: number, tolMul = 1): DrawingHit | null {
  const tolerance = DRAWING_HIT_TOLERANCE_PX * tolMul;
  const painted = v.shapeScreen.find((s) => s.shape.id === shape.id);
  if (painted?.hitTest) return painted.hitTest({ x, y }, tolerance);
  const tool = getDrawingTool(shape.shape);
  if (!tool || shape.hidden) return null;
  const env = envOf(v);
  const state = { selected: false, hovered: false, draft: false };
  return hit(tool, { x, y }, stateOf(shape, tool, 0), geometryOf(env, shape.points, v.priceMin), { ...env, state }, tolerance);
}

/** Boolean form of hitDrawing() used by hover hit-testing. */
export function hitComplexShape(v: FinanceView, shape: StoredShape, x: number, y: number, tolMul = 1): boolean {
  return hitDrawing(v, shape, x, y, tolMul) !== null;
}

/**
 * Apply a tool's constrain() hook to a dragged or drafted anchor (a horizontal
 * line only moves in price, a vertical line only in time).
 */
export function constrainDrawingPoint(
  shape: Pick<StoredShape, "shape" | "points">,
  index: number,
  point: ShapePoint,
  shiftKey = false,
): ShapePoint {
  const constrain = getDrawingTool(shape.shape)?.constrain;
  return constrain ? constrain({ index, point, points: shape.points, shiftKey }) : point;
}

/** Anchors a draft of `tool` collects before it is committed (0 for the cursor or unknown tools). */
export function neededPoints(tool: DrawingTool | string): number {
  return anchorsToCommit(tool);
}
