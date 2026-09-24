/**
 * Financial time-axis adapter over the shared time core (AD-06).
 *
 * The financial widget places bars on a logical index axis (see TimeIndex),
 * so its ticks come from per-bar boundary weights rather than a wall-clock
 * ruler. This adapter owns the per-series weight cache (incremental for
 * appended and live-updated bars), the display zone, and the crosshair
 * label format, so paint code only asks for `ticks()` and `formatCrosshair()`.
 *
 * Every call that reads bar times takes the resolution kind
 * (`parseResolution(resolution).kind`), because the kind decides which
 * calendar the timestamps belong to:
 *
 * - Intraday bars (seconds, minutes, hours) are instants. Ticks, weights and
 *   crosshair labels use the display zone, so a 14:30Z bar reads 09:30 in
 *   New York.
 * - Daily, weekly and monthly bars are calendar dates. The TradingView
 *   datafeed contract (and this repo's `Bar` type) stamps them 00:00 UTC of
 *   the trading day, so they are read in UTC whatever the display zone is. A
 *   1 Feb bar reads "1 Feb" and carries the month boundary in New York and
 *   Tokyo alike. Reading them in a zone west of UTC would label every bar
 *   with the previous day.
 *
 * {@link FinancialTimeAxis.calendarZone} exposes this rule for session
 * boundaries and bar flooring.
 */

import {
  DEFAULT_TICK_SPACING,
  DEFAULT_WEEK_START,
  MAX_DATE_MS,
  barTicks,
  computeTickWeights,
  fieldsFromWall,
  getTimeZone,
  tickLabeler,
  tickLevel,
  type TickLabelOptions,
  type TickSelectionOptions,
  type TickUnit,
  type TimeZone,
  type TimedPoint,
  type WeekStart,
} from "../util/time";
import { DEFAULT_LOCALE, dateTimeFormat, resolveLocale } from "../util/intl";

/** Resolution kinds as produced by `parseResolution().kind`. */
export type TimeAxisResolutionKind = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months";

const RESOLUTION_KINDS: readonly TimeAxisResolutionKind[] = ["seconds", "minutes", "hours", "days", "weeks", "months"];

export interface TimeAxisOptions extends TickLabelOptions {
  /**
   * Resolved IANA display zone (use `resolveTimeZoneId(options.timezone,
   * symbolInfo.timezone)` for the widget's `"exchange"` semantics). Default UTC.
   * An unknown zone throws a RangeError naming it. Daily and coarser bars
   * are always read in UTC (see the module comment).
   */
  timeZone?: string | null;
  /** Local weekday that starts a week. Default Monday (1). */
  weekStart?: WeekStart;
  /** Minimum distance between tick positions in CSS pixels. Default 40. */
  minSpacing?: number;
}

export interface TimeAxisTick {
  /** Bar index the tick sits on. */
  index: number;
  /** The bar's UTC timestamp. */
  time: number;
  weight: number;
  unit: TickUnit;
  label: string;
  /** True when the tick is heavier than the lightest unit on screen (render it emphasised). */
  major: boolean;
}

export interface TimeAxisTickRequest {
  /** Resolution kind of the bars (`parseResolution(resolution).kind`). */
  kind: TimeAxisResolutionKind;
  /** First visible logical index (fractional). */
  from: number;
  /** Last visible logical index (fractional). */
  to: number;
  /** Pixels per bar. */
  barSpacing: number;
  /** Optional label width measurement so labels never overlap. */
  measure?: (label: string) => number;
  /**
   * Optional custom tick label (for example TradingView's
   * `custom_formatters.tickMarkFormatter`). The tick's `wall` time is in the
   * zone the bars are read in. See {@link TickSelectionOptions.format}.
   */
  format?: TickSelectionOptions["format"];
  maxTicks?: number;
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const UNIT_RANK: Record<TickUnit, number> = {
  millisecond: 0, second: 1, minute: 2, hour: 3, day: 4, week: 4, month: 5, year: 6,
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

function assertKind(kind: unknown): asserts kind is TimeAxisResolutionKind {
  if (!RESOLUTION_KINDS.includes(kind as TimeAxisResolutionKind)) {
    throw new RangeError(
      `Unknown resolution kind ${JSON.stringify(kind)}. Pass parseResolution(resolution).kind: ` +
      `${RESOLUTION_KINDS.map((k) => `"${k}"`).join(", ")}.`,
    );
  }
}

/** `true` for seconds, minutes and hours: bars whose timestamps are instants rather than dates. */
export function isIntradayKind(kind: TimeAxisResolutionKind): boolean {
  assertKind(kind);
  return kind === "seconds" || kind === "minutes" || kind === "hours";
}

interface WeightCache {
  /** The bars array the weights belong to. */
  source: ArrayLike<TimedPoint>;
  /** Zone the weights were computed in (the display zone or UTC, by resolution kind). */
  zone: TimeZone;
  weights: Uint8Array;
  length: number;
  firstTime: number;
  lastTime: number;
}

export class FinancialTimeAxis {
  private tz: TimeZone;
  private weekStart: WeekStart;
  private minSpacing: number;
  private locale: string;
  private hourCycle: "h23" | "h12";
  private cache: WeightCache | null = null;

  constructor(options: TimeAxisOptions = {}) {
    const resolved = FinancialTimeAxis.resolve(options, null);
    this.tz = resolved.tz;
    this.weekStart = resolved.weekStart;
    this.minSpacing = resolved.minSpacing;
    this.locale = resolved.locale;
    this.hourCycle = resolved.hourCycle;
  }

  /** Validate a full option set (falling back to `current`) so errors surface at configuration time, not mid-paint. */
  private static resolve(options: TimeAxisOptions, current: FinancialTimeAxis | null): {
    tz: TimeZone;
    weekStart: WeekStart;
    minSpacing: number;
    locale: string;
    hourCycle: "h23" | "h12";
  } {
    const tz = options.timeZone !== undefined || !current ? getTimeZone(options.timeZone) : current.tz;
    const weekStart = options.weekStart ?? current?.weekStart ?? DEFAULT_WEEK_START;
    const minSpacing = options.minSpacing ?? current?.minSpacing ?? DEFAULT_TICK_SPACING;
    const locale = options.locale !== undefined || !current ? resolveLocale(options.locale) : current.locale;
    const hourCycle = options.hourCycle ?? current?.hourCycle ?? "h23";
    if (!Number.isInteger(weekStart) || weekStart < 0 || weekStart > 6) {
      throw new RangeError(`weekStart must be an integer from 0 (Sunday) to 6 (Saturday); received ${weekStart}.`);
    }
    if (!(minSpacing > 0) || !Number.isFinite(minSpacing)) {
      throw new RangeError(`minSpacing must be a positive number of pixels; received ${minSpacing}.`);
    }
    tickLabeler({ locale, hourCycle });
    return { tz, weekStart, minSpacing, locale, hourCycle };
  }

  /** The display zone. */
  get timeZone(): TimeZone {
    return this.tz;
  }

  /**
   * Zone that bars of `kind` are read in: the display zone for intraday
   * bars, UTC for daily, weekly and monthly bars (stamped 00:00 UTC of their
   * trading day). Use it for session boundaries and for flooring bar times.
   */
  calendarZone(kind: TimeAxisResolutionKind): TimeZone {
    return isIntradayKind(kind) ? this.tz : getTimeZone(null);
  }

  /**
   * Change options at runtime (for example `setTimezone`). The update is
   * atomic: invalid options throw and leave the axis unchanged. Weights are
   * only recomputed when the zone the bars are read in, or the week start,
   * actually changes (a new display zone leaves daily weights untouched).
   */
  setOptions(options: TimeAxisOptions): void {
    const next = FinancialTimeAxis.resolve(options, this);
    if (next.weekStart !== this.weekStart) this.cache = null;
    this.tz = next.tz;
    this.weekStart = next.weekStart;
    this.minSpacing = next.minSpacing;
    this.locale = next.locale;
    this.hourCycle = next.hourCycle;
  }

  /**
   * Drop the cached weights so the next call recomputes them. Call it when
   * the bars array is changed in place in a way other than appending bars or
   * replacing the last one (for example a same-length reload after a symbol
   * or resolution change that reuses the array). Passing a new array instance
   * recomputes on its own.
   */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Per-bar boundary weights for `bars` of resolution `kind`, cached across
   * frames. Pass the same array instance every frame (the renderer's
   * `context.bars`; derived series such as Heikin Ashi share its times).
   *
   * - Appending bars to that array, or replacing its last bar, only computes
   *   the new tail (O(appended) per live update).
   * - A new array instance (setData, a history page, a symbol or resolution
   *   change), a prepend, a change of the zone the bars are read in, or a new
   *   week start recomputes everything.
   * - Any other in-place change needs {@link invalidate}: the cache checks
   *   the array's length and its first and last times, not every bar.
   */
  weights(bars: ArrayLike<TimedPoint>, kind: TimeAxisResolutionKind): Uint8Array {
    const zone = this.calendarZone(kind);
    const n = bars.length;
    const cache = this.cache && this.cache.source === bars && this.cache.zone === zone ? this.cache : null;
    let start = 0;
    if (
      cache &&
      n >= cache.length &&
      bars[0]!.time === cache.firstTime &&
      bars[cache.length - 1]!.time === cache.lastTime
    ) {
      start = cache.length;
    }
    if (cache && start === n && n === cache.length) return cache.weights;

    let out = this.cache?.weights;
    if (!out || out.length < n) {
      const grown = new Uint8Array(Math.max(n, Math.ceil(n * 1.5), 64));
      if (out && start > 0) grown.set(out.subarray(0, start));
      out = grown;
    }
    computeTickWeights(bars, zone, { weekStart: this.weekStart, out, start });
    this.cache = n > 0
      ? { source: bars, zone, weights: out, length: n, firstTime: bars[0]!.time, lastTime: bars[n - 1]!.time }
      : null;
    return out;
  }

  /** Ticks for the visible logical range, labelled in the zone the bars are read in. */
  ticks(bars: ArrayLike<TimedPoint>, request: TimeAxisTickRequest): TimeAxisTick[] {
    const zone = this.calendarZone(request.kind);
    if (!bars.length) return [];
    const ticks = barTicks({
      bars,
      weights: this.weights(bars, request.kind),
      from: request.from,
      to: request.to,
      barSpacing: request.barSpacing,
      timeZone: zone,
      minSpacing: this.minSpacing,
      measure: request.measure,
      format: request.format,
      maxTicks: request.maxTicks,
      weekStart: this.weekStart,
      locale: this.locale,
      hourCycle: this.hourCycle,
    });
    let lightest = Infinity;
    for (const t of ticks) lightest = Math.min(lightest, UNIT_RANK[t.unit]);
    return ticks.map((t) => ({
      index: t.index!,
      time: t.time,
      weight: t.weight,
      unit: t.unit,
      label: t.label,
      major: UNIT_RANK[t.unit] > lightest,
    }));
  }

  /** Axis label for a single bar time at a given weight (for custom tick sources). */
  formatTick(timeMs: number, weight: number, kind: TimeAxisResolutionKind): string {
    const zone = this.calendarZone(kind);
    if (!tickLevel(weight)) return "";
    return tickLabeler({ locale: this.locale, hourCycle: this.hourCycle }).label(zone.toWall(timeMs), weight);
  }

  /**
   * Crosshair / legend time label: "14 Jan '24" for daily and coarser bars
   * (their UTC date), "14 Jan '24 17:00" intraday and "14 Jan '24 17:00:05"
   * for seconds (in the display zone). Non-English locales use Intl names.
   */
  formatCrosshair(timeMs: number, kind: TimeAxisResolutionKind): string {
    const zone = this.calendarZone(kind);
    if (!Number.isFinite(timeMs)) return "";
    const wall = zone.toWall(timeMs);
    // Intl formats only the Date range; the local time of its very ends can fall outside.
    if (!(Math.abs(wall) <= MAX_DATE_MS)) return "";
    const f = fieldsFromWall(wall);
    const english = this.locale === DEFAULT_LOCALE;
    const date = english
      ? `${f.day} ${EN_MONTHS[f.month]} '${pad2(((f.year % 100) + 100) % 100)}`
      : dateTimeFormat(this.locale, { timeZone: "UTC", day: "numeric", month: "short", year: "2-digit" }).format(wall);
    if (!isIntradayKind(kind)) return date;
    if (english && this.hourCycle === "h23") {
      const hm = `${pad2(f.hour)}:${pad2(f.minute)}`;
      return kind === "seconds" ? `${date} ${hm}:${pad2(f.second)}` : `${date} ${hm}`;
    }
    const clock = this.hourCycle === "h12"
      ? { hour: "numeric", minute: "2-digit", hour12: true } as const
      : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
    const time = dateTimeFormat(this.locale, {
      timeZone: "UTC",
      ...clock,
      ...(kind === "seconds" ? { second: "2-digit" } as const : {}),
    }).format(wall);
    return `${date} ${time}`;
  }
}
