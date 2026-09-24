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

// Declaration merging gives the class the methods installed below.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ChartApi extends ApiMethods {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ChartApi implements IChartWidgetApi {
  constructor(context: ChartContext, deps: ChartApiDeps) {
    bindApiScope(this, { context, deps });
  }
}

installApiModules(ChartApi.prototype, API_MODULES);
