// Main-series painters: candles, hollow candles, OHLC bars, columns, baseline.
//
// Candles and bars paint in device pixels through pixel.ts (AD-04): the wick is
// one hairline (`max(1, floor(dpr))` device pixels) and the body width has the
// wick's parity, so every body sits symmetrically around its wick at any DPR.
// All main-series painters clip to the price pane; a wick that autoscale trims
// shows a small arrowhead at the pane edge instead of bleeding into the volume
// pane or sub-panes. Wick, border, body and arrowhead never overlap, so each
// candle pixel is painted once and translucent colours blend only with what is
// behind the candle.

import { CANDLE_MAX_WIDTH } from "../layout";
import { barSpacing, xForIndex, yForPrice } from "../plotScale";
import type { Bar } from "../../types/charting_library";
import { drawLineArea } from "./lineArea";
import {
  clipToRect,
  deviceLineWidth,
  fillRectBorder,
  lineStart,
  withBitmapSpace,
  type BitmapSpace,
  type DeviceRect,
} from "./pixel";
import type { FinanceView } from "./view";

// Keep an OHLC body discernible when a short plot maps open and close to the
// same (or adjacent) pixel. Two CSS pixels remain clear on high-DPI canvases
// without materially changing normally sized candles.
const MIN_CANDLE_BODY_HEIGHT = 2;
const THIN_DOJI_TICK_HALF_WIDTH = 1;
/** Candle bodies take this share of the bar spacing (capped by CANDLE_MAX_WIDTH). */
const BODY_SPACING_RATIO = 0.74;
/** Bodies narrower than this many hairlines are painted without a border. */
const BORDER_MIN_BODY_HAIRLINES = 3;
/** Rows of the arrowhead drawn where the pane edge trims a wick. */
const CLIP_MARKER_ROWS = 3;

/** Per-frame horizontal geometry shared by every candle, bar, column and volume bar. */
export interface CandleColumns {
  /** Device width of a wick / OHLC stem (one hairline). */
  wickW: number;
  /** Device width of a body; `bodyW - wickW` is even, so the wick is centred. */
  bodyW: number;
  /** Bodies would be no wider than the wick: paint wick-only "thin" candles. */
  thin: boolean;
  /** Whole device pixels between two bar centres (at least 1). */
  slot: number;
}

/**
 * Horizontal candle geometry for a bar spacing, in device pixels.
 *
 * The body is the width nearest to `spacing × 0.74` (capped at
 * CANDLE_MAX_WIDTH) that has the wick's parity, leaving at least one hairline
 * between neighbouring bodies, so `left margin === right margin` around the
 * wick and every visible body has the same width.
 */
export function candleColumns(spacingCss: number, hpr: number): CandleColumns {
  const wickW = deviceLineWidth(1, hpr);
  const slot = Math.max(1, Math.floor(spacingCss * hpr));
  const target = Math.max(1, Math.min(CANDLE_MAX_WIDTH, spacingCss * BODY_SPACING_RATIO)) * hpr;
  // Nearest width with the wick's parity; ties go to the narrower body.
  const below = Math.max(wickW, wickW + 2 * Math.floor((target - wickW) / 2));
  const above = below + 2;
  let bodyW = above - target < target - below ? above : below;
  const cap = slot - wickW;
  if (bodyW > cap) bodyW = Math.max(wickW, cap - ((cap - wickW) % 2));
  return { wickW, bodyW, thin: bodyW <= wickW, slot };
}

/** Device column where a bar's wick starts. */
export function wickColumn(s: BitmapSpace, cols: CandleColumns, x: number): number {
  return lineStart(s.x(x), cols.wickW);
}

/** Device column where a bar's body starts (centred on its wick). */
export function bodyLeft(s: BitmapSpace, cols: CandleColumns, x: number): number {
  return wickColumn(s, cols, x) - (cols.bodyW - cols.wickW) / 2;
}

/** A bar with a finite OHLC that this scale can place (log needs positive prices). */
function paintable(v: FinanceView, b: Bar): boolean {
  if (!Number.isFinite(b.open) || !Number.isFinite(b.high) || !Number.isFinite(b.low) || !Number.isFinite(b.close)) {
    return false;
  }
  // Log scale can't place non-positive opens/closes; the plot scale falls back
  // for such data. Lows at or below zero still draw (to the pane edge).
  return !v.logScale || (b.open > 0 && b.close > 0);
}

interface Rows {
  /** Top/bottom device rows of the full high–low extent. */
  high: number;
  low: number;
  /** Top/bottom device rows of the body. */
  top: number;
  bottom: number;
}

function candleRows(s: BitmapSpace, v: FinanceView, b: Bar, minBodyRows: number): Rows {
  const yO = yForPrice(v, b.open);
  const yC = yForPrice(v, b.close);
  let top = s.y(Math.min(yO, yC));
  let bottom = s.y(Math.max(yO, yC));
  if (bottom - top < minBodyRows) {
    // Centre an enlarged body on the actual open/close values so the visual
    // minimum does not imply a direction or shift a tiny candle's price.
    top = s.y((yO + yC) / 2 - minBodyRows / (2 * s.vpr));
    bottom = top + minBodyRows;
  }
  const high = Math.min(top, s.y(yForPrice(v, b.high)));
  const low = Math.max(bottom, s.y(yForPrice(v, b.low)));
  return { high, low, top, bottom };
}

/**
 * Arrowhead at the pane edge for a wick that the pane clips. Only drawn while
 * the price scale autoscales (autoscale deliberately trims long wicks) and the
 * body is on screen, so a user-dragged scale does not sprout markers.
 */
function drawClipMarkers(
  s: BitmapSpace,
  clip: DeviceRect,
  rows: Rows,
  wickL: number,
  wickW: number,
  maxExtend: number,
): void {
  if (rows.bottom <= clip.y || rows.top >= clip.y + clip.h) return;
  const step = Math.max(1, Math.floor(s.hpr));
  const rowH = s.lineH(1);
  const extend = Math.min(step * (CLIP_MARKER_ROWS - 1), maxExtend);
  if (extend <= 0) return;
  const ctx = s.ctx;
  // The wick already fills its own column and the body its rows: paint only
  // the arrowhead's sides, so a translucent wick colour never doubles up.
  const side = (y: number, e: number): void => {
    ctx.rect(wickL - e, y, e, rowH);
    ctx.rect(wickL + wickW, y, e, rowH);
  };
  ctx.beginPath();
  for (let k = 1; k < CLIP_MARKER_ROWS; k++) {
    const e = Math.min(extend, k * step);
    const top = clip.y + k * rowH;
    const bottom = clip.y + clip.h - (k + 1) * rowH;
    if (rows.high < clip.y && top + rowH <= rows.top) side(top, e);
    if (rows.low > clip.y + clip.h && bottom >= rows.bottom) side(bottom, e);
  }
  ctx.fill();
}

function visibleBarRange(v: FinanceView, bars: Bar[]): { start: number; end: number } {
  const { from, to } = v.visibleRange;
  return {
    start: Math.max(0, Math.floor(from) - 1),
    end: Math.min(bars.length - 1, Math.ceil(to) + 1),
  };
}

/** Clip to the price pane in device pixels; every main-series painter does this. */
function clipToPlot(s: BitmapSpace, v: FinanceView): DeviceRect {
  return clipToRect(s, v.plotL, v.plotT, v.plotW, v.plotH);
}

export function drawCandles(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  bars: Bar[],
  hollow = false,
): void {
  if (!bars.length) return;
  const t = v.context.theme;
  const { start, end } = visibleBarRange(v, bars);
  const markClipped = v.context.autoScalePrice !== false;

  withBitmapSpace(ctx, v.dpr, (s) => {
    const clip = clipToPlot(s, v);
    const cols = candleColumns(barSpacing(v), s.hpr);
    const { wickW, bodyW, thin } = cols;
    const bw = s.lineW(1);
    const bh = s.lineH(1);
    const minBodyRows = thin ? 0 : Math.max(1, Math.round(MIN_CANDLE_BODY_HEIGHT * s.vpr));
    const withBorder = !thin && bodyW >= BORDER_MIN_BODY_HAIRLINES * bw;
    const dojiExtend = s.lineW(THIN_DOJI_TICK_HALF_WIDTH);
    const dojiFits = cols.slot >= wickW + 2 * dojiExtend + 1;

    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b || !paintable(v, b)) continue;
      const up = b.close >= b.open;
      const x = xForIndex(v, i);
      const wl = wickColumn(s, cols, x);
      const rows = candleRows(s, v, b, minBodyRows);

      ctx.fillStyle = up ? t.wickUp : t.wickDown;
      if (thin) {
        // A thin body is a hairline in the body colour in line with the wick;
        // a doji becomes a small horizontal tick so it does not vanish into
        // the wick. The wick stops at the body, as for full candles.
        const doji = rows.bottom - rows.top < bh;
        const e = doji && dojiFits ? dojiExtend : 0;
        const top = doji ? lineStart(s.y((yForPrice(v, b.open) + yForPrice(v, b.close)) / 2), bh) : rows.top;
        const bottom = doji ? top + bh : rows.bottom;
        if (top > rows.high) ctx.fillRect(wl, rows.high, wickW, top - rows.high);
        if (rows.low > bottom) ctx.fillRect(wl, bottom, wickW, rows.low - bottom);
        ctx.fillStyle = up ? t.candleUp : t.candleDown;
        ctx.fillRect(wl - e, top, wickW + 2 * e, bottom - top);
        continue;
      }

      // Neither the wick nor the border is painted under the body fill, so a
      // translucent body blends only with what is behind the candle.
      if (rows.top > rows.high) ctx.fillRect(wl, rows.high, wickW, rows.top - rows.high);
      if (rows.low > rows.bottom) ctx.fillRect(wl, rows.bottom, wickW, rows.low - rows.bottom);
      if (markClipped) drawClipMarkers(s, clip, rows, wl, wickW, (bodyW - wickW) / 2);

      const body: DeviceRect = { x: wl - (bodyW - wickW) / 2, y: rows.top, w: bodyW, h: rows.bottom - rows.top };
      const border = up ? t.borderUp : t.borderDown;
      if (hollow && up) {
        ctx.fillStyle = border;
        fillRectBorder(s, body, bw, bh);
        continue;
      }
      const fill = up ? t.candleUp : t.candleDown;
      if (withBorder && border !== fill) {
        // Frame and fill tile the body without overlapping. A body too short
        // for an interior is all border (fillRectBorder fills it whole).
        ctx.fillStyle = border;
        fillRectBorder(s, body, bw, bh);
        if (body.w > 2 * bw && body.h > 2 * bh) {
          ctx.fillStyle = fill;
          ctx.fillRect(body.x + bw, body.y + bh, body.w - 2 * bw, body.h - 2 * bh);
        }
      } else {
        ctx.fillStyle = fill;
        ctx.fillRect(body.x, body.y, body.w, body.h);
      }
    }
  });
}

const THIN_BARS_OVERRIDE = "mainSeriesProperties.barStyle.thinBars";
const warnedThinBars = new WeakSet<object>();

/**
 * TradingView's `mainSeriesProperties.barStyle.thinBars` (default true): OHLC
 * bars are one hairline wide. `false` thickens stems and ticks with the zoom.
 */
function thinBarsOption(v: FinanceView): boolean {
  const overrides = v.context.options?.overrides;
  const value = overrides?.[THIN_BARS_OVERRIDE];
  if (value === undefined || typeof value === "boolean") return value ?? true;
  if (overrides && !warnedThinBars.has(overrides)) {
    warnedThinBars.add(overrides);
    console.warn(
      `[raze-charts] overrides["${THIN_BARS_OVERRIDE}"] must be a boolean; got ${JSON.stringify(value)}. Using true (thin bars).`,
    );
  }
  return true;
}

export function drawOhlcBars(ctx: CanvasRenderingContext2D, v: FinanceView, bars: Bar[]): void {
  if (!bars.length) return;
  const t = v.context.theme;
  const spacing = barSpacing(v);
  const { start, end } = visibleBarRange(v, bars);
  const thinBars = thinBarsOption(v);
  const markClipped = v.context.autoScalePrice !== false;

  withBitmapSpace(ctx, v.dpr, (s) => {
    const clip = clipToPlot(s, v);
    const hair = s.lineW(1);
    const slot = Math.max(1, Math.floor(spacing * s.hpr));
    // Thick bars grow with the zoom (about a sixth of the spacing, at most
    // three CSS pixels) and never drop below one hairline.
    const stemW = thinBars ? hair : Math.max(hair, Math.min(s.lineW(3), Math.floor(slot / 6)));
    const tickH = thinBars ? s.lineH(1) : Math.max(s.lineH(1), Math.round((stemW / s.hpr) * s.vpr));
    // Ticks reach about 35 % of the spacing (2..8 CSS px) but always leave a
    // hairline between neighbouring bars.
    const wanted = Math.round(Math.max(2, Math.min(8, spacing * 0.35)) * s.hpr);
    const tickW = Math.max(0, Math.min(wanted, Math.floor((slot - stemW - hair) / 2)));

    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b || !paintable(v, b)) continue;
      const up = b.close >= b.open;
      const x = xForIndex(v, i);
      const left = lineStart(s.x(x), stemW);
      const openRow = lineStart(s.y(yForPrice(v, b.open)), tickH);
      const closeRow = lineStart(s.y(yForPrice(v, b.close)), tickH);
      const high = Math.min(s.y(yForPrice(v, b.high)), openRow, closeRow);
      const low = Math.max(s.y(yForPrice(v, b.low)), openRow + tickH, closeRow + tickH);

      ctx.fillStyle = up ? t.candleUp : t.candleDown;
      ctx.beginPath();
      ctx.rect(left, high, stemW, low - high);
      if (tickW > 0) {
        ctx.rect(left - tickW, openRow, tickW, tickH);
        ctx.rect(left + stemW, closeRow, tickW, tickH);
      }
      ctx.fill();
      if (markClipped) {
        const bodyTop = Math.min(openRow, closeRow);
        const bodyBottom = Math.max(openRow, closeRow) + tickH;
        drawClipMarkers(s, clip, { high, low, top: bodyTop, bottom: bodyBottom }, left, stemW, tickW);
      }
    }
  });
}

export function drawColumns(ctx: CanvasRenderingContext2D, v: FinanceView, bars: Bar[]): void {
  if (!bars.length) return;
  const t = v.context.theme;
  const { start, end } = visibleBarRange(v, bars);
  withBitmapSpace(ctx, v.dpr, (s) => {
    const clip = clipToPlot(s, v);
    const cols = candleColumns(barSpacing(v), s.hpr);
    // Columns grow from the bottom of the price pane, whatever the scale mode.
    const base = clip.y + clip.h;
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b || !Number.isFinite(b.close) || !Number.isFinite(b.open)) continue;
      if (v.logScale && !(b.close > 0)) continue;
      const up = b.close >= b.open;
      const top = Math.min(base - s.lineH(1), s.y(yForPrice(v, b.close)));
      ctx.fillStyle = up ? t.candleUp : t.candleDown;
      ctx.fillRect(bodyLeft(s, cols, xForIndex(v, i)), top, cols.bodyW, base - top);
    }
  });
}

/** A close the current scale can place: finite, and positive on a log scale. */
export function plottableClose(v: FinanceView, close: number | undefined): close is number {
  return close !== undefined && Number.isFinite(close) && (!v.logScale || close > 0);
}

export function drawBaseline(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const bars = v.seriesBars;
  if (!bars.length) return;
  const t = v.context.theme;
  const { start, end } = visibleBarRange(v, bars);
  const { from } = v.visibleRange;
  const first = bars[Math.max(0, Math.floor(from))];
  const base = plottableClose(v, first?.close) ? first.close : 0;
  const yBase = yForPrice(v, base);
  const stroke = (): void => {
    ctx.beginPath();
    let started = false;
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b || !plottableClose(v, b.close)) { started = false; continue; }
      const x = xForIndex(v, i);
      const y = yForPrice(v, b.close);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, v.plotT, v.plotW, v.plotH);
  ctx.clip();
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, v.plotT, v.plotW, Math.max(0, yBase - v.plotT));
  ctx.clip();
  stroke();
  ctx.lineTo(xForIndex(v, end), yBase);
  ctx.lineTo(xForIndex(v, start), yBase);
  ctx.closePath();
  ctx.fillStyle = t.candleUp;
  ctx.globalAlpha = 0.16;
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, yBase, v.plotW, Math.max(0, v.plotT + v.plotH - yBase));
  ctx.clip();
  stroke();
  ctx.lineTo(xForIndex(v, end), yBase);
  ctx.lineTo(xForIndex(v, start), yBase);
  ctx.closePath();
  ctx.fillStyle = t.candleDown;
  ctx.globalAlpha = 0.16;
  ctx.fill();
  ctx.restore();
  ctx.restore();
  drawLineArea(ctx, v, false);
}

export function drawPriceSeries(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const style = v.context.chartStyle;
  const bars = v.seriesBars;
  if (style === "line") drawLineArea(ctx, v, false);
  else if (style === "area") drawLineArea(ctx, v, true);
  else if (style === "baseline") drawBaseline(ctx, v);
  else if (style === "columns") drawColumns(ctx, v, bars);
  else if (style === "bars") drawOhlcBars(ctx, v, bars);
  else drawCandles(ctx, v, bars, style === "hollow_candles");
}
