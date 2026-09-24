// Widget chrome: the root/body/chart-area shell with its size and CSS custom
// properties, the header (interval, symbol search, timeframes, custom
// buttons), the left sidebar, scale bar, loading states, indicator and
// object-tree popups, compact mode, fullscreen, the go-to-date popover and the
// countdown tick.

import type { CreateButtonOptions } from "../../types/charting_library";
import { TimeIndex } from "../../data/TimeIndex";
import { t } from "../../i18n";
import { openGoToDatePopover } from "../../ui/GoToDatePopover";
import { IndicatorsMenu, resolveIndicatorPresets } from "../../ui/IndicatorsMenu";
import { IntervalSelector } from "../../ui/IntervalSelector";
import { DEFAULT_SIDEBAR_ITEMS, LeftSidebar, type ChartStyleId } from "../../ui/LeftSidebar";
import { LoadingScreen } from "../../ui/LoadingScreen";
import { ObjectsTree } from "../../ui/ObjectsTree";
import { ensureBaseStyles } from "../../ui/popup";
import { ScaleBar } from "../../ui/ScaleBar";
import { SymbolSearch } from "../../ui/SymbolSearch";
import { TimeframeBar } from "../../ui/TimeframeBar";
import type { PopoverHandle } from "../../ui/kit/Popover";
import { Toolbar } from "../../ui/Toolbar";
import { parseResolution, resolutionToMs } from "../../util/resolution";
import { resolveTimezone } from "../context";
import { isLightColor } from "../theme";
import { resolveTimeframe, type TimeframePreset } from "../timeframe";
import type { WidgetController, WidgetHost } from "./host";
import { applyRootSize, reportOptionProblems, resolveRootSize } from "./options";

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
  private goToDatePopover: PopoverHandle | null = null;
  private readonly loadingOwner = {};
  private readonly onDataAvailable = (): void => {
    if (this.host.context.bars.length) this.finishLoading();
  };

  constructor(private readonly host: WidgetHost) {
    const { context, options } = host;
    const theme = context.theme;
    ensureBaseStyles();
    reportOptionProblems(options);
    this.root = div([
      "position:relative",
      "display:flex",
      "flex-direction:column",
      "overflow:hidden",
      "user-select:none",
      "-webkit-user-select:none",
    ].join(";"));
    this.root.className = "raze-chart-root";
    applyRootSize(this.root, resolveRootSize(options));
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
            context.setChartType(style, "sidebar");
            context.setScaleMode({ autoScale: true }, "chart-type");
            this.leftSidebar?.setChartStyle(style);
          },
        },
        options.raze?.sidebar ?? DEFAULT_SIDEBAR_ITEMS,
        options.raze?.chart_types,
      );
      this.bodyRow.appendChild(this.leftSidebar.el);
    }
    this.chartArea = div("position:relative;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden;user-select:none;-webkit-user-select:none;");
    this.bodyRow.appendChild(this.chartArea);
    this.root.addEventListener("keydown", this.onRootKeyDown);
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
    if (toolbar && context.features.has("timeframes_toolbar")) {
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
        () => this.toggleGoToDate(),
      );
      const dateButton = this.goToDateAnchor();
      dateButton?.setAttribute("aria-haspopup", "dialog");
      dateButton?.setAttribute("aria-expanded", "false");
      dateButton?.setAttribute("aria-keyshortcuts", "Alt+G");
    }
    if (context.features.has("countdown")) {
      this.countdownTimer = window.setInterval(() => {
        if (!lifecycle.destroyed) context.requestOverlayPaint();
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
    const now = Math.floor((lastBar?.time ?? context.now()) / 1000);
    const resolved = resolveTimeframe({ value: preset, type: "period-back" }, now);
    if (!resolved) return;
    if (resolved.all) {
      const n = context.bars.length;
      if (n) {
        context.setViewport({ from: 0, to: n - 1 }, "preset");
        context.setScaleMode({ autoScale: true }, "preset");
      }
      return;
    }
    await data.revealTimeRange(resolved.from, resolved.to);
  }

  // ── Go to date ──────────────────────────────────────────────────────────

  /** Alt+G opens go-to-date (TradingView's shortcut) while focus is in the chart. */
  private readonly onRootKeyDown = (event: KeyboardEvent): void => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.defaultPrevented) return;
    if (event.code !== "KeyG" && event.key.toLowerCase() !== "g") return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if (!this.goToDateAnchor()) return;
    event.preventDefault();
    this.toggleGoToDate();
  };

  /** The header's Date control (the last button of the range bar), or null without one. */
  private goToDateAnchor(): HTMLElement | null {
    const buttons = this.timeframeBar?.el.querySelectorAll("button");
    return buttons?.length ? buttons[buttons.length - 1]! : null;
  }

  /** Open the go-to-date popover, or close it when it is already open. */
  private toggleGoToDate(): void {
    const open = this.goToDatePopover;
    if (open && !open.closed) {
      open.close({ reason: "api" });
      return;
    }
    const anchor = this.goToDateAnchor();
    if (!anchor || this.host.lifecycle.destroyed) return;
    const { context } = this.host;
    const bars = context.bars;
    const { from, to } = context.visibleRange;
    const centre = bars.length
      ? bars[Math.max(0, Math.min(bars.length - 1, Math.round((from + to) / 2)))]!.time
      : context.now();
    this.goToDatePopover = openGoToDatePopover({
      anchor,
      timeZone: resolveTimezone(context.timezone, context.symbolInfo),
      includeTime: isIntraday(String(context.resolution)),
      initial: centre,
      max: Math.max(context.now(), bars[bars.length - 1]?.time ?? 0),
      themeRoot: this.root,
      colorScheme: isLightColor(context.theme.paneBackground) ? "light" : "dark",
      fontFamily: context.fontFamily,
      onSubmit: (timeMs, label) => this.goToDate(timeMs, label),
      onClose: () => {
        this.goToDatePopover = null;
      },
    });
  }

  /**
   * Centre the bar nearest `timeMs` (clamped to the latest bar) at the current
   * zoom level, paging older history in first when needed.
   */
  private async goToDate(timeMs: number, label: string): Promise<void> {
    const { context, data, engine, lifecycle } = this.host;
    if (lifecycle.destroyed) return;
    const resMs = resolutionToMs(String(context.resolution));
    const latest = context.bars[context.bars.length - 1]?.time;
    const target = latest === undefined ? timeMs : Math.min(timeMs, latest);
    const span = Math.max(2, context.visibleRange.to - context.visibleRange.from);
    const halfSec = Math.max(1, Math.round((span * resMs) / 2000));
    const centreSec = Math.floor(target / 1000);
    try {
      await data.revealTimeRange(centreSec - halfSec, centreSec + halfSec);
    } catch (error) {
      if (!lifecycle.destroyed) lifecycle.reportError("go to date", error);
      throw error;
    }
    if (lifecycle.destroyed) return;
    const bars = context.bars;
    const index = bars.length ? new TimeIndex(bars, resMs).indexAt(target) : null;
    if (index !== null) {
      const bar = Math.max(0, Math.min(bars.length - 1, Math.round(index)));
      context.setViewport({ from: bar - span / 2, to: bar + span / 2 }, "timeframe");
      context.setScaleMode({ autoScale: true }, "preset");
    }
    engine.announce(t("goToDate.announce", "Showing {date}.", { date: label }));
  }

  destroy(): void {
    this.goToDatePopover?.close({ restoreFocus: false, reason: "api" });
    this.goToDatePopover = null;
    this.root.removeEventListener("keydown", this.onRootKeyDown);
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

function isIntraday(resolution: string): boolean {
  const kind = parseResolution(resolution).kind;
  return kind === "seconds" || kind === "minutes" || kind === "hours";
}
