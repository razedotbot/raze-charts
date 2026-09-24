// IChartWidgetApi implementation: a facade over the shared context and the
// subsystems in ChartApiDeps. The methods live in ./api/* modules (listed in
// ./api/index.ts) and are composed onto the prototype; per-instance state is
// held privately by ./api/scope.ts, so an instance exposes nothing else.

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
import { API_MODULES, type ApiMethods } from "./api/index";
import { bindApiScope, installApiModules } from "./api/scope";

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

// Declaration merging gives the class the methods installed below. The
// methods are listed explicitly (rather than `extends ApiMethods`) so the
// published declaration keeps the documented surface: no `this: ChartApi`
// parameters and no module mechanics. `checkedModules` below fails to compile
// when an API module adds, drops or changes a method without updating this list.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ChartApi {
  resolution(): ResolutionString;
  setResolution(resolution: ResolutionString, callback?: () => void): void;
  onIntervalChanged(): ISubscription<(interval: ResolutionString, timeframeObj: unknown) => void>;
  symbol(): string;
  setSymbol(symbol: string, callback?: () => void): void;
  getVisibleRange(): { from: number; to: number };
  setVisibleRange(range: { from: number; to: number }): Promise<void>;
  createCompare(symbol: string): Promise<EntityId>;
  executeActionById(actionId: string): void;
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
  createOrderLine(options?: TradingLineOptions): Promise<ITradingLineAdapter>;
  createPositionLine(options?: TradingLineOptions): Promise<ITradingLineAdapter>;
  createBracketOrder(options: BracketOrderOptions): Promise<IBracketOrderAdapter>;
  getTradingLineById(id: string): ITradingLineAdapter | null;
  removeAllTradingLines(): void;
  createStudy(
    name: string,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: Record<string, unknown>,
  ): Promise<EntityId>;
  refreshMarks(): void;
  clearMarks(): void;
  resetData(): void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ChartApi implements IChartWidgetApi {
  constructor(context: ChartContext, deps: ChartApiDeps) {
    bindApiScope(this, { context, deps });
  }
}

type UnboundMethods<T> = { [K in keyof T]: OmitThisParameter<T[K]> };
type MatchesDeclaration<M> =
  [keyof M] extends [keyof ChartApi]
    ? [keyof ChartApi] extends [keyof M]
      ? M extends ChartApi ? (ChartApi extends M ? unknown : never) : never
      : never
    : never;

// `never` (a compile error below) unless API_MODULES provides exactly the
// methods declared on the ChartApi interface, with the same signatures.
const checkedModules: readonly object[] & MatchesDeclaration<UnboundMethods<ApiMethods>> = API_MODULES;

installApiModules(ChartApi.prototype, checkedModules);
