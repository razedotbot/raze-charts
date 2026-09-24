// The widget — the top-level object the app constructs via `new widget(opts)`.
// Owns the DOM tree, the shared context, and the subsystems (data manager,
// engine, toolbar, shape store, left sidebar). Implements the
// IChartingLibraryWidget surface the app uses.

import type {
  ChartingLibraryWidgetOptions,
  ChartLayoutSnapshot,
  Bar,
  ContextMenuCallback,
  CreateButtonOptions,
  EntityId,
  IChartingLibraryWidget,
  IChartWidgetApi,
  ResolutionString,
} from "../types/charting_library";
import { buildFeatureSet, createChartContext, type ChartContext, type IndexRange } from "./context";
import { buildTheme, isLightColor } from "./theme";
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
  private primaryChartArea: HTMLDivElement;
  private layoutPanes: HTMLDivElement[] = [];
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
  private contextMenuRequestId = 0;
  private contextMenuPendingCleanup: (() => void) | null = null;
  private loadId = 0;
  private readonly loadingSubscriptionOwner = {};
  private readonly onDataAvailable = (): void => {
    if (this.context.bars.length) this.finishLoading();
  };

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
    this.context = createChartContext({
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
    });

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
    ].join(";");
    this.root.style.background = theme.paneBackground;
    this.root.style.fontFamily = fontFamily;
    const toolbarBackground = options.toolbar_bg ?? theme.paneBackground;
    const lightChrome = isLightColor(toolbarBackground);
    const lightPopup = isLightColor(theme.paneBackground);
    const chromeText = lightChrome ? "#2a2e39" : "#d1d4dc";
    const popupText = lightPopup ? "#2a2e39" : "#d1d4dc";
    const chromeAccent = lightChrome ? "#174ea6" : "#66d89e";
    const hoverBackground = lightChrome ? "rgba(19,23,34,0.08)" : "rgba(255,255,255,0.08)";
    const activeBackground = lightChrome ? "rgba(23,78,166,0.12)" : "rgba(102,216,158,0.18)";
    const popupBackground = lightPopup ? "#ffffff" : "#1e222d";
    const popupHover = lightPopup ? "rgba(19,23,34,0.08)" : "rgba(255,255,255,0.08)";
    const chromeVariables: Record<string, string> = {
      "--tv-color-pane-background": theme.paneBackground,
      "--tv-color-platform-background": toolbarBackground,
      "--tv-color-toolbar-button-background": options.toolbar_bg ?? "transparent",
      "--tv-color-toolbar-button-background-hover": hoverBackground,
      "--tv-color-toolbar-button-background-active": activeBackground,
      "--tv-color-toolbar-button-text": chromeText,
      "--tv-color-toolbar-button-text-hover": chromeAccent,
      "--tv-color-toolbar-divider-background": theme.scaleLine,
      "--tv-color-popup-background": popupBackground,
      "--tv-color-popup-element-text": popupText,
      "--tv-color-popup-element-background-hover": popupHover,
      "--tv-color-popup-shadow": lightPopup
        ? "0 12px 24px -10px rgba(19,23,34,0.28)"
        : "0 12px 24px -10px rgba(0,0,0,0.6)",
    };
    for (const [name, value] of Object.entries(chromeVariables)) {
      this.root.style.setProperty(name, value);
    }
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
    this.layoutPanes = this.prepareLayoutPanes();
    this.primaryChartArea = this.layoutPanes[0]!;

    this.data = new DataManager(this.context);
    this.shapes = new ShapeStore(this.context, this.commands);
    this.trading = new TradingStore(this.context);
    const registry = new StudyRegistry();
    for (const def of raze?.custom_studies ?? []) registry.register(def);
    this.studies = new StudyStore(this.context, registry, this.commands);
    this.engine = new ChartEngine(this.primaryChartArea, this.context);
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
      this.primaryChartArea.appendChild(this.scaleBar.el);
    }

    this.loading = new LoadingScreen(options.loading_screen, theme.paneBackground);
    this.primaryChartArea.appendChild(this.loading.el);
    this.context.dataChanged.subscribe(
      this.loadingSubscriptionOwner,
      this.onDataAvailable as (...args: never[]) => void,
    );

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
      createShape: (point, opts) => this.shapes.create(point, opts),
      createMultipointShape: (points, opts) => this.shapes.createPoints(points, opts),
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
    try {
      const request = !document.fullscreenElement
        ? el.requestFullscreen?.()
        : document.exitFullscreen?.();
      void request?.catch((error: unknown) => this.reportError("toggle fullscreen", error));
    } catch (error) {
      this.reportError("toggle fullscreen", error);
    }
  }

  private async boot(): Promise<void> {
    let loadFailed = false;
    try {
      await this.data.resolveAndLoad();
    } catch (e) {
      loadFailed = true;
      if (!this.destroyed) this.reportError("load symbol", e);
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
            undefined,
            undefined,
            () => this.intervalSelector?.setActive(String(this.context.resolution)),
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
          () => {
            this.intervalSelector?.refresh();
            this.symbolSearch?.setSymbol(this.context.symbol);
          },
          () => this.symbolSearch?.setSymbol(this.context.symbol),
        );
      });
      this.toolbar.searchSlot.appendChild(this.symbolSearch.el);
    }

    if (this.toolbar && this.context.features.has("time_frames_toolbar")) {
      this.timeframeBar = new TimeframeBar(
        this.context,
        this.toolbar.rangeSlot,
        (preset) => {
          void this.applyPreset(preset).catch((error: unknown) => {
            if (!this.destroyed) {
              this.timeframeBar?.setActive(null);
              this.reportError(`apply timeframe ${preset}`, error);
            }
          });
        },
        () => this.goToDate(),
      );
    }

    this.spawnLayout();
    this.wireLayoutSync();
    this.wireUndoKeys();
    this.startCountdownClock();

    if (loadFailed) this.showLoadingError();
    else if (!this.context.bars.length) this.showEmptyState();
    else this.finishLoading();
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
    onError?: () => void,
  ): void {
    if (this.destroyed) return;
    const requestId = ++this.dataChangeId;
    let request: Promise<void>;
    try {
      request = start();
    } catch (error) {
      this.reportError(description, error);
      if (!this.context.bars.length) this.showLoadingError();
      try {
        onError?.();
      } catch (rollbackError) {
        this.reportError(`rollback ${description}`, rollbackError);
      }
      return;
    }
    void request
      .then(() => {
        if (this.destroyed || requestId !== this.dataChangeId) return;
        this.syncAccessibility();
        if (!this.context.bars.length) this.showEmptyState();
        try {
          after?.();
        } catch (error) {
          this.reportError(`finish ${description}`, error);
        }
        if (callback) this.callConsumerCallback(`${description} callback`, callback);
      })
      .catch((error: unknown) => {
        if (this.destroyed || requestId !== this.dataChangeId) return;
        this.reportError(description, error);
        if (!this.context.bars.length) this.showLoadingError();
        try {
          onError?.();
        } catch (rollbackError) {
          this.reportError(`rollback ${description}`, rollbackError);
        }
      });
  }

  onChartReady(callback: () => void): void {
    const safeCallback = (): void => this.callConsumerCallback("onChartReady", callback);
    if (this.isChartReady) {
      queueMicrotask(safeCallback);
    } else {
      this.chartReady.subscribe(null, safeCallback as never, true);
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
    this.contextMenuRequestId += 1;
    this.cancelPendingContextMenu();
    closeContextMenu();
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
      drawings: this.shapes.snapshot().filter((shape) => !shape.disableSave).map((shape) => ({
        id: String(shape.id),
        shape: String(shape.shape),
        points: shape.points,
        text: shape.text,
        lock: shape.lock,
        disableSelection: shape.disableSelection,
        disableSave: shape.disableSave,
        disableUndo: shape.disableUndo,
        showInObjectsTree: shape.showInObjectsTree,
        hidden: shape.hidden,
        zOrder: shape.zOrder,
        overrides: shape.overrides,
      })),
      studies: this.studies.list().map((study) => ({
        id: String(study.id),
        name: study.name,
        length: study.length,
        color: study.color,
        lock: study.lock,
        forceOverlay: study.forceOverlay,
        inputs: { ...study.inputs },
      })),
      compare: this.context.compare.map((item) => item.symbol),
    };
    if (callback) this.callConsumerCallback("save callback", () => callback(state));
    return state;
  }

  async load(state: ChartLayoutSnapshot): Promise<void> {
    if (!state || state.version !== 1
        || !Array.isArray(state.drawings)
        || !Array.isArray(state.studies)
        || (state.compare !== undefined && !Array.isArray(state.compare))
        || typeof state.symbol !== "string"
        || typeof state.interval !== "string"
        || !state.visibleRange
        || !Number.isFinite(state.visibleRange.from)
        || !Number.isFinite(state.visibleRange.to)
        || state.visibleRange.from > state.visibleRange.to
        || state.drawings.some((drawing) => !drawing
          || typeof drawing.id !== "string"
          || !Array.isArray(drawing.points)
          || drawing.points.some((point) => !point
            || !Number.isFinite(point.time)
            || (point.price !== undefined && !Number.isFinite(point.price))))
        || state.studies.some((study) => !study
          || typeof study.name !== "string"
          || !study.name.trim()
          || !Number.isFinite(study.length))
        || state.compare?.some((symbol) => typeof symbol !== "string")) {
      throw new TypeError("[raze-charts] invalid chart layout snapshot");
    }
    const drawingIds = state.drawings.map((drawing) => drawing.id);
    const studyIds = state.studies.flatMap((study) => study.id ? [study.id] : []);
    if (new Set(drawingIds).size !== drawingIds.length
        || new Set(studyIds).size !== studyIds.length) {
      throw new TypeError("[raze-charts] chart layout snapshot contains duplicate entity ids");
    }
    const unknownStudy = state.studies.find((study) => !this.studies.registry.resolve(study.name));
    if (unknownStudy) {
      throw new Error(`[raze-charts] chart layout references unknown study: ${unknownStudy.name}`);
    }

    const loadId = ++this.loadId;
    const dataChangeId = ++this.dataChangeId;
    const isCurrent = (): boolean => !this.destroyed
      && loadId === this.loadId
      && dataChangeId === this.dataChangeId;
    await this.data.changeSymbol(state.symbol, state.interval as ResolutionString);
    if (!isCurrent()) return;

    // Fetch everything before replacing drawings/studies. This keeps the
    // visible object model coherent if a compare/range request fails and lets
    // a newer load supersede this one without leaving half a snapshot behind.
    const comparisons: { symbol: string; bars: Bar[] }[] = [];
    for (const symbol of state.compare ?? []) {
      const bars = await this.data.loadCompare(symbol);
      if (!isCurrent()) return;
      comparisons.push({ symbol, bars });
    }
    await this.data.revealTimeRange(state.visibleRange.from, state.visibleRange.to);
    if (!isCurrent()) return;

    const resumeHistory = this.commands.suspend();
    try {
      this.context.chartStyle = state.chartStyle;
      this.context.logScale = state.logScale;
      this.context.percentScale = state.percentScale;
      if (state.volumeMode) this.context.volumeMode = state.volumeMode;
      if (typeof state.magnet === "boolean") this.context.magnet = state.magnet;
      this.leftSidebar?.setChartStyle(state.chartStyle);

      this.shapes.removeAll();
      for (const drawing of state.drawings) {
        this.shapes.restore({
          id: drawing.id as EntityId,
          shape: drawing.shape || "horizontal_line",
          points: drawing.points,
          text: drawing.text ?? "",
          lock: drawing.lock ?? false,
          disableSelection: drawing.disableSelection ?? false,
          disableSave: drawing.disableSave ?? false,
          disableUndo: drawing.disableUndo ?? false,
          showInObjectsTree: drawing.showInObjectsTree !== false,
          hidden: drawing.hidden ?? false,
          zOrder: drawing.zOrder === "top" ? "top" : "bottom",
          overrides: drawing.overrides ?? {},
        });
      }
      this.studies.clear();
      for (const study of state.studies) {
        this.studies.add({
          ...study,
          id: study.id as EntityId | undefined,
          lock: study.lock ?? false,
          forceOverlay: study.forceOverlay ?? false,
          inputs: study.inputs ?? {},
        });
      }
      this.context.compare = [];
      for (const comparison of comparisons) this.addCompare(comparison.symbol, comparison.bars);
      this.symbolSearch?.setSymbol(this.context.symbol);
      this.intervalSelector?.refresh();
      this.syncAccessibility();
      if (this.context.bars.length) this.finishLoading();
      else this.showEmptyState();
      this.context.requestPaint();
      this.commands.clear();
    } finally {
      resumeHistory();
    }
  }

  remove(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.dataChangeId += 1;
    this.loadId += 1;
    this.contextMenuRequestId += 1;
    this.cancelPendingContextMenu();
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
    this.context.dataChanged.unsubscribeAll(this.loadingSubscriptionOwner);
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

  private removeEntityTracked(id: EntityId): void {
    if (this.studies.remove(id)) return;
    const compare = this.context.compare.find((item) => item.id === String(id));
    if (compare) {
      this.context.compare = this.context.compare.filter((item) => item.id !== compare.id);
      this.context.requestPaint();
      return;
    }
    const tradingLine = this.trading.get(String(id));
    if (tradingLine) {
      this.trading.remove(String(id));
      return;
    }
    this.shapes.remove(id);
  }

  private async createCompare(symbol: string): Promise<EntityId> {
    const bars = await this.data.loadCompare(symbol);
    if (this.destroyed) throw new Error("[raze-charts] widget was removed before compare data loaded");
    return this.addCompare(symbol, bars);
  }

  private addCompare(symbol: string, bars: Bar[]): EntityId {
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
      if (!Number.isFinite(ms)) {
        this.engine.announce("Enter a valid date or Unix timestamp.");
        return;
      }
      sec = Math.floor(ms / 1000);
    }
    const span = Math.max(1, this.context.visibleRange.to - this.context.visibleRange.from);
    const resMs = Math.max(1, (this.context.bars[1]?.time ?? 0) - (this.context.bars[0]?.time ?? 0));
    const halfSec = Math.floor((span * resMs) / 2000);
    void this.data.revealTimeRange(sec - halfSec, sec + halfSec).catch((error: unknown) => {
      if (!this.destroyed) this.reportError("go to date", error);
    });
  }

  private prepareLayoutPanes(): HTMLDivElement[] {
    const layout = this.context.options.raze?.layout;
    if (this.context.options.raze?.layout_child) return [this.chartArea];
    const cells = layout === "2x2" ? 4 : layout === "2x1" ? 2 : 1;
    if (cells <= 1) return [this.chartArea];
    this.chartArea.style.display = "grid";
    this.chartArea.style.gridTemplateRows = layout === "2x2" ? "1fr 1fr" : "1fr 1fr";
    this.chartArea.style.gridTemplateColumns = layout === "2x2" ? "1fr 1fr" : "1fr";
    const panes: HTMLDivElement[] = [];
    for (let index = 0; index < cells; index++) {
      const pane = document.createElement("div");
      pane.className = "raze-chart-layout-pane";
      pane.dataset.paneIndex = String(index);
      pane.style.cssText = "position:relative;min-width:0;min-height:0;overflow:hidden;";
      this.chartArea.appendChild(pane);
      panes.push(pane);
    }
    return panes;
  }

  private spawnLayout(): void {
    if (this.layoutPanes.length <= 1) return;
    const symbols = this.context.options.raze?.layout_symbols ?? [];
    for (let i = 1; i < this.layoutPanes.length; i++) {
      const cell = this.layoutPanes[i]!;
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
        const updates = panes
          .filter((other) => other !== pane)
          .map((other) => other.data.revealTimeRange(range.from, range.to));
        void Promise.allSettled(updates).then((results) => {
          for (const result of results) {
            if (result.status === "rejected" && !this.destroyed) {
              this.reportError("synchronise chart layout", result.reason);
            }
          }
        }).finally(() => {
          this.layoutSyncing = false;
        });
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
      closeContextMenu();
      this.cancelPendingContextMenu();
      const requestId = ++this.contextMenuRequestId;
      const { unixTime, price } = this.renderer.timePriceAtEvent(e);
      let result: ReturnType<ContextMenuCallback>;
      try {
        result = this.contextMenuCb(unixTime, price);
      } catch (error) {
        this.reportError("open context menu", error);
        return;
      }
      const show = (items: Awaited<ReturnType<ContextMenuCallback>>): void => {
        if (this.destroyed || requestId !== this.contextMenuRequestId || !this.root.isConnected) return;
        showContextMenu(
          e.clientX,
          e.clientY,
          Array.isArray(items) ? items : [],
          this.context.fontFamily,
          this.root,
        );
      };
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        const cancelRequest = (): void => {
          if (requestId === this.contextMenuRequestId) this.contextMenuRequestId += 1;
          cleanup();
        };
        const onKey = (event: KeyboardEvent): void => {
          if (event.key === "Escape") cancelRequest();
        };
        const cleanup = (): void => {
          document.removeEventListener("pointerdown", cancelRequest, true);
          document.removeEventListener("keydown", onKey, true);
          if (this.contextMenuPendingCleanup === cleanup) this.contextMenuPendingCleanup = null;
        };
        document.addEventListener("pointerdown", cancelRequest, true);
        document.addEventListener("keydown", onKey, true);
        this.contextMenuPendingCleanup = cleanup;
        void Promise.resolve(result).then((items) => {
          cleanup();
          show(items);
        }).catch((error: unknown) => {
          cleanup();
          if (!this.destroyed && requestId === this.contextMenuRequestId) {
            this.reportError("open context menu", error);
          }
        });
      } else {
        show(result as Awaited<ReturnType<ContextMenuCallback>>);
      }
    });
  }

  private callConsumerCallback(description: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.reportError(description, error);
    }
  }

  private cancelPendingContextMenu(): void {
    this.contextMenuPendingCleanup?.();
    this.contextMenuPendingCleanup = null;
  }

  private finishLoading(): void {
    if (!this.loading) return;
    this.loading.hide();
  }

  private showEmptyState(): void {
    if (!this.loading) return;
    if (!this.loading.el.isConnected) this.primaryChartArea.appendChild(this.loading.el);
    this.loading.showEmpty();
  }

  private showLoadingError(): void {
    if (!this.loading) return;
    if (!this.loading.el.isConnected) this.primaryChartArea.appendChild(this.loading.el);
    this.loading.showError();
  }

  private reportError(operation: string, error: unknown): void {
    console.error(`[raze-charts] failed to ${operation}`, error);
  }
}
