// IChartWidgetApi implementation. Facade over the shared context, the data
// manager (history/marks) and the shape store. Methods the app calls:
//   resolution, onIntervalChanged, createShape, getShapeById, removeEntity,
//   clearMarks, refreshMarks, resetData, getVisibleRange/setVisibleRange.

import type {
  CreateShapeOptions,
  EntityId,
  IChartWidgetApi,
  ILineDataSourceApi,
  ISubscription,
  ResolutionString,
  ShapePoint,
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
  createStudy(
    name: string,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: Record<string, unknown>,
  ): Promise<EntityId>;
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
    // Translate a time range (unix seconds) into bar-index space.
    const bars = this.context.bars;
    if (bars.length) {
      const fromMs = range.from * 1000;
      const toMs = range.to * 1000;
      let fi = 0;
      let ti = bars.length - 1;
      for (let i = 0; i < bars.length; i++) {
        if (bars[i]!.time <= fromMs) fi = i;
        if (bars[i]!.time <= toMs) ti = i;
      }
      this.context.visibleRange = { from: fi, to: Math.max(fi + 1, ti) };
      this.context.autoScalePrice = true;
      this.context.requestPaint();
    }
    return Promise.resolve();
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
