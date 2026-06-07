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

import type { Mark, MarkCustomColor } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import type { ChartEngine } from "./ChartEngine";
import type { ShapeStore, StoredShape } from "../core/ShapeStore";
import type { DataManager } from "../data/DataManager";
import { resolutionToMs, parseResolution } from "../util/resolution";
import { decimalsFromPricescale, formatPrice, formatVolume } from "../util/format";

const PRICE_AXIS_W_DEFAULT = 64;
const PRICE_AXIS_W_MIN = 56;
const PRICE_AXIS_W_MAX = 128;
const TIME_AXIS_H = 22;
const MIN_BAR_SPACING = 1.5;
const MAX_BAR_SPACING = 64;
const VOLUME_FRACTION = 0.16; // bottom 16% of the plot reserved for volume bars
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
  private priceAxisW = PRICE_AXIS_W_DEFAULT; // widened to fit the widest label
  private priceMin = 0;
  private priceMax = 1;

  // Pointer/drag state.
  private dragging:
    | null
    | { kind: "pan"; startX: number; startFrom: number; startTo: number }
    | { kind: "shape"; id: string; startY: number }
    | { kind: "priceScale"; startY: number; startMin: number; startMax: number }
    | { kind: "timeScale"; startX: number; startFrom: number; startTo: number } = null;
  private hoverShapeId: string | null = null;

  private boundMove: (e: MouseEvent) => void;
  private boundDown: (e: MouseEvent) => void;
  private boundUp: (e: MouseEvent) => void;
  private boundLeave: () => void;
  private boundWheel: (e: WheelEvent) => void;
  private boundDbl: (e: MouseEvent) => void;
  private onData: () => void;

  constructor(
    private readonly context: ChartContext,
    private readonly engine: ChartEngine,
    private readonly shapes: ShapeStore,
    private readonly data: DataManager,
  ) {
    this.canvas = engine.canvas;
    this.boundMove = (e) => this.onMouseMove(e);
    this.boundDown = (e) => this.onMouseDown(e);
    this.boundUp = () => this.onMouseUp();
    this.boundLeave = () => this.onMouseLeave();
    this.boundWheel = (e) => this.onWheel(e);
    this.boundDbl = (e) => this.onDblClick(e);
    this.onData = () => this.engine.markDirty();
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
  }

  destroy(): void {
    this.context.dataChanged.unsubscribe(null, this.onData as never);
    this.canvas.removeEventListener("mousemove", this.boundMove);
    this.canvas.removeEventListener("mousedown", this.boundDown);
    window.removeEventListener("mouseup", this.boundUp);
    this.canvas.removeEventListener("mouseleave", this.boundLeave);
    this.canvas.removeEventListener("wheel", this.boundWheel);
    this.canvas.removeEventListener("dblclick", this.boundDbl);
    this.engine.paintHook = null;
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
    const r = this.priceMax - this.priceMin || 1;
    return this.plotT + (this.priceMax - p) / r * this.plotH;
  }

  private priceForY(y: number): number {
    const r = this.priceMax - this.priceMin || 1;
    return this.priceMax - (y - this.plotT) / this.plotH * r;
  }

  /** Public: time (unix seconds) + price under a canvas pixel — for onContextMenu. */
  timePriceAt(x: number, y: number): { unixTime: number; price: number } {
    const bars = this.context.bars;
    const idx = Math.round(this.indexForX(x));
    let unixTime = 0;
    if (bars.length) {
      const clamped = Math.max(0, Math.min(bars.length - 1, idx));
      const bar = bars[clamped];
      if (bar) {
        // Extrapolate beyond the last bar so right-side clicks still map to time.
        const resMs = resolutionToMs(this.context.resolution);
        unixTime = Math.floor((bar.time + (idx - clamped) * resMs) / 1000);
      }
    }
    return { unixTime, price: this.priceForY(y) };
  }

  // ── Visible-price computation (auto-fit) ────────────────────────────────────
  private computePriceRange(): void {
    if (this.context.priceRange && !this.context.autoScalePrice) {
      this.priceMin = this.context.priceRange.min;
      this.priceMax = this.context.priceRange.max;
      return;
    }
    const bars = this.context.bars;
    const { from, to } = this.context.visibleRange;
    const start = Math.max(0, Math.floor(from));
    const end = Math.min(bars.length - 1, Math.ceil(to));

    // Track the candle BODY envelope (open/close) separately from the full
    // high/low extent. The scale fits the bodies; wicks get bounded extra room.
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
    // NOTE: horizontal-line shapes (limit/avg/ATH lines) are deliberately NOT
    // folded into the auto-fit — off-range lines clip at the edges (TV behaviour).
    if (!Number.isFinite(bodyHi) || !Number.isFinite(bodyLo) || bodyHi <= 0) {
      this.priceMin = 0;
      this.priceMax = 1;
      return;
    }
    // Bodies are always fully visible; wicks may extend up to `wickRoom` beyond
    // the body envelope. An isolated extreme wick (common on a token's first
    // bars) then clips instead of stretching the whole axis and leaving the
    // candles squashed against one edge with a wall of empty space.
    const bodyRange = Math.max(0, bodyHi - bodyLo);
    const wickRoom = Math.max(bodyRange, bodyHi * 0.06);
    hi = Math.min(hi, bodyHi + wickRoom);
    lo = Math.max(Math.max(0, bodyLo - wickRoom), Number.isFinite(lo) ? lo : bodyLo);
    if (lo >= hi) {
      lo = bodyLo * 0.99;
      hi = bodyHi * 1.01;
    }
    const pad = (hi - lo) * 0.08;
    this.priceMin = Math.max(0, lo - pad);
    this.priceMax = hi + pad;
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  private render(ctx: CanvasRenderingContext2D): void {
    const W = this.engine.cssWidth;
    const H = this.engine.cssHeight;
    if (W <= 0 || H <= 0) return;

    this.plotL = 0;
    this.plotT = 0;
    this.plotW = Math.max(1, W - this.priceAxisW);
    this.plotH = Math.max(1, H - TIME_AXIS_H);

    this.computePriceRange();

    const t = this.context.theme;
    const priceTicks = this.computePriceTicks();
    const timeTicks = this.computeTimeTicks();

    // Size the price axis to the widest label it must show (TV-style), so full
    // comma-separated numbers aren't clipped. Converges in one frame.
    this.adjustPriceAxisWidth(ctx, priceTicks);

    this.drawGrid(ctx, priceTicks, timeTicks);
    this.drawVolume(ctx);
    this.drawCandles(ctx);
    this.drawShapes(ctx);
    this.drawMarks(ctx);
    this.drawPriceAxis(ctx, priceTicks);
    this.drawTimeAxis(ctx, timeTicks);
    this.drawLastPrice(ctx);
    this.drawCrosshair(ctx);
    this.drawLegend(ctx);

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
      };
    }

    // Axis separators.
    ctx.strokeStyle = t.scaleLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.plotL + this.plotW + 0.5, 0);
    ctx.lineTo(this.plotL + this.plotW + 0.5, this.plotT + this.plotH);
    ctx.moveTo(0, this.plotT + this.plotH + 0.5);
    ctx.lineTo(W, this.plotT + this.plotH + 0.5);
    ctx.stroke();
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

  private drawCandles(ctx: CanvasRenderingContext2D): void {
    const bars = this.context.bars;
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

  // ── Shapes (P5): horizontal lines ───────────────────────────────────────────
  private shapeScreen: { shape: StoredShape; y: number }[] = [];

  private drawShapes(ctx: CanvasRenderingContext2D): void {
    this.shapeScreen = [];
    const pricescale = this.context.symbolInfo?.pricescale ?? 100;
    for (const s of this.shapes.list()) {
      if (s.shape !== "horizontal_line") continue;
      const price = s.points[0]?.price;
      if (typeof price !== "number" || !Number.isFinite(price)) continue;
      const y = this.yForPrice(price);
      if (y < this.plotT - 40 || y > this.plotT + this.plotH + 40) {
        this.shapeScreen.push({ shape: s, y });
        continue;
      }
      const o = s.overrides;
      const color = (o.linecolor as string) ?? "#2962ff";
      const width = (o.linewidth as number) ?? 1;
      const style = (o.linestyle as number) ?? 0; // 0 solid, 2 dashed
      const textColor = (o.textcolor as string) ?? color;
      const fontsize = (o.fontsize as number) ?? 11;
      const showPrice = o.showPrice !== false;
      const bold = o.bold === true;
      const italic = o.italic === true;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(style === 2 ? [5, 4] : style === 1 ? [2, 3] : []);
      const yy = Math.round(y) + 0.5;
      ctx.beginPath();
      ctx.moveTo(this.plotL, yy);
      ctx.lineTo(this.plotL + this.plotW, yy);
      ctx.stroke();
      ctx.setLineDash([]);

      // Text label (above the line, right-aligned to match the app's overrides).
      if (s.text) {
        ctx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontsize}px ${this.context.fontFamily}`;
        ctx.fillStyle = textColor;
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillText(s.text, this.plotL + this.plotW - 6, yy - 3);
      }

      // Price tag on the axis.
      if (showPrice) {
        const label = formatPrice(price, pricescale);
        this.drawAxisTag(ctx, yy - 0.5, label, color, "#ffffff");
      }
      ctx.restore();
      this.shapeScreen.push({ shape: s, y });
    }
  }

  // ── Axes ──────────────────────────────────────────────────────────────────
  private computePriceTicks(): number[] {
    const target = Math.max(2, Math.floor(this.plotH / 56));
    const range = this.priceMax - this.priceMin;
    if (range <= 0) return [];
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
    const first = Math.ceil(this.priceMin / step) * step;
    const ticks: number[] = [];
    for (let p = first; p <= this.priceMax; p += step) ticks.push(p);
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
      const w = ctx.measureText(formatPrice(v, pricescale)).width;
      if (w > widest) widest = w;
    };
    for (const p of ticks) consider(p);
    consider(this.priceMax);
    consider(this.priceMin);
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
      ctx.fillText(formatPrice(p, pricescale), rightEdge, y);
    }
  }

  private drawTimeAxis(ctx: CanvasRenderingContext2D, ticks: { index: number; time: number }[]): void {
    const t = this.context.theme;
    ctx.fillStyle = t.scaleBackground;
    ctx.fillRect(0, this.plotT + this.plotH, this.engine.cssWidth, TIME_AXIS_H);
    ctx.fillStyle = t.scaleText;
    ctx.font = `11px ${this.context.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const y = this.plotT + this.plotH + TIME_AXIS_H / 2;
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
    this.drawAxisTag(ctx, cy, formatPrice(price, pricescale), color, "#10100e", true);
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
    const { y } = this.crosshair;
    let { x } = this.crosshair;
    if (x > this.plotL + this.plotW || y > this.plotT + this.plotH) return;

    // Snap the vertical line to the hovered bar's centre for a precise feel.
    const bars = this.context.bars;
    const idx = Math.round(this.indexForX(x));
    const snapBar = bars[Math.max(0, Math.min(bars.length - 1, idx))];
    if (snapBar && idx >= 0 && idx < bars.length) x = this.xForIndex(idx);

    ctx.save();
    ctx.strokeStyle = t.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, this.plotT);
    ctx.lineTo(Math.round(x) + 0.5, this.plotT + this.plotH);
    ctx.moveTo(this.plotL, Math.round(y) + 0.5);
    ctx.lineTo(this.plotL + this.plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const pill = this.neutralPill();
    const pricescale = this.context.symbolInfo?.pricescale ?? 100;
    if (t.showPriceScaleCrosshairLabel) {
      this.drawAxisTag(ctx, y, formatPrice(this.priceForY(y), pricescale), pill.bg, pill.fg);
    }
    if (t.showTimeScaleCrosshairLabel && snapBar) {
      const label = this.formatCrosshairTime(snapBar.time, parseResolution(this.context.resolution).kind);
      ctx.font = `11px ${this.context.fontFamily}`;
      const w = ctx.measureText(label).width + 14;
      const tx = Math.max(this.plotL, Math.min(this.plotL + this.plotW - w, x - w / 2));
      ctx.fillStyle = pill.bg;
      this.roundRect(ctx, tx, this.plotT + this.plotH + 2, w, TIME_AXIS_H - 4, 3);
      ctx.fill();
      ctx.fillStyle = pill.fg;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, tx + w / 2, this.plotT + this.plotH + TIME_AXIS_H / 2 + 0.5);
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
    }
    if (bar.volume) {
      ctx.fillStyle = dim;
      ctx.font = `11px ${this.context.fontFamily}`;
      ctx.fillText(`Vol ${formatVolume(bar.volume)}`, 10, 35);
    }
  }

  // ── Interaction ─────────────────────────────────────────────────────────────
  private onMouseMove(e: MouseEvent): void {
    const x = e.offsetX;
    const y = e.offsetY;
    this.crosshair = { x, y, active: x <= this.plotL + this.plotW && y <= this.plotT + this.plotH };

    if (this.dragging?.kind === "pan") {
      const dxBars = (x - this.dragging.startX) / this.barSpacing;
      this.context.visibleRange = {
        from: this.dragging.startFrom - dxBars,
        to: this.dragging.startTo - dxBars,
      };
      void this.data.maybeLoadMoreHistory();
    } else if (this.dragging?.kind === "priceScale") {
      // Drag the price axis vertically to rescale price: down = zoom out
      // (wider range), up = zoom in. Pivots around the range centre captured at
      // mousedown so the scaling is stable across the whole drag.
      const dy = y - this.dragging.startY;
      const factor = Math.min(20, Math.max(0.05, 1 + dy / (this.plotH * 0.5)));
      const center = (this.dragging.startMin + this.dragging.startMax) / 2;
      const half = ((this.dragging.startMax - this.dragging.startMin) / 2) * factor;
      this.context.autoScalePrice = false;
      this.context.priceRange = { min: Math.max(0, center - half), max: center + half };
    } else if (this.dragging?.kind === "timeScale") {
      // Drag the time axis horizontally to change bar spacing: left = zoom out
      // (more bars), right = zoom in. Anchored on the right edge.
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
      if (s && s.points[0]) {
        s.points[0].price = this.priceForY(y);
      }
    } else {
      // Hover cursor: axes get resize affordances, unlocked shapes too.
      const inPriceAxis = x > this.plotL + this.plotW && y < this.plotT + this.plotH;
      const inTimeAxis = y > this.plotT + this.plotH && x < this.plotL + this.plotW;
      this.hoverShapeId = null;
      if (!inPriceAxis && !inTimeAxis) {
        for (const { shape, y: sy } of this.shapeScreen) {
          if (!shape.lock && Math.abs(sy - y) <= 4 && x <= this.plotL + this.plotW) {
            this.hoverShapeId = shape.id as unknown as string;
            break;
          }
        }
      }
      this.canvas.style.cursor = inPriceAxis
        ? "ns-resize"
        : inTimeAxis
          ? "ew-resize"
          : this.hoverShapeId
            ? "ns-resize"
            : "crosshair";
    }
    this.engine.markDirty();
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const x = e.offsetX;
    const y = e.offsetY;
    const inPriceAxis = x > this.plotL + this.plotW && y < this.plotT + this.plotH;
    const inTimeAxis = y > this.plotT + this.plotH && x < this.plotL + this.plotW;

    if (this.hoverShapeId) {
      this.dragging = { kind: "shape", id: this.hoverShapeId, startY: y };
      return;
    }
    if (inPriceAxis) {
      // Snapshot the currently-displayed range so the drag scales from here.
      this.dragging = { kind: "priceScale", startY: y, startMin: this.priceMin, startMax: this.priceMax };
      this.context.autoScalePrice = false;
      this.context.priceRange = { min: this.priceMin, max: this.priceMax };
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
    if (x <= this.plotL + this.plotW && y <= this.plotT + this.plotH) {
      this.dragging = {
        kind: "pan",
        startX: x,
        startFrom: this.context.visibleRange.from,
        startTo: this.context.visibleRange.to,
      };
    }
  }

  private onMouseUp(): void {
    if (this.dragging?.kind === "shape") {
      // Fire points_changed so the app's drawing_event handler reacts to drags.
      const id = this.dragging.id;
      this.context.drawingEvent.fire(id, "points_changed");
    }
    this.dragging = null;
  }

  private onMouseLeave(): void {
    this.crosshair.active = false;
    if (!this.dragging) this.canvas.style.cursor = "default";
    this.engine.markDirty();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { from, to } = this.context.visibleRange;
    const span = to - from;
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    const newSpan = Math.max(this.plotW / MAX_BAR_SPACING, Math.min(this.plotW / MIN_BAR_SPACING, span * factor));
    // Zoom around the cursor's bar index.
    const pivot = this.indexForX(e.offsetX);
    const leftFrac = (pivot - from) / span;
    this.context.visibleRange = {
      from: pivot - leftFrac * newSpan,
      to: pivot + (1 - leftFrac) * newSpan,
    };
    void this.data.maybeLoadMoreHistory();
    this.engine.markDirty();
  }

  private onDblClick(e: MouseEvent): void {
    const x = e.offsetX;
    const y = e.offsetY;
    const inPriceAxis = x > this.plotL + this.plotW && y < this.plotT + this.plotH;
    // Double-clicking the price axis resets ONLY the price scale to auto-fit
    // (keeps the time view); anywhere else resets the whole view.
    this.context.priceRange = null;
    this.context.autoScalePrice = true;
    if (!inPriceAxis) {
      const n = this.context.bars.length;
      if (n) {
        const count = Math.min(n, 120);
        this.context.visibleRange = { from: n - count, to: n - 1 + Math.max(2, Math.floor(count * 0.06)) };
      }
    }
    this.engine.markDirty();
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Keep imports used (decimalsFromPricescale reserved for future tick precision).
void decimalsFromPricescale;
