import { PRICE_AXIS_W_MAX, PRICE_AXIS_W_MIN, TIME_AXIS_H } from "../layout";
import { barSpacing, formatAxisPrice, fromDisplay, indexForX, xForIndex, yForPrice } from "../plotScale";
import { parseResolution } from "../../util/resolution";
import { resolveLocale } from "../../util/intl";
import { UTC_ZONE_ID, type TickFormatInput, type TickUnit } from "../../util/time";
import { FinancialTimeAxis, resolveDisplayTimeZone, type TimeAxisResolutionKind, type TimeAxisTick } from "../timeAxis";
import type { ChartContext } from "../../core/context";
import { timeAxisTopOf } from "./primitives";
import type { FinanceView } from "./view";

// ── Price axis ──────────────────────────────────────────────────────────────

/**
 * A price-axis tick: a bare price, or a tick object from the price-scale
 * math that carries its preformatted `label` (fixed precision per axis).
 * Painters prefer `label` and format `value` / `price` only without one.
 */
export type PriceAxisTick = number | { readonly value?: number; readonly price?: number; readonly label?: string };

/** The price a tick sits at. */
export function priceTickValue(tick: PriceAxisTick): number {
  if (typeof tick === "number") return tick;
  return typeof tick.value === "number" ? tick.value : typeof tick.price === "number" ? tick.price : NaN;
}

function priceTickLabel(v: FinanceView, tick: PriceAxisTick, pricescale: number): string {
  if (typeof tick === "object" && typeof tick.label === "string") return tick.label;
  return formatAxisPrice(v, priceTickValue(tick), pricescale);
}

export function adjustPriceAxisWidth(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  ticks: readonly PriceAxisTick[],
): number {
  const pricescale = v.context.symbolInfo?.pricescale ?? 100;
  ctx.font = `11px ${v.fontFamily}`;
  let widest = 0;
  const consider = (text: string): void => {
    const w = ctx.measureText(text).width;
    if (w > widest) widest = w;
  };
  for (const tick of ticks) consider(priceTickLabel(v, tick, pricescale));
  consider(formatAxisPrice(v, fromDisplay(v, v.priceMax), pricescale));
  consider(formatAxisPrice(v, fromDisplay(v, v.priceMin), pricescale));
  const last = v.context.bars[v.context.bars.length - 1];
  if (last) consider(formatAxisPrice(v, last.close, pricescale));
  return Math.round(Math.max(PRICE_AXIS_W_MIN, Math.min(PRICE_AXIS_W_MAX, widest + 16)));
}

export function drawPriceAxis(ctx: CanvasRenderingContext2D, v: FinanceView, ticks: readonly PriceAxisTick[]): void {
  const t = v.context.theme;
  const pricescale = v.context.symbolInfo?.pricescale ?? 100;
  ctx.fillStyle = t.scaleBackground;
  ctx.fillRect(v.plotL + v.plotW, 0, v.priceAxisW, v.cssHeight);
  ctx.fillStyle = t.scaleText;
  ctx.font = `11px ${v.fontFamily}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const rightEdge = v.plotL + v.plotW + v.priceAxisW - 7;
  for (const tick of ticks) {
    const y = yForPrice(v, priceTickValue(tick));
    if (!(y >= v.plotT + 6 && y <= v.plotT + v.plotH - 2)) continue;
    ctx.fillText(priceTickLabel(v, tick, pricescale), rightEdge, y);
  }
}

// ── Time axis: display zone ─────────────────────────────────────────────────

/** Minimum distance between time-axis labels in CSS pixels (lightweight-charts uses 80 at 12 px). */
export const TIME_LABEL_MIN_SPACING = 80;
/** Label centres stay this far inside the plot so their text is never clipped. */
const TIME_LABEL_EDGE = 16;

interface TimeAxisBinding {
  axis: FinancialTimeAxis;
  /** What the zone and locale were resolved from: setting, symbol zone, locale, options. */
  inputs: readonly unknown[];
  /** The resolved display zone id (Etc/UTC for an unknown zone). */
  zone: string;
  /** Warnings already printed for this chart (paint runs every frame). */
  warned: Set<string>;
  ticks: { key: string; source: unknown; formatter: unknown; ticks: TimeAxisTick[] } | null;
}

const bindings = new WeakMap<object, TimeAxisBinding>();

function warnOnce(binding: TimeAxisBinding, key: string, message: string): void {
  if (binding.warned.has(key)) return;
  binding.warned.add(key);
  console.warn(`[raze-charts] ${message}`);
}

function bindingOf(context: ChartContext): TimeAxisBinding {
  let binding = bindings.get(context);
  if (!binding) {
    binding = { axis: new FinancialTimeAxis({ minSpacing: TIME_LABEL_MIN_SPACING }), inputs: [], zone: UTC_ZONE_ID, warned: new Set(), ticks: null };
    bindings.set(context, binding);
  }
  return binding;
}

function resolveDisplayZone(context: ChartContext, binding: TimeAxisBinding, setting: string | null): string {
  const zone = resolveDisplayTimeZone(setting, context.symbolInfo?.timezone, context.options);
  if (!zone.valid) {
    const source = zone.custom
      ? `custom_timezones "${zone.custom.id}" alias`
      : !setting || setting === "exchange" ? `symbolInfo.timezone of ${context.symbol},` : "timezone";
    warnOnce(
      binding,
      `zone:${zone.requested}`,
      `${source} "${zone.requested}" is not a known IANA time zone; showing ${UTC_ZONE_ID}. Use a name such as "America/New_York", or "exchange".`,
    );
  }
  return zone.id;
}

/** Intl-safe form of the widget locale (TradingView spells some with "_": "zh_TW"). */
function axisLocale(locale: string): string {
  try {
    return resolveLocale(String(locale || "en").replace(/_/g, "-"));
  } catch {
    return "en";
  }
}

/**
 * The financial time axis of a chart, synchronised with its display zone
 * (`setTimezone()` / `options.timezone`, `"exchange"` following
 * `symbolInfo.timezone`, `custom_timezones` aliases) and locale. An unknown
 * zone warns once and falls back to UTC instead of throwing mid-paint. The
 * zone and locale are only resolved again when one of their inputs changes.
 */
export function timeAxisOf(context: ChartContext): FinancialTimeAxis {
  const binding = bindingOf(context);
  // The live setTimezone() seam when present, else options.timezone.
  const setting = (context as Partial<Pick<ChartContext, "timezone">>).timezone ?? context.options.timezone ?? null;
  const inputs = [setting, context.symbolInfo?.timezone, context.locale, context.options];
  if (inputs.some((value, i) => value !== binding.inputs[i])) {
    const zone = resolveDisplayZone(context, binding, setting);
    binding.axis.setOptions({ timeZone: zone, locale: axisLocale(context.locale) });
    binding.inputs = inputs;
    binding.zone = zone;
    binding.ticks = null;
  }
  return binding.axis;
}

/**
 * A chart's display zone as resolved (the symbol's zone for `"exchange"`, a
 * `custom_timezones` alias, `Etc/UTC` for an unknown zone), in the spelling
 * it was configured with. The time axis, crosshair, session breaks and the
 * corner caption all show this zone.
 */
export function displayTimeZoneId(context: ChartContext): string {
  timeAxisOf(context);
  return bindingOf(context).zone;
}

/** Resolution kind of the chart's bars (decides which calendar the bar times belong to). */
export function resolutionKindOf(context: ChartContext): TimeAxisResolutionKind {
  return parseResolution(context.resolution).kind;
}

// ── Time axis: custom formatters ────────────────────────────────────────────

/** TradingView `TickMarkType` for a tick unit. */
const TICK_MARK_TYPE: Record<TickUnit, string> = {
  year: "Year",
  month: "Month",
  week: "DayOfMonth",
  day: "DayOfMonth",
  hour: "Time",
  minute: "Time",
  second: "TimeWithSeconds",
  millisecond: "TimeWithSeconds",
};

interface DateFormatterLike {
  format(date: Date): string;
}

function formatters(context: ChartContext): Record<string, unknown> {
  const value = context.options.custom_formatters as unknown;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Call a user formatter; null uses the default label, a throw or another non-string warns once and does too. */
function callFormatter(context: ChartContext, name: string, call: () => unknown, fallback: string): string {
  let value: unknown;
  try {
    value = call();
  } catch (error) {
    warnOnce(bindingOf(context), `throw:${name}`, `custom_formatters.${name} threw (${String(error)}); using the default label.`);
    return fallback;
  }
  if (typeof value === "string") return value;
  // null / undefined ask for the default label (lightweight-charts semantics).
  if (value == null) return fallback;
  warnOnce(bindingOf(context), `type:${name}`, `custom_formatters.${name} must return a string, not ${typeof value}; using the default label.`);
  return fallback;
}

/**
 * `custom_formatters.tickMarkFormatter(date, tickMarkType)` as a tick
 * `format` hook. Like TradingView, `date` carries the local time in its UTC
 * fields (read it with `getUTCHours()` and friends).
 */
function tickMarkFormat(context: ChartContext, formatter: unknown): ((tick: TickFormatInput, fallback: string) => string) | undefined {
  if (typeof formatter !== "function") return undefined;
  return (tick, fallback) => callFormatter(
    context,
    "tickMarkFormatter",
    () => formatter(new Date(tick.wall), TICK_MARK_TYPE[tick.unit]),
    fallback,
  );
}

/**
 * Crosshair time label for a bar time: "14 Jan '24 17:00" in the display
 * zone (the UTC date for daily and coarser bars), or the
 * `custom_formatters.dateFormatter` / `timeFormatter` output when given.
 */
export function formatCrosshairTimeLabel(context: ChartContext, timeMs: number): string {
  const axis = timeAxisOf(context);
  const kind = resolutionKindOf(context);
  const parts = axis.crosshairParts(timeMs, kind);
  if (!parts.date) return "";
  const custom = formatters(context);
  let { date, time } = parts;
  const dateFormatter = custom.dateFormatter as DateFormatterLike | undefined;
  const timeFormatter = custom.timeFormatter as DateFormatterLike | undefined;
  if (typeof dateFormatter?.format === "function") {
    date = callFormatter(context, "dateFormatter", () => dateFormatter.format(new Date(parts.wall)), date);
  }
  if (time && typeof timeFormatter?.format === "function") {
    time = callFormatter(context, "timeFormatter", () => timeFormatter.format(new Date(parts.wall)), time);
  }
  return time ? `${date} ${time}` : date;
}

// ── Time axis: ticks ────────────────────────────────────────────────────────

/** A time-axis tick: a bar index and time (read by the grid) plus its label and weight. */
export interface TimeAxisPaintTick {
  index: number;
  time: number;
  label?: string;
  unit?: TickUnit;
  weight?: number;
  /** Heavier than the lightest unit on screen: a date among times, a month among days. */
  major?: boolean;
}

/**
 * Calendar-aware time ticks for the visible bars, in the chart's display
 * zone. Density follows pixels per bar (never the wall-clock span, so
 * overnight and weekend gaps do not thin the labels), labels are measured so
 * they never overlap, and every label centre stays far enough inside the
 * plot for its text to fit. Results are cached until the bars, the view or
 * the zone change, so pointer-only repaints reuse them.
 */
export function computeTimeAxisTicks(ctx: CanvasRenderingContext2D, v: FinanceView): TimeAxisTick[] {
  const context = v.context;
  const bars = context.bars;
  if (!bars.length || !(v.plotW > 2 * TIME_LABEL_EDGE)) return [];
  const axis = timeAxisOf(context);
  const binding = bindingOf(context);
  const kind = resolutionKindOf(context);
  const spacing = barSpacing(v);
  if (!(spacing > 0) || !Number.isFinite(spacing)) return [];
  const from = indexForX(v, v.plotL + TIME_LABEL_EDGE);
  const to = indexForX(v, v.plotL + v.plotW - TIME_LABEL_EDGE);
  const formatter = formatters(context).tickMarkFormatter;
  // Labels are measured in the heavier weight dates and months are drawn in.
  // The probe width is part of the key, so a web font that finishes loading
  // re-measures them. A zone or locale change clears the cache on its own.
  ctx.font = `600 11px ${v.fontFamily}`;
  const key = [
    bars.length, bars[0]!.time, bars[bars.length - 1]!.time, from, to, spacing, kind, ctx.font, ctx.measureText("0").width,
  ].join("|");
  const cached = binding.ticks;
  if (cached && cached.key === key && cached.source === bars && cached.formatter === formatter) return cached.ticks;

  const format = tickMarkFormat(context, formatter);
  const widths = new Map<string, number>();
  const measure = (label: string): number => {
    let width = widths.get(label);
    if (width === undefined) widths.set(label, (width = ctx.measureText(label).width));
    return width;
  };
  let ticks: TimeAxisTick[];
  try {
    ticks = axis.ticks(bars, { kind, from, to, barSpacing: spacing, measure, format });
  } catch (error) {
    warnOnce(binding, "ticks", `time-axis ticks failed (${String(error)}); the axis is left blank for this frame.`);
    ticks = [];
  }
  binding.ticks = { key, source: bars, formatter, ticks };
  return ticks;
}

const CALENDAR_UNITS: ReadonlySet<TickUnit> = new Set(["day", "week", "month", "year"]);

export function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  ticks: readonly TimeAxisPaintTick[],
): void {
  const t = v.context.theme;
  const top = timeAxisTopOf(v);
  ctx.fillStyle = t.scaleBackground;
  ctx.fillRect(0, top, v.cssWidth, TIME_AXIS_H);
  ctx.fillStyle = t.scaleText;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const y = top + TIME_AXIS_H / 2;
  const regular = `11px ${v.fontFamily}`;
  const bold = `600 11px ${v.fontFamily}`;
  // Labels stay inside the plot's span, so none reaches the corner cell
  // (axisChromeRect) reserved for the timezone and countdown.
  const left = v.plotL + 2;
  const right = Math.min(v.plotL + v.plotW, v.axisChromeRect?.x ?? Infinity) - 2;
  for (const tk of ticks) {
    const x = xForIndex(v, tk.index);
    const label = tk.label;
    if (!label) continue;
    // Dates among times, months among days and years stand out; an hour among minutes does not.
    ctx.font = tk.major && tk.unit !== undefined && CALENDAR_UNITS.has(tk.unit) ? bold : regular;
    const half = ctx.measureText(label).width / 2;
    if (x - half < left || x + half > right) continue;
    ctx.fillText(label, x, y);
  }
}
