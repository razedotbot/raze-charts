// The per-chart API returned by widget.activeChart() and widget.chart(index).

import type { EntityId, ISubscription, ResolutionString } from "./common";
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
  setSymbol(symbol: string, callback?: () => void): void;
  symbol(): string;
  executeActionById?(actionId: "undo" | "redo" | "magnet" | string): void;
  createCompare?(symbol: string): Promise<EntityId>;
}
