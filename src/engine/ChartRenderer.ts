// The renderer: turns the bar series + marks + shapes on the shared context
// into pixels on the engine's canvas, and owns all pointer interaction
// (pan, wheel-zoom, crosshair, shape drag, lazy history loading).
//
// Layout (single main pane):
//   ┌───────────────────────────────┬─────┐
//   │ legend                        │  P  │  P = price axis (right)
//   │            candles            │  r  │
//   │            + volume overlay   │  i  │
//   │            + marks + shapes   │  c  │
//   ├───────────────────────────────┴─────┤
//   │ time axis (bottom)                  │
//   └─────────────────────────────────────┘

import type { Bar, Mark, MarkCustomColor, ShapePoint, StudyDefinition } from "../types/charting_library";
import type { ChartContext, DrawingTool } from "../core/context";
import type { ChartEngine } from "./ChartEngine";
import type { ShapeStore, StoredShape } from "../core/ShapeStore";
import type { DataManager } from "../data/DataManager";
import type { StudyStore } from "../studies/StudyStore";
import { resolutionToMs, parseResolution } from "../util/resolution";
import { decimalsFromPricescale, formatPrice, formatVolume } from "../util/format";
import { heikinAshi } from "../util/heikinAshi";

const PRICE_AXIS_W_DEFAULT = 64;
const PRICE_AXIS_W_MIN = 56;
const PRICE_AXIS_W_MAX = 128;
const TIME_AXIS_H = 22;
const MIN_BAR_SPACING = 1.5;
const MAX_BAR_SPACING = 64;
const VOLUME_FRACTION = 0.16; // bottom 16% of the main plot reserved for volume bars
const SUB_PANE_FRACTION = 0.22; // of full canvas height per study sub-pane (RSI, custom panes)
const SUB_PANES_MAX_FRACTION = 0.45; // all sub-panes together never squeeze the main plot below ~55%
const SUB_PANE_GAP = 3;
const CANDLE_MAX_WIDTH = 18;  // cap so few-bar charts don't render giant blocks

// Round time-step boundaries (ms) for time-axis gridlines, ascending.
const SEC = 1000, MIN_MS = 60_000, HR = 3_600_000, DAY_MS = 86_400_000;
const NICE_TIME_STEPS = [
  SEC, 5 * SEC, 15 * SEC, 30 * SEC,
  MIN_MS, 5 * MIN_MS, 15 * MIN_MS, 30 * MIN_MS,
  HR, 2 * HR, 3 * HR, 6 * HR, 12 * HR,
  DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS, 90 * DAY_MS, 365 * DAY_MS,
];

interface Crosshair {
  x: number;
  y: number;
  active: boolean;
}

export class ChartRenderer {
  private canvas: HTMLCanvasElement;
  private crosshair: Crosshair = { x: 0, y: 0, active: false };

  // Cached per-frame plot geometry (filled at the top of render()).
  private plotL = 0;
  private plotT = 0;
  private plotW = 0;
  private plotH = 0;
  /** One entry per active pane-study definition, top-to-bottom below the main plot. */
  private subPanes: { def: StudyDefinition; top: number; h: number; min: number; max: number }[] = [];
  private priceAxisW = PRICE_AXIS_W_DEFAULT; // widened to fit the widest label
  private priceMin = 0;
  private priceMax = 1;

  // Pointer/drag state.
  private dragging:
    | null
    | { kind: "pan"; startX: number; startFrom: number; startTo: number }
    | { kind: "shape"; id: string; startY: number; pointIndex: number }
    | { kind: "priceScale"; startY: number; startMin: number; startMax: number }
    | { kind: "timeScale"; startX: number; startFrom: number; startTo: number } = null;
  private hoverShapeId: string | null = null;
  private hoverMark: Mark | null = null;
  /** In-progress multipoint drawing (left-toolbar tool). */
  private draft: { tool: DrawingTool; points: ShapePoint[] } | null = null;
  /** Percent-scale base = first visible bar close. */
  private pctBase = 1;
  /** Cached series for HA / OHLC used this frame. */
  private seriesBars: Bar[] = [];
  private onToolDone: ((tool: DrawingTool) => void) | null = null;

  private boundMove: (e: MouseEvent) => void;
  private boundDown: (e: MouseEvent) => void;
  private boundUp: (e: MouseEvent) => void;
  private boundLeave: () => void;
  private boundWheel: (e: WheelEvent) => void;
  private boundDbl: (e: MouseEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;
  private onData: () => void;

  constructor(
    private readonly context: ChartContext,
    private readonly engine: ChartEngine,
    private readonly shapes: ShapeStore,
    private readonly data: DataManager,
    private readonly studies: StudyStore,
  ) {
    this.canvas = engine.canvas;
    this.boundMove = (e) => this.onMouseMove(e);
    this.boundDown = (e) => this.onMouseDown(e);
    this.boundUp = () => this.onMouseUp();
    this.boundLeave = () => this.onMouseLeave();
    this.boundWheel = (e) => this.onWheel(e);
    this.boundDbl = (e) => this.onDblClick(e);
    this.boundKey = (e) => this.onKeyDown(e);
    this.onData = () => this.engine.markDirty();
  }

  /** Called by Widget when the left-sidebar tool resets after a finished draw. */
  setToolDoneHandler(fn: (tool: DrawingTool) => void): void {
    this.onToolDone = fn;
  }

  attach(): void {
    this.engine.paintHook = (ctx) => this.render(ctx);
    this.context.dataChanged.subscribe(null, this.onData as never);
    this.canvas.addEventListener("mousemove", this.boundMove);
    this.canvas.addEventListener("mousedown", this.boundDown);
    window.addEventListener("mouseup", this.boundUp);
    this.canvas.addEventListener("mouseleave", this.boundLeave);
    this.canvas.addEventListener("wheel", this.boundWheel, { passive: false });
    this.canvas.addEventListener("dblclick", this.boundDbl);
    window.addEventListener("keydown", this.boundKey);
    // Allow keyboard focus for shortcuts.
    this.canvas.tabIndex = 0;
    this.canvas.style.outline = "none";
  }

  destroy(): void {
    this.context.dataChanged.unsubscribe(null, this.onData as never);
    this.canvas.removeEventListener("mousemove", this.boundMove);
    this.canvas.removeEventListener("mousedown", this.boundDown);
    window.removeEventListener("mouseup", this.boundUp);
    this.canvas.removeEventListener("mouseleave", this.boundLeave);
    this.canvas.removeEventListener("wheel", this.boundWheel);
    this.canvas.removeEventListener("dblclick", this.boundDbl);
    window.removeEventListener("keydown", this.boundKey);
    this.engine.paintHook = null;
  }

  /** Fit visible range to recent bars + reset price autoscale. */
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

  /** PNG download of the current canvas. */
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

  // ── Geometry helpers ────────────────────────────────────────────────────────
  private get barSpacing(): number {
    const span = this.context.visibleRange.to - this.context.visibleRange.from;
    if (span <= 0) return MAX_BAR_SPACING;
    return this.plotW / span;
  }

  private xForIndex(i: number): number {
    const { from } = this.context.visibleRange;
    return this.plotL + (i - from + 0.5) * this.barSpacing;
  }

  private indexForX(x: number): number {
    const { from } = this.context.visibleRange;
    return from + (x - this.plotL) / this.barSpacing - 0.5;
  }

  private yForPrice(p: number): number {
    const d = this.toDisplay(p);
    const r = this.priceMax - this.priceMin || 1;
    return this.plotT + (this.priceMax - d) / r * this.plotH;
  }

  private priceForY(y: number): number {
    const r = this.priceMax - this.priceMin || 1;
    const d = this.priceMax - (y - this.plotT) / this.plotH * r;
    return this.fromDisplay(d);
  }

  private toDisplay(price: number): number {
    if (this.context.percentScale) {
      return this.pctBase > 0 ? ((price - this.pctBase) / this.pctBase) * 100 : 0;
    }
    if (this.context.logScale) {
      return price > 0 ? Math.log10(price) : Math.log10(Number.MIN_VALUE);
    }
    return price;
  }

  private fromDisplay(d: number): number {
    if (this.context.percentScale) {
      return this.pctBase * (1 + d / 100);
    }
    if (this.context.logScale) {
      return Math.pow(10, d);
    }
    return d;
  }

  private formatAxisPrice(price: number, pricescale: number): string {
    if (this.context.percentScale) {
      const pct = this.toDisplay(price);
      const sign = pct >= 0 ? "+" : "";
      return `${sign}${pct.toFixed(2)}%`;
    }
    return formatPrice(price, pricescale);
  }

  /** Top of the time-axis strip (below main plot, or below the last sub-pane). */
  private timeAxisTop(): number {
    const last = this.subPanes[this.subPanes.length - 1];
    return last ? last.top + last.h : this.plotT + this.plotH;
  }

  /** Public: time (unix seconds) + price under a canvas pixel — for onContextMenu
   *  and drawing placement. Uses a *fractional* bar index so click→store→render
   *  round-trips to the same X (no snap-to-candle-centre). */
  timePriceAt(x: number, y: number): { unixTime: number; price: number } {
    const bars = this.context.bars;
    let unixTime = 0;
    if (bars.length) {
      const resMs = resolutionToMs(this.context.resolution);
      // Fractional index — Math.round here made trend/fib handles jump to bar
      // centres while the crosshair stayed on the cursor (off-centre drawing).
      const idx = this.indexForX(x);
      unixTime = (bars[0]!.time + idx * resMs) / 1000;
    }
    return { unixTime, price: this.priceForY(y) };
  }

  /** Same as timePriceAt but from a raw mouse event (AppZoom-safe). */
  timePriceAtEvent(e: MouseEvent): { unixTime: number; price: number } {
    const { x, y } = this.pointerXY(e);
    return this.timePriceAt(x, y);
  }

  // ── Visible-price computation (auto-fit) ────────────────────────────────────
  private computePriceRange(): void {
    const bars = this.seriesBars.length ? this.seriesBars : this.context.bars;
    const { from, to } = this.context.visibleRange;
    const start = Math.max(0, Math.floor(from));
    const end = Math.min(bars.length - 1, Math.ceil(to));

    // Percent base = first visible close (TV-style).
    const baseBar = bars[start] ?? bars[0];
    this.pctBase = baseBar && baseBar.close > 0 ? baseBar.close : 1;

    if (this.context.priceRange && !this.context.autoScalePrice) {
      this.priceMin = this.toDisplay(this.context.priceRange.min);
      this.priceMax = this.toDisplay(this.context.priceRange.max);
      if (this.priceMin >= this.priceMax) {
        this.priceMax = this.priceMin + 1;
      }
      return;
    }

    let bodyHi = -Infinity;
    let bodyLo = Infinity;
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b) continue;
      const c = b.close > 0 ? b.close : b.open;
      const bH = Math.max(b.open, c);
      const bL = Math.min(b.open, c);
      if (bH > bodyHi) bodyHi = bH;
      if (bL > 0 && bL < bodyLo) bodyLo = bL;
      if (b.high > hi) hi = b.high;
      const low = b.low > 0 ? b.low : bL;
      if (low > 0 && low < lo) lo = low;
    }
    if (!Number.isFinite(bodyHi) || !Number.isFinite(bodyLo) || bodyHi <= 0) {
      this.priceMin = 0;
      this.priceMax = 1;
      return;
    }
    const bodyRange = Math.max(0, bodyHi - bodyLo);
    const wickRoom = Math.max(bodyRange, bodyHi * 0.06);
    hi = Math.min(hi, bodyHi + wickRoom);
    lo = Math.max(Math.max(0, bodyLo - wickRoom), Number.isFinite(lo) ? lo : bodyLo);
    if (lo >= hi) {
      lo = bodyLo * 0.99;
      hi = bodyHi * 1.01;
    }
    if (this.context.logScale) {
      lo = Math.max(lo, hi * 1e-6, Number.MIN_VALUE);
    }
    const dHi = this.toDisplay(hi);
    const dLo = this.toDisplay(lo);
    const pad = (dHi - dLo) * 0.08;
    this.priceMin = dLo - pad;
    this.priceMax = dHi + pad;
    if (this.priceMin >= this.priceMax) {
      this.priceMax = this.priceMin + 1;
    }
  }

  private refreshSeriesBars(): void {
    if (this.context.chartStyle === "heikin_ashi") {
      this.seriesBars = heikinAshi(this.context.bars);
    } else {
      this.seriesBars = this.context.bars;
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  private render(ctx: CanvasRenderingContext2D): void {
    const W = this.engine.cssWidth;
    const H = this.engine.cssHeight;
    if (W <= 0 || H <= 0) return;

    const paneDefs = this.studies.paneDefs();
    const nPanes = paneDefs.length;
    const paneFrac = nPanes ? Math.min(SUB_PANE_FRACTION, SUB_PANES_MAX_FRACTION / nPanes) : 0;
    const paneH = nPanes ? Math.max(48, Math.floor(H * paneFrac)) : 0;
    const panesTotal = nPanes * (paneH + SUB_PANE_GAP);

    this.plotL = 0;
    this.plotT = 0;
    this.plotW = Math.max(1, W - this.priceAxisW);
    this.plotH = Math.max(1, H - TIME_AXIS_H - panesTotal);
    this.subPanes = paneDefs.map((def, i) => ({
      def,
      top: this.plotT + this.plotH + SUB_PANE_GAP + i * (paneH + SUB_PANE_GAP),
      h: paneH,
      min: 0,
      max: 1,
    }));

    this.refreshSeriesBars();
    this.computePriceRange();

    const t = this.context.theme;
    const priceTicks = this.computePriceTicks();
    const timeTicks = this.computeTimeTicks();

    // Size the price axis to the widest label it must show (TV-style), so full
    // comma-separated numbers aren't clipped. Converges in one frame.
    this.adjustPriceAxisWidth(ctx, priceTicks);

    this.drawGrid(ctx, priceTicks, timeTicks);
    this.drawVolume(ctx);
    this.drawSeries(ctx);
    this.drawOverlayStudies(ctx);
    this.drawShapes(ctx);
    this.drawDraft(ctx);
    this.drawMarks(ctx);
    this.drawPriceAxis(ctx, priceTicks);
    this.drawSubPanes(ctx, timeTicks);
    this.drawTimeAxis(ctx, timeTicks);
    this.drawLastPrice(ctx);
    this.drawCrosshair(ctx);
    this.drawLegend(ctx);
    this.drawMarkTooltip(ctx);

    // Opt-in debug snapshot for QA (window.__RAZE_DEBUG = true).
    if ((window as unknown as { __RAZE_DEBUG?: boolean }).__RAZE_DEBUG) {
      const bars = this.context.bars;
      let nonzero = 0, firstReal = -1, lastReal = -1;
      for (let i = 0; i < bars.length; i++) {
        if (bars[i]!.close > 0) { nonzero++; if (firstReal < 0) firstReal = i; lastReal = i; }
      }
      (window as unknown as { __razeChartState?: unknown }).__razeChartState = {
        bars: bars.length, nonzero, firstReal, lastReal,
        visibleRange: { ...this.context.visibleRange },
        priceMin: this.priceMin, priceMax: this.priceMax,
        firstBarClose: bars[0]?.close, lastBarClose: bars[bars.length - 1]?.close,
        studies: this.studies.list().map((s) => ({ id: s.id, name: s.name, length: s.length })),
      };
    }

    // Axis separators.
    ctx.strokeStyle = t.scaleLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.plotL + this.plotW + 0.5, 0);
    ctx.lineTo(this.plotL + this.plotW + 0.5, this.timeAxisTop());
    ctx.moveTo(0, this.plotT + this.plotH + 0.5);
    ctx.lineTo(W, this.plotT + this.plotH + 0.5);
    for (const p of this.subPanes) {
      ctx.moveTo(0, p.top + p.h + 0.5);
      ctx.lineTo(W, p.top + p.h + 0.5);
    }
    ctx.stroke();
  }

  private drawOverlayStudies(ctx: CanvasRenderingContext2D): void {
    for (const s of this.studies.list()) {
      if (s.def.pane !== "overlay") continue;
      this.strokeStudyLine(ctx, s.values, s.color, (v) => this.yForPrice(v), this.plotT, this.plotT + this.plotH);
    }
  }

  /** Value range of a sub-pane: the definition's fixed range, or auto-fit to
   *  the visible values of its studies. */
  private subPaneRange(def: StudyDefinition): { min: number; max: number } {
    if (def.range) return def.range;
    const { from, to } = this.context.visibleRange;
    const start = Math.max(0, Math.floor(from) - 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of this.studies.paneStudies(def)) {
      const end = Math.min(s.values.length - 1, Math.ceil(to) + 1);
      for (let i = start; i <= end; i++) {
        const v = s.values[i];
        if (v == null || !Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1 };
    if (lo === hi) return { min: lo - 1, max: hi + 1 };
    const pad = (hi - lo) * 0.1;
    return { min: lo - pad, max: hi + pad };
  }

  private drawSubPanes(
    ctx: CanvasRenderingContext2D,
    timeTicks: { index: number; time: number }[],
  ): void {
    const t = this.context.theme;
    for (const pane of this.subPanes) {
      const { def } = pane;
      const range = this.subPaneRange(def);
      pane.min = range.min;
      pane.max = range.max;
      const span = Math.max(1e-12, range.max - range.min);
      const yFor = (v: number): number => {
        const clamped = Math.max(range.min, Math.min(range.max, v));
        return pane.top + ((range.max - clamped) / span) * pane.h;
      };

      ctx.fillStyle = t.paneBackground;
      ctx.fillRect(this.plotL, pane.top, this.plotW, pane.h);

      const levels = def.levels ?? [];
      ctx.strokeStyle = t.horzGrid;
      ctx.lineWidth = 1;
      for (const level of levels) {
        const y = Math.round(yFor(level.value)) + 0.5;
        ctx.beginPath();
        ctx.setLineDash(level.dashed ? [3, 3] : []);
        ctx.moveTo(this.plotL, y);
        ctx.lineTo(this.plotL + this.plotW, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.strokeStyle = t.vertGrid;
      ctx.beginPath();
      for (const tk of timeTicks) {
        const x = Math.round(this.xForIndex(tk.index)) + 0.5;
        if (x < this.plotL || x > this.plotL + this.plotW) continue;
        ctx.moveTo(x, pane.top);
        ctx.lineTo(x, pane.top + pane.h);
      }
      ctx.stroke();

      for (const s of this.studies.paneStudies(def)) {
        this.strokeStudyLine(ctx, s.values, s.color, yFor, pane.top, pane.top + pane.h);
      }

      ctx.fillStyle = t.scaleText;
      ctx.font = `10px ${this.context.fontFamily}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const level of levels) {
        if (!level.axisLabel) continue;
        ctx.fillText(String(level.value), this.plotL + this.plotW + 6, yFor(level.value));
      }
      ctx.textBaseline = "top";
      ctx.fillText(def.label ?? def.name, this.plotL + 6, pane.top + 4);
    }
  }

  private strokeStudyLine(
    ctx: CanvasRenderingContext2D,
    values: (number | null)[],
    color: string,
    yFor: (v: number) => number,
    clipTop: number,
    clipBot: number,
  ): void {
    const bars = this.context.bars;
    if (!bars.length || values.length === 0) return;
    const { from, to } = this.context.visibleRange;
    const start = Math.max(0, Math.floor(from) - 1);
    const end = Math.min(bars.length - 1, Math.ceil(to) + 1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(this.plotL, clipTop, this.plotW, Math.max(1, clipBot - clipTop));
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let drawing = false;
    for (let i = start; i <= end; i++) {
      const v = values[i];
      if (v == null || !Number.isFinite(v)) {
        drawing = false;
        continue;
      }
      const x = this.xForIndex(i);
      const y = yFor(v);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    priceTicks: number[],
    timeTicks: { index: number; time: number }[],
  ): void {
    const t = this.context.theme;
    ctx.lineWidth = 1;
    ctx.strokeStyle = t.horzGrid;
    ctx.beginPath();
    for (const p of priceTicks) {
      const y = Math.round(this.yForPrice(p)) + 0.5;
      if (y < this.plotT || y > this.plotT + this.plotH) continue;
      ctx.moveTo(this.plotL, y);
      ctx.lineTo(this.plotL + this.plotW, y);
    }
    ctx.stroke();
    ctx.strokeStyle = t.vertGrid;
    ctx.beginPath();
    for (const tk of timeTicks) {
      const x = Math.round(this.xForIndex(tk.index)) + 0.5;
      if (x < this.plotL || x > this.plotL + this.plotW) continue;
      ctx.moveTo(x, this.plotT);
      ctx.lineTo(x, this.plotT + this.plotH);
    }
    ctx.stroke();
  }

  private drawSeries(ctx: CanvasRenderingContext2D): void {
    const style = this.context.chartStyle;
    if (style === "line" || style === "area") {
      this.drawLineArea(ctx, style === "area");
      return;
    }
    this.drawCandles(ctx, this.seriesBars);
  }

  private drawLineArea(ctx: CanvasRenderingContext2D, fill: boolean): void {
    const bars = this.seriesBars;
    if (!bars.length) return;
    const t = this.context.theme;
    const { from, to } = this.context.visibleRange;
    const start = Math.max(0, Math.floor(from) - 1);
    const end = Math.min(bars.length - 1, Math.ceil(to) + 1);
    const color = t.candleUp;

    ctx.save();
    ctx.beginPath();
    ctx.rect(this.plotL, this.plotT, this.plotW, this.plotH);
    ctx.clip();

    ctx.beginPath();
    let started = false;
    let firstX = 0;
    let lastX = 0;
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b || !(b.close > 0)) {
        started = false;
        continue;
      }
      const x = this.xForIndex(i);
      const y = this.yForPrice(b.close);
      if (!started) {
        ctx.moveTo(x, y);
        firstX = x;
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
      lastX = x;
    }
    if (fill && started) {
      ctx.lineTo(lastX, this.plotT + this.plotH);
      ctx.lineTo(firstX, this.plotT + this.plotH);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.18;
      ctx.fill();
      ctx.globalAlpha = 1;
      // Restroke the line on top.
      ctx.beginPath();
      started = false;
      for (let i = start; i <= end; i++) {
        const b = bars[i];
        if (!b || !(b.close > 0)) { started = false; continue; }
        const x = this.xForIndex(i);
        const y = this.yForPrice(b.close);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }

  private drawCandles(ctx: CanvasRenderingContext2D, bars: Bar[]): void {
    if (!bars.length) return;
    const t = this.context.theme;
    const spacing = this.barSpacing;
    // Cap candle width so sparse charts (a handful of bars stretched across the
    // pane) render as real candles, not giant blocks.
    const bodyW = Math.max(1, Math.min(CANDLE_MAX_WIDTH, spacing * 0.74));
    const half = bodyW / 2;
    const thinBars = spacing < 4;

    const { from, to } = this.context.visibleRange;
    const start = Math.max(0, Math.floor(from) - 1);
    const end = Math.min(bars.length - 1, Math.ceil(to) + 1);

    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b) continue;
      const up = b.close >= b.open;
      const x = this.xForIndex(i);
      const yO = this.yForPrice(b.open);
      const yC = this.yForPrice(b.close);
      const yH = this.yForPrice(b.high);
      const yL = this.yForPrice(b.low > 0 ? b.low : Math.min(b.open, b.close));

      const body = up ? t.candleUp : t.candleDown;
      const wick = up ? t.wickUp : t.wickDown;
      const border = up ? t.borderUp : t.borderDown;

      // Wick.
      ctx.strokeStyle = wick;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const cx = Math.round(x) + 0.5;
      ctx.moveTo(cx, yH);
      ctx.lineTo(cx, yL);
      ctx.stroke();

      if (thinBars) {
        // Too narrow for a body — draw a 1px open→close column.
        ctx.strokeStyle = body;
        ctx.beginPath();
        ctx.moveTo(cx, yO);
        ctx.lineTo(cx, yC);
        ctx.stroke();
        continue;
      }

      const top = Math.min(yO, yC);
      const h = Math.max(1, Math.abs(yC - yO));
      ctx.fillStyle = body;
      ctx.fillRect(Math.round(x - half), Math.round(top), Math.round(bodyW), Math.round(h));
      if (bodyW >= 3) {
        ctx.strokeStyle = border;
        ctx.strokeRect(Math.round(x - half) + 0.5, Math.round(top) + 0.5, Math.round(bodyW) - 1, Math.max(1, Math.round(h) - 1));
      }
    }
  }

  private drawVolume(ctx: CanvasRenderingContext2D): void {
    const bars = this.context.bars;
    if (!bars.length) return;
    const t = this.context.theme;
    const { from, to } = this.context.visibleRange;
    const start = Math.max(0, Math.floor(from) - 1);
    const end = Math.min(bars.length - 1, Math.ceil(to) + 1);

    let maxVol = 0;
    for (let i = start; i <= end; i++) {
      const v = bars[i]?.volume ?? 0;
      if (v > maxVol) maxVol = v;
    }
    if (maxVol <= 0) return;

    const volH = this.plotH * VOLUME_FRACTION;
    const baseY = this.plotT + this.plotH;
    const spacing = this.barSpacing;
    const w = Math.max(1, Math.min(CANDLE_MAX_WIDTH, spacing * 0.74));
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b || !b.volume) continue;
      const up = b.close >= b.open;
      const h = (b.volume / maxVol) * volH;
      const x = this.xForIndex(i);
      ctx.fillStyle = up ? t.volUp : t.volDown;
      ctx.fillRect(Math.round(x - w / 2), Math.round(baseY - h), Math.round(w), Math.round(h));
    }
  }

  // ── Marks (P4) ──────────────────────────────────────────────────────────────
  private markScreen: { mark: Mark; x: number; y: number; r: number }[] = [];

  private drawMarks(ctx: CanvasRenderingContext2D): void {
    this.markScreen = [];
    if (!this.context.features.has("mark_on_bars")) return;
    const marks = this.context.marks;
    const bars = this.context.bars;
    if (!marks.length || !bars.length) return;

    const resMs = resolutionToMs(this.context.resolution);
    const firstT = bars[0]!.time;
    const r = 7;                 // fixed small radius (TV-style badges)
    const gap = 3;               // vertical gap between stacked marks
    const maxStack = 4;          // beyond this, collapse into a "+N" badge
    const bottomLimit = this.plotT + this.plotH - 4;
    const topLimit = this.plotT + 4;

    // Group marks by bar index so multiple marks on one bar stack vertically
    // instead of piling up on the same pixel.
    const byBar = new Map<number, Mark[]>();
    for (const m of marks) {
      const idx = Math.round((m.time * 1000 - firstT) / resMs);
      if (idx < 0 || idx >= bars.length) continue;
      const list = byBar.get(idx);
      if (list) list.push(m);
      else byBar.set(idx, [m]);
    }

    // Declutter horizontally: walk bars left→right, skip groups whose x is
    // within one badge of the previously drawn group so dense runs don't blur.
    const indices = Array.from(byBar.keys()).sort((a, b) => a - b);
    let lastDrawnX = -Infinity;
    for (const idx of indices) {
      const x = this.xForIndex(idx);
      if (x < this.plotL - r || x > this.plotL + this.plotW + r) continue;
      if (x - lastDrawnX < 2 * r + 1) continue;
      lastDrawnX = x;

      const group = byBar.get(idx)!;
      const bar = bars[idx]!;
      // Anchor just above the bar's high so marks sit over their bar, then
      // stack upward toward the top of the pane.
      const highY = this.yForPrice(bar.high);
      const stepY = 2 * r + gap;
      const shown = Math.min(group.length, maxStack);
      // Clamp so the whole upward stack stays inside the plot.
      const minStart = topLimit + r + (shown - 1) * stepY;
      let y = Math.max(minStart, Math.min(bottomLimit - r, highY - r - 6));

      for (let k = 0; k < shown; k++) {
        const m = group[k]!;
        const isLast = k === shown - 1 && group.length > maxStack;
        const col = m.color as MarkCustomColor;
        const border = typeof col === "object" ? col.border : "#2962ff";
        const bg = typeof col === "object" ? col.background : "#2962ff";

        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = border;
        ctx.stroke();

        const label = isLast ? `+${group.length - maxStack + 1}` : (m.label ? m.label.slice(0, 2) : "");
        if (label) {
          ctx.fillStyle = m.labelFontColor || "#fff";
          ctx.font = `bold ${isLast ? 8 : 9}px ${this.context.fontFamily}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, x, y + 0.5);
        }
        this.markScreen.push({ mark: m, x, y, r });
        y -= stepY; // stack upward, above the candle
      }
    }
  }

  // ── Shapes: horizontal_line + drawings (trend/fib/rect/text) ─────────────────
  private shapeScreen: { shape: StoredShape; y: number; hit: "body" | "p0" | "p1" }[] = [];

  private drawShapes(ctx: CanvasRenderingContext2D): void {
    this.shapeScreen = [];
    const pricescale = this.context.symbolInfo?.pricescale ?? 100;
    // First pass: horizontal lines collect label Y for declutter.
    const hLines: { shape: StoredShape; price: number; y: number; labelY: number }[] = [];

    for (const s of this.shapes.list()) {
      if (s.shape === "horizontal_line") {
        const price = s.points[0]?.price;
        if (typeof price !== "number" || !Number.isFinite(price)) continue;
        const y = this.yForPrice(price);
        hLines.push({ shape: s, price, y, labelY: y });
        continue;
      }
      this.drawComplexShape(ctx, s);
    }

    // Declutter overlapping horizontal-line text labels (stack when close).
    hLines.sort((a, b) => a.y - b.y);
    const minGap = 14;
    for (let i = 1; i < hLines.length; i++) {
      const prev = hLines[i - 1]!;
      const cur = hLines[i]!;
      if (cur.labelY - prev.labelY < minGap) {
        cur.labelY = prev.labelY + minGap;
      }
    }

    for (const h of hLines) {
      const s = h.shape;
      const y = h.y;
      if (y < this.plotT - 40 || y > this.plotT + this.plotH + 40) {
        this.shapeScreen.push({ shape: s, y, hit: "body" });
        continue;
      }
      const o = s.overrides;
      const color = (o.linecolor as string) ?? "#2962ff";
      const width = (o.linewidth as number) ?? 1;
      const style = (o.linestyle as number) ?? 0;
      const textColor = (o.textcolor as string) ?? color;
      const fontsize = (o.fontsize as number) ?? 11;
      const showPrice = o.showPrice !== false;
      const bold = o.bold === true;
      const italic = o.italic === true;
      const selected = this.context.selectedShapeId === (s.id as unknown as string);

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? width + 0.5 : width;
      ctx.setLineDash(style === 2 ? [5, 4] : style === 1 ? [2, 3] : []);
      const yy = Math.round(y) + 0.5;
      ctx.beginPath();
      ctx.moveTo(this.plotL, yy);
      ctx.lineTo(this.plotL + this.plotW, yy);
      ctx.stroke();
      ctx.setLineDash([]);

      if (s.text) {
        ctx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontsize}px ${this.context.fontFamily}`;
        ctx.fillStyle = textColor;
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        const ly = Math.round(h.labelY) - 3;
        // Soft background when label was offset from the line.
        if (Math.abs(h.labelY - y) > 2) {
          const tw = ctx.measureText(s.text).width;
          ctx.fillStyle = "rgba(24,22,21,0.72)";
          ctx.fillRect(this.plotL + this.plotW - 8 - tw, ly - fontsize, tw + 4, fontsize + 4);
          ctx.fillStyle = textColor;
        }
        ctx.fillText(s.text, this.plotL + this.plotW - 6, ly);
      }

      if (showPrice) {
        this.drawAxisTag(ctx, yy - 0.5, this.formatAxisPrice(h.price, pricescale), color, "#ffffff");
      }
      ctx.restore();
      this.shapeScreen.push({ shape: s, y, hit: "body" });
    }
  }

  private pointXY(p: ShapePoint): { x: number; y: number } | null {
    if (typeof p.price !== "number" || !Number.isFinite(p.price)) return null;
    const bars = this.context.bars;
    if (!bars.length) return null;
    const resMs = resolutionToMs(this.context.resolution);
    const idx = (p.time * 1000 - bars[0]!.time) / resMs;
    return { x: this.xForIndex(idx), y: this.yForPrice(p.price) };
  }

  private drawComplexShape(ctx: CanvasRenderingContext2D, s: StoredShape): void {
    const o = s.overrides;
    const color = (o.linecolor as string) ?? (o.color as string) ?? "#2962ff";
    const width = (o.linewidth as number) ?? 1;
    const selected = this.context.selectedShapeId === (s.id as unknown as string);
    const pts = s.points.map((p) => this.pointXY(p)).filter(Boolean) as { x: number; y: number }[];

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = selected ? width + 0.75 : width;

    if (s.shape === "trend_line" && pts.length >= 2) {
      const a = pts[0]!;
      const b = pts[1]!;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      this.drawHandle(ctx, a.x, a.y, color);
      this.drawHandle(ctx, b.x, b.y, color);
      this.shapeScreen.push({ shape: s, y: (a.y + b.y) / 2, hit: "body" });
    } else if (s.shape === "rectangle" && pts.length >= 2) {
      const a = pts[0]!;
      const b = pts[1]!;
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      this.drawHandle(ctx, a.x, a.y, color);
      this.drawHandle(ctx, b.x, b.y, color);
      this.shapeScreen.push({ shape: s, y: y + h / 2, hit: "body" });
    } else if (s.shape === "fib_retracement" && pts.length >= 2) {
      const a = pts[0]!;
      const b = pts[1]!;
      const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      const top = Math.min(a.y, b.y);
      const bot = Math.max(a.y, b.y);
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, this.plotL + this.plotW - 4);
      ctx.font = `10px ${this.context.fontFamily}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      for (const lv of levels) {
        const y = a.y + (b.y - a.y) * lv;
        const yy = Math.round(y) + 0.5;
        ctx.globalAlpha = lv === 0 || lv === 1 ? 0.9 : 0.55;
        ctx.setLineDash(lv === 0.5 ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(left, yy);
        ctx.lineTo(right, yy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.85;
        const price = this.priceForY(y);
        const pricescale = this.context.symbolInfo?.pricescale ?? 100;
        ctx.fillText(`${(lv * 100).toFixed(1)}%  ${this.formatAxisPrice(price, pricescale)}`, left + 4, yy - 2);
      }
      ctx.globalAlpha = 1;
      // Vertical guide
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(Math.round(a.x) + 0.5, top);
      ctx.lineTo(Math.round(a.x) + 0.5, bot);
      ctx.stroke();
      ctx.globalAlpha = 1;
      this.drawHandle(ctx, a.x, a.y, color);
      this.drawHandle(ctx, b.x, b.y, color);
      this.shapeScreen.push({ shape: s, y: (a.y + b.y) / 2, hit: "body" });
    } else if (s.shape === "text" && pts.length >= 1) {
      const a = pts[0]!;
      const label = s.text || "Text";
      ctx.font = `12px ${this.context.fontFamily}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(24,22,21,0.75)";
      ctx.fillRect(a.x - 2, a.y - 14, tw + 6, 16);
      ctx.fillStyle = color;
      ctx.fillText(label, a.x, a.y);
      this.drawHandle(ctx, a.x, a.y, color);
      this.shapeScreen.push({ shape: s, y: a.y, hit: "body" });
    }
    ctx.restore();
  }

  private drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    ctx.fillStyle = "#181615";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.rect(x - 3.5, y - 3.5, 7, 7);
    ctx.fill();
    ctx.stroke();
  }

  private drawDraft(ctx: CanvasRenderingContext2D): void {
    if (!this.draft || this.draft.points.length === 0) return;
    const ghost: StoredShape = {
      id: "draft" as never,
      shape: this.draft.tool === "cursor" ? "trend_line" : this.draft.tool,
      points: this.draft.points,
      text: this.draft.tool === "text" ? "…" : "",
      lock: true,
      disableSelection: true,
      zOrder: "top",
      overrides: { linecolor: "#66d89e", linewidth: 1, linestyle: 2 },
    };
    // Preview second point at crosshair if only one placed.
    if (this.draft.points.length === 1 && this.crosshair.active && this.draft.tool !== "horizontal_line" && this.draft.tool !== "text") {
      const { unixTime, price } = this.timePriceAt(this.crosshair.x, this.crosshair.y);
      ghost.points = [...this.draft.points, { time: unixTime, price }];
    }
    if (ghost.shape === "horizontal_line" && ghost.points[0]) {
      const y = this.yForPrice(ghost.points[0].price!);
      ctx.save();
      ctx.strokeStyle = "#66d89e";
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(this.plotL, Math.round(y) + 0.5);
      ctx.lineTo(this.plotL + this.plotW, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.restore();
      return;
    }
    this.drawComplexShape(ctx, ghost);
  }

  private drawMarkTooltip(ctx: CanvasRenderingContext2D): void {
    if (!this.hoverMark) return;
    const hit = this.markScreen.find((m) => m.mark === this.hoverMark);
    if (!hit) return;
    const text = this.hoverMark.text || this.hoverMark.label || "";
    if (!text) return;
    ctx.font = `11px ${this.context.fontFamily}`;
    const pad = 6;
    const lines = text.split("\n").slice(0, 4);
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width), 40);
    const th = lines.length * 14 + pad * 2;
    let x = hit.x + hit.r + 8;
    let y = hit.y - th / 2;
    if (x + tw + pad * 2 > this.plotL + this.plotW) x = hit.x - hit.r - 8 - tw - pad * 2;
    if (y < this.plotT) y = this.plotT + 4;
    ctx.fillStyle = "rgba(24,22,21,0.92)";
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    this.roundRect(ctx, x, y, tw + pad * 2, th, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f4eee1";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad + i * 14));
  }

  // ── Axes ──────────────────────────────────────────────────────────────────
  private computePriceTicks(): number[] {
    const target = Math.max(2, Math.floor(this.plotH / 56));
    const range = this.priceMax - this.priceMin;
    if (range <= 0) return [];
    // Ticks are in display space; convert back to price for labeling.
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-12))));
    const norm = raw / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
    const first = Math.ceil(this.priceMin / step) * step;
    const ticks: number[] = [];
    for (let d = first; d <= this.priceMax; d += step) {
      ticks.push(this.fromDisplay(d));
    }
    return ticks;
  }

  private computeTimeTicks(): { index: number; time: number }[] {
    const bars = this.context.bars;
    if (!bars.length) return [];
    const { from, to } = this.context.visibleRange;
    const start = Math.max(0, Math.floor(from));
    const end = Math.min(bars.length - 1, Math.ceil(to));
    if (end < start) return [];

    // Pick a "nice" time step (round clock boundary) so gridlines land on
    // :00 / :15 / the hour / the day rather than arbitrary bar counts.
    const target = Math.max(2, Math.floor(this.plotW / 110));
    const spanMs = Math.max(1, bars[end]!.time - bars[start]!.time);
    const step = NICE_TIME_STEPS.find((s) => spanMs / s <= target) ?? NICE_TIME_STEPS[NICE_TIME_STEPS.length - 1]!;

    // Bars are aligned to the resolution boundary, so the first bar that enters
    // each step bucket sits on a round time (e.g. HH:00). Tick there.
    const ticks: { index: number; time: number }[] = [];
    let lastBucket: number | null = null;
    for (let i = start; i <= end; i++) {
      const bucket = Math.floor(bars[i]!.time / step);
      if (lastBucket === null || bucket !== lastBucket) {
        ticks.push({ index: i, time: bars[i]!.time });
        lastBucket = bucket;
      }
    }
    return ticks;
  }

  private adjustPriceAxisWidth(ctx: CanvasRenderingContext2D, ticks: number[]): void {
    const pricescale = this.context.symbolInfo?.pricescale ?? 100;
    ctx.font = `11px ${this.context.fontFamily}`;
    let widest = 0;
    const consider = (v: number): void => {
      const w = ctx.measureText(this.formatAxisPrice(v, pricescale)).width;
      if (w > widest) widest = w;
    };
    for (const p of ticks) consider(p);
    consider(this.fromDisplay(this.priceMax));
    consider(this.fromDisplay(this.priceMin));
    const last = this.context.bars[this.context.bars.length - 1];
    if (last) consider(last.close);
    const desired = Math.round(
      Math.max(PRICE_AXIS_W_MIN, Math.min(PRICE_AXIS_W_MAX, widest + 16)),
    );
    if (Math.abs(desired - this.priceAxisW) > 1) {
      this.priceAxisW = desired;
      this.engine.markDirty(); // relayout next frame with the new width
    }
  }

  private drawPriceAxis(ctx: CanvasRenderingContext2D, ticks: number[]): void {
    const t = this.context.theme;
    const pricescale = this.context.symbolInfo?.pricescale ?? 100;
    ctx.fillStyle = t.scaleBackground;
    ctx.fillRect(this.plotL + this.plotW, 0, this.priceAxisW, this.engine.cssHeight);
    ctx.fillStyle = t.scaleText;
    ctx.font = `11px ${this.context.fontFamily}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const rightEdge = this.plotL + this.plotW + this.priceAxisW - 7;
    for (const p of ticks) {
      const y = this.yForPrice(p);
      if (y < this.plotT + 6 || y > this.plotT + this.plotH - 2) continue;
      ctx.fillText(this.formatAxisPrice(p, pricescale), rightEdge, y);
    }
  }

  private drawTimeAxis(ctx: CanvasRenderingContext2D, ticks: { index: number; time: number }[]): void {
    const t = this.context.theme;
    const top = this.timeAxisTop();
    ctx.fillStyle = t.scaleBackground;
    ctx.fillRect(0, top, this.engine.cssWidth, TIME_AXIS_H);
    ctx.fillStyle = t.scaleText;
    ctx.font = `11px ${this.context.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const y = top + TIME_AXIS_H / 2;
    const kind = parseResolution(this.context.resolution).kind;
    for (const tk of ticks) {
      const x = this.xForIndex(tk.index);
      if (x < this.plotL + 18 || x > this.plotL + this.plotW - 18) continue;
      ctx.fillText(this.formatAxisTime(tk.time, kind), x, y);
    }
  }

  private formatAxisTime(ms: number, kind: string): string {
    const d = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const intraday = kind === "seconds" || kind === "minutes" || kind === "hours";
    if (intraday) {
      // Date at midnight, seconds resolution shows HH:MM:SS, else HH:MM (UTC).
      if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) {
        return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
      }
      if (kind === "seconds") {
        return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
      }
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }

  /** Rounded price-axis pill (crosshair value, last price, shape levels). */
  private drawAxisTag(ctx: CanvasRenderingContext2D, y: number, text: string, bg: string, fg: string, bold = false): void {
    const x0 = this.plotL + this.plotW;
    const h = 16;
    const top = Math.max(this.plotT, Math.min(this.plotT + this.plotH - h, y - h / 2));
    ctx.fillStyle = bg;
    this.roundRect(ctx, x0 + 3, top, this.priceAxisW - 5, h, 3);
    ctx.fill();
    ctx.font = `${bold ? "600 " : ""}11px ${this.context.fontFamily}`;
    ctx.fillStyle = fg;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x0 + this.priceAxisW - 7, top + h / 2 + 0.5);
  }

  /** Build a rounded-rect path (caller fills/strokes). */
  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    const anyCtx = ctx as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
    if (typeof anyCtx.roundRect === "function") {
      anyCtx.roundRect(x, y, w, h, rr);
      return;
    }
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // ── Last price line + pill ──────────────────────────────────────────────────
  private drawLastPrice(ctx: CanvasRenderingContext2D): void {
    const bars = this.context.bars;
    const last = bars[bars.length - 1];
    if (!last || !(last.close > 0)) return;
    const t = this.context.theme;
    const price = last.close;
    const up = last.close >= last.open;
    const color = up ? t.candleUp : t.candleDown;
    const pricescale = this.context.symbolInfo?.pricescale ?? 100;
    const y = this.yForPrice(price);

    if (y >= this.plotT && y <= this.plotT + this.plotH) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      const yy = Math.round(y) + 0.5;
      ctx.beginPath();
      ctx.moveTo(this.plotL, yy);
      ctx.lineTo(this.plotL + this.plotW, yy);
      ctx.stroke();
      ctx.restore();
    }
    // Always show the price pill, clamped into the axis even when off-screen.
    const cy = Math.max(this.plotT + 8, Math.min(this.plotT + this.plotH - 8, y));
    this.drawAxisTag(ctx, cy, this.formatAxisPrice(price, pricescale), color, "#10100e", true);
  }

  /** Neutral pill background/foreground for crosshair tags (theme-aware). */
  private neutralPill(): { bg: string; fg: string } {
    const light = this.context.theme.paneBackground.toLowerCase() === "#ffffff";
    return light ? { bg: "#131722", fg: "#ffffff" } : { bg: "#3a3833", fg: "#f4eee1" };
  }

  // ── Crosshair + legend ──────────────────────────────────────────────────────
  private drawCrosshair(ctx: CanvasRenderingContext2D): void {
    if (!this.crosshair.active) return;
    const t = this.context.theme;
    const { x, y } = this.crosshair;
    const contentBottom = this.timeAxisTop();
    if (x < this.plotL || x > this.plotL + this.plotW || y < this.plotT || y > contentBottom) return;

    // Nearest bar for legend / time pill only — crosshair lines follow the
    // pointer exactly. Snapping the vertical line to bar centres made the
    // intersection sit beside the OS cursor (looked like a pointer offset bug).
    const bars = this.context.bars;
    const idx = Math.round(this.indexForX(x));
    const snapBar = bars[Math.max(0, Math.min(bars.length - 1, idx))];

    const inMainPane = y <= this.plotT + this.plotH;
    ctx.save();
    ctx.strokeStyle = t.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    // Vertical through main + study sub-panes — at the actual pointer X.
    ctx.moveTo(Math.round(x) + 0.5, this.plotT);
    ctx.lineTo(Math.round(x) + 0.5, contentBottom);
    // Horizontal only in the pane under the cursor.
    if (inMainPane || this.subPanes.some((p) => y >= p.top && y <= p.top + p.h)) {
      ctx.moveTo(this.plotL, Math.round(y) + 0.5);
      ctx.lineTo(this.plotL + this.plotW, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const pill = this.neutralPill();
    const pricescale = this.context.symbolInfo?.pricescale ?? 100;
    if (t.showPriceScaleCrosshairLabel && inMainPane) {
      this.drawAxisTag(ctx, y, this.formatAxisPrice(this.priceForY(y), pricescale), pill.bg, pill.fg);
    }
    if (t.showTimeScaleCrosshairLabel && snapBar && idx >= 0 && idx < bars.length) {
      const label = this.formatCrosshairTime(snapBar.time, parseResolution(this.context.resolution).kind);
      ctx.font = `11px ${this.context.fontFamily}`;
      const w = ctx.measureText(label).width + 14;
      const tx = Math.max(this.plotL, Math.min(this.plotL + this.plotW - w, x - w / 2));
      const axisTop = this.timeAxisTop();
      ctx.fillStyle = pill.bg;
      this.roundRect(ctx, tx, axisTop + 2, w, TIME_AXIS_H - 4, 3);
      ctx.fill();
      ctx.fillStyle = pill.fg;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, tx + w / 2, axisTop + TIME_AXIS_H / 2 + 0.5);
    }
  }

  private formatCrosshairTime(ms: number, kind: string): string {
    const d = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
    const intraday = kind === "seconds" || kind === "minutes" || kind === "hours";
    if (!intraday) return date;
    const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    return kind === "seconds" ? `${date} ${hm}:${pad(d.getUTCSeconds())}` : `${date} ${hm}`;
  }

  private drawLegend(ctx: CanvasRenderingContext2D): void {
    if (!this.context.features.has("legend_widget")) return;
    const bars = this.context.bars;
    if (!bars.length) return;
    const idx = this.crosshair.active
      ? Math.max(0, Math.min(bars.length - 1, Math.round(this.indexForX(this.crosshair.x))))
      : bars.length - 1;
    const bar = bars[idx];
    if (!bar) return;
    const pricescale = this.context.symbolInfo?.pricescale ?? 100;
    const t = this.context.theme;
    const up = bar.close >= bar.open;
    const col = up ? t.candleUp : t.candleDown;

    const dim = t.scaleText;
    const f = (v: number): string => formatPrice(v, pricescale);

    // O/H/L/C with dim labels + candle-coloured values, then change %.
    // (Symbol name + interval intentionally omitted — shown by the app's own UI.)
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    let x = 10;
    const y = 19;
    ctx.font = `12px ${this.context.fontFamily}`;
    const seg = (label: string, value: string): void => {
      ctx.fillStyle = dim;
      ctx.fillText(label, x, y);
      x += ctx.measureText(label).width + 3;
      ctx.fillStyle = col;
      ctx.fillText(value, x, y);
      x += ctx.measureText(value).width + 9;
    };
    seg("O", f(bar.open));
    seg("H", f(bar.high));
    seg("L", f(bar.low));
    seg("C", f(bar.close));
    if (bar.open > 0) {
      // Match TV: signed absolute change then (signed percent), e.g. -1,812 (-2.02%)
      const abs = bar.close - bar.open;
      const pct = (abs / bar.open) * 100;
      const sign = abs >= 0 ? "+" : "-";
      const chgStr = `${sign}${formatPrice(Math.abs(abs), pricescale)} (${sign}${Math.abs(pct).toFixed(2)}%)`;
      ctx.fillStyle = col;
      ctx.fillText(chgStr, x, y);
      x += ctx.measureText(chgStr).width + 12;
    }
    for (const s of this.studies.list()) {
      const v = s.values[idx];
      if (v == null || !Number.isFinite(v)) continue;
      const label = `${s.name}${s.length}`;
      const value = s.def.formatValue
        ? s.def.formatValue(v)
        : s.def.pane === "pane"
          ? v.toFixed(1)
          : f(v);
      ctx.fillStyle = dim;
      ctx.fillText(label, x, y);
      x += ctx.measureText(label).width + 3;
      ctx.fillStyle = s.color;
      ctx.fillText(value, x, y);
      x += ctx.measureText(value).width + 9;
    }
    if (bar.volume) {
      ctx.fillStyle = dim;
      ctx.font = `11px ${this.context.fontFamily}`;
      ctx.fillText(`Vol ${formatVolume(bar.volume)}`, 10, 35);
    }
  }

  /** Map a mouse event into the same CSS-pixel space the renderer paints in
   *  (`engine.cssWidth` × `cssHeight`). Under AppZoom CSS `zoom`,
   *  getBoundingClientRect is visual (× zoom); scaling by css/rect converts
   *  viewport mouse coords into layout/draw space. */
  private pointerXY(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const rw = rect.width || 1;
    const rh = rect.height || 1;
    const cw = this.engine.cssWidth || this.canvas.clientWidth || 1;
    const ch = this.engine.cssHeight || this.canvas.clientHeight || 1;
    return {
      x: (e.clientX - rect.left) * (cw / rw),
      y: (e.clientY - rect.top) * (ch / rh),
    };
  }

  // ── Interaction ─────────────────────────────────────────────────────────────
  private onMouseMove(e: MouseEvent): void {
    const { x, y } = this.pointerXY(e);
    const contentBottom = this.timeAxisTop();
    this.crosshair = {
      x,
      y,
      active: x >= this.plotL && x <= this.plotL + this.plotW && y >= this.plotT && y <= contentBottom,
    };

    if (this.dragging?.kind === "pan") {
      const dxBars = (x - this.dragging.startX) / this.barSpacing;
      this.context.visibleRange = {
        from: this.dragging.startFrom - dxBars,
        to: this.dragging.startTo - dxBars,
      };
      void this.data.maybeLoadMoreHistory();
    } else if (this.dragging?.kind === "priceScale") {
      const dy = y - this.dragging.startY;
      const factor = Math.min(20, Math.max(0.05, 1 + dy / (this.plotH * 0.5)));
      const center = (this.dragging.startMin + this.dragging.startMax) / 2;
      const half = ((this.dragging.startMax - this.dragging.startMin) / 2) * factor;
      this.context.autoScalePrice = false;
      this.context.priceRange = {
        min: this.fromDisplay(center - half),
        max: this.fromDisplay(center + half),
      };
    } else if (this.dragging?.kind === "timeScale") {
      const dx = x - this.dragging.startX;
      const span = this.dragging.startTo - this.dragging.startFrom;
      const factor = Math.min(20, Math.max(0.05, 1 - dx / (this.plotW * 0.5)));
      const minSpan = this.plotW / MAX_BAR_SPACING;
      const maxSpan = this.plotW / MIN_BAR_SPACING;
      const newSpan = Math.min(maxSpan, Math.max(minSpan, span * factor));
      this.context.visibleRange = { from: this.dragging.startTo - newSpan, to: this.dragging.startTo };
      void this.data.maybeLoadMoreHistory();
    } else if (this.dragging?.kind === "shape") {
      const s = this.shapes.get(this.dragging.id as never);
      if (s) {
        const pt = s.points[this.dragging.pointIndex];
        if (pt) {
          const tp = this.timePriceAt(x, y);
          if (s.shape === "horizontal_line") {
            pt.price = tp.price;
          } else {
            pt.price = tp.price;
            pt.time = tp.unixTime;
          }
        }
      }
    } else {
      const inPriceAxis = x > this.plotL + this.plotW && y < this.plotT + this.plotH;
      const inTimeAxis = y >= contentBottom && x < this.plotL + this.plotW;
      this.hoverShapeId = null;
      this.hoverMark = null;
      if (!inPriceAxis && !inTimeAxis && y <= this.plotT + this.plotH) {
        for (const m of this.markScreen) {
          const dx = x - m.x;
          const dy = y - m.y;
          if (dx * dx + dy * dy <= (m.r + 2) * (m.r + 2)) {
            this.hoverMark = m.mark;
            break;
          }
        }
        if (!this.hoverMark) {
          for (const { shape, y: sy } of this.shapeScreen) {
            if (shape.lock || shape.disableSelection) continue;
            if (shape.shape === "horizontal_line" && Math.abs(sy - y) <= 4 && x <= this.plotL + this.plotW) {
              this.hoverShapeId = shape.id as unknown as string;
              break;
            }
            if (shape.shape !== "horizontal_line") {
              const hit = this.hitComplexShape(shape, x, y);
              if (hit) {
                this.hoverShapeId = shape.id as unknown as string;
                break;
              }
            }
          }
        }
      }
      const drawing = this.context.drawingTool !== "cursor";
      this.canvas.style.cursor = inPriceAxis
        ? "ns-resize"
        : inTimeAxis
          ? "ew-resize"
          : this.hoverShapeId
            ? "ns-resize"
            : drawing
              ? "crosshair"
              : this.hoverMark
                ? "pointer"
                : "crosshair";
    }
    this.engine.markDirty();
  }

  private hitComplexShape(shape: StoredShape, x: number, y: number): boolean {
    const pts = shape.points.map((p) => this.pointXY(p)).filter(Boolean) as { x: number; y: number }[];
    if (pts.length === 0) return false;
    for (const p of pts) {
      if (Math.abs(p.x - x) <= 6 && Math.abs(p.y - y) <= 6) return true;
    }
    if (shape.shape === "trend_line" && pts.length >= 2) {
      return distToSegment(x, y, pts[0]!, pts[1]!) <= 5;
    }
    if (shape.shape === "rectangle" && pts.length >= 2) {
      const a = pts[0]!;
      const b = pts[1]!;
      const l = Math.min(a.x, b.x);
      const r = Math.max(a.x, b.x);
      const t = Math.min(a.y, b.y);
      const bot = Math.max(a.y, b.y);
      const nearEdge =
        (Math.abs(x - l) <= 4 || Math.abs(x - r) <= 4) && y >= t - 4 && y <= bot + 4
        || (Math.abs(y - t) <= 4 || Math.abs(y - bot) <= 4) && x >= l - 4 && x <= r + 4;
      return nearEdge;
    }
    if (shape.shape === "fib_retracement" && pts.length >= 2) {
      return distToSegment(x, y, pts[0]!, pts[1]!) <= 6;
    }
    if (shape.shape === "text" && pts[0]) {
      return Math.abs(pts[0].x - x) <= 20 && Math.abs(pts[0].y - y) <= 12;
    }
    return false;
  }

  private neededPoints(tool: DrawingTool): number {
    if (tool === "horizontal_line" || tool === "text") return 1;
    if (tool === "trend_line" || tool === "rectangle" || tool === "fib_retracement") return 2;
    return 0;
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const { x, y } = this.pointerXY(e);
    const contentBottom = this.timeAxisTop();
    const inPriceAxis = x > this.plotL + this.plotW && y < this.plotT + this.plotH;
    const inTimeAxis = y >= contentBottom && x < this.plotL + this.plotW;
    const inPlot = x <= this.plotL + this.plotW && y >= this.plotT && y <= this.plotT + this.plotH;

    // Drawing tool placement takes priority over pan.
    const tool = this.context.drawingTool;
    if (tool !== "cursor" && inPlot && !inPriceAxis && !inTimeAxis) {
      const tp = this.timePriceAt(x, y);
      const point: ShapePoint = { time: tp.unixTime, price: tp.price };
      if (!this.draft || this.draft.tool !== tool) {
        this.draft = { tool, points: [point] };
      } else {
        this.draft.points.push(point);
      }
      const need = this.neededPoints(tool);
      if (this.draft.points.length >= need) {
        this.finishDraft();
      }
      this.engine.markDirty();
      return;
    }

    if (this.hoverShapeId) {
      const s = this.shapes.get(this.hoverShapeId as never);
      let pointIndex = 0;
      if (s && s.shape !== "horizontal_line") {
        const pts = s.points.map((p) => this.pointXY(p));
        let best = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          if (!p) continue;
          const d = Math.hypot(p.x - x, p.y - y);
          if (d < best) { best = d; pointIndex = i; }
        }
      }
      this.context.selectedShapeId = this.hoverShapeId;
      this.dragging = { kind: "shape", id: this.hoverShapeId, startY: y, pointIndex };
      return;
    }
    if (inPriceAxis) {
      this.dragging = { kind: "priceScale", startY: y, startMin: this.priceMin, startMax: this.priceMax };
      this.context.autoScalePrice = false;
      this.context.priceRange = {
        min: this.fromDisplay(this.priceMin),
        max: this.fromDisplay(this.priceMax),
      };
      return;
    }
    if (inTimeAxis) {
      this.dragging = {
        kind: "timeScale",
        startX: x,
        startFrom: this.context.visibleRange.from,
        startTo: this.context.visibleRange.to,
      };
      return;
    }
    this.context.selectedShapeId = null;
    if (x <= this.plotL + this.plotW && y <= this.plotT + this.plotH) {
      this.dragging = {
        kind: "pan",
        startX: x,
        startFrom: this.context.visibleRange.from,
        startTo: this.context.visibleRange.to,
      };
    }
  }

  private finishDraft(): void {
    if (!this.draft) return;
    const { tool, points } = this.draft;
    this.draft = null;
    let text = "";
    if (tool === "text") {
      text = window.prompt("Label text", "Note") ?? "";
      if (!text.trim()) {
        this.onToolDone?.("cursor");
        this.context.drawingTool = "cursor";
        this.engine.markDirty();
        return;
      }
    }
    const defaults: Record<string, unknown> = {
      linecolor: tool === "fib_retracement" ? "#f5a623" : "#66d89e",
      linewidth: 1,
      linestyle: tool === "horizontal_line" ? 2 : 0,
      showPrice: tool === "horizontal_line",
    };
    void this.shapes.createPoints(points, {
      shape: tool,
      text,
      lock: false,
      overrides: defaults,
    }).then((id) => {
      this.context.selectedShapeId = id as unknown as string;
    });
    this.context.drawingTool = "cursor";
    this.onToolDone?.("cursor");
    this.engine.markDirty();
  }

  private onMouseUp(): void {
    if (this.dragging?.kind === "shape") {
      const id = this.dragging.id;
      this.context.drawingEvent.fire(id, "points_changed");
    }
    this.dragging = null;
  }

  private onMouseLeave(): void {
    this.crosshair.active = false;
    this.hoverMark = null;
    if (!this.dragging) this.canvas.style.cursor = "default";
    this.engine.markDirty();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { from, to } = this.context.visibleRange;
    const span = to - from;
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    const newSpan = Math.max(this.plotW / MAX_BAR_SPACING, Math.min(this.plotW / MIN_BAR_SPACING, span * factor));
    const { x } = this.pointerXY(e);
    const pivot = this.indexForX(x);
    const leftFrac = (pivot - from) / span;
    this.context.visibleRange = {
      from: pivot - leftFrac * newSpan,
      to: pivot + (1 - leftFrac) * newSpan,
    };
    void this.data.maybeLoadMoreHistory();
    this.engine.markDirty();
  }

  private onDblClick(e: MouseEvent): void {
    const { x, y } = this.pointerXY(e);
    const inPriceAxis = x > this.plotL + this.plotW && y < this.plotT + this.plotH;
    this.context.priceRange = null;
    this.context.autoScalePrice = true;
    if (!inPriceAxis) this.fitContent();
    else this.engine.markDirty();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable) return;

    const { from, to } = this.context.visibleRange;
    const span = to - from;
    if (e.key === "Escape") {
      this.draft = null;
      this.context.drawingTool = "cursor";
      this.context.selectedShapeId = null;
      this.onToolDone?.("cursor");
      this.engine.markDirty();
      e.preventDefault();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.context.selectedShapeId) {
        this.shapes.remove(this.context.selectedShapeId as never);
        this.engine.markDirty();
        e.preventDefault();
      }
      return;
    }
    if (e.key === "f" || e.key === "F") {
      this.fitContent();
      e.preventDefault();
      return;
    }
    if (e.key === "+" || e.key === "=") {
      const newSpan = Math.max(this.plotW / MAX_BAR_SPACING, span / 1.15);
      this.context.visibleRange = { from: to - newSpan, to };
      this.engine.markDirty();
      e.preventDefault();
      return;
    }
    if (e.key === "-" || e.key === "_") {
      const newSpan = Math.min(this.plotW / MIN_BAR_SPACING, span * 1.15);
      this.context.visibleRange = { from: to - newSpan, to };
      void this.data.maybeLoadMoreHistory();
      this.engine.markDirty();
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      const shift = span * 0.08 * dir;
      this.context.visibleRange = { from: from + shift, to: to + shift };
      void this.data.maybeLoadMoreHistory();
      this.engine.markDirty();
      e.preventDefault();
    }
  }
}

function distToSegment(
  px: number,
  py: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  return Math.hypot(px - qx, py - qy);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Keep imports used (decimalsFromPricescale reserved for future tick precision).
void decimalsFromPricescale;
