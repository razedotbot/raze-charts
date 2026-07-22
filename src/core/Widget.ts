// The widget — the top-level object the app constructs via `new widget(opts)`.
// Owns the DOM tree, the shared context, and the subsystems (data manager,
// engine, toolbar, shape store, left sidebar). Implements the
// IChartingLibraryWidget surface the app uses.

import type {
  ChartingLibraryWidgetOptions,
  ContextMenuCallback,
  CreateButtonOptions,
  IChartingLibraryWidget,
  IChartWidgetApi,
  ResolutionString,
} from "../types/charting_library";
import { buildFeatureSet, type ChartContext, type IndexRange } from "./context";
import { buildTheme } from "./theme";
import { Delegate } from "../util/delegate";
import { DataManager } from "../data/DataManager";
import { ShapeStore } from "./ShapeStore";
import { ChartApi, type ChartApiDeps } from "./ChartApi";
import { ChartEngine } from "../engine/ChartEngine";
import { ChartRenderer } from "../engine/ChartRenderer";
import { Toolbar } from "../ui/Toolbar";
import { IntervalSelector } from "../ui/IntervalSelector";
import { LoadingScreen } from "../ui/LoadingScreen";
import { IndicatorsMenu, resolveIndicatorPresets } from "../ui/IndicatorsMenu";
import { DEFAULT_SIDEBAR_ITEMS, LeftSidebar, type ChartStyleId } from "../ui/LeftSidebar";
import { ScaleBar } from "../ui/ScaleBar";
import { StudyStore } from "../studies/StudyStore";
import { StudyRegistry } from "../studies/registry";
import { showContextMenu, closeContextMenu } from "../ui/ContextMenu";
import { ensureBaseStyles } from "../ui/popup";

const DEFAULT_FONT = "'Trebuchet MS', Roboto, Ubuntu, sans-serif";

export class Widget implements IChartingLibraryWidget {
  private root: HTMLDivElement;
  private bodyRow: HTMLDivElement;
  private chartArea: HTMLDivElement;
  private context: ChartContext;
  private data: DataManager;
  private shapes: ShapeStore;
  private engine: ChartEngine;
  private renderer: ChartRenderer;
  private toolbar: Toolbar | null = null;
  private leftSidebar: LeftSidebar | null = null;
  private scaleBar: ScaleBar | null = null;
  private intervalSelector: IntervalSelector | null = null;
  private indicatorsMenu: IndicatorsMenu | null = null;
  private loading: LoadingScreen | null;
  private api: ChartApi;
  private studies: StudyStore;

  private chartReady: Delegate<[]> = new Delegate();
  private isChartReady = false;
  private headerReadyResolve!: () => void;
  private headerReadyPromise: Promise<void>;
  private subscriptions = new Map<string, Set<(...a: never[]) => void>>();
  private contextMenuCb: ContextMenuCallback | null = null;
  private destroyed = false;
  private compactRO: ResizeObserver | null = null;

  constructor(options: ChartingLibraryWidgetOptions) {
    const containerEl =
      typeof options.container === "string"
        ? document.getElementById(options.container)
        : options.container;
    if (!containerEl) throw new Error("[raze-charts] widget container not found");

    const fontFamily = options.custom_font_family || DEFAULT_FONT;
    const theme = buildTheme(options);
    const features = buildFeatureSet(options);
    const raze = options.raze;
    const showHeader = features.has("header_widget");
    const showLeftToolbar = features.has("left_toolbar");

    const initialRange: IndexRange = { from: 0, to: 1 };
    this.context = {
      options,
      datafeed: options.datafeed,
      locale: options.locale ?? "en",
      fontFamily,
      symbol: options.symbol,
      resolution: options.interval,
      symbolInfo: null,
      theme,
      features,
      bars: [],
      marks: [],
      visibleRange: initialRange,
      autoScalePrice: true,
      priceRange: null,
      chartStyle: "candles",
      logScale: false,
      percentScale: false,
      drawingTool: "cursor",
      selectedShapeId: null,
      intervalChanged: new Delegate(),
      dataChanged: new Delegate(),
      drawingEvent: new Delegate(),
      requestPaint: () => {},
    };

    ensureBaseStyles();
    this.root = document.createElement("div");
    this.root.className = "raze-chart-root";
    this.root.style.cssText = [
      "position:relative",
      "width:100%",
      "height:100%",
      "display:flex",
      "flex-direction:column",
      "overflow:hidden",
      `background:${theme.paneBackground}`,
      `font-family:${fontFamily}`,
      "--tv-color-pane-background:" + theme.paneBackground,
      "--tv-color-platform-background:" + theme.paneBackground,
    ].join(";");
    containerEl.appendChild(this.root);

    if (showHeader) {
      this.toolbar = new Toolbar(this.context);
      this.root.appendChild(this.toolbar.el);
    }

    this.bodyRow = document.createElement("div");
    this.bodyRow.style.cssText = "display:flex;flex:1 1 auto;min-height:0;overflow:hidden;position:relative;";
    this.root.appendChild(this.bodyRow);

    if (showLeftToolbar) {
      this.leftSidebar = new LeftSidebar(
        this.context,
        {
          onTool: (tool) => {
            this.context.drawingTool = tool;
            this.renderer.cancelDraft();
            this.leftSidebar?.setTool(tool);
            this.context.requestPaint();
          },
          onIndicatorsClick: (anchor) => {
            this.indicatorsMenu?.toggle(anchor);
          },
          onFit: () => this.renderer.fitContent(),
          onScreenshot: () => this.renderer.takeScreenshot(),
          onFullscreen: () => this.toggleFullscreen(),
          onChartType: (style: ChartStyleId) => {
            this.context.chartStyle = style;
            this.leftSidebar?.setChartStyle(style);
            this.context.autoScalePrice = true;
            this.context.priceRange = null;
            this.context.requestPaint();
          },
        },
        raze?.sidebar ?? DEFAULT_SIDEBAR_ITEMS,
        raze?.chart_types,
      );
      this.bodyRow.appendChild(this.leftSidebar.el);
    }

    this.chartArea = document.createElement("div");
    this.chartArea.style.cssText = "position:relative;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden;";
    this.bodyRow.appendChild(this.chartArea);

    this.data = new DataManager(this.context);
    this.shapes = new ShapeStore(this.context);
    const registry = new StudyRegistry();
    for (const def of raze?.custom_studies ?? []) registry.register(def);
    this.studies = new StudyStore(this.context, registry);
    this.engine = new ChartEngine(this.chartArea, this.context);
    this.renderer = new ChartRenderer(this.context, this.engine, this.shapes, this.data, this.studies);
    this.renderer.setToolDoneHandler((tool) => {
      this.context.drawingTool = tool;
      this.leftSidebar?.setTool(tool);
    });

    if (features.has("scale_bar")) {
      this.scaleBar = new ScaleBar(this.context, () => {
        this.scaleBar?.sync();
        this.context.requestPaint();
      });
      this.chartArea.appendChild(this.scaleBar.el);
    }

    this.loading = new LoadingScreen(options.loading_screen, theme.paneBackground);
    this.chartArea.appendChild(this.loading.el);

    this.indicatorsMenu = new IndicatorsMenu(
      this.context,
      this.studies,
      resolveIndicatorPresets(raze, registry),
    );

    const deps: ChartApiDeps = {
      refreshMarks: () => this.data.refreshMarks(),
      clearMarks: () => this.data.clearMarks(),
      resetData: () => this.data.resetData(),
      setResolution: (res, cb) => {
        void this.data.changeResolution(res).then(() => cb?.());
      },
      setSymbol: (sym, cb) => {
        void this.data.changeSymbol(sym).then(() => {
          this.intervalSelector?.refresh();
          cb?.();
        });
      },
      createShape: (point, opts) => this.shapes.create(point, opts),
      createMultipointShape: (points, opts) => this.shapes.createPoints(points, opts),
      getShapeById: (id) => this.shapes.adapter(id),
      removeEntity: (id) => {
        if (this.studies.remove(id)) return;
        this.shapes.remove(id);
      },
      removeAllShapes: () => this.shapes.removeAll(),
      createStudy: (name, _force, _lock, inputs) => {
        const lengthRaw = inputs?.length ?? inputs?.Length ?? inputs?.periods;
        const length = typeof lengthRaw === "number" && Number.isFinite(lengthRaw) ? lengthRaw : 0;
        const color = typeof inputs?.color === "string" ? inputs.color : "";
        const id = this.studies.add({ name, length, color });
        if (!id) return Promise.reject(new Error(`[raze-charts] unknown study: ${name}`));
        return Promise.resolve(id);
      },
    };
    this.api = new ChartApi(this.context, deps);

    this.context.drawingEvent.subscribe(null, ((id: string, type: string) => {
      this.emit("drawing_event", id, type);
    }) as never);

    this.headerReadyPromise = new Promise<void>((resolve) => {
      this.headerReadyResolve = resolve;
    });

    this.renderer.attach();
    this.wireContextMenu();

    // Compact mode: below the breakpoint the left sidebar auto-hides so the
    // plot keeps the width (TV mobile behaviour). 0 disables.
    const compactBp = raze?.compact_breakpoint ?? 520;
    if (this.leftSidebar && compactBp > 0 && typeof ResizeObserver !== "undefined") {
      const sync = (): void => {
        const w = this.root.clientWidth || 0;
        if (this.leftSidebar) {
          this.leftSidebar.el.style.display = w > 0 && w < compactBp ? "none" : "flex";
        }
      };
      this.compactRO = new ResizeObserver(sync);
      this.compactRO.observe(this.root);
      sync();
    }

    void this.boot();
  }

  private toggleFullscreen(): void {
    const el = this.root;
    if (!document.fullscreenElement) {
      void el.requestFullscreen?.();
    } else {
      void document.exitFullscreen?.();
    }
  }

  private async boot(): Promise<void> {
    try {
      await this.data.resolveAndLoad();
    } catch (e) {
      console.error("[raze-charts] failed to load symbol", e);
    }
    if (this.destroyed) return;

    if (this.toolbar && this.context.features.has("header_resolutions")) {
      this.intervalSelector = new IntervalSelector(
        this.context,
        this.toolbar.intervalSlot,
        (res) => { void this.data.changeResolution(res); },
        this.context.options.favorites?.intervals?.map(String),
      );
      this.context.intervalChanged.subscribe(null, ((res: ResolutionString) => {
        this.intervalSelector?.setActive(String(res));
      }) as never);
    }

    this.loading?.hide();
    this.loading = null;
    this.headerReadyResolve();
    this.isChartReady = true;
    this.chartReady.fire();
  }

  onChartReady(callback: () => void): void {
    if (this.isChartReady) {
      queueMicrotask(callback);
    } else {
      this.chartReady.subscribe(null, callback as never, true);
    }
  }

  headerReady(): Promise<void> {
    return this.headerReadyPromise;
  }

  activeChart(): IChartWidgetApi {
    return this.api;
  }

  chart(_index?: number): IChartWidgetApi {
    return this.api;
  }

  createButton(options?: CreateButtonOptions): HTMLElement {
    if (!this.toolbar) {
      // Chrome-less: return a detached button so callers don't crash.
      const btn = document.createElement("div");
      return btn;
    }
    return this.toolbar.createButton(options);
  }

  setCSSCustomProperty(name: string, value: string): void {
    this.root.style.setProperty(name, value);
  }

  subscribe(event: string, callback: (...args: never[]) => void): void {
    let set = this.subscriptions.get(event);
    if (!set) {
      set = new Set();
      this.subscriptions.set(event, set);
    }
    set.add(callback);
  }

  unsubscribe(event: string, callback: (...args: never[]) => void): void {
    this.subscriptions.get(event)?.delete(callback);
  }

  private emit(event: string, ...args: unknown[]): void {
    const set = this.subscriptions.get(event);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try {
        (cb as (...a: unknown[]) => void)(...args);
      } catch {
        /* ignore */
      }
    }
  }

  onContextMenu(callback: ContextMenuCallback): void {
    this.contextMenuCb = callback;
  }

  setSymbol(symbol: string, interval: ResolutionString, callback?: () => void): void {
    this.context.resolution = interval;
    void this.data.changeSymbol(symbol).then(() => callback?.());
  }

  remove(): void {
    this.destroyed = true;
    closeContextMenu();
    this.compactRO?.disconnect();
    this.compactRO = null;
    this.renderer.destroy();
    this.engine.destroy();
    this.data.destroy();
    this.studies.destroy();
    this.intervalSelector?.destroy();
    this.indicatorsMenu?.destroy();
    this.leftSidebar?.destroy();
    this.scaleBar?.destroy();
    this.toolbar?.destroy();
    this.loading?.destroy();
    this.chartReady.destroy();
    this.subscriptions.clear();
    this.root.remove();
  }

  private wireContextMenu(): void {
    this.chartArea.addEventListener("contextmenu", (e) => {
      // Touch long-press is the crosshair gesture — suppress the native menu.
      if (this.renderer.lastPointerType !== "mouse") {
        e.preventDefault();
        return;
      }
      if (!this.contextMenuCb) return;
      e.preventDefault();
      const { unixTime, price } = this.renderer.timePriceAtEvent(e);
      const result = this.contextMenuCb(unixTime, price);
      const show = (items: typeof result extends Promise<infer R> ? R : typeof result): void => {
        showContextMenu(e.clientX, e.clientY, items as never, this.context.fontFamily);
      };
      if (result instanceof Promise) {
        void result.then(show);
      } else {
        show(result as never);
      }
    });
  }
}
