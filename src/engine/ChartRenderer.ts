// Finance widget renderer: plot layout, layered scene paint, the default,
// reset and fit views, and the gesture host. Draw code lives in paint/*;
// interaction in GestureController; paint order and layer split in scene.ts;
// the canvas layers in ChartEngine/layers.ts. Visual constants must stay
// frozen (see layout.ts).

import type { Mark, TimescaleMark } from "../types/charting_library";
import {
  DEFAULT_BAR_SPACING,
  DEFAULT_VISIBLE_BARS,
  type ChartContext,
  type DrawingTool,
  type IndexRange,
} from "../core/context";
import type { ChartEngine, EngineResize } from "./ChartEngine";
import type { ShapeStore } from "../core/ShapeStore";
import type { TradingStore } from "../core/TradingStore";
import type { DataManager } from "../data/DataManager";
import type { StudyStore } from "../studies/StudyStore";
import {
  MAX_BAR_SPACING,
  PRICE_AXIS_W_DEFAULT,
  PRICE_AXIS_W_MIN,
  TIME_AXIS_H,
  computePlotLayout,
  timeAxisTop,
  type SubPaneGeom,
} from "./layout";
import {
  autoFitPriceRange,
  computePriceTicks,
  type PlotScale,
  toDisplay,
} from "./plotScale";
import { adjustPriceAxisWidth, computeTimeAxisTicks } from "./paint/axes";
import { composeLegendSnapshot } from "./paint/legend";
import type {
  Crosshair,
  DraftShape,
  FinanceView,
  MarkHit,
  ShapeHit,
  TimescaleMarkHit,
  TradingHit,
} from "./paint/view";
import { compareAutoScaleLevels } from "./paint/chrome";
import { paintFinanceLayer, paintFinanceScene } from "./scene";
import { SeriesTransformCache } from "./seriesTransform";
import { GestureController, type GestureHost } from "./gestures";

/** Right-edge padding, in bars, of the default, reset and fit views. */
export function defaultRightPadBars(visibleBars: number): number {
  return Math.min(8, Math.max(1, Math.round(visibleBars * 0.06)));
}

/**
 * Bars the default view shows so that, together with its right padding, it
 * spans `plotWidth` at `spacing` CSS px per bar. Null while the width is unknown.
 */
export function defaultVisibleBarsFor(plotWidth: number, spacing = DEFAULT_BAR_SPACING): number | null {
  if (!(plotWidth > 0) || !(spacing > 0)) return null;
  const span = plotWidth / spacing;
  return Math.max(2, Math.round(span + 1 - defaultRightPadBars(span)));
}

/** The default and reset view over `n` bars: the latest `count` bars plus the right padding. */
export function defaultViewRange(n: number, count: number): IndexRange {
  return { from: n - count, to: n - 1 + defaultRightPadBars(count) };
}

/**
 * Every loaded bar in view: the first candle fully inside the left edge and
 * the latest one followed by the right padding. Few bars never spread wider
 * than MAX_BAR_SPACING; the view then stays anchored to the latest bar.
 */
export function fitAllRange(n: number, plotWidth: number): IndexRange {
  const to = n - 1 + defaultRightPadBars(n);
  const from = plotWidth > 0 ? Math.min(-0.5, to - plotWidth / MAX_BAR_SPACING) : -0.5;
  return { from, to };
}

export class ChartRenderer implements GestureHost {
  readonly canvas: HTMLCanvasElement;
  crosshair: Crosshair = { x: 0, y: 0, active: false };
  plotL = 0;
  plotT = 0;
  plotW = 0;
  plotH = 0;
  subPanes: SubPaneGeom[] = [];
  volumePane: { top: number; h: number } | null = null;
  priceAxisW = PRICE_AXIS_W_DEFAULT;
  priceMin = 0;
  priceMax = 1;
  hoverShapeId: string | null = null;
  hoverTradingLineId: string | null = null;
  hoverTradingHit: "body" | "cancel" | null = null;
  hoverMark: Mark | null = null;
  /** Seam: hovered timescale-mark badge (set by interaction in W1B-10). */
  hoverTimescaleMark: TimescaleMark | null = null;
  lastPointerType = "mouse";
  onToolDone: ((tool: DrawingTool) => void) | null = null;
  draft: DraftShape | null = null;
  markScreen: MarkHit[] = [];
  shapeScreen: ShapeHit[] = [];
  tradingScreen: TradingHit[] = [];
  /** Seam: timescale-mark badge hit targets (filled by the badge painter in W1B-09). */
  timescaleMarkScreen: TimescaleMarkHit[] = [];

  private pctBase = 1;
  /** Log scale requested but the visible data reaches <= 0 (see autoFitPriceRange). */
  private logFallback = false;
  private readonly series = new SeriesTransformCache();
  private gestures: GestureController;
  private onData: () => void;
  /** Main-layer inputs as of the last main paint; see mainStateChanged(). */
  private mainKey: unknown[] = [];
  private priceTicks: number[] = [];
  private timeTicks: { index: number; time: number }[] = [];
  /**
   * Drawing hit list the overlay paints into (the draft ghost). Overlay
   * frames run without a main paint, which is what resets `shapeScreen`, so
   * anything they appended there would pile up and be hit-tested as a real
   * drawing. Cleared every overlay frame.
   */
  private readonly overlayShapeScreen: ShapeHit[] = [];
  /** Pointers currently pressed on the chart (drags edit drawings in place). */
  private readonly pressed = new Set<number>();
  /**
   * Price-axis width measured on a frame that painted bars; null before the
   * first one. Whether an empty frame (placeholder labels) paints before the
   * first data load is a race, so the default view must not read
   * `priceAxisW` until bars painted (see defaultPlotWidth()).
   */
  private dataAxisW: number | null = null;
  /** The default view fell back to DEFAULT_VISIBLE_BARS because the plot had no width yet. */
  private defaultViewFallback = false;
  private readonly defaultVisibleBarsProvider = (): number => {
    const count = defaultVisibleBarsFor(this.defaultPlotWidth());
    if (count === null) {
      this.defaultViewFallback = true;
      return DEFAULT_VISIBLE_BARS;
    }
    return count;
  };
  private readonly onPressStart = (e: PointerEvent): void => {
    this.pressed.add(e.pointerId);
  };
  private readonly onPressEnd = (e: PointerEvent): void => {
    this.pressed.delete(e.pointerId);
  };
  /**
   * A pointer event with no button down (a hover move, or the capture loss
   * that follows a release) proves the pointer was released, even when the
   * pointerup never reached the window listener (lost capture, another frame
   * or a stopped event). A press stuck in the set would turn every later
   * hover frame into a full scene repaint. A capture lost while a button is
   * still down keeps the press: the gesture keeps dragging on canvas moves.
   */
  private readonly onPressIdle = (e: PointerEvent): void => {
    if (e.buttons === 0) this.pressed.delete(e.pointerId);
  };
  /** A window blur mid-drag can swallow the release: forget every press. */
  private readonly onPressBlur = (): void => {
    this.pressed.clear();
  };

  constructor(
    readonly context: ChartContext,
    readonly engine: ChartEngine,
    readonly shapes: ShapeStore,
    readonly trading: TradingStore,
    readonly data: DataManager,
    readonly studies: StudyStore,
  ) {
    this.canvas = engine.canvas;
    this.gestures = new GestureController(this);
    this.onData = () => {
      this.series.invalidate();
      this.engine.markDirty();
    };
  }

  get selectedShapeId(): string | null {
    return this.context.selectedShapeId;
  }

  /**
   * Gesture repaint request. Hover and crosshair moves only invalidate the
   * overlay layer; the engine still repaints the main layer when state it
   * paints (range, scale, selection, hover target, ...) changed, and always
   * while a pointer is pressed, because drags edit drawings in place.
   */
  requestPaint(): void {
    if (this.pressed.size) this.engine.markDirty();
    else this.engine.markOverlayDirty();
  }

  setToolDoneHandler(fn: (tool: DrawingTool) => void): void {
    this.onToolDone = fn;
  }

  attach(): void {
    this.series.invalidate();
    this.engine.paintHook = (ctx) => this.render(ctx);
    this.engine.overlayPaintHook = (ctx) => this.renderOverlay(ctx);
    this.engine.mainInvalidationCheck = () => this.mainStateChanged();
    this.engine.onResize = (size) => this.onEngineResize(size);
    this.context.defaultVisibleBars = this.defaultVisibleBarsProvider;
    this.context.dataChanged.subscribe(null, this.onData as never);
    // Capture phase: the press is known before the gesture handlers run.
    this.canvas.addEventListener("pointerdown", this.onPressStart, true);
    this.canvas.addEventListener("pointermove", this.onPressIdle, true);
    this.canvas.addEventListener("lostpointercapture", this.onPressIdle, true);
    window.addEventListener("pointerup", this.onPressEnd, true);
    window.addEventListener("pointercancel", this.onPressEnd, true);
    window.addEventListener("blur", this.onPressBlur);
    this.gestures.attach();
  }

  destroy(): void {
    this.context.dataChanged.unsubscribe(null, this.onData as never);
    this.gestures.destroy();
    this.canvas.removeEventListener("pointerdown", this.onPressStart, true);
    this.canvas.removeEventListener("pointermove", this.onPressIdle, true);
    this.canvas.removeEventListener("lostpointercapture", this.onPressIdle, true);
    window.removeEventListener("pointerup", this.onPressEnd, true);
    window.removeEventListener("pointercancel", this.onPressEnd, true);
    window.removeEventListener("blur", this.onPressBlur);
    this.pressed.clear();
    this.engine.paintHook = null;
    this.engine.overlayPaintHook = null;
    this.engine.mainInvalidationCheck = null;
    this.engine.onResize = null;
    if (this.context.defaultVisibleBars === this.defaultVisibleBarsProvider) {
      this.context.defaultVisibleBars = () => DEFAULT_VISIBLE_BARS;
    }
    this.series.invalidate();
  }

  /**
   * Fit every loaded bar in view (F, double-click, the sidebar Fit button)
   * and re-enable price autoscale. Goes through setViewport, so it fires
   * exactly one `viewportChanged` (layout sync, visible-range events) when
   * the range moves. Returns true when the view or the scale changed.
   */
  fitContent(): boolean {
    return this.applyView(fitAllRange(this.context.bars.length, this.currentPlotWidth()), "fit");
  }

  /**
   * Reset to the default view: DEFAULT_BAR_SPACING px per bar anchored to the
   * latest bar (TradingView's "Reset chart view"), with price autoscale.
   * Returns true when the view or the scale changed.
   */
  resetView(): boolean {
    const n = this.context.bars.length;
    return this.applyView(defaultViewRange(n, this.context.defaultVisibleBars()), "reset");
  }

  private applyView(range: IndexRange, reason: "fit" | "reset"): boolean {
    const scaled = this.context.setScaleMode({ autoScale: true }, reason);
    const moved = this.context.bars.length > 0 && this.context.setViewport(range, reason);
    return scaled || moved;
  }

  /**
   * The whole chart (scene plus overlay) repainted into a new canvas at device
   * resolution, for screenshots and exports. It repaints instead of stacking
   * the layer bitmaps (ChartEngine.composite()): Chromium draws text on the
   * opaque `{ alpha: false }` scene layer with LCD subpixel anti-aliasing,
   * whose colour fringes look wrong once a PNG is scaled or shown on another
   * display. This canvas keeps alpha, so exported text is greyscale. Hover,
   * hit testing and the on-screen layers are left untouched.
   */
  snapshot(): HTMLCanvasElement {
    const { cssWidth: width, cssHeight: height, dpr } = this.engine;
    const out = document.createElement("canvas");
    out.width = Math.floor(width * dpr);
    out.height = Math.floor(height * dpr);
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("[raze-charts] 2D canvas context unavailable");
    if (width <= 0 || height <= 0 || this.plotW <= 0) return out;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.context.theme.paneBackground;
    ctx.fillRect(0, 0, width, height);
    // Scratch hit lists: an export must not replace the ones hit testing reads.
    const view = this.financeView();
    view.markScreen = [];
    view.shapeScreen = [];
    view.tradingScreen = [];
    view.timescaleMarkScreen = [];
    paintFinanceScene(ctx, view, this.priceTicks, this.timeTicks);
    return out;
  }

  takeScreenshot(): void {
    try {
      // The DOM legend is not in the canvas bitmap; paint it into the export.
      composeLegendSnapshot(this.snapshot(), this.financeView()).toBlob((blob) => {
        if (!blob) {
          console.warn("[raze-charts] takeScreenshot: the chart has no pixels to export yet (zero-size container?)");
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `raze-chart-${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, "image/png");
    } catch (error) {
      console.warn(`[raze-charts] takeScreenshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  cancelDraft(): void {
    this.draft = null;
    this.engine.markOverlayDirty();
  }

  plotScale(): PlotScale {
    return {
      plotL: this.plotL,
      plotT: this.plotT,
      plotW: this.plotW,
      plotH: this.plotH,
      priceMin: this.priceMin,
      priceMax: this.priceMax,
      pctBase: this.pctBase,
      visibleRange: this.context.visibleRange,
      percentScale: this.context.percentScale,
      logScale: this.context.logScale,
      logFallback: this.logFallback,
    };
  }

  financeView(): FinanceView {
    const s = this.plotScale();
    const axisTop = timeAxisTop(this.plotT, this.plotH, this.subPanes, this.volumePane);
    return {
      ...s,
      context: this.context,
      cssWidth: this.engine.cssWidth,
      cssHeight: this.engine.cssHeight,
      dpr: this.engine.dpr,
      priceAxisW: this.priceAxisW,
      subPanes: this.subPanes,
      volumePane: this.volumePane,
      seriesBars: this.series.current,
      studies: this.studies,
      shapes: this.shapes,
      trading: this.trading,
      markScreen: this.markScreen,
      shapeScreen: this.shapeScreen,
      tradingScreen: this.tradingScreen,
      timescaleMarkScreen: this.timescaleMarkScreen,
      crosshair: this.crosshair,
      hoverMark: this.hoverMark,
      hoverTimescaleMark: this.hoverTimescaleMark,
      hoverShapeId: this.hoverShapeId,
      draft: this.draft,
      selectedShapeId: this.context.selectedShapeId,
      selectedTradingLineId: this.context.selectedTradingLineId,
      fontFamily: this.context.fontFamily,
      axisTags: [],
      axisChromeRect: {
        x: this.plotL + this.plotW,
        y: axisTop,
        w: this.priceAxisW,
        h: TIME_AXIS_H,
      },
    };
  }

  timePriceAt(x: number, y: number): { unixTime: number; price: number } {
    return this.gestures.timePriceAt(x, y);
  }

  timePriceAtEvent(e: MouseEvent): { unixTime: number; price: number } {
    const { x, y } = this.gestures.pointerXY(e);
    return this.timePriceAt(x, y);
  }

  /** Plot width with a price axis `axisWidth` px wide, from the engine size (0 while unknown). */
  private plotWidthFor(axisWidth: number): number {
    const width = this.engine.cssWidth;
    return width > 0 ? Math.max(0, width - axisWidth) : 0;
  }

  /** Plot width for the next frame (0 while unknown). */
  private currentPlotWidth(): number {
    return this.plotWidthFor(this.priceAxisW);
  }

  /**
   * Plot width the default view is sized for: the axis width measured on bars,
   * or PRICE_AXIS_W_MIN before any bar painted. That is what an empty frame
   * measures (its placeholder labels never reach the minimum), so panes of a
   * layout that boot together derive the same bar count whether or not one of
   * them painted an empty frame first.
   */
  private defaultPlotWidth(): number {
    return this.plotWidthFor(this.dataAxisW ?? PRICE_AXIS_W_MIN);
  }

  /**
   * Keep the bar spacing across width changes, anchored to the right edge,
   * as TradingView does: a wider pane shows more history instead of fatter
   * candles. A chart that booted with no width gets its default view once it
   * is laid out. Reason `resize` keeps the change local to this pane (no
   * `viewportChanged`, so no layout relay): every pane of a layout rescales by
   * its own width ratio, which keeps equal-width panes in sync.
   */
  private onEngineResize({ width, previousWidth }: EngineResize): void {
    const n = this.context.bars.length;
    if (!n) return;
    const next = width - this.priceAxisW;
    const previous = previousWidth - this.priceAxisW;
    if (next <= 0 || next === previous) return;
    const range = this.context.visibleRange;
    if (previous <= 0) {
      const fallback = defaultViewRange(n, DEFAULT_VISIBLE_BARS);
      if (this.defaultViewFallback && range.from === fallback.from && range.to === fallback.to) {
        const count = defaultVisibleBarsFor(this.defaultPlotWidth()) ?? DEFAULT_VISIBLE_BARS;
        this.context.setViewport(defaultViewRange(n, count), "resize");
      }
      this.defaultViewFallback = false;
      return;
    }
    const span = range.to - range.from;
    if (!(span > 0)) return;
    if (this.context.setViewport({ from: range.to - (span * next) / previous, to: range.to }, "resize")) {
      // A wider pane can uncover the left edge of the loaded history.
      void this.data.maybeLoadMoreHistory?.();
    }
  }

  private refreshSeriesBars(): void {
    this.series.resolve(this.context.chartStyle, this.context.bars);
  }

  /**
   * Everything the main layer paints that a gesture can change without
   * calling markDirty(). Compared on overlay-only frames.
   */
  private mainStateKey(): unknown[] {
    const c = this.context;
    const range = c.visibleRange;
    const price = c.priceRange;
    return [
      range?.from, range?.to, c.autoScalePrice, price?.min, price?.max, c.logScale, c.percentScale,
      c.chartStyle, c.volumeMode, c.bars, c.bars?.length, c.compare, c.compare?.length, c.theme, c.symbol,
      c.resolution, c.symbolInfo, c.marks, c.timescaleMarks, c.selectedShapeId, c.selectedTradingLineId,
      this.hoverShapeId, this.hoverTradingLineId, this.hoverTradingHit, this.hoverTimescaleMark,
    ];
  }

  private mainStateChanged(): boolean {
    const key = this.mainStateKey();
    const previous = this.mainKey;
    if (key.length !== previous.length) return true;
    for (let i = 0; i < key.length; i++) {
      if (!Object.is(key[i], previous[i])) return true;
    }
    return false;
  }

  private render(ctx: CanvasRenderingContext2D): void {
    const W = this.engine.cssWidth;
    const H = this.engine.cssHeight;
    if (W <= 0 || H <= 0) return;

    const layout = computePlotLayout(
      W,
      H,
      this.priceAxisW,
      this.studies.paneDefs(),
      this.context.volumeMode,
    );
    this.plotL = layout.plotL;
    this.plotT = layout.plotT;
    this.plotW = layout.plotW;
    this.plotH = layout.plotH;
    this.subPanes = layout.subPanes;
    this.volumePane = layout.volumePane;

    this.refreshSeriesBars();
    const seriesBars = this.series.current;
    const bars = seriesBars.length ? seriesBars : this.context.bars;
    const fitted = autoFitPriceRange(
      bars,
      this.plotScale(),
      this.context.autoScalePrice,
      this.context.priceRange,
    );
    this.pctBase = fitted.pctBase;
    this.logFallback = fitted.logFallback;
    this.priceMin = fitted.priceMin;
    this.priceMax = fitted.priceMax;
    if (this.context.autoScalePrice) {
      const scale = { ...this.plotScale(), pctBase: fitted.pctBase };
      const levels = this.trading.autoScalePrices()
        .map((price) => toDisplay(scale, price))
        .filter(Number.isFinite)
        .concat(compareAutoScaleLevels(scale, this.context));
      if (levels.length) {
        const low = Math.min(this.priceMin, ...levels);
        const high = Math.max(this.priceMax, ...levels);
        const pad = Math.max((high - low) * 0.06, Math.abs(high) * 0.001, 1e-9);
        this.priceMin = low - pad;
        this.priceMax = high + pad;
      }
    }

    const v = this.financeView();
    const priceTicks = computePriceTicks(v);
    const timeTicks = computeTimeAxisTicks(ctx, v);
    this.priceTicks = priceTicks;
    this.timeTicks = timeTicks;

    const desired = adjustPriceAxisWidth(ctx, v, priceTicks);
    if (Math.abs(desired - this.priceAxisW) > 1) {
      this.priceAxisW = desired;
      this.engine.markDirty();
    }
    if (this.context.bars.length) this.dataAxisW = this.priceAxisW;

    paintFinanceLayer("main", ctx, v, priceTicks, timeTicks);
    this.mainKey = this.mainStateKey();

    if ((window as unknown as { __RAZE_DEBUG?: boolean }).__RAZE_DEBUG) {
      const all = this.context.bars;
      let nonzero = 0, firstReal = -1, lastReal = -1;
      for (let i = 0; i < all.length; i++) {
        if (all[i]!.close > 0) { nonzero++; if (firstReal < 0) firstReal = i; lastReal = i; }
      }
      // The window holds the last painted pane; each canvas holds its own
      // pane's state (multi-chart layouts).
      (window as unknown as { __razeChartState?: unknown }).__razeChartState =
      (this.canvas as unknown as { __razeChartState?: unknown }).__razeChartState = {
        bars: all.length, nonzero, firstReal, lastReal,
        visibleRange: { ...this.context.visibleRange },
        plotW: this.plotW,
        barSpacing: this.plotW / Math.max(1e-9, this.context.visibleRange.to - this.context.visibleRange.from),
        priceMin: this.priceMin, priceMax: this.priceMax,
        firstBarClose: all[0]?.close, lastBarClose: all[all.length - 1]?.close,
        studies: this.studies.list().map((s) => ({ id: s.id, name: s.name, length: s.length })),
        crosshair: { ...this.crosshair },
        paints: { ...this.engine.paintStats },
      };
    }
  }

  /**
   * Overlay layer: reuses the geometry and hit lists of the last main paint.
   * Overlay painters may read those lists (the mark tooltip reads
   * markScreen) but never add to them; the draft ghost goes to a scratch list.
   */
  private renderOverlay(ctx: CanvasRenderingContext2D): void {
    if (this.engine.cssWidth <= 0 || this.engine.cssHeight <= 0 || this.plotW <= 0) return;
    const view = this.financeView();
    this.overlayShapeScreen.length = 0;
    view.shapeScreen = this.overlayShapeScreen;
    paintFinanceLayer("overlay", ctx, view, this.priceTicks, this.timeTicks);
  }
}
