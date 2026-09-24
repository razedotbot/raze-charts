// Finance widget renderer: plot layout, scene paint, and gesture host.
// Draw code lives in paint/*; interaction in GestureController; paint order
// in scene.ts. Visual constants must stay frozen (see layout.ts).

import type { Bar, Mark, TimescaleMark } from "../types/charting_library";
import type { ChartContext, DrawingTool } from "../core/context";
import type { ChartEngine } from "./ChartEngine";
import type { ShapeStore } from "../core/ShapeStore";
import type { TradingStore } from "../core/TradingStore";
import type { DataManager } from "../data/DataManager";
import type { StudyStore } from "../studies/StudyStore";
import { heikinAshi } from "../util/heikinAshi";
import {
  PRICE_AXIS_W_DEFAULT,
  TIME_AXIS_H,
  computePlotLayout,
  timeAxisTop,
  type SubPaneGeom,
} from "./layout";
import {
  autoFitPriceRange,
  computePriceTicks,
  computeTimeTicks,
  type PlotScale,
  toDisplay,
} from "./plotScale";
import { adjustPriceAxisWidth } from "./paint/axes";
import type {
  Crosshair,
  DraftShape,
  FinanceView,
  MarkHit,
  ShapeHit,
  TimescaleMarkHit,
  TradingHit,
} from "./paint/view";
import { paintFinanceScene } from "./scene";
import { GestureController, type GestureHost } from "./gestures";

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
  private seriesBars: Bar[] = [];
  private heikinAshiSource: Bar[] | null = null;
  private heikinAshiBars: Bar[] | null = null;
  private cachedChartStyle: ChartContext["chartStyle"] | null = null;
  private gestures: GestureController;
  private onData: () => void;

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
      this.invalidateSeriesBars();
      this.engine.markDirty();
    };
  }

  get selectedShapeId(): string | null {
    return this.context.selectedShapeId;
  }

  requestPaint(): void {
    this.engine.markDirty();
  }

  setToolDoneHandler(fn: (tool: DrawingTool) => void): void {
    this.onToolDone = fn;
  }

  attach(): void {
    this.invalidateSeriesBars();
    this.engine.paintHook = (ctx) => this.render(ctx);
    this.context.dataChanged.subscribe(null, this.onData as never);
    this.gestures.attach();
  }

  destroy(): void {
    this.context.dataChanged.unsubscribe(null, this.onData as never);
    this.gestures.destroy();
    this.engine.paintHook = null;
    this.invalidateSeriesBars();
  }

  fitContent(): void {
    const n = this.context.bars.length;
    this.context.priceRange = null;
    this.context.autoScalePrice = true;
    if (n) {
      const count = Math.min(n, 120);
      this.context.visibleRange = {
        from: n - count,
        to: n - 1 + Math.max(2, Math.floor(count * 0.08)),
      };
    }
    this.engine.markDirty();
  }

  takeScreenshot(): void {
    try {
      this.canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `raze-chart-${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, "image/png");
    } catch {
      /* ignore */
    }
  }

  cancelDraft(): void {
    this.draft = null;
    this.engine.markDirty();
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
      seriesBars: this.seriesBars,
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

  private refreshSeriesBars(): void {
    const style = this.context.chartStyle;
    if (style !== this.cachedChartStyle) {
      this.invalidateSeriesBars();
      this.cachedChartStyle = style;
    }

    if (style !== "heikin_ashi") {
      this.seriesBars = this.context.bars;
      return;
    }

    // DataManager fires dataChanged for both array replacement and in-place
    // forming-bar updates. Retaining the transformed array between those
    // events keeps pointer-driven repaints O(visible bars), while the source
    // identity check also protects callers that replace context.bars directly.
    if (this.heikinAshiSource !== this.context.bars || !this.heikinAshiBars) {
      this.heikinAshiSource = this.context.bars;
      this.heikinAshiBars = heikinAshi(this.context.bars);
    }
    this.seriesBars = this.heikinAshiBars;
  }

  private invalidateSeriesBars(): void {
    this.heikinAshiSource = null;
    this.heikinAshiBars = null;
    this.seriesBars = [];
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
    const bars = this.seriesBars.length ? this.seriesBars : this.context.bars;
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
        .filter(Number.isFinite);
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
    const timeTicks = computeTimeTicks(this.context.bars, v);

    const desired = adjustPriceAxisWidth(ctx, v, priceTicks);
    if (Math.abs(desired - this.priceAxisW) > 1) {
      this.priceAxisW = desired;
      this.engine.markDirty();
    }

    paintFinanceScene(ctx, v, priceTicks, timeTicks);

    if ((window as unknown as { __RAZE_DEBUG?: boolean }).__RAZE_DEBUG) {
      const all = this.context.bars;
      let nonzero = 0, firstReal = -1, lastReal = -1;
      for (let i = 0; i < all.length; i++) {
        if (all[i]!.close > 0) { nonzero++; if (firstReal < 0) firstReal = i; lastReal = i; }
      }
      (window as unknown as { __razeChartState?: unknown }).__razeChartState = {
        bars: all.length, nonzero, firstReal, lastReal,
        visibleRange: { ...this.context.visibleRange },
        priceMin: this.priceMin, priceMax: this.priceMax,
        firstBarClose: all[0]?.close, lastBarClose: all[all.length - 1]?.close,
        studies: this.studies.list().map((s) => ({ id: s.id, name: s.name, length: s.length })),
        crosshair: { ...this.crosshair },
      };
    }
  }
}
