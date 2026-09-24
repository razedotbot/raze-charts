// Drawing-tool plugin contract (AD-03), fixed before any implementation so the
// registry (W1B-11), interaction (W1B-10) and store (W1B-20) packages can be
// built in parallel against one interface. Built-in tools implement exactly
// the same contract as host tools registered through defineDrawingTool().
//
// Coordinates: `ShapePoint`s are data space (Unix seconds + price); everything
// a tool paints or hit-tests is CSS pixels in the chart canvas. The runtime
// maps between them and hands tools only the mapped geometry plus a small
// read-only environment, so tools never reach into engine internals.

import type { ShapePoint } from "../types/charting_library";
import type { AxisTag, Rect, ScreenPoint } from "../engine/paint/view";

/** TradingView line style numbering: 0 solid, 1 dotted, 2 dashed, 3 large dashed, 4 sparse dotted. */
export type DrawingLineStyle = 0 | 1 | 2 | 3 | 4;

/** Sidebar grouping for the tool picker. */
export type DrawingToolGroup =
  | "lines"
  | "fibonacci"
  | "shapes"
  | "annotation"
  | "measure"
  | "patterns"
  | "projection"
  | "custom";

/**
 * How many anchors a tool collects while drafting: a fixed count (one click per
 * anchor), or a free-form path with a minimum that is finished by double-click
 * and/or Enter (Escape always cancels).
 */
export type DrawingAnchorSpec =
  | number
  | {
    readonly min: number;
    readonly max?: number;
    readonly finish: "double-click" | "enter" | "either";
  };

/** Cursor a hit requests while hovered. */
export type DrawingCursor =
  | "pointer"
  | "move"
  | "grab"
  | "text"
  | "crosshair"
  | "ew-resize"
  | "ns-resize"
  | "nwse-resize"
  | "nesw-resize";

/**
 * Result of a tool hit test. `anchor` drags one anchor, `body` moves every
 * anchor by the same bar/price delta, `label` targets the text (double-click
 * edits it inline).
 */
export type DrawingHit =
  | { readonly kind: "anchor"; readonly index: number; readonly cursor?: DrawingCursor }
  | { readonly kind: "body"; readonly cursor?: DrawingCursor }
  | { readonly kind: "label"; readonly cursor?: DrawingCursor };

/** A fib/level row edited in the settings dialog. */
export interface DrawingLevel {
  readonly value: number;
  readonly color?: string;
  readonly visible?: boolean;
}

// ── Property schema (drives defaults, validation, the settings dialog and save/load) ──

interface DrawingPropFieldBase<V> {
  /** Settings-dialog label; translated through t() by the dialog. */
  readonly title: string;
  readonly default: V;
  /** Dialog tab. Defaults to `style`. */
  readonly group?: "style" | "text" | "coordinates" | "visibility";
  /** Short help text shown by the dialog. */
  readonly description?: string;
}

export interface DrawingColorField<V extends string = string> extends DrawingPropFieldBase<V> {
  readonly type: "color";
}
export interface DrawingNumberField extends DrawingPropFieldBase<number> {
  readonly type: "number";
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}
export interface DrawingLineWidthField extends DrawingPropFieldBase<number> {
  readonly type: "lineWidth";
}
export interface DrawingLineStyleField extends DrawingPropFieldBase<DrawingLineStyle> {
  readonly type: "lineStyle";
}
export interface DrawingBooleanField extends DrawingPropFieldBase<boolean> {
  readonly type: "boolean";
}
export interface DrawingTextField<V extends string = string> extends DrawingPropFieldBase<V> {
  readonly type: "text";
  readonly multiline?: boolean;
  readonly maxLength?: number;
}
export interface DrawingSelectField<V extends string = string> extends DrawingPropFieldBase<V> {
  readonly type: "select";
  readonly options: readonly { readonly value: V; readonly title: string }[];
}
export interface DrawingLevelsField extends DrawingPropFieldBase<readonly DrawingLevel[]> {
  readonly type: "levels";
}

export type DrawingPropField =
  | DrawingColorField
  | DrawingNumberField
  | DrawingLineWidthField
  | DrawingLineStyleField
  | DrawingBooleanField
  | DrawingTextField
  | DrawingSelectField
  | DrawingLevelsField;

/** The field kinds allowed for a property of type V. */
export type DrawingPropFieldFor<V> =
  [V] extends [boolean] ? DrawingBooleanField
    : [V] extends [DrawingLineStyle] ? DrawingLineStyleField | DrawingNumberField
      : [V] extends [number] ? DrawingNumberField | DrawingLineWidthField
        : [V] extends [readonly DrawingLevel[]] ? DrawingLevelsField
          : [V] extends [string] ? DrawingColorField<V> | DrawingTextField<V> | DrawingSelectField<V>
            : never;

/** One field per property; the schema's defaults are the tool's defaults. */
export type DrawingPropSchema<TProps extends object> = {
  readonly [K in keyof TProps]-?: DrawingPropFieldFor<TProps[K]>;
};

// ── Runtime-facing shapes ───────────────────────────────────────────────────

/** Read-only drawing state handed to a tool. */
export interface DrawingState<TProps extends object = Record<string, unknown>> {
  readonly id: string;
  readonly toolId: string;
  /** Data-space anchors (Unix seconds, price). */
  readonly points: readonly ShapePoint[];
  readonly props: Readonly<TProps>;
  readonly text: string;
  /** Integer z-order; larger paints later and hit-tests first (W1B-20). */
  readonly z: number;
  readonly locked: boolean;
  readonly hidden: boolean;
}

/** Anchors mapped to CSS pixels for this frame. */
export interface DrawingGeometry {
  /** 1:1 with `points`; null when a point cannot be mapped (for example before its history loads). */
  readonly anchors: readonly (ScreenPoint | null)[];
  /** Main price plot; tools clip to it (rays and extended lines intersect it exactly). */
  readonly plot: Rect;
}

/** Theme tokens every tool paints with, so the light theme stays readable. */
export interface DrawingThemeTokens {
  readonly drawingDefault: string;
  readonly handleFill: string;
  readonly handleStroke: string;
  readonly labelBackground: string;
  readonly labelText: string;
  readonly paneBackground: string;
}

/** Frame state of one drawing. */
export interface DrawingInteractionState {
  readonly selected: boolean;
  readonly hovered: boolean;
  /** True while the anchors are still being placed. */
  readonly draft: boolean;
}

/** Read-only services available while painting and hit-testing. */
export interface DrawingEnv {
  readonly plot: Rect;
  /** Device pixels per CSS pixel, for crisp bitmap-space strokes. */
  readonly dpr: number;
  readonly fontFamily: string;
  readonly theme: DrawingThemeTokens;
  readonly state: DrawingInteractionState;
  /** Symbol-aware price formatter (pricescale, custom_formatters). */
  readonly formatPrice: (price: number) => string;
  /** Localised duration label for a bar count and time span (`42 bars, 42d`). */
  readonly formatDuration: (bars: number, seconds: number) => string;
  /** Resolution of one bar in milliseconds. */
  readonly barMs: number;
  /** Width of one bar slot in CSS pixels. */
  readonly barSpacing: number;
  timeToX(unixSeconds: number): number | null;
  priceToY(price: number): number;
  xToTime(x: number): number;
  yToPrice(y: number): number;
}

/** Paint-time services: DrawingEnv plus the axis-tag sink. */
export interface DrawingPaintEnv extends DrawingEnv {
  /** Queue a price/time axis pill, painted after the axes (never under them). */
  pushAxisTag(tag: Omit<AxisTag, "source">): void;
}

/** Arguments for an anchor-constraint hook (for example Shift snaps to 45 degrees). */
export interface DrawingConstrainInput {
  readonly index: number;
  readonly point: ShapePoint;
  readonly points: readonly ShapePoint[];
  readonly shiftKey: boolean;
}

// ── The tool definition ─────────────────────────────────────────────────────

export interface DrawingToolDefinition<TProps extends object = Record<string, unknown>> {
  /** Unique id: `[a-z][a-z0-9_]*`. Stored in snapshots, so never rename a published id. */
  readonly id: string;
  /** Sidebar/tooltip/objects-tree title (English default; translated through t()). */
  readonly title: string;
  /** Inline SVG markup for an 18px icon; sanitised by the registry. */
  readonly icon: string;
  readonly group?: DrawingToolGroup;
  /** Other names accepted by createShape (TradingView names such as `extended`). */
  readonly aliases?: readonly string[];
  readonly anchors: DrawingAnchorSpec;
  /** Property schema; its defaults seed new drawings and the settings dialog. */
  readonly props: DrawingPropSchema<TProps>;
  /** Whether the tool carries user text (enables inline editing on double-click). */
  readonly text?: boolean;
  /** Paint one drawing. Called inside a save()/restore() pair. */
  paint(ctx: CanvasRenderingContext2D, drawing: DrawingState<TProps>, geometry: DrawingGeometry, env: DrawingPaintEnv): void;
  /** Hit-test against exactly what paint() drew. Return null for a miss. */
  hitTest(point: ScreenPoint, drawing: DrawingState<TProps>, geometry: DrawingGeometry, env: DrawingEnv, tolerancePx: number): DrawingHit | null;
  /** Handle positions; defaults to the mapped anchors. Painted only when hovered or selected. */
  handles?(drawing: DrawingState<TProps>, geometry: DrawingGeometry, env: DrawingEnv): readonly ScreenPoint[];
  /** Adjust a dragged or drafted anchor (angle snapping, horizontal locks). */
  constrain?(input: DrawingConstrainInput): ShapePoint;
  /** Validate and normalise untrusted props from createShape/load (return path errors). */
  validateProps?(props: Record<string, unknown>): readonly { path: string; message: string }[];
  /** Accessible description for the objects tree and live-region announcements. */
  describe?(drawing: DrawingState<TProps>, env: DrawingEnv): string;
}

/** Built-in tool ids, closed so createShape can reject unknown kinds with this list. */
export type BuiltinDrawingToolId =
  | "trend_line"
  | "horizontal_line"
  | "vertical_line"
  | "ray"
  | "extended_line"
  | "measure"
  | "fib_retracement"
  | "rectangle"
  | "text";

/** The anchor count a spec requires before a draft can be committed. */
export function minAnchors(spec: DrawingAnchorSpec): number {
  return typeof spec === "number" ? spec : spec.min;
}

/** Whether a draft with `count` anchors must stop collecting points. */
export function anchorsComplete(spec: DrawingAnchorSpec, count: number): boolean {
  if (typeof spec === "number") return count >= spec;
  return spec.max !== undefined && count >= spec.max;
}
