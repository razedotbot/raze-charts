// IChartWidgetApi implementation. Facade over the shared context, the data
// manager (history/marks) and the shape store. Methods the app calls:
//   resolution, onIntervalChanged, createShape, getShapeById, removeEntity,
//   clearMarks, refreshMarks, resetData, getVisibleRange/setVisibleRange.

import type {
  BracketOrderOptions,
  CreateShapeOptions,
  EntityId,
  IBracketOrderAdapter,
  IChartWidgetApi,
  ILineDataSourceApi,
  ISubscription,
  ITradingLineAdapter,
  ResolutionString,
  ShapePoint,
  TradingLineOptions,
} from "../types/charting_library";
import type { ChartContext } from "./context";
import { Delegate } from "../util/delegate";

/** Subsystems ChartApi delegates to. Wired by the Widget after construction. */
export interface ChartApiDeps {
  /** Re-request marks from the datafeed and repaint. */
  refreshMarks(): void;
  /** Drop cached marks so the next refresh re-paints from scratch. */
  clearMarks(): void;
  /** Drop bar cache and re-request history for the current symbol/resolution. */
  resetData(): void;
  /** Change resolution; resolves bars then fires intervalChanged. */
  setResolution(res: ResolutionString, cb?: () => void): void;
  /** Change symbol; resolves + reloads. */
  setSymbol(symbol: string, cb?: () => void): void;
  /** Shape store. */
  createShape(point: ShapePoint, options: CreateShapeOptions): Promise<EntityId>;
  createMultipointShape(points: ShapePoint[], options: CreateShapeOptions): Promise<EntityId>;
  getShapeById(id: EntityId): ILineDataSourceApi;
  removeEntity(id: EntityId): void;
  removeAllShapes(): void;
  createTradingLine(options: TradingLineOptions, kind: "order" | "position"): ITradingLineAdapter;
  createBracketOrder(options: BracketOrderOptions): IBracketOrderAdapter;
  getTradingLineById(id: string): ITradingLineAdapter | null;
  removeAllTradingLines(): void;
  createStudy(
    name: string,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: Record<string, unknown>,
  ): Promise<EntityId>;
  setVisibleRange(range: { from: number; to: number }): Promise<void>;
  createCompare(symbol: string): Promise<EntityId>;
  executeActionById(actionId: string): void;
}

export class ChartApi implements IChartWidgetApi {
  private intervalSub: ISubscription<(i: ResolutionString, tf: unknown) => void>;

  constructor(
    private readonly context: ChartContext,
    private readonly deps: ChartApiDeps,
  ) {
    // onIntervalChanged returns a live view over the context's delegate.
    const d = context.intervalChanged as unknown as Delegate<[ResolutionString, unknown]>;
    this.intervalSub = {
      subscribe: (obj, fn, once) => d.subscribe(obj, fn as never, once),
      unsubscribe: (obj, fn) => d.unsubscribe(obj, fn as never),
      unsubscribeAll: (obj) => d.unsubscribeAll(obj),
    };
  }

  resolution(): ResolutionString {
    return this.context.resolution;
  }

  setResolution(resolution: ResolutionString, callback?: () => void): void {
    this.deps.setResolution(resolution, callback);
  }

  onIntervalChanged(): ISubscription<(interval: ResolutionString, timeframeObj: unknown) => void> {
    return this.intervalSub;
  }

  symbol(): string {
    return this.context.symbol;
  }

  setSymbol(symbol: string, callback?: () => void): void {
    this.deps.setSymbol(symbol, callback);
  }

  getVisibleRange(): { from: number; to: number } {
    const bars = this.context.bars;
    const { from, to } = this.context.visibleRange;
    const idx = (i: number): number => {
      const clamped = Math.max(0, Math.min(bars.length - 1, Math.round(i)));
      const bar = bars[clamped];
      return bar ? Math.floor(bar.time / 1000) : 0;
    };
    return { from: idx(from), to: idx(to) };
  }

  setVisibleRange(range: { from: number; to: number }): Promise<void> {
    return this.deps.setVisibleRange(range);
  }

  createCompare(symbol: string): Promise<EntityId> {
    return this.deps.createCompare(symbol);
  }

  executeActionById(actionId: string): void {
    this.deps.executeActionById(actionId);
  }

  createShape<TOverrides extends object>(
    point: ShapePoint,
    options: CreateShapeOptions<TOverrides>,
  ): Promise<EntityId> {
    return this.deps.createShape(point, options as CreateShapeOptions);
  }

  createMultipointShape<TOverrides extends object>(
    points: ShapePoint[],
    options: CreateShapeOptions<TOverrides>,
  ): Promise<EntityId> {
    return this.deps.createMultipointShape(points, options as CreateShapeOptions);
  }

  getShapeById(entityId: EntityId): ILineDataSourceApi {
    return this.deps.getShapeById(entityId);
  }

  removeEntity(entityId: EntityId): void {
    this.deps.removeEntity(entityId);
  }

  removeAllShapes(): void {
    this.deps.removeAllShapes();
  }

  createOrderLine(options: TradingLineOptions = {}): Promise<ITradingLineAdapter> {
    return Promise.resolve().then(() => this.deps.createTradingLine(options, "order"));
  }

  createPositionLine(options: TradingLineOptions = {}): Promise<ITradingLineAdapter> {
    return Promise.resolve().then(() => this.deps.createTradingLine(options, "position"));
  }

  createBracketOrder(options: BracketOrderOptions): Promise<IBracketOrderAdapter> {
    return Promise.resolve().then(() => this.deps.createBracketOrder(options));
  }

  getTradingLineById(id: string): ITradingLineAdapter | null {
    return this.deps.getTradingLineById(id);
  }

  removeAllTradingLines(): void {
    this.deps.removeAllTradingLines();
  }

  createStudy(
    name: string,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: Record<string, unknown>,
  ): Promise<EntityId> {
    return this.deps.createStudy(name, forceOverlay, lock, inputs);
  }

  refreshMarks(): void {
    this.deps.refreshMarks();
  }

  clearMarks(): void {
    this.deps.clearMarks();
  }

  resetData(): void {
    this.deps.resetData();
  }
}
