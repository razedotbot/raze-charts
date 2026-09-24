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

// ── Chart API ───────────────────────────────────────────────────────────────
export interface IChartWidgetApi {
  resolution(): ResolutionString;
  setResolution(resolution: ResolutionString, callback?: () => void): void;
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
  /** Add a study — built-in (EMA / SMA / RSI) or registered via `raze.custom_studies`. Returns an entity id removable via removeEntity. Inputs are typed for names registered in `StudyInputsRegistry`; invalid inputs reject with a `StudyInputError`. */
  createStudy<N extends string>(
    name: N,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: StudyCreateInputs<N>,
  ): Promise<EntityId>;
  refreshMarks(): void;
  clearMarks(): void;
  resetData(): void;
  /**
   * Raze extension: fit every loaded bar in view and re-enable price autoscale
   * (the F key, double-click and the sidebar Fit button). Fires one
   * visible-range change when the range moves. Optional, like
   * `executeActionById`, so code that implements or mocks this interface
   * keeps compiling; the Raze chart always provides it.
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
  executeActionById?(actionId: "undo" | "redo" | "magnet" | string): void;
  createCompare?(symbol: string): Promise<EntityId>;
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
