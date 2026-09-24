// Contracts between the widget runtime (./runtime.ts) and its controllers.
//
// The runtime builds the shared context, runs every controller registered in
// ./controllers.ts through the lifecycle below, and owns the kernel services
// (data manager, stores, engine, renderer). The public `Widget` class is a
// thin facade over one runtime and exposes none of it.

import type {
  ChartingLibraryWidgetOptions,
  IChartingLibraryWidget,
} from "../../types/charting_library";
import type { DataManager } from "../../data/DataManager";
import type { ChartEngine } from "../../engine/ChartEngine";
import type { ChartRenderer } from "../../engine/ChartRenderer";
import type { StudyStore } from "../../studies/StudyStore";
import type { CommandStack } from "../CommandStack";
import type { ChartContext } from "../context";
import type { ShapeStore } from "../ShapeStore";
import type { TradingStore } from "../TradingStore";
import type { LifecycleController } from "./LifecycleController";

/**
 * Lifecycle hooks a controller may implement. Construction (`create` in the
 * definition) happens before the kernel exists, so a controller may build DOM
 * the engine measures; everything that needs the kernel belongs in `attach`.
 */
export interface WidgetController {
  /** Kernel services exist. Runs in registration order. */
  attach?(): void;
  /** The first data load settled; header slots may be populated. Runs in
   * registration order, before chart readiness fires. */
  boot?(): void;
  /** Teardown. Runs in reverse registration order, after the kernel stops. */
  destroy?(): void;
}

/**
 * Controllers by id. Each controller module adds its own entry through
 * declaration merging:
 *
 * ```ts
 * declare module "./host" {
 *   interface WidgetControllerMap { theme: ThemeController }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface WidgetControllerMap {}

export type WidgetControllerId = keyof WidgetControllerMap;

export interface WidgetControllerDefinition<K extends WidgetControllerId = WidgetControllerId> {
  readonly id: K;
  /**
   * Construct the controller. Only `options`, `context`, `container`,
   * `commands`, `lifecycle` and controllers registered earlier are available.
   */
  create(host: WidgetHost): WidgetControllerMap[K];
}

export function defineWidgetController<K extends WidgetControllerId>(
  id: K,
  create: (host: WidgetHost) => WidgetControllerMap[K],
): WidgetControllerDefinition<K> {
  return { id, create };
}

/** A layout child widget together with its runtime (for viewport/crosshair sync). */
export interface ChildWidget {
  readonly widget: IChartingLibraryWidget;
  readonly host: WidgetHost;
}

/** Everything a controller may reach. Kernel members are available from `attach`. */
export interface WidgetHost {
  readonly options: ChartingLibraryWidgetOptions;
  readonly container: HTMLElement;
  readonly context: ChartContext;
  readonly commands: CommandStack;
  readonly lifecycle: LifecycleController;
  readonly controllers: WidgetControllerMap;
  readonly data: DataManager;
  readonly shapes: ShapeStore;
  readonly trading: TradingStore;
  readonly studies: StudyStore;
  readonly engine: ChartEngine;
  readonly renderer: ChartRenderer;
  /** Construct a nested widget (multi-chart layouts) and return its runtime. */
  spawnChild(options: ChartingLibraryWidgetOptions): ChildWidget;
}
