// Drawings created through the chart API (createShape and friends).

// ── Shapes ──────────────────────────────────────────────────────────────────
export interface ShapePoint {
  /** Unix time in seconds. Millisecond timestamps (above 1e11) are converted with a warning. */
  time: number;
  /** Required by every price-anchored kind (all built-ins except `vertical_line`); a point without one rejects. */
  price?: number;
  /**
   * TradingView's bar-price fallback (`open`/`high`/`low`/`close`) for a point
   * without a price. Not supported: pass `price` instead.
   */
  channel?: string;
}
export type ShapeStyle = string;
export type DrawingEventType = "click" | "move" | "remove" | "hide" | "show" | "create" | "points_changed" | "properties_changed";

/** Drawing kinds the chart paints and hit-tests out of the box. */
export type BuiltinShapeName =
  | "trend_line"
  | "horizontal_line"
  | "vertical_line"
  | "ray"
  | "extended_line"
  | "measure"
  | "fib_retracement"
  | "rectangle"
  | "text";

/**
 * TradingView shape names accepted by createShape and stored as their Raze
 * equivalent: `extended` -> `extended_line`, `date_and_price_range` -> `measure`.
 */
export type ShapeNameAlias = "extended" | "date_and_price_range";

/**
 * Registry of host drawing-tool ids, for typing only. Augment it when a custom
 * tool is registered so createShape accepts its id:
 *
 *   declare module "@razedotbot/charts" {
 *     interface CustomShapeNames { arrow_marker: true }
 *   }
 */
export interface CustomShapeNames {}

/** Canonical drawing kinds: the built-ins plus registered custom tool ids. */
export type ShapeKind = BuiltinShapeName | Extract<keyof CustomShapeNames, string>;

/** Every name createShape accepts: canonical kinds plus TradingView aliases. Anything else rejects. */
export type SupportedShapeName = ShapeKind | ShapeNameAlias;

/** Stable machine-readable codes carried by ShapeError. */
export type ShapeErrorCode =
  /** `shape` is not a supported kind or alias. */
  | "E_SHAPE_KIND"
  /** Points are missing, not finite, or fewer than the kind needs. */
  | "E_SHAPE_POINTS"
  /** Another option (text, zOrder, a property) has the wrong type. */
  | "E_SHAPE_OPTION"
  /** No drawing has the requested id (never created, or removed). */
  | "E_SHAPE_NOT_FOUND";

export interface CreateShapeOptions<TOverrides extends object = Record<string, unknown>> {
  /** Drawing kind; defaults to `horizontal_line`. Unsupported names reject with a ShapeError listing the supported kinds. */
  shape?: SupportedShapeName;
  text?: string;
  lock?: boolean;
  disableSelection?: boolean;
  /** Keep the live drawing out of widget.save() layout snapshots. */
  disableSave?: boolean;
  /** Do not add this drawing's creation to undo history; later edits/removal remain undoable. */
  disableUndo?: boolean;
  showInObjectsTree?: boolean;
  /** Place the new drawing above (default) or below every existing drawing. */
  zOrder?: "top" | "bottom";
  overrides?: TOverrides;
  [key: string]: unknown;
}

/** Drawing properties accepted by setProperties: overrides plus the label text. */
export interface ShapeProperties {
  /** The drawing's label (horizontal_line, text and any kind that shows text). */
  text?: string;
  [key: string]: unknown;
}

/** Which z-order moves would change a drawing's position (mirrors TradingView). */
export interface AvailableZOrderOperations {
  bringForwardEnabled: boolean;
  bringToFrontEnabled: boolean;
  sendBackwardEnabled: boolean;
  sendToBackEnabled: boolean;
}

/**
 * Handle returned by getShapeById. Every method throws a ShapeError
 * (`E_SHAPE_NOT_FOUND`) once the drawing has been removed.
 */
export interface ILineDataSourceApi {
  getPoints(): ShapePoint[];
  setPoints(points: ShapePoint[]): void;
  setPriceLevel?(price: number): void;
  /** Paint above every other drawing. */
  bringToFront(): void;
  /** Swap places with the drawing directly above. */
  bringForward(): void;
  /** Swap places with the drawing directly below. */
  sendBackward(): void;
  /** Paint below every other drawing. */
  sendToBack(): void;
  availableZOrderOperations(): AvailableZOrderOperations;
  /** Overrides plus `text`. */
  getProperties(): ShapeProperties;
  /** Merge overrides; `text` replaces the label. One undo step, one properties_changed event. */
  setProperties(props: ShapeProperties): void;
}
