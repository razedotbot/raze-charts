// Widget chrome: the root/body/chart-area shell with its CSS custom
// properties, the header (interval, symbol search, timeframes, custom
// buttons), the left sidebar, scale bar, loading states, indicator and
// object-tree popups, compact mode, fullscreen, go-to-date and the countdown tick.

import type { CreateButtonOptions } from "../../types/charting_library";
import { IndicatorsMenu, resolveIndicatorPresets } from "../../ui/IndicatorsMenu";
import { IntervalSelector } from "../../ui/IntervalSelector";
import { DEFAULT_SIDEBAR_ITEMS, LeftSidebar, type ChartStyleId } from "../../ui/LeftSidebar";
import { LoadingScreen } from "../../ui/LoadingScreen";
import { ObjectsTree } from "../../ui/ObjectsTree";
import { ensureBaseStyles } from "../../ui/popup";
import { ScaleBar } from "../../ui/ScaleBar";
import { SymbolSearch } from "../../ui/SymbolSearch";
import { TimeframeBar } from "../../ui/TimeframeBar";
import { Toolbar } from "../../ui/Toolbar";
import { isLightColor } from "../theme";
import { resolveTimeframe, type TimeframePreset } from "../timeframe";
import type { WidgetController, WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    chrome: ChromeController;
  }
}

const div = (cssText: string): HTMLDivElement => {
  const el = document.createElement("div");
  el.style.cssText = cssText;
  return el;
};

export class ChromeController implements WidgetController {
  readonly root: HTMLDivElement;
  readonly bodyRow: HTMLDivElement;
  readonly chartArea: HTMLDivElement;
  toolbar: Toolbar | null = null;
  leftSidebar: LeftSidebar | null = null;
  scaleBar: ScaleBar | null = null;
  intervalSelector: IntervalSelector | null = null;
  timeframeBar: TimeframeBar | null = null;
  symbolSearch: SymbolSearch | null = null;
  objectsTree: ObjectsTree | null = null;
  indicatorsMenu: IndicatorsMenu | null = null;
  loading: LoadingScreen | null = null;
  private compactRO: ResizeObserver | null = null;
  private countdownTimer = 0;
  private readonly loadingOwner = {};
  private readonly onDataAvailable = (): void => {
    if (this.host.context.bars.length) this.finishLoading();
  };

  constructor(private readonly host: WidgetHost) {
    const { context, options } = host;
    const theme = context.theme;
    ensureBaseStyles();
    this.root = div([
      "position:relative",
      "width:100%",
      "height:100%",
      "display:flex",
      "flex-direction:column",
      "overflow:hidden",
      "user-select:none",
      "-webkit-user-select:none",
    ].join(";"));
    this.root.className = "raze-chart-root";
    this.root.style.background = theme.paneBackground;
    this.root.style.fontFamily = context.fontFamily;
    const toolbarBackground = options.toolbar_bg ?? theme.paneBackground;
    const lightChrome = isLightColor(toolbarBackground);
    const lightPopup = isLightColor(theme.paneBackground);
    const chromeVariables: Record<string, string> = {
      "--tv-color-pane-background": theme.paneBackground,
      "--tv-color-platform-background": toolbarBackground,
      "--tv-color-toolbar-button-background": options.toolbar_bg ?? "transparent",
      "--tv-color-toolbar-button-background-hover": lightChrome ? "rgba(19,23,34,0.08)" : "rgba(255,255,255,0.08)",
      "--tv-color-toolbar-button-background-active": lightChrome ? "rgba(23,78,166,0.12)" : "rgba(102,216,158,0.18)",
      "--tv-color-toolbar-button-text": lightChrome ? "#2a2e39" : "#d1d4dc",
      "--tv-color-toolbar-button-text-hover": lightChrome ? "#174ea6" : "#66d89e",
      "--tv-color-toolbar-divider-background": theme.scaleLine,
      "--tv-color-popup-background": lightPopup ? "#ffffff" : "#1e222d",
      "--tv-color-popup-element-text": lightPopup ? "#2a2e39" : "#d1d4dc",
      "--tv-color-popup-element-background-hover": lightPopup ? "rgba(19,23,34,0.08)" : "rgba(255,255,255,0.08)",
      "--tv-color-popup-shadow": lightPopup
        ? "0 12px 24px -10px rgba(19,23,34,0.28)"
        : "0 12px 24px -10px rgba(0,0,0,0.6)",
    };
    for (const [name, value] of Object.entries(chromeVariables)) {
      this.root.style.setProperty(name, value);
    }
    host.container.appendChild(this.root);

    if (context.features.has("header_widget")) {
      this.toolbar = new Toolbar(context);
      this.root.appendChild(this.toolbar.el);
    }
    this.bodyRow = div("display:flex;flex:1 1 auto;min-height:0;overflow:hidden;position:relative;");
    this.root.appendChild(this.bodyRow);
    if (context.features.has("left_toolbar")) {
      this.leftSidebar = new LeftSidebar(
        context,
        {
          onTool: (tool) => {
            context.drawingTool = tool;
            host.renderer.cancelDraft();
            this.leftSidebar?.setTool(tool);
            context.requestPaint();
          },
          onIndicatorsClick: (anchor) => this.indicatorsMenu?.toggle(anchor),
          onObjectsTreeClick: (anchor) => this.objectsTree?.toggle(anchor),
          onFit: () => host.renderer.fitContent(),
          onScreenshot: () => host.renderer.takeScreenshot(),
          onFullscreen: () => this.toggleFullscreen(),
          onChartType: (style: ChartStyleId) => {
            context.chartStyle = style;
            this.leftSidebar?.setChartStyle(style);
            context.autoScalePrice = true;
            context.priceRange = null;
            context.requestPaint();
          },
        },
        options.raze?.sidebar ?? DEFAULT_SIDEBAR_ITEMS,
        options.raze?.chart_types,
      );
      this.bodyRow.appendChild(this.leftSidebar.el);
    }
    this.chartArea = div("position:relative;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden;user-select:none;-webkit-user-select:none;");
    this.bodyRow.appendChild(this.chartArea);
  }

  attach(): void {
    const { context, options, renderer, studies } = this.host;
    const primary = this.host.controllers.layout.primary;
    renderer.setToolDoneHandler((tool) => {
      context.drawingTool = tool;
      this.leftSidebar?.setTool(tool);
    });
    if (context.features.has("scale_bar")) {
      this.scaleBar = new ScaleBar(context, () => {
        this.scaleBar?.sync();
        context.requestPaint();
      });
      primary.appendChild(this.scaleBar.el);
    }
    this.loading = new LoadingScreen(options.loading_screen, context.theme.paneBackground);
    primary.appendChild(this.loading.el);
    context.dataChanged.subscribe(this.loadingOwner, this.onDataAvailable as (...args: never[]) => void);
    this.indicatorsMenu = new IndicatorsMenu(context, studies, resolveIndicatorPresets(options.raze, studies.registry));
    this.objectsTree = new ObjectsTree(context, this.host.shapes, studies);

    // Compact mode: below the breakpoint the left sidebar auto-hides so the
    // plot keeps the width (TV mobile behaviour). 0 disables.
    const compactBp = options.raze?.compact_breakpoint ?? 520;
    if (this.leftSidebar && compactBp > 0 && typeof ResizeObserver !== "undefined") {
      const sync = (): void => {
        const w = this.root.clientWidth || 0;
        if (this.leftSidebar) this.leftSidebar.el.style.display = w > 0 && w < compactBp ? "none" : "flex";
      };
      this.compactRO = new ResizeObserver(sync);
      this.compactRO.observe(this.root);
      sync();
    }
  }

  boot(): void {
    const { context, lifecycle, data } = this.host;
    const toolbar = this.toolbar;
    if (toolbar && context.features.has("header_resolutions")) {
      this.intervalSelector = new IntervalSelector(
        context,
        toolbar.intervalSlot,
        (res) => lifecycle.runDataChange(
          `change resolution to ${res}`,
          () => data.changeResolution(res),
          undefined,
          undefined,
          () => this.intervalSelector?.setActive(String(context.resolution)),
        ),
        context.options.favorites?.intervals?.map(String),
        () => data.getConfig(),
      );
      context.intervalChanged.subscribe(null, ((res: string) => {
        this.intervalSelector?.setActive(String(res));
      }) as never);
    }
    if (toolbar && context.features.has("header_symbol_search")) {
      this.symbolSearch = new SymbolSearch(context, (symbol) => lifecycle.runDataChange(
        `change symbol to ${symbol}`,
        () => data.changeSymbol(symbol),
        undefined,
        () => this.syncSymbol(context.symbol),
        () => this.symbolSearch?.setSymbol(context.symbol),
      ));
      toolbar.searchSlot.appendChild(this.symbolSearch.el);
    }
    if (toolbar && context.features.has("time_frames_toolbar")) {
      this.timeframeBar = new TimeframeBar(
        context,
        toolbar.rangeSlot,
        (preset) => {
          void this.applyPreset(preset).catch((error: unknown) => {
            if (lifecycle.destroyed) return;
            this.timeframeBar?.setActive(null);
            lifecycle.reportError(`apply timeframe ${preset}`, error);
          });
        },
        () => this.goToDate(),
      );
    }
    if (context.features.has("countdown")) {
      this.countdownTimer = window.setInterval(() => {
        if (!lifecycle.destroyed) context.requestPaint();
      }, 1000);
    }
  }

  createButton(options?: CreateButtonOptions): HTMLElement {
    // Chrome-less: return a detached element so callers don't crash.
    return this.toolbar ? this.toolbar.createButton(options) : document.createElement("div");
  }

  /** Refresh the accessible name after the symbol changed. */
  syncAccessibility(): void {
    const engine = this.host.engine;
    engine.syncAccessibility();
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", engine.accessibilityLabel);
    this.root.setAttribute("aria-describedby", engine.accessibilityDescriptionId);
  }

  /** Header state after the symbol changed. */
  syncSymbol(symbol: string): void {
    this.intervalSelector?.refresh();
    this.symbolSearch?.setSymbol(symbol);
  }

  finishLoading(): void {
    this.loading?.hide();
  }

  showEmptyState(): void {
    this.connectedLoading()?.showEmpty();
  }

  showLoadingError(): void {
    this.connectedLoading()?.showError();
  }

  /** The loading screen, re-mounted if a previous load already removed it. */
  private connectedLoading(): LoadingScreen | null {
    const loading = this.loading;
    if (loading && !loading.el.isConnected) this.host.controllers.layout.primary.appendChild(loading.el);
    return loading;
  }

  private toggleFullscreen(): void {
    const report = (error: unknown): void => this.host.lifecycle.reportError("toggle fullscreen", error);
    try {
      const request = !document.fullscreenElement
        ? this.root.requestFullscreen?.()
        : document.exitFullscreen?.();
      void request?.catch(report);
    } catch (error) {
      report(error);
    }
  }

  private async applyPreset(preset: TimeframePreset): Promise<void> {
    const { context, data } = this.host;
    const lastBar = context.bars[context.bars.length - 1];
    const now = Math.floor((lastBar?.time ?? Date.now()) / 1000);
    const resolved = resolveTimeframe({ value: preset, type: "period-back" }, now);
    if (!resolved) return;
    if (resolved.all) {
      const n = context.bars.length;
      if (n) {
        context.visibleRange = { from: 0, to: n - 1 };
        context.autoScalePrice = true;
        context.viewportChanged.fire(data.visibleUnixRange());
        context.requestPaint();
      }
      return;
    }
    await data.revealTimeRange(resolved.from, resolved.to);
  }

  private goToDate(): void {
    const { context, data, engine, lifecycle } = this.host;
    const raw = window.prompt("Go to date (YYYY-MM-DD or unix seconds)", "");
    if (!raw?.trim()) return;
    let sec = Number(raw);
    if (!Number.isFinite(sec)) {
      const ms = Date.parse(raw.trim());
      if (!Number.isFinite(ms)) {
        engine.announce("Enter a valid date or Unix timestamp.");
        return;
      }
      sec = Math.floor(ms / 1000);
    }
    const span = Math.max(1, context.visibleRange.to - context.visibleRange.from);
    const resMs = Math.max(1, (context.bars[1]?.time ?? 0) - (context.bars[0]?.time ?? 0));
    const halfSec = Math.floor((span * resMs) / 2000);
    void data.revealTimeRange(sec - halfSec, sec + halfSec).catch((error: unknown) => {
      if (!lifecycle.destroyed) lifecycle.reportError("go to date", error);
    });
  }

  destroy(): void {
    this.compactRO?.disconnect();
    this.compactRO = null;
    if (this.countdownTimer) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = 0;
    }
    this.host.context.dataChanged.unsubscribeAll(this.loadingOwner);
    this.objectsTree?.destroy();
    this.symbolSearch?.destroy();
    this.timeframeBar?.destroy();
    this.intervalSelector?.destroy();
    this.indicatorsMenu?.destroy();
    this.leftSidebar?.destroy();
    this.scaleBar?.destroy();
    this.toolbar?.destroy();
    this.loading?.destroy();
    this.root.remove();
  }
}
