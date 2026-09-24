// Shared view passed to every finance paint function. Built each frame by
// ChartRenderer so draw code never reaches into private fields.
//
// Fields marked "seam" were declared ahead of their wave-1B producers or
// consumers (W1A-06); docs/seams.md names who fills and who reads each one.

import type { Bar, Mark, ShapePoint, TimescaleMark } from "../../types/charting_library";
import type { ChartContext, DrawingTool } from "../../core/context";
import type { ShapeStore, StoredShape } from "../../core/ShapeStore";
import type { StoredTradingLine, TradingStore } from "../../core/TradingStore";
import type { StudyStore } from "../../studies/StudyStore";
import type { DrawingHit } from "../../drawings/types";
import type { SubPaneGeom } from "../layout";
import type { PlotScale } from "../plotScale";

export interface Crosshair {
  x: number;
  y: number;
  active: boolean;
}

/** Axis-aligned rectangle in CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Screen-space point in CSS pixels. */
export interface ScreenPoint {
  x: number;
  y: number;
}

export interface MarkHit {
  mark: Mark;
  x: number;
  y: number;
  r: number;
}

/** Hit target for a painted timescale-mark badge (seam: W1B-09 produces, W1B-10 consumes). */
export interface TimescaleMarkHit {
  mark: TimescaleMark;
  x: number;
  y: number;
  r: number;
}

export interface ShapeHit {
  shape: StoredShape;
  y: number;
  hit: "body" | "p0" | "p1";
  /**
   * Seam (W1B-11 produces, W1B-10 consumes): paint-order z of the drawing so
   * hit-testing can walk topmost-first. Absent means "paint order".
   */
  z?: number;
  /**
   * Seam (W1B-11 produces, W1B-10 consumes): exact hit test against the
   * geometry that was painted this frame. Consumers fall back to `y`
   * proximity when a producer does not provide it.
   */
  hitTest?: (point: ScreenPoint, tolerancePx: number) => DrawingHit | null;
}

export interface TradingHit {
  line: StoredTradingLine;
  y: number;
  x1: number;
  x2: number;
  hit: "body" | "cancel";
}

export interface DraftShape {
  tool: DrawingTool;
  points: ShapePoint[];
}

/** What queued an axis tag; used for de-collision priority, hit-testing and a11y text. */
export type AxisTagSourceKind = "drawing" | "trading" | "study" | "compare" | "series" | "crosshair" | "custom";

/**
 * Default de-collision priority by source: higher-priority tags keep their
 * exact position and paint last. The crosshair tag always wins.
 */
export const AXIS_TAG_PRIORITY: Readonly<Record<AxisTagSourceKind, number>> = Object.freeze({
  custom: 0,
  drawing: 10,
  study: 20,
  compare: 30,
  trading: 40,
  series: 50,
  crosshair: 100,
});

/**
 * A label pill queued for the price or time axis during the frame. Painters
 * push tags instead of drawing into the axis gutter directly, because the axis
 * background is painted after them (the hidden horizontal-line price tag bug).
 * The axis-overlay pass (W1B-07) de-collides and paints them after the axes.
 */
export interface AxisTag {
  axis: "price" | "time";
  /** CSS px along the axis: y for the price axis, x for the time axis. */
  coord: number;
  text: string;
  background: string;
  color: string;
  bold?: boolean;
  /** Band the pill is clamped into (CSS px along the axis). Defaults to the main plot. */
  clamp?: { start: number; end: number };
  /** De-collision priority; defaults to AXIS_TAG_PRIORITY[source.kind]. */
  priority?: number;
  source: { kind: AxisTagSourceKind; id?: string };
}

export interface FinanceView extends PlotScale {
  context: ChartContext;
  cssWidth: number;
  cssHeight: number;
  /** Seam (W1B-08 pixel.ts): device pixels per CSS pixel for bitmap-space snapping. */
  dpr: number;
  priceAxisW: number;
  subPanes: SubPaneGeom[];
  volumePane: { top: number; h: number } | null;
  seriesBars: Bar[];
  studies: StudyStore;
  shapes: ShapeStore;
  trading: TradingStore;
  markScreen: MarkHit[];
  shapeScreen: ShapeHit[];
  tradingScreen: TradingHit[];
  /** Seam (W1B-09 fills while painting badges, W1B-10 hit-tests it). Reset by its painter each frame. */
  timescaleMarkScreen: TimescaleMarkHit[];
  crosshair: Crosshair;
  hoverMark: Mark | null;
  /** Seam (W1B-10 sets on hover, W1B-09/W1B-10 show its tooltip). */
  hoverTimescaleMark: TimescaleMark | null;
  /** Seam (W1B-11): handles paint only for the hovered or selected drawing. */
  hoverShapeId: string | null;
  draft: DraftShape | null;
  selectedShapeId: string | null;
  selectedTradingLineId: string | null;
  fontFamily: string;
  /**
   * Seam: axis tags queued this frame (drawings W1B-11, trading, studies).
   * A fresh empty array per view; painted by the axis-overlay pass (W1B-07).
   */
  axisTags: AxisTag[];
  /**
   * Seam: the reserved price-axis x time-axis corner cell, the only place the
   * timezone/countdown chrome (W1B-09) may paint, so it never overprints ticks.
   */
  axisChromeRect: Rect;
}
