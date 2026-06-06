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

const PRICE_AXIS_W = 66;
const TIME_AXIS_H = 22;
const MIN_BAR_SPACING = 1.5;
const MAX_BAR_SPACING = 64;
const VOLUME_FRACTION = 0.16; // bottom 16% of the plot reserved for volume bars

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
  private priceMin = 0;
  private priceMax = 1;

  // Pointer/drag state.
  private dragging: null | { kind: "pan"; startX: number; startFrom: number; startTo: number }
    | { kind: "shape"; id: string; startY: number } = null;
  private hoverShapeId: string | null = null;

  private boundMove: (e: MouseEvent) => void;
  private boundDown: (e: MouseEvent) => void;
  private boundUp: (e: MouseEvent) => void;
  private boundLeave: () => void;
  private boundWheel: (e: WheelEvent) => void;
  private boundDbl: () => void;
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
    this.boundDbl = () => this.onDblClick();
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
    let lo = Infinity;
    let hi = -Infinity;
    const start = Math.max(0, Math.floor(from));
    const end = Math.min(bars.length - 1, Math.ceil(to));
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b) continue;
      if (b.low > 0 && b.low < lo) lo = b.low;
      if (b.high > hi) hi = b.high;
    }
    // NOTE: horizontal-line shapes (limit/avg/ATH lines) are deliberately NOT
    // folded into the auto-fit. TradingView fits the price scale to the bars and
    // lets off-range lines clip at the edges; including them would squish the
    // candles whenever a line sits far from current price.
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) {
      this.priceMin = 0;
      this.priceMax = 1;
      return;
    }
    if (lo === hi) {
      lo *= 0.99;
      hi *= 1.01;
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
    this.plotW = Math.max(1, W - PRICE_AXIS_W);
    this.plotH = Math.max(1, H - TIME_AXIS_H);

    this.computePriceRange();

    const t = this.context.theme;
    const priceTicks = this.computePriceTicks();
    const timeTicks = this.computeTimeTicks();

    this.drawGrid(ctx, priceTicks, timeTicks);
    this.drawVolume(ctx);
    this.drawCandles(ctx);
    this.drawShapes(ctx);
    this.drawMarks(ctx);
    this.drawPriceAxis(ctx, priceTicks);
    this.drawTimeAxis(ctx, timeTicks);
    this.drawCrosshair(ctx);
    this.drawLegend(ctx);

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
    const bodyW = Math.max(1, Math.min(MAX_BAR_SPACING, spacing * 0.7));
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
    const w = Math.max(1, spacing * 0.7);
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
    const baseY = this.plotT + this.plotH - this.plotH * VOLUME_FRACTION;

    for (const m of marks) {
      const tMs = m.time * 1000;
      // Map the mark's time to the nearest bar index.
      const idx = Math.round((tMs - firstT) / resMs);
      if (idx < 0 || idx >= bars.length) continue;
      const x = this.xForIndex(idx);
      if (x < this.plotL - 10 || x > this.plotL + this.plotW + 10) continue;
      const r = Math.max(7, Math.min(13, (m.minSize ?? 16) / 2));
      const y = baseY - 6;
      const col = m.color as MarkCustomColor;
      const border = typeof col === "object" ? col.border : "#2962ff";
      const bg = typeof col === "object" ? col.background : "#2962ff";

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = border;
      ctx.stroke();

      if (m.label) {
        ctx.fillStyle = m.labelFontColor || "#fff";
        ctx.font = `bold ${Math.round(r)}px ${this.context.fontFamily}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(m.label.slice(0, 2), x, y + 0.5);
      }
      this.markScreen.push({ mark: m, x, y, r });
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
    const target = Math.max(2, Math.floor(this.plotW / 90));
    const span = to - from;
    const stepBars = Math.max(1, Math.round(span / target));
    const ticks: { index: number; time: number }[] = [];
    const start = Math.max(0, Math.floor(from));
    const end = Math.min(bars.length - 1, Math.ceil(to));
    for (let i = start; i <= end; i++) {
      if (i % stepBars !== 0) continue;
      ticks.push({ index: i, time: bars[i]!.time });
    }
    return ticks;
  }

  private drawPriceAxis(ctx: CanvasRenderingContext2D, ticks: number[]): void {
    const t = this.context.theme;
    const pricescale = this.context.symbolInfo?.pricescale ?? 100;
    ctx.fillStyle = t.scaleBackground;
    ctx.fillRect(this.plotL + this.plotW, 0, PRICE_AXIS_W, this.engine.cssHeight);
    ctx.fillStyle = t.scaleText;
    ctx.font = `11px ${this.context.fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const p of ticks) {
      const y = this.yForPrice(p);
      if (y < this.plotT + 6 || y > this.plotT + this.plotH - 2) continue;
      ctx.fillText(formatPrice(p, pricescale), this.plotL + this.plotW + 6, y);
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
    const intraday = parseResolution(this.context.resolution).kind !== "days";
    for (const tk of ticks) {
      const x = this.xForIndex(tk.index);
      if (x < this.plotL + 16 || x > this.plotL + this.plotW - 16) continue;
      ctx.fillText(this.formatAxisTime(tk.time, intraday), x, y);
    }
  }

  private formatAxisTime(ms: number, intraday: boolean): string {
    const d = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, "0");
    if (intraday) {
      // Show date at midnight boundaries, else HH:MM (UTC, matching Etc/UTC).
      if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) {
        return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
      }
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }

  private drawAxisTag(ctx: CanvasRenderingContext2D, y: number, text: string, bg: string, fg: string): void {
    ctx.font = `11px ${this.context.fontFamily}`;
    const w = PRICE_AXIS_W - 2;
    const h = 15;
    ctx.fillStyle = bg;
    ctx.fillRect(this.plotL + this.plotW + 1, y - h / 2, w, h);
    ctx.fillStyle = fg;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, this.plotL + this.plotW + 6, y);
  }

  // ── Crosshair + legend ──────────────────────────────────────────────────────
  private drawCrosshair(ctx: CanvasRenderingContext2D): void {
    if (!this.crosshair.active) return;
    const t = this.context.theme;
    const { x, y } = this.crosshair;
    if (x > this.plotL + this.plotW || y > this.plotT + this.plotH) return;
    ctx.save();
    ctx.strokeStyle = t.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, this.plotT);
    ctx.lineTo(Math.round(x) + 0.5, this.plotT + this.plotH);
    ctx.moveTo(this.plotL, Math.round(y) + 0.5);
    ctx.lineTo(this.plotL + this.plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const pricescale = this.context.symbolInfo?.pricescale ?? 100;
    if (t.showPriceScaleCrosshairLabel) {
      this.drawAxisTag(ctx, y, formatPrice(this.priceForY(y), pricescale), t.scaleText === "#131722" ? "#e0e3eb" : "#363a45", t.scaleText === "#131722" ? "#131722" : "#ffffff");
    }
    if (t.showTimeScaleCrosshairLabel) {
      const bars = this.context.bars;
      const idx = Math.round(this.indexForX(x));
      const bar = bars[Math.max(0, Math.min(bars.length - 1, idx))];
      if (bar) {
        const intraday = parseResolution(this.context.resolution).kind !== "days";
        const label = this.formatCrosshairTime(bar.time, intraday);
        ctx.font = `11px ${this.context.fontFamily}`;
        const w = ctx.measureText(label).width + 12;
        const tx = Math.max(this.plotL, Math.min(this.plotL + this.plotW - w, x - w / 2));
        ctx.fillStyle = "#363a45";
        ctx.fillRect(tx, this.plotT + this.plotH + 1, w, TIME_AXIS_H - 2);
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, tx + w / 2, this.plotT + this.plotH + TIME_AXIS_H / 2);
      }
    }
  }

  private formatCrosshairTime(ms: number, intraday: boolean): string {
    const d = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
    if (intraday) return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    return date;
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

    const name = this.context.symbolInfo?.name ?? this.context.symbol;
    ctx.font = `bold 13px ${this.context.fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = t.scaleText;
    ctx.fillText(name, 8, 6);

    ctx.font = `12px ${this.context.fontFamily}`;
    ctx.fillStyle = col;
    const f = (v: number): string => formatPrice(v, pricescale);
    const ohlc = `O ${f(bar.open)}  H ${f(bar.high)}  L ${f(bar.low)}  C ${f(bar.close)}`;
    ctx.fillText(ohlc, 8, 24);
    if (bar.volume) {
      ctx.fillStyle = t.scaleText;
      ctx.fillText(`Vol ${formatVolume(bar.volume)}`, 8, 40);
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
      this.context.autoScalePrice = true;
      void this.data.maybeLoadMoreHistory();
    } else if (this.dragging?.kind === "shape") {
      const s = this.shapes.get(this.dragging.id as never);
      if (s && s.points[0]) {
        s.points[0].price = this.priceForY(y);
      }
    } else {
      // Hover detection for draggable (unlocked) shapes → resize cursor.
      this.hoverShapeId = null;
      for (const { shape, y: sy } of this.shapeScreen) {
        if (!shape.lock && Math.abs(sy - y) <= 4 && x <= this.plotL + this.plotW) {
          this.hoverShapeId = shape.id as unknown as string;
          break;
        }
      }
      this.canvas.style.cursor = this.hoverShapeId ? "ns-resize" : "crosshair";
    }
    this.engine.markDirty();
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const x = e.offsetX;
    const y = e.offsetY;
    if (this.hoverShapeId) {
      this.dragging = { kind: "shape", id: this.hoverShapeId, startY: y };
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
    this.context.autoScalePrice = true;
    void this.data.maybeLoadMoreHistory();
    this.engine.markDirty();
  }

  private onDblClick(): void {
    // Reset to the most recent window + auto price scale.
    const n = this.context.bars.length;
    if (n) {
      const count = Math.min(n, 120);
      this.context.visibleRange = { from: n - count, to: n - 1 + Math.max(2, Math.floor(count * 0.06)) };
    }
    this.context.priceRange = null;
    this.context.autoScalePrice = true;
    this.engine.markDirty();
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Keep imports used (decimalsFromPricescale reserved for future tick precision).
void decimalsFromPricescale;
