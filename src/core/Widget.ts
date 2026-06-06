// The widget — the top-level object the app constructs via `new widget(opts)`.
// Owns the DOM tree, the shared context, and the subsystems (data manager,
// engine, toolbar, shape store). Implements the IChartingLibraryWidget surface
// the app uses: onChartReady, headerReady, activeChart/chart, createButton,
// setCSSCustomProperty, subscribe, onContextMenu, remove.

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
import { LoadingScreen } from "../ui/LoadingScreen";
import { showContextMenu, closeContextMenu } from "../ui/ContextMenu";

const DEFAULT_FONT = "'Trebuchet MS', Roboto, Ubuntu, sans-serif";

export class Widget implements IChartingLibraryWidget {
  private root: HTMLDivElement;
  private chartArea: HTMLDivElement;
  private context: ChartContext;
  private data: DataManager;
  private shapes: ShapeStore;
  private engine: ChartEngine;
  private renderer: ChartRenderer;
  private toolbar: Toolbar;
  private loading: LoadingScreen | null;
  private api: ChartApi;

  private chartReady: Delegate<[]> = new Delegate();
  private isChartReady = false;
  private headerReadyResolve!: () => void;
  private headerReadyPromise: Promise<void>;
  private subscriptions = new Map<string, Set<(...a: never[]) => void>>();
  private contextMenuCb: ContextMenuCallback | null = null;
  private destroyed = false;

  constructor(options: ChartingLibraryWidgetOptions) {
    const containerEl =
      typeof options.container === "string"
        ? document.getElementById(options.container)
        : options.container;
    if (!containerEl) throw new Error("[raze-charts] widget container not found");

    const fontFamily = options.custom_font_family || DEFAULT_FONT;
    const theme = buildTheme(options);

    // ── Shared context ────────────────────────────────────────────────────────
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
      features: buildFeatureSet(options),
      bars: [],
      marks: [],
      visibleRange: initialRange,
      autoScalePrice: true,
      priceRange: null,
      intervalChanged: new Delegate(),
      dataChanged: new Delegate(),
      drawingEvent: new Delegate(),
      requestPaint: () => {},
    };

    // ── DOM tree: root → toolbar + chartArea(canvas) + loadingScreen ───────────
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

    this.toolbar = new Toolbar(this.context);
    this.root.appendChild(this.toolbar.el);

    this.chartArea = document.createElement("div");
    this.chartArea.style.cssText = "position:relative;flex:1 1 auto;min-height:0;overflow:hidden;";
    this.root.appendChild(this.chartArea);

    // ── Subsystems ─────────────────────────────────────────────────────────────
    this.data = new DataManager(this.context);
    this.shapes = new ShapeStore(this.context);
    this.engine = new ChartEngine(this.chartArea, this.context);
    this.renderer = new ChartRenderer(this.context, this.engine, this.shapes, this.data);

    this.loading = new LoadingScreen(options.loading_screen, theme.paneBackground);
    this.chartArea.appendChild(this.loading.el);

    const deps: ChartApiDeps = {
      refreshMarks: () => this.data.refreshMarks(),
      clearMarks: () => this.data.clearMarks(),
      resetData: () => this.data.resetData(),
      setResolution: (res, cb) => {
        void this.data.changeResolution(res).then(() => cb?.());
      },
      setSymbol: (sym, cb) => {
        void this.data.changeSymbol(sym).then(() => cb?.());
      },
      createShape: (point, opts) => this.shapes.create(point, opts),
      getShapeById: (id) => this.shapes.adapter(id),
      removeEntity: (id) => this.shapes.remove(id),
      removeAllShapes: () => this.shapes.removeAll(),
    };
    this.api = new ChartApi(this.context, deps);

    // Re-emit drawing events (drag etc.) to widget.subscribe("drawing_event").
    this.context.drawingEvent.subscribe(null, ((id: string, type: string) => {
      this.emit("drawing_event", id, type);
    }) as never);

    // headerReady resolves once the toolbar is mounted (immediately — DOM toolbar).
    this.headerReadyPromise = new Promise<void>((resolve) => {
      this.headerReadyResolve = resolve;
    });

    this.renderer.attach();
    this.wireContextMenu();

    // ── Boot: resolve symbol, load bars, then fire ready ────────────────────────
    void this.boot();
  }

  private async boot(): Promise<void> {
    try {
      await this.data.resolveAndLoad();
    } catch (e) {
      console.error("[raze-charts] failed to load symbol", e);
    }
    if (this.destroyed) return;
    this.loading?.hide();
    this.loading = null;
    // headerReady fires first (the app mounts buttons), then onChartReady.
    this.headerReadyResolve();
    this.isChartReady = true;
    this.chartReady.fire();
  }

  // ── IChartingLibraryWidget ──────────────────────────────────────────────────
  onChartReady(callback: () => void): void {
    if (this.isChartReady) {
      // Defer to mimic TV's async ready callback.
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
    this.renderer.destroy();
    this.engine.destroy();
    this.data.destroy();
    this.toolbar.destroy();
    this.loading?.destroy();
    this.chartReady.destroy();
    this.subscriptions.clear();
    this.root.remove();
  }

  // ── Right-click → onContextMenu callback ────────────────────────────────────
  private wireContextMenu(): void {
    this.chartArea.addEventListener("contextmenu", (e) => {
      if (!this.contextMenuCb) return;
      e.preventDefault();
      const { unixTime, price } = this.renderer.timePriceAt(e.offsetX, e.offsetY);
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
