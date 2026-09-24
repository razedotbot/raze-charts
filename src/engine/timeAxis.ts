/**
 * Financial time-axis adapter over the shared time core (AD-06).
 *
 * The financial widget places bars on a logical index axis (see TimeIndex),
 * so its ticks come from per-bar boundary weights rather than a wall-clock
 * ruler. This adapter owns the per-series weight cache (incremental for
 * appended and live-updated bars), the display zone, and the crosshair
 * label format, so paint code only asks for `ticks()` and `formatCrosshair()`.
 */

import {
  DEFAULT_TICK_SPACING,
  DEFAULT_WEEK_START,
  barTicks,
  computeTickWeights,
  fieldsFromWall,
  getTimeZone,
  tickLabeler,
  tickLevel,
  type TickLabelOptions,
  type TickUnit,
  type TimeZone,
  type TimedPoint,
  type WeekStart,
} from "../util/time";
import { DEFAULT_LOCALE, dateTimeFormat, resolveLocale } from "../util/intl";

/** Resolution kinds as produced by `parseResolution().kind`. */
export type TimeAxisResolutionKind = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months";

export interface TimeAxisOptions extends TickLabelOptions {
  /**
   * Resolved IANA display zone (use `resolveTimeZoneId(options.timezone,
   * symbolInfo.timezone)` for the widget's `"exchange"` semantics). Default UTC.
   * An unknown zone throws a RangeError naming it.
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
  /** First visible logical index (fractional). */
  from: number;
  /** Last visible logical index (fractional). */
  to: number;
  /** Pixels per bar. */
  barSpacing: number;
  /** Optional label width measurement so labels never overlap. */
  measure?: (label: string) => number;
  maxTicks?: number;
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const UNIT_RANK: Record<TickUnit, number> = {
  millisecond: 0, second: 1, minute: 2, hour: 3, day: 4, week: 4, month: 5, year: 6,
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

function isIntraday(kind: string): boolean {
  return kind === "seconds" || kind === "minutes" || kind === "hours";
}

interface WeightCache {
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
   * Change options at runtime (for example `setTimezone`). The update is
   * atomic: invalid options throw and leave the axis unchanged. Weights are
   * only recomputed when the zone or week start actually changes.
   */
  setOptions(options: TimeAxisOptions): void {
    const next = FinancialTimeAxis.resolve(options, this);
    if (next.tz !== this.tz || next.weekStart !== this.weekStart) this.cache = null;
    this.tz = next.tz;
    this.weekStart = next.weekStart;
    this.minSpacing = next.minSpacing;
    this.locale = next.locale;
    this.hourCycle = next.hourCycle;
  }

  /**
   * Per-bar boundary weights for `bars`, cached across frames. Appending bars
   * or replacing the last bar in place only computes the new tail; a prepend
   * (history page) or any other structural change recomputes everything.
   */
  weights(bars: ArrayLike<TimedPoint>): Uint8Array {
    const n = bars.length;
    const cache = this.cache;
    let start = 0;
    if (
      cache &&
      n >= cache.length &&
      cache.length > 0 &&
      bars[0]!.time === cache.firstTime &&
      bars[cache.length - 1]!.time === cache.lastTime
    ) {
      start = cache.length;
    }
    if (cache && start === n && n === cache.length) return cache.weights;

    let out = cache?.weights;
    if (!out || out.length < n) {
      const grown = new Uint8Array(Math.max(n, Math.ceil(n * 1.5), 64));
      if (out && start > 0) grown.set(out.subarray(0, start));
      out = grown;
    }
    computeTickWeights(bars, this.tz, { weekStart: this.weekStart, out, start });
    this.cache = n > 0
      ? { weights: out, length: n, firstTime: bars[0]!.time, lastTime: bars[n - 1]!.time }
      : null;
    return out;
  }

  /** Ticks for the visible logical range, labelled in the display zone. */
  ticks(bars: ArrayLike<TimedPoint>, request: TimeAxisTickRequest): TimeAxisTick[] {
    if (!bars.length) return [];
    const ticks = barTicks({
      bars,
      weights: this.weights(bars),
      from: request.from,
      to: request.to,
      barSpacing: request.barSpacing,
      timeZone: this.tz,
      minSpacing: this.minSpacing,
      measure: request.measure,
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

  /** Axis label for a single time at a given weight (for custom tick sources). */
  formatTick(timeMs: number, weight: number): string {
    if (!tickLevel(weight)) return "";
    return tickLabeler({ locale: this.locale, hourCycle: this.hourCycle }).label(this.tz.toWall(timeMs), weight);
  }

  /**
   * Crosshair / legend time label in the display zone:
   * "14 Jan '24" for daily and coarser, "14 Jan '24 17:00" intraday and
   * "14 Jan '24 17:00:05" for seconds. Non-English locales use Intl names.
   */
  formatCrosshair(timeMs: number, kind: TimeAxisResolutionKind | string): string {
    if (!Number.isFinite(timeMs)) return "";
    const wall = this.tz.toWall(timeMs);
    const f = fieldsFromWall(wall);
    const english = this.locale === DEFAULT_LOCALE;
    const date = english
      ? `${f.day} ${EN_MONTHS[f.month]} '${pad2(((f.year % 100) + 100) % 100)}`
      : dateTimeFormat(this.locale, { timeZone: "UTC", day: "numeric", month: "short", year: "2-digit" }).format(wall);
    if (!isIntraday(kind)) return date;
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
