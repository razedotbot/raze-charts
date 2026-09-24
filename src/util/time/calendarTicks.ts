/**
 * Weighted calendar ticks shared by the financial widget and native `/chart`.
 *
 * Every candidate tick carries a *weight*: the highest calendar boundary it
 * sits on (or, for bars, the highest boundary crossed since the previous
 * bar) on a ladder that runs from 1 ms to 1000 years:
 *
 *   ms 1/2/5/10/20/50/100/200/500 < s 1/2/5/10/15/30 < min 1/2/5/10/15/30
 *     < h 1/2/3/6/12 < day 1/2 < week < half month < month 1/3/6
 *     < year 1/2/5/10/20/…/1000
 *
 * Multi-day rungs count days of the month (see {@link floorWall}): "2 days"
 * marks the odd days 1, 3, …, 31 and "half month" (`day` step 14) marks the
 * 1st and the 15th, so both nest in months. Adjacent rungs are at most 3.5x
 * apart, which bounds how far the label count can jump when the axis
 * narrows by a few pixels (it can never fall from ten labels to one).
 *
 * The ladder is not one chain: 2 min does not divide 5 min, 10 min does not
 * divide 15 min, and weeks do not nest in half months. Selection therefore
 * runs on three nested *tracks* and keeps the densest result (ties go to the
 * first):
 *
 *   quarter  1/5/15/30 s and min, 1/3/6/12 h, weeks, 5-year rungs (TradingView's ladder)
 *   decimal  1/5/10/30 s and min, 1/3/6/12 h, weeks, 5-year rungs
 *   binary   1/2/10/30 s and min, 1/2/6/12 h, odd days, half months, 2-year rungs
 *
 * Within a track, selection walks the ladder from the top and admits a level
 * as a whole or not at all: the first level whose own calendar rhythm no
 * longer fits the minimum spacing is refused and finer levels are not
 * considered, so labels stay calendar-regular ("2025 Apr Jul Oct 2026", never
 * "Jan Feb Apr May"). Collisions that come from the data rather than the
 * calendar (a 09:30 session open beside 10:00) only drop the finer tick (see
 * admitLevel).
 *
 * Two fallbacks keep the axis from going blank. Irregular data (sparse bars)
 * can leave holes much wider than the typical gap, including at the axis
 * edges; those holes are filled greedily from the refused levels. And when
 * the regular result has fewer than two ticks although the axis has room for
 * two (a narrow card, or a few sessions squeezed into 120 px), the refused
 * levels are admitted greedily, heaviest first, until it does.
 *
 * All calendar math happens in wall time for a {@link TimeZone}, so ticks sit
 * on local midnights, month and year starts, and DST days never duplicate or
 * skip labels (a repeated fall-back hour is labelled twice, a skipped
 * spring-forward hour not at all).
 */

import { dateTimeFormat, resolveLocale } from "../intl";
import {
  DAY_MS,
  HOUR_MS,
  MAX_DATE_MS,
  MINUTE_MS,
  SECOND_MS,
  civilFromDays,
  daysFromCivil,
  getTimeZone,
  wallFromFields,
  type TimeZone,
} from "./zone";

export type TickUnit = "millisecond" | "second" | "minute" | "hour" | "day" | "week" | "month" | "year";

export interface TickLevel {
  /** 1-based rank on the ladder; a higher weight is a more significant boundary. */
  readonly weight: number;
  readonly unit: TickUnit;
  /** Step in `unit`s. Day steps above 1 count days of the month (see {@link floorWall}). */
  readonly step: number;
  /** Nominal duration (months and years use the mean Gregorian length). */
  readonly nominalMs: number;
}

/** Weight of a bar that crosses no boundary (a duplicate or non-finite timestamp). */
export const NO_TICK = 0;

/** Default minimum distance between two tick positions, in CSS pixels. */
export const DEFAULT_TICK_SPACING = 40;

const YEAR_MS = 365.2425 * DAY_MS;
const MONTH_MS = YEAR_MS / 12;

const UNIT_MS: Record<TickUnit, number> = {
  millisecond: 1,
  second: SECOND_MS,
  minute: MINUTE_MS,
  hour: HOUR_MS,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: MONTH_MS,
  year: YEAR_MS,
};

const rungsOf = (unit: TickUnit, steps: readonly number[]): Array<readonly [TickUnit, number]> =>
  steps.map((step) => [unit, step] as const);

/** Rungs in ascending nominal length (the half month sits between the week and the month). */
const LADDER: ReadonlyArray<readonly [TickUnit, number]> = [
  ...rungsOf("millisecond", [1, 2, 5, 10, 20, 50, 100, 200, 500]),
  ...rungsOf("second", [1, 2, 5, 10, 15, 30]),
  ...rungsOf("minute", [1, 2, 5, 10, 15, 30]),
  ...rungsOf("hour", [1, 2, 3, 6, 12]),
  ...rungsOf("day", [1, 2]),
  ["week", 1],
  ["day", 14],
  ...rungsOf("month", [1, 3, 6]),
  ...rungsOf("year", [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]),
];

/** The tick ladder in ascending weight order (`TICK_LEVELS[w - 1].weight === w`). */
export const TICK_LEVELS: readonly TickLevel[] = LADDER
  .map(([unit, step], i) => Object.freeze({ weight: i + 1, unit, step, nominalMs: UNIT_MS[unit] * step }));

/** Weight of the `(unit, step)` ladder rung. Throws for a rung that is not on the ladder. */
export function tickWeight(unit: TickUnit, step = 1): number {
  const level = TICK_LEVELS.find((l) => l.unit === unit && l.step === step);
  if (!level) {
    const rungs = TICK_LEVELS.filter((l) => l.unit === unit).map((l) => l.step).join(", ");
    throw new RangeError(`No ${unit} tick level with step ${step}. Available ${unit} steps: ${rungs || "none"}.`);
  }
  return level.weight;
}

/** The level for a weight, or `undefined` for {@link NO_TICK} and out-of-range weights. */
export function tickLevel(weight: number): TickLevel | undefined {
  return TICK_LEVELS[weight - 1];
}

/** Weights of the first rung of each unit, for "is this at least a day boundary?" comparisons. */
export const TickWeight = Object.freeze({
  Millisecond: tickWeight("millisecond"),
  Second: tickWeight("second"),
  Minute: tickWeight("minute"),
  Hour: tickWeight("hour"),
  Day: tickWeight("day"),
  Week: tickWeight("week"),
  Month: tickWeight("month"),
  Year: tickWeight("year"),
});

// ---------------------------------------------------------------------------
// Wall-time calendar arithmetic
// ---------------------------------------------------------------------------

/** Weekday a week starts on: 0 = Sunday … 6 = Saturday. ISO weeks (the default) start on Monday. */
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const DEFAULT_WEEK_START: WeekStart = 1;

function assertStep(unit: TickUnit, step: number): void {
  if (!Number.isInteger(step) || step < 1) {
    throw new RangeError(`Calendar step for "${unit}" must be a positive integer; received ${step}.`);
  }
}

/** @internal Shared validators (also used by FinancialTimeAxis). */
export function assertWeekStart(weekStart: number): void {
  if (!Number.isInteger(weekStart) || weekStart < 0 || weekStart > 6) {
    throw new RangeError(`weekStart must be an integer from 0 (Sunday) to 6 (Saturday); received ${weekStart}.`);
  }
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Days in a month (`month` 1-12). */
function daysInMonth(year: number, month: number): number {
  return month === 12 ? 31 : daysFromCivil(year, month + 1, 1) - daysFromCivil(year, month, 1);
}

/**
 * First day (1-based) of the `step`-day period of the month that contains
 * `day`. Periods start on the 1st; a period shorter than half a step at the
 * end of the month joins the previous one (step 14 gives the 1st and 15th).
 */
function dayOfMonthFloor(day: number, step: number, monthLength: number): number {
  let start = 1 + Math.floor((day - 1) / step) * step;
  if (start > 1 && monthLength - start + 1 < step / 2) start -= step;
  return start;
}

/**
 * Start of the `step × unit` bucket containing a wall time.
 *
 * Sub-day steps that do not divide a day are aligned to the wall epoch
 * (1970-01-01 00:00). Day steps above 1 count days of the month like d3's
 * `timeDay.every(n)`: periods start on the 1st, and a period shorter than
 * half a step at the month end joins the previous one, so step 2 gives the
 * odd days and step 14 gives the 1st and 15th. Periods that run across
 * month ends (for example n-day bars) are plain day arithmetic instead.
 */
export function floorWall(wallMs: number, unit: TickUnit, step = 1, weekStart: WeekStart = DEFAULT_WEEK_START): number {
  switch (unit) {
    case "millisecond":
    case "second":
    case "minute":
    case "hour": {
      const size = UNIT_MS[unit] * step;
      return Math.floor(wallMs / size) * size;
    }
    case "day": {
      const days = Math.floor(wallMs / DAY_MS);
      if (step === 1 || !Number.isFinite(days)) return days * DAY_MS;
      const { year, month, day } = civilFromDays(days);
      return (days - day + dayOfMonthFloor(day, step, daysInMonth(year, month))) * DAY_MS;
    }
    case "week": {
      // Week q starts on day 7q - 4 + weekStart (1970-01-01 was a Thursday).
      const week = Math.floor((Math.floor(wallMs / DAY_MS) + 4 - weekStart) / 7);
      return ((Math.floor(week / step) * step) * 7 - 4 + weekStart) * DAY_MS;
    }
    case "month": {
      const { year, month } = civilFromDays(Math.floor(wallMs / DAY_MS));
      const index = Math.floor((year * 12 + month - 1) / step) * step;
      return wallFromFields(Math.floor(index / 12), mod(index, 12));
    }
    case "year": {
      const { year } = civilFromDays(Math.floor(wallMs / DAY_MS));
      return wallFromFields(Math.floor(year / step) * step, 0);
    }
  }
}

/** Add `count × step × unit` to a wall time (calendar-aware for months and years). */
export function addWall(wallMs: number, unit: TickUnit, step = 1, count = 1): number {
  if (unit === "month" || unit === "year") {
    const days = Math.floor(wallMs / DAY_MS);
    const { year, month, day } = civilFromDays(days);
    const months = unit === "month" ? step * count : step * count * 12;
    const target = year * 12 + month - 1 + months;
    const ty = Math.floor(target / 12);
    const tm = mod(target, 12);
    // Clamp the day to the target month's length (31 Jan + 1 month = 28/29 Feb).
    const monthLength = (wallFromFields(ty, tm + 1) - wallFromFields(ty, tm)) / DAY_MS;
    return wallFromFields(ty, tm, Math.min(day, monthLength)) + (wallMs - days * DAY_MS);
  }
  return wallMs + UNIT_MS[unit] * step * count;
}

/** The next `step × unit` bucket start after the bucket start `wallMs`. */
function nextBoundary(wallMs: number, unit: TickUnit, step: number): number {
  if (unit !== "day" || step === 1) return addWall(wallMs, unit, step);
  const next = wallMs + step * DAY_MS;
  if (floorWall(next, unit, step) === next) return next;
  // The month ended, or its short tail joined this period: the next period is the 1st.
  return addWall(floorWall(wallMs, "month"), "month");
}

/**
 * Start (UTC ms) of the local `step × unit` period containing `utcMs`, for
 * example the local Monday 00:00 of its week or the first of its quarter.
 * A local midnight that does not exist (a DST gap) resolves forward. Day
 * steps above 1 count days of the month (see {@link floorWall}).
 *
 * Sub-day periods inside the hour repeated when clocks fall back belong to
 * the pass that contains `utcMs`: in New York on 3 Nov 2024, 06:30Z (01:30
 * EST, the second 01:30) floors to the hour at 06:00Z (01:00 EST), not to
 * 05:00Z (01:00 EDT) an hour earlier.
 */
export function floorToCalendar(
  utcMs: number,
  unit: TickUnit,
  step = 1,
  zone: TimeZone | string | null = null,
  weekStart: WeekStart = DEFAULT_WEEK_START,
): number {
  assertStep(unit, step);
  assertWeekStart(weekStart);
  const tz = typeof zone === "object" && zone !== null ? zone : getTimeZone(zone);
  if (!Number.isFinite(utcMs)) return NaN;
  const floored = floorWall(tz.toWall(utcMs), unit, step, weekStart);
  if (UNIT_MS[unit] < DAY_MS && tz.fixedOffset === null) {
    // A repeated wall time has two instants; the later one starts the period
    // when it is not after the instant (the second pass through the hour).
    const later = tz.fromWall(floored, "later");
    if (later <= utcMs && tz.toWall(later) === floored) return later;
  }
  const utc = tz.fromWall(floored, "compatible");
  // Defensive: a period start resolved forward out of a DST gap must never
  // lie after the instant it contains.
  return utc > utcMs ? tz.fromWall(floored, "earlier") : utc;
}

/** Add `count × step × unit` of local calendar time to a UTC instant. */
export function addCalendar(
  utcMs: number,
  unit: TickUnit,
  step = 1,
  count = 1,
  zone: TimeZone | string | null = null,
): number {
  assertStep(unit, step);
  const tz = typeof zone === "object" && zone !== null ? zone : getTimeZone(zone);
  if (!Number.isFinite(utcMs)) return NaN;
  // Fixed-length units are exact elapsed time; calendar units keep the local clock time.
  if (unit !== "day" && unit !== "week" && unit !== "month" && unit !== "year") {
    return utcMs + UNIT_MS[unit] * step * count;
  }
  return tz.fromWall(addWall(tz.toWall(utcMs), unit, step, count), "compatible");
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

// Derived tables are marked pure so bundles that never call boundaryWeight
// (native /chart only needs calendarTicks) drop them.
const SUB_DAY_LEVELS = /* @__PURE__ */ TICK_LEVELS.filter((l) => UNIT_MS[l.unit] < DAY_MS).reverse();
const YEAR_LEVELS = /* @__PURE__ */ TICK_LEVELS.filter((l) => l.unit === "year").reverse();
const MONTH_LEVELS = /* @__PURE__ */ TICK_LEVELS.filter((l) => l.unit === "month").reverse();
/** Day and week rungs, heaviest first (half month, week, 2 days, day). */
const DAY_LEVELS = /* @__PURE__ */ TICK_LEVELS.filter((l) => l.unit === "day" || l.unit === "week").reverse();
const LEVELS_DESC = /* @__PURE__ */ [...TICK_LEVELS].reverse();

/**
 * Weight of the most significant boundary between two wall times: the
 * highest level whose bucket differs, or {@link NO_TICK} for equal wall
 * times. It compares wall times only, so it cannot tell a duplicate bar from
 * the repeated hour after clocks fall back (01:00 EDT and 01:00 EST read the
 * same). {@link computeTickWeights} tells them apart by their UTC times.
 */
export function boundaryWeight(prevWall: number, wall: number, weekStart: WeekStart = DEFAULT_WEEK_START): number {
  if (!Number.isFinite(prevWall) || !Number.isFinite(wall) || prevWall === wall) return NO_TICK;
  const prevDay = Math.floor(prevWall / DAY_MS);
  const day = Math.floor(wall / DAY_MS);
  if (prevDay !== day) {
    const a = civilFromDays(prevDay);
    const b = civilFromDays(day);
    for (const level of YEAR_LEVELS) {
      if (Math.floor(a.year / level.step) !== Math.floor(b.year / level.step)) return level.weight;
    }
    const am = a.year * 12 + a.month - 1;
    const bm = b.year * 12 + b.month - 1;
    for (const level of MONTH_LEVELS) {
      if (Math.floor(am / level.step) !== Math.floor(bm / level.step)) return level.weight;
    }
    // Same month from here on.
    const length = daysInMonth(b.year, b.month);
    for (const level of DAY_LEVELS) {
      if (level.unit === "week") {
        if (Math.floor((prevDay + 4 - weekStart) / 7) !== Math.floor((day + 4 - weekStart) / 7)) return level.weight;
      } else if (level.step === 1 || dayOfMonthFloor(a.day, level.step, length) !== dayOfMonthFloor(b.day, level.step, length)) {
        return level.weight;
      }
    }
  }
  for (const level of SUB_DAY_LEVELS) {
    const size = level.nominalMs;
    if (Math.floor(prevWall / size) !== Math.floor(wall / size)) return level.weight;
  }
  return NO_TICK;
}

/** Weight of the most significant boundary a wall time sits exactly on (used for the first bar). */
export function alignedWeight(wall: number, weekStart: WeekStart = DEFAULT_WEEK_START): number {
  if (!Number.isFinite(wall)) return NO_TICK;
  for (const level of LEVELS_DESC) {
    if (floorWall(wall, level.unit, level.step, weekStart) === wall) return level.weight;
  }
  return NO_TICK;
}

export interface TimedPoint {
  readonly time: number;
}

/**
 * Weight of a bar at `wall` that follows a bar at `prevWall`.
 *
 * Normally this is the heaviest boundary crossed since the previous bar. When
 * the local clock went back (a later instant with an equal or earlier wall
 * time: the repeated hour after clocks fall back), the bar starts the repeated
 * stretch. It then weighs as much as the heaviest sub-day rung it sits on or
 * crosses, so the second 01:00 is labelled like the first. It never weighs a
 * day or more, because the date has not changed.
 */
function stepWeight(prevTime: number, prevWall: number, time: number, wall: number, weekStart: WeekStart): number {
  const crossed = boundaryWeight(prevWall, wall, weekStart);
  if (!(time > prevTime && wall <= prevWall)) return crossed;
  return Math.min(Math.max(crossed, alignedWeight(wall, weekStart)), TickWeight.Day - 1);
}

/**
 * Per-bar tick weights for a time-sorted series.
 *
 * Each bar carries the heaviest calendar boundary crossed since the previous
 * bar. The first bar of the series weighs what a session open on its local
 * day weighs after an overnight gap (the weight of that day's midnight: at
 * least a day, a month on the 1st), so an intraday series that starts at a
 * 09:30 open is labelled with its date, and loading an earlier history page
 * does not change its weight. Bars in a repeated fall-back hour are weighted
 * like the first pass through it (see {@link stepWeight}), and only a true
 * duplicate (an equal UTC time) weighs {@link NO_TICK}.
 *
 * `out` is reused when it is large enough, and only indices from `start`
 * are (re)computed, so appending live bars costs O(appended).
 */
export function computeTickWeights(
  points: ArrayLike<TimedPoint>,
  zone: TimeZone | string | null = null,
  options: { weekStart?: WeekStart; out?: Uint8Array; start?: number } = {},
): Uint8Array {
  const weekStart = options.weekStart ?? DEFAULT_WEEK_START;
  assertWeekStart(weekStart);
  const tz = typeof zone === "object" && zone !== null ? zone : getTimeZone(zone);
  const n = points.length;
  const out = options.out && options.out.length >= n ? options.out : new Uint8Array(n);
  const start = Math.max(0, Math.min(n, options.start ?? 0));
  let prevTime = start > 0 ? points[start - 1]!.time : NaN;
  let prevWall = tz.toWall(prevTime);
  for (let i = start; i < n; i++) {
    const time = points[i]!.time;
    const wall = tz.toWall(time);
    out[i] = i === 0
      ? alignedWeight(floorWall(wall, "day"), weekStart)
      : stepWeight(prevTime, prevWall, time, wall, weekStart);
    prevTime = time;
    prevWall = wall;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface TickLabelOptions {
  /** BCP 47 locale for month names and digits. Default "en-US". */
  locale?: string;
  /** "h23" (default, 09:30 / 17:00) or "h12" (9:30 AM / 5:00 PM). */
  hourCycle?: "h23" | "h12";
}

export interface TickLabeler {
  /**
   * Label for a tick of `weight` at wall time `wallMs`: "2025", "Feb", "14",
   * "09:30", "09:30:15", ".250". Empty for a wall time Intl cannot format
   * (non-finite, or outside the Date range).
   */
  label(wallMs: number, weight: number): string;
}

const labelers = new Map<string, TickLabeler>();

/** Cached labeler for `(locale, hourCycle)`; every formatter is built once. */
export function tickLabeler(options: TickLabelOptions = {}): TickLabeler {
  const locale = resolveLocale(options.locale);
  const hourCycle = options.hourCycle ?? "h23";
  if (hourCycle !== "h23" && hourCycle !== "h12") {
    throw new RangeError(`hourCycle must be "h23" or "h12"; received ${String(hourCycle)}.`);
  }
  const key = `${locale}|${hourCycle}`;
  const cached = labelers.get(key);
  if (cached) return cached;

  // Wall milliseconds are formatted as UTC so no second zone conversion happens.
  const base = { timeZone: "UTC" } as const;
  const clock = hourCycle === "h12"
    ? { ...base, hour: "numeric", minute: "2-digit", hour12: true } as const
    : { ...base, hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  const year = dateTimeFormat(locale, { ...base, year: "numeric" });
  const month = dateTimeFormat(locale, { ...base, month: "short" });
  const day = dateTimeFormat(locale, { ...base, day: "numeric" });
  const minute = dateTimeFormat(locale, clock);
  const second = dateTimeFormat(locale, { ...clock, second: "2-digit" });

  const labeler: TickLabeler = {
    label(wallMs, weight) {
      if (!(Math.abs(wallMs) <= MAX_DATE_MS)) return "";
      const unit = tickLevel(weight)?.unit ?? "millisecond";
      switch (unit) {
        case "year": return year.format(wallMs);
        case "month": return month.format(wallMs);
        case "week":
        case "day": return day.format(wallMs);
        case "hour":
        case "minute": return minute.format(wallMs);
        case "second": return second.format(wallMs);
        case "millisecond": return `.${String(mod(wallMs, SECOND_MS)).padStart(3, "0")}`;
      }
    },
  };
  labelers.set(key, labeler);
  return labeler;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface CalendarTick {
  /** UTC instant of the tick (for bar ticks, the bar's own timestamp). */
  time: number;
  /** Offset in CSS pixels from the start of the visible range. */
  x: number;
  weight: number;
  unit: TickUnit;
  label: string;
  /** Bar index (bar ticks only). */
  index?: number;
}

/** What a custom tick {@link TickSelectionOptions.format | format} function receives. */
export interface TickFormatInput {
  /** UTC instant of the tick. */
  time: number;
  /** Local wall time of the tick (read its fields with `fieldsFromWall`). */
  wall: number;
  weight: number;
  /** Unit and step of the tick's ladder rung (a `day` step of 14 is a half month). */
  unit: TickUnit;
  step: number;
  /** Bar index (bar ticks only). */
  index?: number;
}

export interface TickSelectionOptions extends TickLabelOptions {
  /** Minimum distance between tick positions in CSS pixels. Default {@link DEFAULT_TICK_SPACING}. */
  minSpacing?: number;
  /**
   * Optional label width measurement (for example `ctx.measureText(s).width`).
   * When given, two ticks must also be far enough apart for their centred
   * labels not to overlap: `(wa + wb) / 2 + labelGap`.
   */
  measure?: (label: string) => number;
  /**
   * Optional custom label, for example "14 Feb" for day ticks or "Feb 2025"
   * for month ticks. It receives the tick and the default label, and must
   * return a string. Labels are formatted before they are measured, so
   * `measure` and the collision checks see the final text.
   */
  format?: (tick: TickFormatInput, defaultLabel: string) => string;
  /** Extra space between measured labels. Default 8. */
  labelGap?: number;
  /** Upper bound on the number of ticks. */
  maxTicks?: number;
  /** Local weekday that starts a week. Default Monday (1). */
  weekStart?: WeekStart;
}

interface Candidate {
  time: number;
  wall: number;
  /** Wall time of the previous bar (or just before the boundary), to re-derive crossings. */
  prevWall: number;
  x: number;
  weight: number;
  index: number;
  label: string | null;
  width: number;
}

interface Selector {
  minSpacing: number;
  labelGap: number;
  measure: TickSelectionOptions["measure"];
  format: TickSelectionOptions["format"];
  maxTicks: number;
  weekStart: WeekStart;
  labeler: TickLabeler;
}

/** @internal */
export function assertMinSpacing(minSpacing: number): void {
  if (!(minSpacing > 0) || !Number.isFinite(minSpacing)) {
    throw new RangeError(`minSpacing must be a positive number of pixels; received ${minSpacing}.`);
  }
}

function makeSelector(options: TickSelectionOptions): Selector {
  const minSpacing = options.minSpacing ?? DEFAULT_TICK_SPACING;
  assertMinSpacing(minSpacing);
  const maxTicks = options.maxTicks ?? Infinity;
  if (!(maxTicks >= 1)) throw new RangeError(`maxTicks must be at least 1; received ${maxTicks}.`);
  for (const key of ["measure", "format"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "function") {
      throw new TypeError(`${key} must be a function; received ${typeof options[key]}.`);
    }
  }
  const weekStart = options.weekStart ?? DEFAULT_WEEK_START;
  assertWeekStart(weekStart);
  return {
    minSpacing,
    labelGap: options.labelGap ?? 8,
    measure: options.measure,
    format: options.format,
    maxTicks,
    weekStart,
    labeler: tickLabeler(options),
  };
}

function labelOf(s: Selector, c: Candidate): string {
  if (c.label === null) {
    let label = s.labeler.label(c.wall, c.weight);
    if (s.format) {
      const { unit, step } = tickLevel(c.weight)!;
      const input: TickFormatInput = { time: c.time, wall: c.wall, weight: c.weight, unit, step };
      if (c.index >= 0) input.index = c.index;
      const custom: unknown = s.format(input, label);
      if (typeof custom !== "string") {
        throw new TypeError(`format must return a string label; received ${typeof custom} for the ${step} ${unit} tick at ${c.time}.`);
      }
      label = custom;
    }
    c.label = label;
    c.width = s.measure ? Math.max(0, Number(s.measure(label)) || 0) : 0;
  }
  return c.label;
}

function required(s: Selector, a: Candidate, b: Candidate): number {
  if (!s.measure) return s.minSpacing;
  labelOf(s, a);
  labelOf(s, b);
  return Math.max(s.minSpacing, (a.width + b.width) / 2 + s.labelGap);
}

/** Index of the first accepted tick with x >= c.x. */
function lowerBound(list: Candidate[], x: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.x < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function fits(s: Selector, accepted: Candidate[], c: Candidate): boolean {
  const at = lowerBound(accepted, c.x);
  const right = accepted[at];
  if (right && right.x - c.x < required(s, c, right)) return false;
  const left = accepted[at - 1];
  if (left && c.x - left.x < required(s, left, c)) return false;
  return true;
}

function mergeByX(a: Candidate[], b: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i]!.x <= b[j]!.x)) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  return out;
}

const weightsOf = (unit: TickUnit, steps: readonly number[]): number[] => steps.map((step) => tickWeight(unit, step));
const TWO_FAMILY = [...weightsOf("millisecond", [2, 20, 200]), ...weightsOf("year", [2, 20, 200])];
const FIVE_FAMILY = [...weightsOf("millisecond", [5, 50, 500]), ...weightsOf("year", [5, 50, 500])];
const MONTH_DAYS = weightsOf("day", [2, 14]);

/** Rungs each track leaves out (see the module comment). Every track is a nested chain apart from weeks in months. */
const TRACKS: ReadonlyArray<ReadonlySet<number>> = [
  // quarter: 1/5/15/30 s and min, 1/3/6/12 h, weeks, 5-year rungs.
  new Set([...TWO_FAMILY, ...weightsOf("second", [2, 10]), ...weightsOf("minute", [2, 10]), tickWeight("hour", 2), ...MONTH_DAYS]),
  // decimal: 1/5/10/30 s and min, 1/3/6/12 h, weeks, 5-year rungs.
  new Set([...TWO_FAMILY, ...weightsOf("second", [2, 15]), ...weightsOf("minute", [2, 15]), tickWeight("hour", 2), ...MONTH_DAYS]),
  // binary: 1/2/10/30 s and min, 1/2/6/12 h, odd days, half months, 2-year rungs.
  new Set([...FIVE_FAMILY, ...weightsOf("second", [5, 15]), ...weightsOf("minute", [5, 15]), tickWeight("hour", 3), TickWeight.Week]),
];
const TRACK_SPECIFIC = new Set(TRACKS.flatMap((track) => [...track]));

/**
 * Re-derive a candidate's weight on a track: the heaviest rung of the track
 * it crosses. A bar where the local clock went back (the repeated fall-back
 * hour) also counts the rungs it sits on, as in {@link stepWeight}.
 */
function onTrack(c: Candidate, excluded: ReadonlySet<number>, weekStart: WeekStart): Candidate {
  if (!excluded.has(c.weight)) return c;
  const back = c.wall <= c.prevWall;
  for (let w = c.weight - 1; w > NO_TICK; w--) {
    if (excluded.has(w)) continue;
    const { unit, step } = TICK_LEVELS[w - 1]!;
    const floor = floorWall(c.wall, unit, step, weekStart);
    if (floorWall(c.prevWall, unit, step, weekStart) !== floor || (back && floor === c.wall)) {
      return { ...c, weight: w, label: null, width: 0 };
    }
  }
  return { ...c, weight: NO_TICK, label: null, width: 0 };
}

/** Pixel extent of the visible axis, `[start, end]`. */
type Extent = readonly [number, number];

function selectBest(s: Selector, candidates: Candidate[], extent: Extent): Candidate[] {
  if (!candidates.some((c) => TRACK_SPECIFIC.has(c.weight))) return select(s, candidates, extent);
  let best: Candidate[] | null = null;
  for (const excluded of TRACKS) {
    const picked = select(s, candidates.map((c) => onTrack(c, excluded, s.weekStart)), extent);
    if (!best || picked.length > best.length) best = picked;
  }
  return best!;
}

/**
 * Pick ticks from `candidates` (sorted by x) on one track. See the module
 * comment for the level-by-level rule and the two fallbacks.
 */
function select(s: Selector, candidates: Candidate[], extent: Extent): Candidate[] {
  const groups = new Map<number, Candidate[]>();
  for (const c of candidates) {
    if (c.weight === NO_TICK) continue;
    let group = groups.get(c.weight);
    if (!group) groups.set(c.weight, (group = []));
    group.push(c);
  }
  const weights = [...groups.keys()].sort((a, b) => b - a);

  let accepted: Candidate[] = [];
  let rejectedFrom = weights.length;
  for (let w = 0; w < weights.length; w++) {
    const survivors = admitLevel(s, accepted, groups.get(weights[w]!)!, tickLevel(weights[w]!)!.nominalMs);
    if (!survivors || accepted.length + survivors.length > s.maxTicks) {
      rejectedFrom = w;
      break;
    }
    accepted = mergeByX(accepted, survivors);
  }

  if (rejectedFrom < weights.length && accepted.length < s.maxTicks) {
    const refused = weights.slice(rejectedFrom).map((w) => groups.get(w)!);
    // Room for two ticks means two ticks: a lone label cannot show a scale.
    const wanted = Math.min(2, Math.floor((extent[1] - extent[0]) / s.minSpacing), s.maxTicks);
    if (accepted.length < wanted) accepted = fillSparse(s, accepted, refused, wanted);
    if (accepted.length < wanted) accepted = spreadOut(s, weights.map((w) => groups.get(w)!), wanted) ?? accepted;
    accepted = fillHoles(s, accepted, refused, extent);
  }
  return accepted;
}

/**
 * Last resort for a narrow axis where one heavy tick in the middle blocks
 * every neighbour (a 2030 label on a 65 px axis of ten years, with 2026 and
 * 2034 each 26 px away). Pool the levels heaviest first and pick ticks left
 * to right, which fits the most labels a pool allows; the first pool that
 * yields `wanted` ticks wins. Returns `null` when no pool does.
 */
function spreadOut(s: Selector, groups: Candidate[][], wanted: number): Candidate[] | null {
  let pool: Candidate[] = [];
  for (const group of groups) {
    pool = mergeByX(pool, group);
    const out: Candidate[] = [];
    for (const c of pool) {
      if (out.length >= s.maxTicks) break;
      if (fits(s, out, c)) out.push(c);
    }
    if (out.length >= wanted) return out;
  }
  return null;
}

/**
 * Admit one level's candidates next to the heavier ticks already accepted,
 * or return `null` when the level is too dense.
 *
 * Two ticks that are too close in pixels and roughly one rung interval apart
 * in time (0.9-1.5x its nominal length) mean the rung itself is crowded: a
 * 28-day February at 1.4 px/day, or a trading year of 260 bars at 0.15
 * px/bar. Admitting part of such a level produces irregular labels ("Jan Feb
 * Apr"), so the whole level is refused. A conflict with a tick much nearer or
 * farther in time comes from the data or from a non-nested heavier rung (a
 * 09:30 session open beside 10:00, a Monday beside the 1st of the month, two
 * sparse bars either side of an hour-long gap); only the finer tick is dropped.
 */
function admitLevel(s: Selector, accepted: Candidate[], group: Candidate[], nominalMs: number): Candidate[] | null {
  const crowded = (a: Candidate, b: Candidate): boolean => {
    const t = Math.abs(b.time - a.time);
    return t >= 0.9 * nominalMs && t <= 1.5 * nominalMs;
  };
  const kept: Candidate[] = [];
  for (const c of group) {
    const at = lowerBound(accepted, c.x);
    const neighbours = [accepted[at - 1], accepted[at], kept[kept.length - 1]];
    let drop = false;
    for (const n of neighbours) {
      if (!n || Math.abs(c.x - n.x) >= required(s, n, c)) continue;
      if (crowded(n, c)) return null;
      drop = true;
    }
    if (!drop) kept.push(c);
  }
  return kept;
}

/**
 * The regular result has fewer ticks than the axis has room for (a crowded
 * top level, or a single heavier boundary in view). Admit refused levels
 * greedily, heaviest first, until `wanted` ticks are on the axis. Greedy
 * admission of an evenly spaced level keeps every other (or every third)
 * tick, so the result is still close to regular.
 */
function fillSparse(s: Selector, accepted: Candidate[], refused: Candidate[][], wanted: number): Candidate[] {
  const out = [...accepted];
  for (const group of refused) {
    for (const c of group) {
      if (out.length >= s.maxTicks) return out;
      if (fits(s, out, c)) out.splice(lowerBound(out, c.x), 0, c);
    }
    if (out.length >= wanted) break;
  }
  return out;
}

/**
 * Regular data never produces holes: every accepted gap, and each axis end,
 * is within a small factor of the median gap. Sparse or irregular bars can,
 * and there finer labels are better than an empty stretch of axis.
 */
function fillHoles(s: Selector, accepted: Candidate[], finerGroups: Candidate[][], extent: Extent): Candidate[] {
  if (!accepted.length || accepted.length >= s.maxTicks) return accepted;
  const gaps: number[] = [];
  for (let i = 1; i < accepted.length; i++) gaps.push(accepted[i]!.x - accepted[i - 1]!.x);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length ? sorted[sorted.length >> 1]! : 0;
  const threshold = Math.max(2.5 * median, 3 * s.minSpacing);
  // The axis ends act as anchors, so a stretch without labels at either end is a hole too.
  const anchors = [Math.min(extent[0], accepted[0]!.x) - 1e-9, ...accepted.map((c) => c.x), Math.max(extent[1], accepted[accepted.length - 1]!.x) + 1e-9];
  const holes: [number, number][] = [];
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i]! - anchors[i - 1]! > threshold) holes.push([anchors[i - 1]!, anchors[i]!]);
  }
  if (!holes.length) return accepted;

  const out = [...accepted];
  for (const group of finerGroups) {
    for (const c of group) {
      if (out.length >= s.maxTicks) return out;
      if (!holes.some(([a, b]) => c.x > a && c.x < b)) continue;
      if (fits(s, out, c)) out.splice(lowerBound(out, c.x), 0, c);
    }
  }
  return out;
}

function toTick(s: Selector, c: Candidate, withIndex: boolean): CalendarTick {
  const tick: CalendarTick = {
    time: c.time,
    x: c.x,
    weight: c.weight,
    unit: tickLevel(c.weight)!.unit,
    label: labelOf(s, c),
  };
  if (withIndex) tick.index = c.index;
  return tick;
}

// ---------------------------------------------------------------------------
// Continuous ranges (native /chart time scales)
// ---------------------------------------------------------------------------

export interface CalendarTickOptions extends TickSelectionOptions {
  /** Visible range start (UTC ms or Date). */
  from: number | Date;
  /** Visible range end (UTC ms or Date). */
  to: number | Date;
  /** Pixel width of `[from, to]`. */
  width: number;
  /** Display time zone: an IANA id, a {@link TimeZone}, or UTC when omitted. */
  timeZone?: TimeZone | string | null;
}

/** Guard against pathological inputs building millions of candidates. */
const MAX_CANDIDATES = 20_000;

/** Continuous ranges end a day inside the Date range, so local wall times stay formattable. */
const MAX_TICK_RANGE_MS = MAX_DATE_MS - DAY_MS;

/**
 * Calendar-aligned, weighted ticks for a continuous time range.
 *
 * Every boundary of every rung whose nominal spacing reaches a quarter of
 * `minSpacing` is generated in local time, then selected level by level on
 * each track. The rungs below `minSpacing` only feed the fallbacks. When the
 * result is still sparse (fewer than two ticks on an axis with room for
 * two), selection runs once more with rungs down to 1/16 of `minSpacing`,
 * so a lone tick can get a neighbour on even a 100 px axis. That retry only
 * happens on narrow axes, where the extra candidates are few.
 */
export function calendarTicks(options: CalendarTickOptions): CalendarTick[] {
  const s = makeSelector(options);
  const from = +options.from;
  const to = +options.to;
  const { width } = options;
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new RangeError(`calendarTicks needs a finite time range; received [${String(options.from)}, ${String(options.to)}].`);
  }
  if (Math.abs(from) > MAX_TICK_RANGE_MS || Math.abs(to) > MAX_TICK_RANGE_MS) {
    throw new RangeError(
      `calendarTicks range [${from}, ${to}] must lie within ±${MAX_TICK_RANGE_MS} ms: the Date range ` +
      "(±8.64e15 ms, about 273,790 years either side of 1970) less a day, so every local time stays representable.",
    );
  }
  if (!Number.isFinite(width) || width < 0) {
    throw new RangeError(`calendarTicks width must be a non-negative number of pixels; received ${width}.`);
  }
  const zone = typeof options.timeZone === "object" && options.timeZone !== null
    ? options.timeZone
    : getTimeZone(options.timeZone);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  if (width === 0) return [];
  if (hi === lo) {
    const wall = zone.toWall(lo);
    const c: Candidate = { time: lo, wall, prevWall: wall - 1, x: 0, weight: alignedWeight(wall, s.weekStart), index: -1, label: null, width: 0 };
    return c.weight === NO_TICK ? [] : [toTick(s, c, false)];
  }
  const extent: Extent = [0, width];
  let ticks = selectBest(s, rangeCandidates(s, zone, lo, hi, width, 4), extent);
  if (ticks.length < Math.min(2, Math.floor(width / s.minSpacing), s.maxTicks)) {
    const deeper = selectBest(s, rangeCandidates(s, zone, lo, hi, width, 16), extent);
    if (deeper.length > ticks.length) ticks = deeper;
  }
  return ticks.map((c) => toTick(s, c, false));
}

/**
 * Every boundary in `[lo, hi]` of the rungs whose nominal spacing is at
 * least `minSpacing / depth` pixels, sorted by x. Each boundary carries the
 * weight of the heaviest rung it sits on.
 *
 * Levels are generated coarsest first and only whole: when the next finer
 * rung would push the total past {@link MAX_CANDIDATES} it (and every finer
 * rung) is left out. A very wide axis therefore loses its finest fallback
 * rungs, never the right-hand part of its heavier ticks.
 */
function rangeCandidates(s: Selector, zone: TimeZone, lo: number, hi: number, width: number, depth: number): Candidate[] {
  const pxPerMs = width / (hi - lo);
  const found = TICK_LEVELS.findIndex((l) => l.nominalMs * pxPerMs >= s.minSpacing / depth);
  const first = found < 0 ? TICK_LEVELS.length - 1 : found;

  const byTime = new Map<number, Candidate>();
  // Wall times of instants in [lo, hi] lie between these bounds: a short range
  // holds at most one transition, so the endpoint offsets bracket it; a long
  // range is padded by a day, which costs few steps at its coarse rung.
  const offLo = zone.offset(lo);
  const offHi = zone.offset(hi);
  const pad = hi - lo >= 2 * DAY_MS ? DAY_MS : 0;
  const wallFrom = lo + Math.min(offLo, offHi) - pad;
  const wallTo = hi + Math.max(offLo, offHi) + pad;
  for (let li = TICK_LEVELS.length - 1; li >= first; li--) {
    const level = TICK_LEVELS[li]!;
    // Upper bound on this rung's boundaries (twice per repeated hour at most).
    const estimate = (wallTo - wallFrom) / level.nominalMs + 3;
    if (byTime.size + estimate > MAX_CANDIDATES) break;
    const subDay = UNIT_MS[level.unit] < DAY_MS;
    for (let b = floorWall(wallFrom, level.unit, level.step, s.weekStart); b <= wallTo; b = nextBoundary(b, level.unit, level.step)) {
      for (const utc of instantsForWall(zone, b, subDay)) {
        // Coarser rungs were generated first, so a shared instant keeps its heavier weight.
        if (!(utc >= lo && utc <= hi) || byTime.has(utc)) continue;
        const wall = zone.toWall(utc);
        byTime.set(utc, { time: utc, wall, prevWall: wall - 1, x: (utc - lo) * pxPerMs, weight: level.weight, index: -1, label: null, width: 0 });
      }
    }
  }
  return [...byTime.values()].sort((a, b) => a.x - b.x);
}

/**
 * UTC instants whose local wall time is `wall`. Sub-day boundaries in a
 * repeated hour occur twice and boundaries in a skipped hour never; a
 * skipped local midnight still starts its day (resolved forward).
 */
function instantsForWall(zone: TimeZone, wall: number, subDay: boolean): number[] {
  if (zone.fixedOffset !== null) return [wall - zone.fixedOffset];
  const earlier = zone.fromWall(wall, "earlier");
  const later = zone.fromWall(wall, "later");
  if (earlier !== later) {
    const earlierExists = zone.toWall(earlier) === wall;
    const laterExists = zone.toWall(later) === wall;
    if (earlierExists && laterExists) return subDay ? [earlier, later] : [earlier];
    if (!earlierExists && !laterExists) return subDay ? [] : [zone.fromWall(wall, "compatible")];
  }
  return [earlier];
}

// ---------------------------------------------------------------------------
// Logical bar axes (financial widget: gapped sessions)
// ---------------------------------------------------------------------------

export interface BarTickOptions extends TickSelectionOptions {
  /** Time-sorted bars (only `time` is read). */
  bars: ArrayLike<TimedPoint>;
  /** Weights from {@link computeTickWeights} for the same bars and zone. */
  weights: ArrayLike<number>;
  /** First visible logical index (fractional). */
  from: number;
  /** Last visible logical index (fractional). */
  to: number;
  /** Pixels per bar. */
  barSpacing: number;
  /** Zone the weights were computed in (labels are formatted in it). */
  timeZone?: TimeZone | string | null;
}

/**
 * Weighted ticks for a logical (bar-index) axis.
 *
 * Spacing is measured in bars × `barSpacing`, never in wall-clock span, so
 * overnight and weekend gaps do not thin the labels. The first bar of each
 * local day (a session open after an overnight gap, or the first bar of the
 * series) carries at least a day weight and is labelled with its date. The
 * repeated hour after clocks fall back is labelled twice, like the
 * continuous axis. Bars partially inside `[from, to]` are included, like the
 * legacy tick pass; the painter clips by position.
 */
export function barTicks(options: BarTickOptions): CalendarTick[] {
  const s = makeSelector(options);
  const { bars, weights, barSpacing } = options;
  if (weights.length < bars.length) {
    throw new RangeError(`barTicks needs a weight per bar (${bars.length} bars, ${weights.length} weights). Recompute them with computeTickWeights().`);
  }
  if (!(barSpacing > 0) || !Number.isFinite(barSpacing)) {
    throw new RangeError(`barSpacing must be a positive number of pixels per bar; received ${barSpacing}.`);
  }
  const zone = typeof options.timeZone === "object" && options.timeZone !== null
    ? options.timeZone
    : getTimeZone(options.timeZone);
  if (!Number.isFinite(options.from) || !Number.isFinite(options.to)) {
    throw new RangeError(`barTicks needs a finite logical range; received [${options.from}, ${options.to}].`);
  }
  const start = Math.max(0, Math.floor(options.from));
  const end = Math.min(bars.length - 1, Math.ceil(options.to));
  if (end < start) return [];

  // One counting pass decides which weights can matter. A level with more
  // candidates than three times the axis capacity is far too dense to label,
  // so it and everything finer is skipped (kept only if small enough to fill
  // holes). This bounds the work on a fully zoomed-out 500k-bar series.
  const counts = new Uint32Array(TICK_LEVELS.length + 1);
  for (let i = start; i <= end; i++) {
    const weight = weights[i]!;
    if (!(weight >= NO_TICK && weight <= TICK_LEVELS.length) || !Number.isInteger(weight)) {
      throw new RangeError(`Invalid tick weight ${weight} at bar ${i}. Use the weights returned by computeTickWeights().`);
    }
    counts[weight]!++;
  }
  const capacity = ((end - start) * barSpacing) / s.minSpacing + 1;
  let floorWeight = 1;
  for (let w = TICK_LEVELS.length; w >= 1; w--) {
    if (counts[w]! > 3 * capacity) {
      floorWeight = counts[w]! <= 16 * capacity ? w : w + 1;
      break;
    }
  }

  const candidates: Candidate[] = [];
  for (let i = start; i <= end; i++) {
    const weight = weights[i]!;
    if (weight < floorWeight || weight === NO_TICK) continue;
    const time = bars[i]!.time;
    const wall = zone.toWall(time);
    // The first bar weighs like a session open after an overnight gap (see computeTickWeights).
    const prevWall = i > 0 ? zone.toWall(bars[i - 1]!.time) : floorWall(wall, "day") - 1;
    candidates.push({ time, wall, prevWall, x: (i - options.from) * barSpacing, weight, index: i, label: null, width: 0 });
  }
  // The span the bars cover on screen: whitespace before the first bar or
  // after the last one is not a hole to fill with labels.
  const extent: Extent = [
    Math.max(0, (start - options.from) * barSpacing),
    Math.min(options.to - options.from, end - options.from) * barSpacing,
  ];
  return selectBest(s, candidates, extent).map((c) => toTick(s, c, true));
}
