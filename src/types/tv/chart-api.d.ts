// The per-chart API returned by widget.activeChart() and widget.chart(index).

import type { EntityId, ISubscription, ResolutionString } from "./common";
import type { CreateShapeOptions, ILineDataSourceApi, ShapePoint } from "./shapes";
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
 * - `hideAllDrawingTools`: hide every visible drawing; run again to show them.
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
 * `{ "plot.color": "#ff0000" }`. The primary plot's colour is supported;
 * other keys warn once.
 */
export type CreateStudyOverrides = Readonly<Record<string, string | number | boolean>>;

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
   * entity id removable via removeEntity. Rejects with an Error for an
   * unknown study and a TypeError for inputs, overrides or options of the
   * wrong shape.
   */
  createStudy(
    name: string,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: CreateStudyInputs,
    overrides?: CreateStudyOverrides,
    options?: CreateStudyOptions,
  ): Promise<EntityId>;
  refreshMarks(): void;
  clearMarks(): void;
  resetData(): void;
  setSymbol(symbol: string, callback?: () => void): void;
  symbol(): string;
  /** Run a chart action. Throws a TypeError listing the supported ids for any other id. */
  executeActionById(actionId: ChartActionId): void;
  /** Current state of a toggle action. Throws a TypeError for any other id. */
  getCheckableActionState(actionId: CheckableChartActionId): boolean;
  /** Overlay another symbol on this chart. */
  createCompare(symbol: string): Promise<EntityId>;
}
