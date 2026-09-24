/**
 * Weighted calendar ticks shared by the financial widget and native `/chart`.
 *
 * Every candidate tick carries a *weight*: the highest calendar boundary it
 * sits on (or, for bars, the highest boundary crossed since the previous
 * bar) on a ladder that runs from 1 ms to 1000 years:
 *
 *   ms 1/2/5/10/20/50/100/200/500 < s 1/5/15/30 < min 1/5/15/30
 *     < h 1/3/6/12 < day < week < month 1/3/6 < year 1/2/5/10/20/…/1000
 *
 * Selection walks the ladder from the top and admits a level as a whole or
 * not at all: the first level whose own calendar rhythm no longer fits the
 * minimum spacing is refused and finer levels are not considered, so labels
 * stay calendar-regular ("2025 Apr Jul Oct 2026", never "Jan Feb Apr May").
 * Collisions that come from the data rather than the calendar (a 09:30
 * session open beside 10:00) only drop the finer tick (see admitLevel).
 * Irregular data (sparse bars) can leave holes much wider than the typical
 * gap; those holes are then filled greedily from the refused levels.
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
  MINUTE_MS,
  SECOND_MS,
  civilFromDays,
  getTimeZone,
  wallFromFields,
  type TimeZone,
} from "./zone";

export type TickUnit = "millisecond" | "second" | "minute" | "hour" | "day" | "week" | "month" | "year";

export interface TickLevel {
  /** 1-based rank on the ladder; a higher weight is a more significant boundary. */
  readonly weight: number;
  readonly unit: TickUnit;
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

const LADDER: ReadonlyArray<readonly [TickUnit, readonly number[]]> = [
  ["millisecond", [1, 2, 5, 10, 20, 50, 100, 200, 500]],
  ["second", [1, 5, 15, 30]],
  ["minute", [1, 5, 15, 30]],
  ["hour", [1, 3, 6, 12]],
  ["day", [1]],
  ["week", [1]],
  ["month", [1, 3, 6]],
  ["year", [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]],
];

/** The tick ladder in ascending weight order (`TICK_LEVELS[w - 1].weight === w`). */
export const TICK_LEVELS: readonly TickLevel[] = LADDER.flatMap(([unit, steps]) => steps.map((step) => ({ unit, step })))
  .map(({ unit, step }, i) => Object.freeze({ weight: i + 1, unit, step, nominalMs: UNIT_MS[unit] * step }));

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

function assertWeekStart(weekStart: number): void {
  if (!Number.isInteger(weekStart) || weekStart < 0 || weekStart > 6) {
    throw new RangeError(`weekStart must be an integer from 0 (Sunday) to 6 (Saturday); received ${weekStart}.`);
  }
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * Start of the `step × unit` bucket containing a wall time. Sub-day steps
 * that do not divide a day are aligned to the wall epoch (1970-01-01 00:00).
 */
export function floorWall(wallMs: number, unit: TickUnit, step = 1, weekStart: WeekStart = DEFAULT_WEEK_START): number {
  switch (unit) {
    case "millisecond":
    case "second":
    case "minute":
    case "hour":
    case "day": {
      const size = UNIT_MS[unit] * step;
      return Math.floor(wallMs / size) * size;
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

/**
 * Start (UTC ms) of the local `step × unit` period containing `utcMs`, for
 * example the local Monday 00:00 of its week or the first of its quarter.
 * A local midnight that does not exist (a DST gap) resolves forward.
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

const SUB_DAY_LEVELS = TICK_LEVELS.filter((l) => UNIT_MS[l.unit] < DAY_MS).reverse();
const YEAR_LEVELS = TICK_LEVELS.filter((l) => l.unit === "year").reverse();
const MONTH_LEVELS = TICK_LEVELS.filter((l) => l.unit === "month").reverse();
const LEVELS_DESC = [...TICK_LEVELS].reverse();

/**
 * Weight of the most significant boundary between two consecutive wall
 * times: the highest level whose bucket differs. A wall time that moves
 * backwards (the repeated hour when clocks fall back) still counts, so the
 * second 01:00 is labelled like the first.
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
    if (Math.floor((prevDay + 4 - weekStart) / 7) !== Math.floor((day + 4 - weekStart) / 7)) return TickWeight.Week;
    return TickWeight.Day;
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
 * Per-bar tick weights for a time-sorted series.
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
  let prevWall = start > 0 ? tz.toWall(points[start - 1]!.time) : NaN;
  for (let i = start; i < n; i++) {
    const wall = tz.toWall(points[i]!.time);
    out[i] = i === 0 ? alignedWeight(wall, weekStart) : boundaryWeight(prevWall, wall, weekStart);
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
  /** Label for a tick of `weight` at wall time `wallMs`: "2025", "Feb", "14", "09:30", "09:30:15", ".250". */
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
      if (!Number.isFinite(wallMs)) return "";
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

export interface TickSelectionOptions extends TickLabelOptions {
  /** Minimum distance between tick positions in CSS pixels. Default {@link DEFAULT_TICK_SPACING}. */
  minSpacing?: number;
  /**
   * Optional label width measurement (for example `ctx.measureText(s).width`).
   * When given, two ticks must also be far enough apart for their centred
   * labels not to overlap: `(wa + wb) / 2 + labelGap`.
   */
  measure?: (label: string) => number;
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
  measure: ((label: string) => number) | undefined;
  maxTicks: number;
  labeler: TickLabeler;
}

function makeSelector(options: TickSelectionOptions): Selector {
  const minSpacing = options.minSpacing ?? DEFAULT_TICK_SPACING;
  if (!(minSpacing > 0) || !Number.isFinite(minSpacing)) {
    throw new RangeError(`minSpacing must be a positive number of pixels; received ${minSpacing}.`);
  }
  const maxTicks = options.maxTicks ?? Infinity;
  if (!(maxTicks >= 1)) throw new RangeError(`maxTicks must be at least 1; received ${maxTicks}.`);
  if (options.measure !== undefined && typeof options.measure !== "function") {
    throw new TypeError("measure must be a function that returns a label width in pixels.");
  }
  return {
    minSpacing,
    labelGap: options.labelGap ?? 8,
    measure: options.measure,
    maxTicks,
    labeler: tickLabeler(options),
  };
}

function labelOf(s: Selector, c: Candidate): string {
  if (c.label === null) {
    c.label = s.labeler.label(c.wall, c.weight);
    c.width = s.measure ? Math.max(0, Number(s.measure(c.label)) || 0) : 0;
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

// The ladder is a strict chain (each rung's boundaries are a subset of the
// next finer rung's) except where the 2- and 5-multiples of years and
// milliseconds branch: 2015 is a 5-year boundary but not a 2-year one. Mixing
// both branches yields "2015 2018 2020 2022 2024 2025", so selection runs
// once per branch and keeps the denser (still regular) result.
const MS_LEVELS = TICK_LEVELS.filter((l) => l.unit === "millisecond").reverse();
const branch = (steps: readonly number[]): Set<number> => new Set(
  TICK_LEVELS.filter((l) => (l.unit === "year" || l.unit === "millisecond") && steps.includes(l.step)).map((l) => l.weight),
);
const TWO_BRANCH = branch([2, 20, 200]);
const FIVE_BRANCH = branch([5, 50, 500]);

function crossesRung(prevWall: number, wall: number, level: TickLevel): boolean {
  if (level.unit === "year") {
    const a = civilFromDays(Math.floor(prevWall / DAY_MS)).year;
    const b = civilFromDays(Math.floor(wall / DAY_MS)).year;
    return Math.floor(a / level.step) !== Math.floor(b / level.step);
  }
  return Math.floor(prevWall / level.step) !== Math.floor(wall / level.step);
}

/** Re-derive a candidate's weight with the rungs in `excluded` removed from the ladder. */
function withoutBranch(c: Candidate, excluded: Set<number>): Candidate {
  if (!excluded.has(c.weight)) return c;
  const rungs = (tickLevel(c.weight)!.unit === "year" ? YEAR_LEVELS : MS_LEVELS)
    .filter((l) => l.weight < c.weight && !excluded.has(l.weight));
  const hit = rungs.find((l) => crossesRung(c.prevWall, c.wall, l)) ?? rungs[rungs.length - 1]!;
  return { ...c, weight: hit.weight, label: null };
}

function selectBest(s: Selector, candidates: Candidate[]): Candidate[] {
  if (!candidates.some((c) => TWO_BRANCH.has(c.weight) || FIVE_BRANCH.has(c.weight))) return select(s, candidates);
  const twos = select(s, candidates.map((c) => withoutBranch(c, FIVE_BRANCH)));
  const fives = select(s, candidates.map((c) => withoutBranch(c, TWO_BRANCH)));
  return fives.length >= twos.length ? fives : twos;
}

/**
 * Pick ticks from `candidates` (sorted by x). See the module comment for the
 * level-by-level rule and the hole filling for irregular data.
 */
function select(s: Selector, candidates: Candidate[]): Candidate[] {
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

  if (rejectedFrom < weights.length && accepted.length >= 2 && accepted.length < s.maxTicks) {
    accepted = fillHoles(s, accepted, weights.slice(rejectedFrom).map((w) => groups.get(w)!));
  }
  return accepted;
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
 * Regular data never produces holes: every accepted gap is within a small
 * factor of the median. Sparse or irregular bars can, and there finer
 * labels are better than an empty stretch of axis.
 */
function fillHoles(s: Selector, accepted: Candidate[], finerGroups: Candidate[][]): Candidate[] {
  const gaps: number[] = [];
  for (let i = 1; i < accepted.length; i++) gaps.push(accepted[i]!.x - accepted[i - 1]!.x);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1]!;
  const threshold = Math.max(2.5 * median, 3 * s.minSpacing);
  const holes: [number, number][] = [];
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i]! > threshold) holes.push([accepted[i]!.x, accepted[i + 1]!.x]);
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

/**
 * Calendar-aligned, weighted ticks for a continuous time range.
 *
 * The finest ladder rung whose nominal spacing reaches `minSpacing` bounds
 * the candidates; every boundary of that rung and of all heavier rungs is
 * generated in local time, then selected level by level.
 */
export function calendarTicks(options: CalendarTickOptions): CalendarTick[] {
  const s = makeSelector(options);
  const weekStart = options.weekStart ?? DEFAULT_WEEK_START;
  assertWeekStart(weekStart);
  const from = +options.from;
  const to = +options.to;
  const { width } = options;
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new RangeError(`calendarTicks needs a finite time range; received [${String(options.from)}, ${String(options.to)}].`);
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
    const c: Candidate = { time: lo, wall, prevWall: wall - 1, x: 0, weight: alignedWeight(wall, weekStart), index: -1, label: null, width: 0 };
    return c.weight === NO_TICK ? [] : [toTick(s, c, false)];
  }
  const pxPerMs = width / (hi - lo);
  const finest = TICK_LEVELS.findIndex((l) => l.nominalMs * pxPerMs >= s.minSpacing * 0.9);
  if (finest < 0) return [];

  const byTime = new Map<number, Candidate>();
  // Wall times of instants in [lo, hi] lie between these bounds: a short range
  // holds at most one transition, so the endpoint offsets bracket it; a long
  // range is padded by a day, which costs few steps at its coarse rung.
  const offLo = zone.offset(lo);
  const offHi = zone.offset(hi);
  const pad = hi - lo >= 2 * DAY_MS ? DAY_MS : 0;
  const wallFrom = lo + Math.min(offLo, offHi) - pad;
  const wallTo = hi + Math.max(offLo, offHi) + pad;
  for (let li = finest; li < TICK_LEVELS.length; li++) {
    const level = TICK_LEVELS[li]!;
    const subDay = UNIT_MS[level.unit] < DAY_MS;
    let b = floorWall(wallFrom, level.unit, level.step, weekStart);
    const end = wallTo;
    for (let guard = 0; b <= end && guard < MAX_CANDIDATES; guard++, b = addWall(b, level.unit, level.step)) {
      for (const utc of instantsForWall(zone, b, subDay)) {
        if (utc < lo || utc > hi) continue;
        const existing = byTime.get(utc);
        if (existing) {
          if (level.weight > existing.weight) existing.weight = level.weight;
          continue;
        }
        if (byTime.size >= MAX_CANDIDATES) break;
        const wall = zone.toWall(utc);
        byTime.set(utc, { time: utc, wall, prevWall: wall - 1, x: (utc - lo) * pxPerMs, weight: level.weight, index: -1, label: null, width: 0 });
      }
    }
  }
  // Every rung from `finest` up is walked, so each boundary already carries
  // the weight of the heaviest rung it sits on.
  const candidates = [...byTime.values()].sort((a, b) => a.x - b.x);
  return selectBest(s, candidates).map((c) => toTick(s, c, false));
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
 * local day (a session open after an overnight gap) carries at least a day
 * weight and is labelled with its date. Bars partially inside `[from, to]`
 * are included, like the legacy tick pass; the painter clips by position.
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
  const start = Math.max(0, Math.floor(options.from));
  const end = Math.min(bars.length - 1, Math.ceil(options.to));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

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
    const prevWall = i > 0 ? zone.toWall(bars[i - 1]!.time) : wall - 1;
    candidates.push({ time, wall, prevWall, x: (i - options.from) * barSpacing, weight, index: i, label: null, width: 0 });
  }
  return selectBest(s, candidates).map((c) => toTick(s, c, true));
}
