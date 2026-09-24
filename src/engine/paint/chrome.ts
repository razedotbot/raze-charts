// Axis chrome for the finance widget: the timezone caption in the reserved
// price-axis x time-axis corner cell, the bar-close countdown under the
// last-price tag, timescale-mark badges above the time axis, compare series
// normalised to their own base, and the optional time navigator.

import type { Bar, TimescaleMark } from "../../types/charting_library";
import type { ChartContext } from "../../core/context";
import { isLightColor } from "../../core/theme";
import { parseResolution, resolutionToMs } from "../../util/resolution";
import { getTimeZone } from "../../util/time/zone";
import { TimeIndex } from "../../data/TimeIndex";
import { type PlotScale, toDisplay, xForIndex, yForPrice } from "../plotScale";
import { displayTimeZoneId } from "./axes";
import { roundRect, timeAxisTopOf } from "./primitives";
import type { FinanceView, Rect, TimescaleMarkHit } from "./view";

// ── Timezone caption (corner cell) ───────────────────────────────────────────

/** Font size of the corner caption; shrinks down to the minimum before giving up. */
const CAPTION_FONT_PX = 10;
const CAPTION_MIN_FONT_PX = 8;
/** Horizontal inset inside the corner cell; matches the price labels' right edge. */
const CAPTION_INSET = 7;

/**
 * Compact UTC-offset label for a zone at an instant: "UTC", "UTC-4",
 * "UTC+5:30". Evaluated at `atMs`, so it follows daylight-saving changes.
 * An unknown zone id is returned unchanged.
 */
export function utcOffsetLabel(zoneId: string, atMs: number): string {
  let offsetMs: number;
  try {
    offsetMs = getTimeZone(zoneId).offset(atMs);
  } catch {
    return zoneId;
  }
  if (!Number.isFinite(offsetMs)) return zoneId;
  const totalMinutes = Math.round(offsetMs / 60_000);
  if (totalMinutes === 0) return "UTC";
  const sign = totalMinutes < 0 ? "-" : "+";
  const abs = Math.abs(totalMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

/**
 * Pick the caption for the corner cell: the IANA name when it fits in
 * `maxWidth`, otherwise the compact UTC offset ("UTC-4"). Returns the offset
 * label even when it is too wide; the painter then shrinks the font.
 */
export function timezoneCaption(
  zoneId: string,
  atMs: number,
  maxWidth: number,
  measure: (text: string) => number,
): string {
  if (measure(zoneId) <= maxWidth) return zoneId;
  return utcOffsetLabel(zoneId, atMs);
}

/**
 * The display zone the corner caption names: the zone the time axis resolved
 * (`setTimezone()` / `options.timezone`, `"exchange"` following the symbol,
 * `custom_timezones` aliases, `Etc/UTC` for an unknown zone).
 */
export function displayTimezone(context: ChartContext): string {
  return displayTimeZoneId(context);
}

function nowOf(context: ChartContext): number {
  return typeof context.now === "function" ? context.now() : Date.now();
}

/**
 * Paint the timezone caption inside `v.axisChromeRect`, the reserved corner
 * cell under the price axis, so it can never overprint a time-axis tick. Long
 * zone names abbreviate to their UTC offset; nothing leaves the cell.
 */
export function drawTimezoneCaption(ctx: CanvasRenderingContext2D, v: FinanceView): Rect | null {
  if (!v.context.features.has("timezone_display")) return null;
  const cell = v.axisChromeRect;
  const maxWidth = cell.w - CAPTION_INSET * 2;
  if (maxWidth <= 0 || cell.h <= 0) return null;
  ctx.save();
  let size = CAPTION_FONT_PX;
  ctx.font = `${size}px ${v.fontFamily}`;
  const label = timezoneCaption(displayTimezone(v.context), nowOf(v.context), maxWidth, (s) => ctx.measureText(s).width);
  let width = ctx.measureText(label).width;
  while (width > maxWidth && size > CAPTION_MIN_FONT_PX) {
    size -= 1;
    ctx.font = `${size}px ${v.fontFamily}`;
    width = ctx.measureText(label).width;
  }
  if (width > maxWidth) {
    ctx.restore();
    return null;
  }
  const right = cell.x + cell.w - CAPTION_INSET;
  const midY = cell.y + cell.h / 2;
  ctx.fillStyle = v.context.theme.scaleText;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(label, right, midY);
  ctx.restore();
  return { x: right - width, y: midY - size / 2, w: width, h: size };
}

// ── Bar-close countdown ──────────────────────────────────────────────────────

/**
 * Close time of the bar that opens at `openMs`. Months step by calendar
 * months (UTC fields, the datafeed convention for D/W/M bars) instead of the
 * 30-day approximation; every other resolution adds its fixed length.
 */
export function barCloseTime(openMs: number, resolution: string): number {
  const parsed = parseResolution(resolution);
  if (parsed.kind !== "months") return openMs + parsed.ms;
  const d = new Date(openMs);
  const targetMonth = d.getUTCMonth() + parsed.amount;
  // Clamp the day so 31 Jan + 1M closes on the last day of February.
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  return Date.UTC(
    d.getUTCFullYear(),
    targetMonth,
    Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/**
 * Milliseconds until the forming bar closes, or null when the countdown must
 * be hidden. When the last bar has already closed but the next period is
 * still running (a quiet market with no tick yet), this counts down that
 * period. When the last bar is more than one period old (stale feed, market
 * closed, historical data) it returns null instead of a frozen "0:00".
 */
export function barCountdownMs(lastOpenMs: number, resolution: string, nowMs: number): number | null {
  if (!Number.isFinite(lastOpenMs) || !Number.isFinite(nowMs)) return null;
  const close = barCloseTime(lastOpenMs, resolution);
  const period = close - lastOpenMs;
  if (!(period > 0)) return null;
  let remain = close - nowMs;
  if (remain <= 0) {
    const next = barCloseTime(close, resolution);
    if (nowMs >= next) return null;
    remain = next - nowMs;
  }
  // A client clock behind the server can overshoot; never show more than one bar.
  return Math.min(remain, period);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Format a countdown: "m:ss" under an hour, "h:mm:ss" under a day and
 * "Nd hh:mm" from one day up (so 1D reads "22:55:25", 1W "4d 03:12").
 */
export function formatBarCountdown(remainMs: number): string {
  const total = Math.max(0, Math.floor(remainMs / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${pad2(hours)}:${pad2(minutes)}`;
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${minutes}:${pad2(seconds)}`;
}

const warnedShowCountdown = new WeakSet<object>();

/**
 * Whether the countdown should show: the `countdown` featureset (on by
 * default) gated by the TradingView `mainSeriesProperties.showCountdown`
 * override. Enabling the override while the feature is disabled warns once.
 */
export function countdownEnabled(context: Pick<ChartContext, "features" | "options">): boolean {
  const override = (context.options?.overrides as Record<string, unknown> | undefined)?.["mainSeriesProperties.showCountdown"];
  const feature = context.features.has("countdown");
  if (override === true && !feature && !warnedShowCountdown.has(context)) {
    warnedShowCountdown.add(context);
    console.warn(
      "[raze-charts] overrides[\"mainSeriesProperties.showCountdown\"] is true but the \"countdown\" feature is disabled; "
        + "remove \"countdown\" from disabled_features to show the bar countdown.",
    );
  }
  return feature && override !== false;
}

/** Text colour of the last-price tag (kept in step with paint/lastPrice.ts). */
const LAST_PRICE_TAG_TEXT = "#10100e";
/** Geometry of the last-price tag drawn by drawAxisTag (paint/primitives.ts). */
const TAG_H = 16;
const COUNTDOWN_LINE_H = 13;

/**
 * Countdown line box under (or, near the bottom edge, above) the last-price
 * tag, or null when the countdown is hidden.
 */
export function countdownBox(v: FinanceView): { rect: Rect; text: string; color: string; below: boolean } | null {
  if (!countdownEnabled(v.context)) return null;
  const bars = v.context.bars;
  const last = bars[bars.length - 1];
  if (!last || !Number.isFinite(last.close)) return null;
  const remain = barCountdownMs(last.time, v.context.resolution, nowOf(v.context));
  if (remain === null) return null;
  const t = v.context.theme;
  const color = last.close >= last.open ? t.candleUp : t.candleDown;
  // Mirror drawLastPrice + drawAxisTag so the countdown joins the tag.
  const y = yForPrice(v, last.close);
  const cy = Math.max(v.plotT + 8, Math.min(v.plotT + v.plotH - 8, y));
  const tagTop = Math.max(v.plotT, Math.min(v.plotT + v.plotH - TAG_H, cy - TAG_H / 2));
  const below = tagTop + TAG_H + COUNTDOWN_LINE_H <= v.plotT + v.plotH;
  const lineTop = below ? tagTop + TAG_H : tagTop - COUNTDOWN_LINE_H;
  return {
    rect: { x: v.plotL + v.plotW + 3, y: lineTop, w: v.priceAxisW - 5, h: COUNTDOWN_LINE_H },
    text: formatBarCountdown(remain),
    color,
    below,
  };
}

/**
 * Paint the bar countdown as a second line of the last-price tag, like
 * TradingView. The countdown paints on the overlay layer, above the scene's
 * last-price tag, so it must not overlap the tag: it squares the corners on
 * the side it shares with the tag instead of extending under it.
 */
export function drawBarCountdown(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const box = countdownBox(v);
  if (!box) return;
  const { rect } = box;
  ctx.save();
  ctx.fillStyle = box.color;
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 3);
  ctx.fill();
  ctx.fillRect(rect.x, box.below ? rect.y : rect.y + rect.h - 3, rect.w, 3);
  let size = 10;
  ctx.font = `${size}px ${v.fontFamily}`;
  const maxWidth = rect.w - 6;
  while (ctx.measureText(box.text).width > maxWidth && size > CAPTION_MIN_FONT_PX) {
    size -= 1;
    ctx.font = `${size}px ${v.fontFamily}`;
  }
  ctx.fillStyle = LAST_PRICE_TAG_TEXT;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(box.text, rect.x + rect.w - 2, rect.y + rect.h / 2);
  ctx.restore();
}

/**
 * Axis chrome pass: the timezone caption in the corner cell and the
 * countdown under the last-price tag. The countdown is exported separately
 * so the overlay layer can repaint it on its own timer.
 */
export function drawAxisChrome(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  drawTimezoneCaption(ctx, v);
  drawBarCountdown(ctx, v);
}

// ── Timescale marks ──────────────────────────────────────────────────────────

/** TradingView's named mark colours. */
const MARK_CONST_COLORS: Readonly<Record<string, string>> = Object.freeze({
  red: "#f23645",
  green: "#089981",
  blue: "#2962ff",
  yellow: "#f9a825",
});
const DEFAULT_MARK_COLOR = MARK_CONST_COLORS.blue!;
const BADGE_R = 8;
const BADGE_GAP = 2;
const BADGE_MAX_STACK = 3;
const MARK_SHAPES = new Set(["circle", "earning", "earningUp", "earningDown"]);

const warnedMarkShapes = new Set<string>();
let warnedImageUrl = false;

function markColor(mark: TimescaleMark): string {
  const c = mark.color;
  if (typeof c === "string" && c) return MARK_CONST_COLORS[c] ?? c;
  return DEFAULT_MARK_COLOR;
}

function markShape(mark: TimescaleMark): string {
  if (typeof mark.imageUrl === "string" && mark.imageUrl && !warnedImageUrl) {
    warnedImageUrl = true;
    console.warn("[raze-charts] timescale mark imageUrl is not supported; drawing the label badge instead.");
  }
  const shape = typeof mark.shape === "string" ? mark.shape : "circle";
  if (MARK_SHAPES.has(shape)) return shape;
  if (!warnedMarkShapes.has(shape)) {
    warnedMarkShapes.add(shape);
    console.warn(
      `[raze-charts] timescale mark shape "${shape}" is not supported; drawing a circle. `
        + `Supported shapes: ${[...MARK_SHAPES].join(", ")}.`,
    );
  }
  return "circle";
}

/** Badge glyph: the whole label when it is at most two characters, else its first character. */
export function timescaleMarkGlyph(label: unknown): string {
  const chars = Array.from(String(label ?? "").trim());
  return chars.length <= 2 ? chars.join("") : chars[0]!;
}

/**
 * The vertical centre of the badge row: just above the time axis (and above
 * the time navigator when it is shown), below every pane.
 */
export function timescaleMarkRowY(v: FinanceView): number {
  const navTop = timeNavigatorTop(v);
  return (navTop ?? timeAxisTopOf(v)) - BADGE_R - 3;
}

/** Topmost timescale-mark badge under a point, for hover, focus and tooltip hit-testing. */
export function timescaleMarkAt(hits: readonly TimescaleMarkHit[], x: number, y: number, slop = 2): TimescaleMarkHit | null {
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i]!;
    const dx = x - hit.x;
    const dy = y - hit.y;
    if (dx * dx + dy * dy <= (hit.r + slop) * (hit.r + slop)) return hit;
  }
  return null;
}

function badgePath(ctx: CanvasRenderingContext2D, shape: string, x: number, y: number, r: number): void {
  if (shape === "circle") {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    return;
  }
  roundRect(ctx, x - r, y - r, r * 2, r * 2, 3);
}

function drawBadge(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  mark: TimescaleMark | null,
  glyph: string,
  color: string,
  x: number,
  y: number,
  hovered: boolean,
): void {
  const shape = mark ? markShape(mark) : "circle";
  badgePath(ctx, shape, x, y, BADGE_R);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = v.context.theme.paneBackground;
  ctx.stroke();
  if (shape === "earningUp" || shape === "earningDown") {
    const up = shape === "earningUp";
    const tip = up ? y - BADGE_R - 4 : y + BADGE_R + 4;
    const base = up ? y - BADGE_R : y + BADGE_R;
    ctx.beginPath();
    ctx.moveTo(x - 3, base);
    ctx.lineTo(x, tip);
    ctx.lineTo(x + 3, base);
    ctx.closePath();
    ctx.fill();
  }
  if (hovered) {
    badgePath(ctx, shape, x, y, BADGE_R + 2.5);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  if (!glyph) return;
  const custom = mark && typeof mark.labelFontColor === "string" ? mark.labelFontColor : null;
  ctx.fillStyle = custom ?? (isLightColor(color) ? "#131722" : "#ffffff");
  ctx.font = `600 ${glyph.length > 1 ? 8 : 9}px ${v.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, x, y + 0.5);
}

/**
 * Paint timescale marks as coloured badges in the row directly above the time
 * axis, so they never overprint tick labels. Marks closer than one badge are
 * stacked (at most three, the last showing "+N"). Every painted badge is
 * recorded in `v.timescaleMarkScreen` for hover, focus and tooltips; the
 * hovered mark gets a ring and a guide line up through the panes.
 */
export function drawTimescaleMarks(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  v.timescaleMarkScreen.length = 0;
  const marks = v.context.timescaleMarks;
  const bars = v.context.bars;
  if (!marks.length || !bars.length) return;
  const timeIndex = new TimeIndex(bars, resolutionToMs(v.context.resolution));

  const placed: { mark: TimescaleMark; x: number }[] = [];
  for (const mark of marks) {
    const logical = timeIndex.indexAt(Number(mark.time) * 1000);
    if (logical == null) continue;
    const x = xForIndex(v, logical);
    if (x < v.plotL + BADGE_R || x > v.plotL + v.plotW - BADGE_R) continue;
    placed.push({ mark, x });
  }
  if (!placed.length) return;
  placed.sort((a, b) => a.x - b.x);

  // Cluster badges that would overlap horizontally; each cluster stacks up.
  const clusters: { x: number; marks: TimescaleMark[] }[] = [];
  for (const p of placed) {
    const prev = clusters[clusters.length - 1];
    if (prev && p.x - prev.x < BADGE_R * 2 + BADGE_GAP) prev.marks.push(p.mark);
    else clusters.push({ x: p.x, marks: [p.mark] });
  }

  const rowY = timescaleMarkRowY(v);
  const hover = v.hoverTimescaleMark;
  ctx.save();
  if (hover) {
    const hovered = clusters.find((c) => c.marks.includes(hover));
    if (hovered) {
      const x = Math.round(hovered.x) + 0.5;
      ctx.strokeStyle = markColor(hover);
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, v.plotT);
      ctx.lineTo(x, rowY - BADGE_R - 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }
  const step = BADGE_R * 2 + BADGE_GAP;
  for (const cluster of clusters) {
    const shown = Math.min(cluster.marks.length, BADGE_MAX_STACK);
    for (let k = 0; k < shown; k++) {
      const y = rowY - k * step;
      if (y - BADGE_R < v.plotT) break;
      const overflow = k === shown - 1 && cluster.marks.length > BADGE_MAX_STACK;
      if (overflow) {
        const rest = cluster.marks.slice(k);
        const isHover = hover !== null && rest.includes(hover);
        drawBadge(ctx, v, null, `+${rest.length}`, v.context.theme.scaleLine, cluster.x, y, isHover);
        // The overflow badge hit-tests as its first hidden mark.
        v.timescaleMarkScreen.push({ mark: rest[0]!, x: cluster.x, y, r: BADGE_R });
        break;
      }
      const mark = cluster.marks[k]!;
      drawBadge(ctx, v, mark, timescaleMarkGlyph(mark.label), markColor(mark), cluster.x, y, mark === hover);
      v.timescaleMarkScreen.push({ mark, x: cluster.x, y, r: BADGE_R });
    }
  }
  ctx.restore();
}

// ── Compare series ───────────────────────────────────────────────────────────

type CompareItem = ChartContext["compare"][number];
type CompareContext = Pick<ChartContext, "bars" | "compare" | "resolution">;

/** One compare series projected onto the main scale for the current view. */
export interface CompareProjection {
  item: CompareItem;
  /** The compare's own close at the first visible bar (its normalisation base). */
  base: number;
  /** Visible points: logical bar index and the price mapped onto the main scale. */
  points: { logical: number; price: number }[];
  /** Latest compare close and its mapped price, for the axis label. */
  last: { close: number; price: number } | null;
}

function sameResolution(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = parseResolution(a);
  const pb = parseResolution(b);
  return pa.kind === pb.kind && pa.ms === pb.ms;
}

function lowerBoundByTime(bars: readonly Bar[], timeMs: number): number {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const mid = low + ((high - low) >> 1);
    if (bars[mid]!.time < timeMs) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Project every compare series onto the main price scale. Each compare is
 * normalised to its own close at the first visible bar, and mapped to
 * `pctBase * close / base`, where `pctBase` is the main series' close at that
 * bar. In percent mode that is exactly "percent change from the first visible
 * bar"; in price and log mode it overlays the compare on the main series
 * (TradingView's "same % scale"). Either way both series share a y at the
 * first visible bar, whatever their magnitudes. Compares still loaded at
 * another resolution are skipped until they are reloaded.
 */
export function projectCompares(scale: PlotScale, context: CompareContext): CompareProjection[] {
  const bars = context.bars;
  if (!context.compare.length || !bars.length) return [];
  const { from, to } = scale.visibleRange;
  const start = Math.max(0, Math.min(bars.length - 1, Math.floor(from)));
  const end = Math.max(start, Math.min(bars.length - 1, Math.ceil(to)));
  const timeIndex = new TimeIndex(bars, resolutionToMs(context.resolution));
  const windowFrom = timeIndex.timeAt(from - 1) ?? bars[start]!.time;
  const windowTo = timeIndex.timeAt(to + 1) ?? bars[end]!.time;
  const baseTime = bars[start]!.time;
  const mainBase = scale.pctBase > 0 ? scale.pctBase : 1;

  const out: CompareProjection[] = [];
  for (const item of context.compare) {
    if (item.resolution && !sameResolution(item.resolution, context.resolution)) continue;
    const series = item.bars;
    if (!series.length) continue;
    let baseIndex = lowerBoundByTime(series, baseTime);
    while (baseIndex < series.length && !(series[baseIndex]!.close > 0)) baseIndex++;
    const baseBar = series[baseIndex];
    if (!baseBar || baseBar.time > windowTo) continue;
    const base = baseBar.close;
    const map = (close: number): number => mainBase * (close / base);

    const points: CompareProjection["points"] = [];
    for (let i = lowerBoundByTime(series, windowFrom); i < series.length; i++) {
      const bar = series[i]!;
      if (bar.time > windowTo) break;
      if (!(bar.close > 0)) continue;
      const logical = timeIndex.indexAt(bar.time);
      if (logical == null) continue;
      points.push({ logical, price: map(bar.close) });
    }
    let last: CompareProjection["last"] = null;
    for (let i = series.length - 1; i >= 0; i--) {
      const close = series[i]!.close;
      if (close > 0) {
        last = { close, price: map(close) };
        break;
      }
    }
    out.push({ item, base, points, last });
  }
  return out;
}

/**
 * Display-space values of the visible compare points, for autoscale. The
 * renderer merges them into the fitted range so every compare line stays
 * inside the plot.
 */
export function compareAutoScaleLevels(scale: PlotScale, context: CompareContext): number[] {
  const levels: number[] = [];
  const { from, to } = scale.visibleRange;
  let lo = Infinity;
  let hi = -Infinity;
  for (const projection of projectCompares(scale, context)) {
    for (const p of projection.points) {
      if (p.logical < Math.floor(from) || p.logical > Math.ceil(to)) continue;
      const d = toDisplay(scale, p.price);
      if (!Number.isFinite(d)) continue;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
  }
  if (Number.isFinite(lo)) levels.push(lo, hi);
  return levels;
}

/** Compare prices are formatted by magnitude: the compare symbol's pricescale is unknown here. */
function compareDecimals(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 1) return 2;
  if (abs === 0) return 2;
  return Math.min(8, Math.ceil(-Math.log10(abs)) + 3);
}

/** Axis label for a compare's latest value: its percent change in percent mode, else its own price. */
export function compareAxisLabel(scale: PlotScale, projection: CompareProjection): string | null {
  if (!projection.last) return null;
  if (scale.percentScale) {
    const pct = (projection.last.close / projection.base - 1) * 100;
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  }
  const close = projection.last.close;
  return close.toFixed(compareDecimals(close));
}

export function drawCompare(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const projections = projectCompares(v, v.context);
  if (!projections.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, v.plotT, v.plotW, v.plotH);
  ctx.clip();
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  for (const projection of projections) {
    ctx.strokeStyle = projection.item.color;
    ctx.beginPath();
    let drawing = false;
    for (const p of projection.points) {
      const x = xForIndex(v, p.logical);
      const y = yForPrice(v, p.price);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  for (const projection of projections) {
    const text = compareAxisLabel(v, projection);
    if (!text || !projection.last) continue;
    const color = projection.item.color;
    v.axisTags.push({
      axis: "price",
      coord: yForPrice(v, projection.last.price),
      text,
      background: color,
      color: isLightColor(color) ? "#131722" : "#ffffff",
      source: { kind: "compare", id: projection.item.id },
    });
  }
}

// ── Time navigator ───────────────────────────────────────────────────────────

const NAVIGATOR_H = 28;

/** Top of the time navigator strip, or null when it is not painted. */
function timeNavigatorTop(v: FinanceView): number | null {
  if (!v.context.features.has("time_navigator") || v.context.bars.length < 2) return null;
  const top = timeAxisTopOf(v) - NAVIGATOR_H;
  return top < v.plotT + 40 ? null : top;
}

export function drawTimeNavigator(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const top = timeNavigatorTop(v);
  if (top === null) return;
  const bars = v.context.bars;
  const t = v.context.theme;
  const h = NAVIGATOR_H;
  let min = Infinity;
  let max = -Infinity;
  for (const bar of bars) {
    if (bar.close < min) min = bar.close;
    if (bar.close > max) max = bar.close;
  }
  if (!Number.isFinite(min) || min === max) return;
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = t.scaleBackground;
  ctx.fillRect(v.plotL, top, v.plotW, h);
  ctx.beginPath();
  for (let i = 0; i < bars.length; i++) {
    const x = v.plotL + (i / Math.max(1, bars.length - 1)) * v.plotW;
    const y = top + 2 + (1 - (bars[i]!.close - min) / (max - min)) * (h - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = t.lineColor ?? t.candleUp;
  ctx.lineWidth = 1;
  ctx.stroke();
  const n = bars.length;
  const left = v.plotL + (Math.max(0, v.visibleRange.from) / Math.max(1, n - 1)) * v.plotW;
  const right = v.plotL + (Math.min(n - 1, v.visibleRange.to) / Math.max(1, n - 1)) * v.plotW;
  ctx.fillStyle = "rgba(102,216,158,0.16)";
  ctx.fillRect(left, top, Math.max(2, right - left), h);
  ctx.restore();
}
