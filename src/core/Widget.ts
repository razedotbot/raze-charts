// The widget — the top-level object the app constructs via `new widget(opts)`.
// Owns the DOM tree, the shared context, and the subsystems (data manager,
// engine, toolbar, shape store, left sidebar). Implements the
// IChartingLibraryWidget surface the app uses.

import type {
  ChartingLibraryWidgetOptions,
  ChartLayoutSnapshot,
  ContextMenuCallback,
  CreateButtonOptions,
  CreateShapeOptions,
  EntityId,
  IChartingLibraryWidget,
  IChartWidgetApi,
  ResolutionString,
  ShapePoint,
} from "../types/charting_library";
import { buildFeatureSet, type ChartContext, type IndexRange } from "./context";
import { buildTheme } from "./theme";
import { createPriceFormatter } from "../util/format";
import { Delegate } from "../util/delegate";
import { DataManager } from "../data/DataManager";
import { ShapeStore } from "./ShapeStore";
import { TradingStore } from "./TradingStore";
import { ChartApi, type ChartApiDeps } from "./ChartApi";
import { ChartEngine } from "../engine/ChartEngine";
import { ChartRenderer } from "../engine/ChartRenderer";
import { Toolbar } from "../ui/Toolbar";
import { IntervalSelector } from "../ui/IntervalSelector";
import { TimeframeBar } from "../ui/TimeframeBar";
import { SymbolSearch } from "../ui/SymbolSearch";
import { ObjectsTree } from "../ui/ObjectsTree";
import { LoadingScreen } from "../ui/LoadingScreen";
import { IndicatorsMenu, resolveIndicatorPresets } from "../ui/IndicatorsMenu";
import { DEFAULT_SIDEBAR_ITEMS, LeftSidebar, type ChartStyleId } from "../ui/LeftSidebar";
import { ScaleBar } from "../ui/ScaleBar";
import { StudyStore } from "../studies/StudyStore";
import { StudyRegistry } from "../studies/registry";
import { showContextMenu, closeContextMenu } from "../ui/ContextMenu";
import { ensureBaseStyles } from "../ui/popup";
import { CommandStack } from "./CommandStack";
import { resolveTimeframe, type TimeframePreset } from "./timeframe";

const DEFAULT_FONT = "'Trebuchet MS', Roboto, Ubuntu, sans-serif";

export class Widget implements IChartingLibraryWidget {
  private root: HTMLDivElement;
  private bodyRow: HTMLDivElement;
  private chartArea: HTMLDivElement;
  private context: ChartContext;
  private data: DataManager;
  private shapes: ShapeStore;
  private trading: TradingStore;
  private engine: ChartEngine;
  private renderer: ChartRenderer;
  private toolbar: Toolbar | null = null;
  private leftSidebar: LeftSidebar | null = null;
  private scaleBar: ScaleBar | null = null;
  private intervalSelector: IntervalSelector | null = null;
  private timeframeBar: TimeframeBar | null = null;
  private symbolSearch: SymbolSearch | null = null;
  private objectsTree: ObjectsTree | null = null;
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
  /** Only the newest imperative data change may run its completion callback. */
  private dataChangeId = 0;
  private headerReadySettled = false;
  private commands = new CommandStack();
  private childWidgets: Widget[] = [];
  private layoutSyncing = false;
  private compareSeq = 0;
  private countdownTimer = 0;

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
      formatPrice: createPriceFormatter(options, null),
      theme,
      features,
      bars: [],
      marks: [],
      timescaleMarks: [],
      visibleRange: initialRange,
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
      "user-select:none",
      "-webkit-user-select:none",
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
          onObjectsTreeClick: (anchor) => {
            this.objectsTree?.toggle(anchor);
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
    this.chartArea.style.cssText = "position:relative;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden;user-select:none;-webkit-user-select:none;";
    this.bodyRow.appendChild(this.chartArea);

    this.data = new DataManager(this.context);
    this.shapes = new ShapeStore(this.context);
    this.trading = new TradingStore(this.context);
    const registry = new StudyRegistry();
    for (const def of raze?.custom_studies ?? []) registry.register(def);
    this.studies = new StudyStore(this.context, registry);
    this.engine = new ChartEngine(this.chartArea, this.context);
    this.syncAccessibility();
    this.renderer = new ChartRenderer(this.context, this.engine, this.shapes, this.trading, this.data, this.studies);
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

    this.objectsTree = new ObjectsTree(this.context, this.shapes, this.studies);

    const deps: ChartApiDeps = {
      refreshMarks: () => this.data.refreshMarks(),
      clearMarks: () => this.data.clearMarks(),
      resetData: () => this.data.resetData(),
      setResolution: (res, cb) => {
        this.runDataChange(
          `change resolution to ${res}`,
          () => this.data.changeResolution(res),
          cb,
        );
      },
      setSymbol: (sym, cb) => {
        this.runDataChange(
          `change symbol to ${sym}`,
          () => this.data.changeSymbol(sym),
          cb,
          () => {
            this.intervalSelector?.refresh();
            this.symbolSearch?.setSymbol(sym);
          },
        );
      },
      createShape: (point, opts) => this.createShapeTracked(point, opts),
      createMultipointShape: (points, opts) => this.createPointsTracked(points, opts),
      getShapeById: (id) => this.shapes.adapter(id),
      removeEntity: (id) => this.removeEntityTracked(id),
      removeAllShapes: () => this.shapes.removeAll(),
      createTradingLine: (options, kind) => this.trading.create(options, kind),
      createBracketOrder: (options) => this.trading.createBracket(options),
      getTradingLineById: (id) => this.trading.adapter(id),
      removeAllTradingLines: () => this.trading.removeAll(),
      createStudy: (name, forceOverlay, lock, inputs) => {
        const lengthRaw = inputs?.length ?? inputs?.Length ?? inputs?.periods;
        const length = typeof lengthRaw === "number" && Number.isFinite(lengthRaw) ? lengthRaw : 0;
        const color = typeof inputs?.color === "string" ? inputs.color : "";
        const extra: Record<string, number | string> = {};
        if (inputs) {
          for (const [key, value] of Object.entries(inputs)) {
            if (key === "length" || key === "Length" || key === "periods" || key === "color") continue;
            if (typeof value === "number" || typeof value === "string") extra[key] = value;
          }
        }
        const id = this.studies.add({
          name,
          length,
          color,
          lock: !!lock,
          forceOverlay: !!forceOverlay,
          inputs: extra,
        });
        if (!id) return Promise.reject(new Error(`[raze-charts] unknown study: ${name}`));
        this.commands.push({
          undo: () => { this.studies.remove(id); },
          redo: () => {
            this.studies.add({ name, length, color, lock: !!lock, forceOverlay: !!forceOverlay, inputs: extra });
          },
        });
        return Promise.resolve(id);
      },
      setVisibleRange: (range) => this.data.revealTimeRange(range.from, range.to),
      createCompare: (symbol) => this.createCompare(symbol),
      executeActionById: (actionId) => this.executeActionById(actionId),
    };
    this.api = new ChartApi(this.context, deps);

    this.context.drawingEvent.subscribe(null, ((id: string, type: string) => {
      this.emit("drawing_event", id, type);
    }) as never);
    this.context.tradingEvent.subscribe(null, ((line: unknown, type: string) => {
      this.emit("trading_event", line, type);
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
      if (!this.destroyed) console.error("[raze-charts] failed to load symbol", e);
    }
    if (this.destroyed) return;

    if (this.toolbar && this.context.features.has("header_resolutions")) {
      this.intervalSelector = new IntervalSelector(
        this.context,
        this.toolbar.intervalSlot,
        (res) => {
          this.runDataChange(
            `change resolution to ${res}`,
            () => this.data.changeResolution(res),
          );
        },
        this.context.options.favorites?.intervals?.map(String),
      );
      this.context.intervalChanged.subscribe(null, ((res: ResolutionString) => {
        this.intervalSelector?.setActive(String(res));
      }) as never);
    }

    if (this.toolbar && this.context.features.has("header_symbol_search")) {
      this.symbolSearch = new SymbolSearch(this.context, (symbol) => {
        this.runDataChange(
          `change symbol to ${symbol}`,
          () => this.data.changeSymbol(symbol),
          undefined,
          () => this.intervalSelector?.refresh(),
        );
      });
      this.toolbar.searchSlot.appendChild(this.symbolSearch.el);
    }

    if (this.toolbar && this.context.features.has("time_frames_toolbar")) {
      this.timeframeBar = new TimeframeBar(
        this.context,
        this.toolbar.rangeSlot,
        (preset) => { void this.applyPreset(preset); },
        () => this.goToDate(),
      );
    }

    this.spawnLayout();
    this.wireLayoutSync();
    this.wireUndoKeys();
    this.startCountdownClock();

    this.loading?.hide();
    this.loading = null;
    this.resolveHeaderReady();
    this.isChartReady = true;
    this.chartReady.fire();
  }

  private resolveHeaderReady(): void {
    if (this.headerReadySettled) return;
    this.headerReadySettled = true;
    this.headerReadyResolve();
  }

  private syncAccessibility(): void {
    this.engine.syncAccessibility();
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", this.engine.accessibilityLabel);
    this.root.setAttribute("aria-describedby", this.engine.accessibilityDescriptionId);
  }

  private runDataChange(
    description: string,
    start: () => Promise<void>,
    callback?: () => void,
    after?: () => void,
  ): void {
    if (this.destroyed) return;
    const requestId = ++this.dataChangeId;
    let request: Promise<void>;
    try {
      request = start();
    } catch (error) {
      console.error(`[raze-charts] failed to ${description}`, error);
      return;
    }
    void request
      .then(() => {
        if (this.destroyed || requestId !== this.dataChangeId) return;
        this.syncAccessibility();
        after?.();
        callback?.();
      })
      .catch((error: unknown) => {
        if (this.destroyed || requestId !== this.dataChangeId) return;
        console.error(`[raze-charts] failed to ${description}`, error);
      });
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

  chart(index?: number): IChartWidgetApi {
    if (index && this.childWidgets[index - 1]) return this.childWidgets[index - 1]!.activeChart();
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
    this.runDataChange(
      `change symbol to ${symbol}`,
      () => this.data.changeSymbol(symbol, interval),
      callback,
      () => {
        this.intervalSelector?.refresh();
        this.symbolSearch?.setSymbol(symbol);
      },
    );
  }

  save(callback?: (state: ChartLayoutSnapshot) => void): ChartLayoutSnapshot {
    const state: ChartLayoutSnapshot = {
      version: 1,
      symbol: this.context.symbol,
      interval: String(this.context.resolution),
      visibleRange: this.api.getVisibleRange(),
      chartStyle: this.context.chartStyle,
      logScale: this.context.logScale,
      percentScale: this.context.percentScale,
      volumeMode: this.context.volumeMode,
      magnet: this.context.magnet,
      drawings: this.shapes.snapshot().map((shape) => ({
        id: String(shape.id),
        shape: String(shape.shape),
        points: shape.points,
        text: shape.text,
        lock: shape.lock,
        zOrder: shape.zOrder,
        overrides: shape.overrides,
      })),
      studies: this.studies.list().map((study) => ({
        name: study.name,
        length: study.length,
        color: study.color,
      })),
      compare: this.context.compare.map((item) => item.symbol),
    };
    callback?.(state);
    return state;
  }

  async load(state: ChartLayoutSnapshot): Promise<void> {
    this.context.chartStyle = state.chartStyle;
    this.context.logScale = state.logScale;
    this.context.percentScale = state.percentScale;
    if (state.volumeMode) this.context.volumeMode = state.volumeMode;
    if (typeof state.magnet === "boolean") this.context.magnet = state.magnet;
    this.leftSidebar?.setChartStyle(state.chartStyle);
    await this.data.changeSymbol(state.symbol, state.interval as ResolutionString);
    this.shapes.removeAll();
    for (const drawing of state.drawings) {
      await this.shapes.createPoints(drawing.points, {
        shape: drawing.shape,
        text: drawing.text,
        lock: drawing.lock,
        zOrder: drawing.zOrder,
        overrides: drawing.overrides,
      });
    }
    this.studies.clear();
    for (const study of state.studies) this.studies.add(study);
    this.context.compare = [];
    for (const symbol of state.compare ?? []) await this.createCompare(symbol);
    await this.data.revealTimeRange(state.visibleRange.from, state.visibleRange.to);
    this.symbolSearch?.setSymbol(state.symbol);
    this.intervalSelector?.setActive(state.interval);
    this.context.requestPaint();
  }

  remove(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.dataChangeId += 1;
    // Cancel datafeed callbacks before tearing down the render/event surfaces.
    this.data.destroy();
    // Consumers awaiting headerReady must not hang when a widget is removed
    // while its datafeed is still booting.
    this.resolveHeaderReady();
    closeContextMenu();
    this.compactRO?.disconnect();
    this.compactRO = null;
    if (this.countdownTimer) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = 0;
    }
    this.renderer.destroy();
    this.engine.destroy();
    this.studies.destroy();
    for (const child of this.childWidgets) child.remove();
    this.childWidgets = [];
    this.objectsTree?.destroy();
    this.symbolSearch?.destroy();
    this.timeframeBar?.destroy();
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

  private async createShapeTracked(
    point: ShapePoint,
    opts: CreateShapeOptions,
  ): Promise<EntityId> {
    return this.createPointsTracked([point], opts);
  }

  private async createPointsTracked(
    points: ShapePoint[],
    opts: CreateShapeOptions,
  ): Promise<EntityId> {
    const id = await this.shapes.createPoints(points, opts);
    if (!opts.disableUndo) {
      const stored = this.shapes.get(id);
      if (stored) {
        const snap = {
          ...stored,
          points: stored.points.map((p) => ({ ...p })),
          overrides: { ...stored.overrides },
        };
        this.commands.push({
          undo: () => this.shapes.remove(id),
          redo: () => this.shapes.restore(snap),
        });
      }
    }
    return id;
  }

  private removeEntityTracked(id: EntityId): void {
    const study = this.studies.has(id) ? this.studies.list().find((s) => s.id === id) : null;
    if (study) {
      this.studies.remove(id);
      this.commands.push({
        undo: () => {
          this.studies.add({
            name: study.name,
            length: study.length,
            color: study.color,
            lock: study.lock,
            forceOverlay: study.forceOverlay,
            inputs: study.inputs,
          });
        },
        redo: () => { this.studies.remove(id); },
      });
      return;
    }
    const compare = this.context.compare.find((item) => item.id === String(id));
    if (compare) {
      this.context.compare = this.context.compare.filter((item) => item.id !== compare.id);
      this.context.requestPaint();
      return;
    }
    const shape = this.shapes.get(id);
    const tradingLine = this.trading.get(String(id));
    if (tradingLine) {
      this.trading.remove(String(id));
      return;
    }
    this.shapes.remove(id);
    if (shape) {
      this.commands.push({
        undo: () => this.shapes.restore(shape),
        redo: () => this.shapes.remove(id),
      });
    }
  }

  private async createCompare(symbol: string): Promise<EntityId> {
    const bars = await this.data.loadCompare(symbol);
    this.compareSeq += 1;
    const id = `compare_${symbol}_${this.compareSeq}` as EntityId;
    const colors = ["#26a69a", "#f5a623", "#e040fb", "#42a5f5"];
    this.context.compare.push({
      id: String(id),
      symbol,
      bars,
      color: colors[(this.context.compare.length) % colors.length]!,
    });
    this.context.requestPaint();
    return id;
  }

  private executeActionById(actionId: string): void {
    if (actionId === "undo") this.commands.undo();
    else if (actionId === "redo") this.commands.redo();
    else if (actionId === "magnet") this.context.magnet = !this.context.magnet;
    else if (actionId === "stay_in_drawing_mode") {
      this.context.stayInDrawingMode = !this.context.stayInDrawingMode;
    } else if (actionId === "objects_tree" && this.leftSidebar) {
      const btn = this.leftSidebar.el.querySelector('[aria-label="Objects tree"]');
      if (btn instanceof HTMLElement) this.objectsTree?.toggle(btn);
    } else if (actionId === "volume_pane") {
      const order = ["overlay", "pane", "hidden"] as const;
      const i = order.indexOf(this.context.volumeMode);
      this.context.volumeMode = order[(i + 1) % order.length]!;
    }
    this.context.requestPaint();
  }

  private async applyPreset(preset: TimeframePreset): Promise<void> {
    const lastBar = this.context.bars[this.context.bars.length - 1];
    const now = Math.floor((lastBar?.time ?? Date.now()) / 1000);
    const resolved = resolveTimeframe({ value: preset, type: "period-back" }, now);
    if (!resolved) return;
    if (resolved.all) {
      const n = this.context.bars.length;
      if (n) {
        this.context.visibleRange = { from: 0, to: n - 1 };
        this.context.autoScalePrice = true;
        this.context.viewportChanged.fire(this.data.visibleUnixRange());
        this.context.requestPaint();
      }
      return;
    }
    await this.data.revealTimeRange(resolved.from, resolved.to);
  }

  private goToDate(): void {
    const raw = window.prompt("Go to date (YYYY-MM-DD or unix seconds)", "");
    if (!raw?.trim()) return;
    let sec = Number(raw);
    if (!Number.isFinite(sec)) {
      const ms = Date.parse(raw.trim());
      if (!Number.isFinite(ms)) return;
      sec = Math.floor(ms / 1000);
    }
    const span = Math.max(1, this.context.visibleRange.to - this.context.visibleRange.from);
    const resMs = Math.max(1, (this.context.bars[1]?.time ?? 0) - (this.context.bars[0]?.time ?? 0));
    const halfSec = Math.floor((span * resMs) / 2000);
    void this.data.revealTimeRange(sec - halfSec, sec + halfSec);
  }

  private spawnLayout(): void {
    const layout = this.context.options.raze?.layout;
    if (this.context.options.raze?.layout_child) return;
    const cells = layout === "2x2" ? 4 : layout === "2x1" ? 2 : 1;
    if (cells <= 1) return;
    this.chartArea.style.display = "grid";
    this.chartArea.style.gridTemplateRows = layout === "2x2" ? "1fr 1fr" : "1fr 1fr";
    this.chartArea.style.gridTemplateColumns = layout === "2x2" ? "1fr 1fr" : "1fr";
    const pane0 = document.createElement("div");
    pane0.style.cssText = "position:relative;min-width:0;min-height:0;overflow:hidden;";
    while (this.chartArea.firstChild) pane0.appendChild(this.chartArea.firstChild);
    this.chartArea.appendChild(pane0);
    const symbols = this.context.options.raze?.layout_symbols ?? [];
    for (let i = 1; i < cells; i++) {
      const cell = document.createElement("div");
      cell.style.cssText = "position:relative;min-width:0;min-height:0;overflow:hidden;";
      this.chartArea.appendChild(cell);
      const child = new Widget({
        ...this.context.options,
        container: cell,
        symbol: symbols[i] ?? this.context.symbol,
        disabled_features: [
          ...(this.context.options.disabled_features ?? []),
          "header_widget",
          "left_toolbar",
        ],
        raze: {
          ...this.context.options.raze,
          layout: "1",
          layout_child: true,
        },
      });
      this.childWidgets.push(child);
    }
  }

  private wireLayoutSync(): void {
    if (!this.childWidgets.length) return;
    const panes = [this, ...this.childWidgets];
    for (const pane of panes) {
      pane.context.viewportChanged.subscribe(null, ((range: { from: number; to: number }) => {
        if (this.layoutSyncing) return;
        this.layoutSyncing = true;
        for (const other of panes) {
          if (other === pane) continue;
          void other.data.revealTimeRange(range.from, range.to);
        }
        this.layoutSyncing = false;
      }) as never);
      pane.context.crosshairMoved.subscribe(null, ((ev: { unixTime: number; price: number; active: boolean }) => {
        if (this.layoutSyncing) return;
        this.layoutSyncing = true;
        for (const other of panes) {
          if (other === pane) continue;
          other.context.syncedCrosshair = ev;
          other.context.requestPaint();
        }
        this.layoutSyncing = false;
      }) as never);
    }
  }

  private startCountdownClock(): void {
    if (!this.context.features.has("countdown")) return;
    this.countdownTimer = window.setInterval(() => {
      if (!this.destroyed) this.context.requestPaint();
    }, 1000);
  }

  private wireUndoKeys(): void {
    this.engine.canvas.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) this.commands.redo();
        else this.commands.undo();
        this.context.requestPaint();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        this.commands.redo();
        this.context.requestPaint();
      }
    });
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
