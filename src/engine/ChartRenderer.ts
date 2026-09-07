// Finance widget renderer: plot layout, scene paint, and gesture host.
// Draw code lives in paint/*; interaction in GestureController; paint order
// in scene.ts. Visual constants must stay frozen (see layout.ts).

import type { Bar, Mark } from "../types/charting_library";
import type { ChartContext, DrawingTool } from "../core/context";
import type { ChartEngine } from "./ChartEngine";
import type { ShapeStore } from "../core/ShapeStore";
import type { DataManager } from "../data/DataManager";
import type { StudyStore } from "../studies/StudyStore";
import { heikinAshi } from "../util/heikinAshi";
import {
  PRICE_AXIS_W_DEFAULT,
  computePlotLayout,
  type SubPaneGeom,
} from "./layout";
import {
  autoFitPriceRange,
  computePriceTicks,
  computeTimeTicks,
  type PlotScale,
} from "./plotScale";
import { adjustPriceAxisWidth } from "./paint/axes";
import type { Crosshair, DraftShape, FinanceView, MarkHit, ShapeHit } from "./paint/view";
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
  priceAxisW = PRICE_AXIS_W_DEFAULT;
  priceMin = 0;
  priceMax = 1;
  hoverShapeId: string | null = null;
  hoverMark: Mark | null = null;
  lastPointerType = "mouse";
  onToolDone: ((tool: DrawingTool) => void) | null = null;
  draft: DraftShape | null = null;
  markScreen: MarkHit[] = [];
  shapeScreen: ShapeHit[] = [];

  private pctBase = 1;
  private seriesBars: Bar[] = [];
  private gestures: GestureController;
  private onData: () => void;

  constructor(
    readonly context: ChartContext,
    readonly engine: ChartEngine,
    readonly shapes: ShapeStore,
    readonly data: DataManager,
    readonly studies: StudyStore,
  ) {
    this.canvas = engine.canvas;
    this.gestures = new GestureController(this);
    this.onData = () => this.engine.markDirty();
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
    this.engine.paintHook = (ctx) => this.render(ctx);
    this.context.dataChanged.subscribe(null, this.onData as never);
    this.gestures.attach();
  }

  destroy(): void {
    this.context.dataChanged.unsubscribe(null, this.onData as never);
    this.gestures.destroy();
    this.engine.paintHook = null;
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
    };
  }

  financeView(): FinanceView {
    const s = this.plotScale();
    return {
      ...s,
      context: this.context,
      cssWidth: this.engine.cssWidth,
      cssHeight: this.engine.cssHeight,
      priceAxisW: this.priceAxisW,
      subPanes: this.subPanes,
      seriesBars: this.seriesBars,
      studies: this.studies,
      shapes: this.shapes,
      markScreen: this.markScreen,
      shapeScreen: this.shapeScreen,
      crosshair: this.crosshair,
      hoverMark: this.hoverMark,
      draft: this.draft,
      selectedShapeId: this.context.selectedShapeId,
      fontFamily: this.context.fontFamily,
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
    if (this.context.chartStyle === "heikin_ashi") {
      this.seriesBars = heikinAshi(this.context.bars);
    } else {
      this.seriesBars = this.context.bars;
    }
  }

  private render(ctx: CanvasRenderingContext2D): void {
    const W = this.engine.cssWidth;
    const H = this.engine.cssHeight;
    if (W <= 0 || H <= 0) return;

    const layout = computePlotLayout(W, H, this.priceAxisW, this.studies.paneDefs());
    this.plotL = layout.plotL;
    this.plotT = layout.plotT;
    this.plotW = layout.plotW;
    this.plotH = layout.plotH;
    this.subPanes = layout.subPanes;

    this.refreshSeriesBars();
    const bars = this.seriesBars.length ? this.seriesBars : this.context.bars;
    const fitted = autoFitPriceRange(
      bars,
      this.plotScale(),
      this.context.autoScalePrice,
      this.context.priceRange,
    );
    this.pctBase = fitted.pctBase;
    this.priceMin = fitted.priceMin;
    this.priceMax = fitted.priceMax;

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
