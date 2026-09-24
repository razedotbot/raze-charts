// The per-chart API returned by widget.activeChart() and widget.chart(index).

import type { EntityId, ISubscription, ResolutionString, Timezone } from "./common";
import type { CreateShapeOptions, ILineDataSourceApi, ShapePoint } from "./shapes";
import type { StudyCreateInputs } from "./studies";
import type {
  BracketOrderOptions,
  IBracketOrderAdapter,
  ITradingLineAdapter,
  TradingLineOptions,
} from "./trading";

// ── Actions ─────────────────────────────────────────────────────────────────
/**
 * Actions `executeActionById` performs: the TradingView `ChartActionId` names
 * whose behaviour exists, plus Raze aliases. Any other id throws.
 *
 * - `undo` / `redo`: command history.
 * - `chartReset`: default time-scale view and price auto-scale.
 * - `timeScaleReset`: default time-scale view; the price scale is unchanged.
 * - `insertIndicator`: open the Indicators panel.
 * - `symbolSearch`: focus the header symbol search.
 * - `paneObjectTree` (alias `objects_tree`): toggle the objects tree.
 * - `stayInDrawingModeAction` (alias `stay_in_drawing_mode`), `magnet`: toggles.
 * - `hideAllDrawingTools`: view toggle that hides every drawing, including
 *   ones created while it is on. Each drawing's own `hidden` flag, `save()`
 *   and undo history are untouched; run it again to show them.
 * - `paneRemoveAllStudiesDrawingTools`: remove every study and drawing (undo
 *   restores the drawings, then the studies).
 * - `volume_pane`: cycle the volume between overlay, pane and hidden.
 */
export type ChartActionId =
  | "undo"
  | "redo"
  | "chartReset"
  | "timeScaleReset"
  | "insertIndicator"
  | "symbolSearch"
  | "paneObjectTree"
  | "objects_tree"
  | "stayInDrawingModeAction"
  | "stay_in_drawing_mode"
  | "magnet"
  | "hideAllDrawingTools"
  | "paneRemoveAllStudiesDrawingTools"
  | "volume_pane";

/** Toggle actions whose state `getCheckableActionState` reports. */
export type CheckableChartActionId =
  | "stayInDrawingModeAction"
  | "stay_in_drawing_mode"
  | "magnet"
  | "hideAllDrawingTools";

// ── Studies ─────────────────────────────────────────────────────────────────
/** One `createStudy` input value. */
export type CreateStudyInputValue = number | string | boolean;

/**
 * `createStudy` inputs: an object keyed by input id (`length`, a custom
 * study's own ids, or TradingView's legacy `in_0`, `in_1`, ... positions), or
 * the legacy positional array mapped onto the study's declared inputs in order.
 */
export type CreateStudyInputs =
  | Readonly<Record<string, CreateStudyInputValue | undefined>>
  | readonly CreateStudyInputValue[];

/**
 * TradingView style overrides keyed `<plot>.<property>`, for example
 * `{ "plot.color": "#ff0000", "plot.linewidth": 2, "signal.visible": false }`.
 * `<plot>` is `plot` (or the study name) for the primary plot, `plot_<n>` by
 * position, or a plot name such as MACD's `signal`. `color`, `linewidth` and
 * `visible` are applied; other properties and unknown plots warn once.
 */
export type CreateStudyOverrides = Readonly<Record<string, string | number | boolean>>;

/** Style of one study plot, set through createStudy overrides or `studies_overrides`. */
export interface StudyPlotStyleOverride {
  color?: string;
  /** Line width in CSS pixels. */
  lineWidth?: number;
  /** `false` hides the plot; it still computes. */
  visible?: boolean;
}

/**
 * Per-plot styles of one study, keyed by plot reference: the plot index
 * (`"0"` is the primary plot) or the lower-case plot name (`"signal"`; a last
 * word such as `"upper"` also matches `BB upper`). `save()` keeps them.
 */
export type StudyPlotStyles = Readonly<Record<string, Readonly<StudyPlotStyleOverride>>>;

/** TradingView `createStudy` options. Unsupported options warn once. */
export interface CreateStudyOptions {
  /** Keep the creation out of undo history; later removal stays undoable. */
  disableUndo?: boolean;
  /** Accepted for compatibility; Raze Charts has no study count limit. */
  checkLimit?: boolean;
  /** `as-series` puts the study on the main price scale (like `forceOverlay`). Other values warn. */
  priceScale?: string;
  allowChangeCurrency?: boolean;
  allowChangeUnit?: boolean;
}

// ── Chart API ───────────────────────────────────────────────────────────────
export interface IChartWidgetApi {
  resolution(): ResolutionString;
  setResolution(resolution: ResolutionString, callback?: () => void): void;
  /** Host view of interval changes; `unsubscribeAll(null)` removes only host listeners. */
  onIntervalChanged(): ISubscription<(interval: ResolutionString, timeframeObj: unknown) => void>;
  setVisibleRange(range: { from: number; to: number }): Promise<void>;
  getVisibleRange(): { from: number; to: number };
  createShape<TOverrides extends object>(
    point: ShapePoint,
    options: CreateShapeOptions<TOverrides>,
  ): Promise<EntityId>;
  createMultipointShape<TOverrides extends object>(
    points: ShapePoint[],
    options: CreateShapeOptions<TOverrides>,
  ): Promise<EntityId>;
  getShapeById(entityId: EntityId): ILineDataSourceApi;
  removeEntity(entityId: EntityId): void;
  removeAllShapes(): void;
  /** TradingView-style editable order line. */
  createOrderLine(options?: TradingLineOptions): Promise<ITradingLineAdapter>;
  /** TradingView-style editable open-position line. */
  createPositionLine(options?: TradingLineOptions): Promise<ITradingLineAdapter>;
  /** Linked entry + optional stop-loss/take-profit lines with risk/reward visualization. */
  createBracketOrder(options: BracketOrderOptions): Promise<IBracketOrderAdapter>;
  getTradingLineById(id: string): ITradingLineAdapter | null;
  removeAllTradingLines(): void;
  /**
   * Add a study: built-in or registered via `raze.custom_studies`. Returns an
   * entity id removable via removeEntity. Inputs are typed for names
   * registered in `StudyInputsRegistry`. Rejects with an Error for an unknown
   * study, a `StudyInputError` (a TypeError) for invalid inputs, and a
   * TypeError for overrides or options of the wrong shape.
   */
  createStudy<N extends string>(
    name: N,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: StudyCreateInputs<N> | readonly CreateStudyInputValue[],
    overrides?: CreateStudyOverrides,
    options?: CreateStudyOptions,
  ): Promise<EntityId>;
  refreshMarks(): void;
  clearMarks(): void;
  resetData(): void;
  /**
   * Raze extension: fit every loaded bar in view and re-enable price autoscale
   * (the F key, double-click and the sidebar Fit button). Fires one
   * visible-range change when the range moves. Optional, so code that
   * implements or mocks this interface keeps compiling; the Raze chart
   * always provides it.
   */
  fitContent?(): void;
  /**
   * Raze extension: reset to the default view, 6 px per bar anchored to the
   * latest bar, with price autoscale (TradingView's "Reset chart view").
   * Optional for the same reason as `fitContent`; always provided.
   */
  resetView?(): void;
  setSymbol(symbol: string, callback?: () => void): void;
  symbol(): string;
  /** Run a chart action. Throws a TypeError listing the supported ids for any other id. */
  executeActionById(actionId: ChartActionId): void;
  /** Current state of a toggle action. Throws a TypeError for any other id. */
  getCheckableActionState(actionId: CheckableChartActionId): boolean;
  /** Overlay another symbol on this chart. */
  createCompare(symbol: string): Promise<EntityId>;
  /** Display timezone setting: an IANA id, `"exchange"` (the symbol's zone) or a `custom_timezones` id. */
  timezone(): string;
  /**
   * Show the time axis, crosshair and session breaks in another zone and
   * repaint. Throws a RangeError with guidance for an unknown zone.
   */
  setTimezone(timezone: Timezone | "exchange"): void;
  /** Fires `(timezone, previous)` after setTimezone() changes the setting. */
  onTimezoneChanged(): ISubscription<(timezone: string) => void>;
  /** TradingView's timezone API for this chart. */
  getTimezoneApi(): ITimezoneApi;
}

// ── Timezone API ────────────────────────────────────────────────────────────
/** A display timezone choice. */
export interface TimezoneInfo {
  /** IANA id, `"exchange"`, or a `custom_timezones` id. */
  id: string;
  /** Human-readable name: the zone's city ("New York"), "UTC", "Exchange" or a `custom_timezones` title. */
  title: string;
  /** Current UTC offset in minutes (east positive), when known. */
  offset?: number;
}

export interface ITimezoneApi {
  /** Every zone setTimezone() accepts: "exchange", UTC, custom_timezones ids and the IANA zones Intl knows. */
  availableTimezones(): TimezoneInfo[];
  /** The current setting, with its title and current offset. */
  getTimezone(): TimezoneInfo;
  setTimezone(timezone: Timezone | "exchange"): void;
  onTimezoneChanged(): ISubscription<(timezone: string) => void>;
}
