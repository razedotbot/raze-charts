// Composition root behind the public `Widget` facade. Builds the shared
// context, drives every registered controller through create -> attach ->
// boot -> destroy, and owns the kernel services between those phases.

import type { ChartingLibraryWidgetOptions } from "../../types/charting_library";
import { DataManager } from "../../data/DataManager";
import { ChartEngine } from "../../engine/ChartEngine";
import { ChartRenderer } from "../../engine/ChartRenderer";
import { StudyRegistry } from "../../studies/registry";
import { StudyStore } from "../../studies/StudyStore";
import { createPriceFormatter } from "../../util/format";
import { Delegate } from "../../util/delegate";
import { CommandStack } from "../CommandStack";
import { buildFeatureSet, createChartContext, type ChartContext } from "../context";
import { ShapeStore } from "../ShapeStore";
import { buildTheme } from "../theme";
import { TradingStore } from "../TradingStore";
import { WIDGET_CONTROLLERS } from "./controllers";
import type { ChildWidget, WidgetController, WidgetControllerMap, WidgetHost } from "./host";
import { LifecycleController } from "./LifecycleController";

const DEFAULT_FONT = "'Trebuchet MS', Roboto, Ubuntu, sans-serif";

export function createWidgetContext(options: ChartingLibraryWidgetOptions): ChartContext {
  const raze = options.raze;
  return createChartContext({
    options,
    datafeed: options.datafeed,
    locale: options.locale ?? "en",
    fontFamily: options.custom_font_family || DEFAULT_FONT,
    symbol: options.symbol,
    resolution: options.interval,
    symbolInfo: null,
    formatPrice: createPriceFormatter(options, null),
    theme: buildTheme(options),
    features: buildFeatureSet(options),
    bars: [],
    marks: [],
    timescaleMarks: [],
    visibleRange: { from: 0, to: 1 },
    autoScalePrice: true,
    priceRange: null,
    chartStyle: "candles",
    logScale: false,
    percentScale: false,
    volumeMode: raze?.volume_mode ?? "overlay",
    magnet: raze?.magnet ?? false,
    stayInDrawingMode: false,
    compare: [],
    syncedCrosshair: null,
    drawingTool: "cursor",
    selectedShapeId: null,
    selectedTradingLineId: null,
    intervalChanged: new Delegate(),
    dataChanged: new Delegate(),
    drawingEvent: new Delegate(),
    tradingEvent: new Delegate(),
    viewportChanged: new Delegate(),
    crosshairMoved: new Delegate(),
    requestPaint: () => {},
  });
}

export class WidgetRuntime implements WidgetHost {
  readonly container: HTMLElement;
  readonly context: ChartContext;
  readonly commands = new CommandStack();
  readonly lifecycle: LifecycleController;
  readonly controllers = {} as WidgetControllerMap;
  readonly data: DataManager;
  readonly shapes: ShapeStore;
  readonly trading: TradingStore;
  readonly studies: StudyStore;
  readonly engine: ChartEngine;
  readonly renderer: ChartRenderer;
  private readonly installed: WidgetController[] = [];

  constructor(
    readonly options: ChartingLibraryWidgetOptions,
    readonly spawnChild: (options: ChartingLibraryWidgetOptions) => ChildWidget,
  ) {
    const container = typeof options.container === "string"
      ? document.getElementById(options.container)
      : options.container;
    if (!container) throw new Error("[raze-charts] widget container not found");
    this.container = container;
    this.context = createWidgetContext(options);
    this.lifecycle = new LifecycleController(this);

    const controllers = this.controllers as unknown as Record<string, WidgetController>;
    for (const { id, create } of WIDGET_CONTROLLERS) {
      if (id in controllers) throw new Error(`[raze-charts] widget controller "${id}" is registered twice`);
      // Hook-free controllers (weak types) are valid WidgetControllers too.
      const controller = create(this) as WidgetController;
      controllers[id] = controller;
      this.installed.push(controller);
    }

    const context = this.context;
    this.data = new DataManager(context);
    this.shapes = new ShapeStore(context, this.commands);
    this.trading = new TradingStore(context);
    const registry = new StudyRegistry();
    for (const def of options.raze?.custom_studies ?? []) registry.register(def);
    this.studies = new StudyStore(context, registry, this.commands);
    this.engine = new ChartEngine(this.controllers.layout.primary, context);
    this.controllers.chrome.syncAccessibility();
    this.renderer = new ChartRenderer(context, this.engine, this.shapes, this.trading, this.data, this.studies);

    for (const controller of this.installed) controller.attach?.();
    this.renderer.attach();
    void this.boot();
  }

  private async boot(): Promise<void> {
    const lifecycle = this.lifecycle;
    let loadFailed = false;
    try {
      await this.data.resolveAndLoad();
    } catch (error) {
      loadFailed = true;
      if (!lifecycle.destroyed) lifecycle.reportError("load symbol", error);
    }
    if (lifecycle.destroyed) return;
    for (const controller of this.installed) controller.boot?.();
    const chrome = this.controllers.chrome;
    if (loadFailed) chrome.showLoadingError();
    else if (!this.context.bars.length) chrome.showEmptyState();
    else chrome.finishLoading();
    lifecycle.markReady();
  }

  remove(): void {
    const lifecycle = this.lifecycle;
    if (lifecycle.destroyed) return;
    lifecycle.destroyed = true;
    lifecycle.dataChangeId += 1;
    // Cancel datafeed callbacks before tearing down the render/event surfaces.
    this.data.destroy();
    lifecycle.settleHeader();
    this.renderer.destroy();
    this.engine.destroy();
    this.studies.destroy();
    for (let i = this.installed.length - 1; i >= 0; i--) this.installed[i]!.destroy?.();
    lifecycle.destroy();
  }
}
