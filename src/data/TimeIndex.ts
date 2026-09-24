/**
 * Maps the chart's real timestamps to its continuous logical (bar-index) axis.
 *
 * A financial time axis deliberately removes closed sessions and missing bars:
 * adjacent bars stay one logical unit apart even when their timestamps are a
 * weekend (or a larger data gap) apart. Values between two bars are linearly
 * interpolated so drawing a point and painting it back is reversible.
 *
 * `points` must be sorted by ascending timestamp. The canonical DataManager
 * series already guarantees this and de-duplicates equal timestamps.
 */

import { DAY_MS, getTimeZone } from "../util/time";

export interface TimePoint {
  /** Milliseconds since the Unix epoch. */
  readonly time: number;
}

/** A time zone as the time core models it: UTC instant → local wall milliseconds. */
export interface WallClockZone {
  toWall(utcMs: number): number;
}

export interface SessionBreakOptions {
  /** Zone whose local midnights split round-the-clock intraday sessions: an IANA id or a zone object. */
  timeZone?: WallClockZone | string | null;
  /** First logical index to report (default: the whole series). */
  from?: number;
  /** Last logical index to report (default: the whole series). */
  to?: number;
}

/** Local day number of an instant in `zone`. */
function localDay(zone: WallClockZone, utcMs: number): number {
  return Math.floor(zone.toWall(utcMs) / DAY_MS);
}

export class TimeIndex {
  private readonly expectedStepMs: number;

  constructor(
    private readonly points: readonly TimePoint[],
    expectedStepMs = 0,
  ) {
    this.expectedStepMs = Number.isFinite(expectedStepMs) && expectedStepMs > 0
      ? expectedStepMs
      : 0;
  }

  get length(): number {
    return this.points.length;
  }

  /**
   * Return the fractional logical index for `timeMs`.
   *
   * Exact bar timestamps always return their exact array index. Timestamps in
   * session gaps interpolate only between the two adjacent bars, rather than
   * manufacturing logical bars for every missing wall-clock interval.
   */
  indexAt(timeMs: number): number | null {
    if (!Number.isFinite(timeMs) || this.points.length === 0) return null;

    const n = this.points.length;
    const firstTime = this.points[0]!.time;
    if (n === 1) {
      return (timeMs - firstTime) / this.edgeStep("right");
    }

    if (timeMs < firstTime) {
      return (timeMs - firstTime) / this.edgeStep("left");
    }

    const lastIndex = n - 1;
    const lastTime = this.points[lastIndex]!.time;
    if (timeMs > lastTime) {
      return lastIndex + (timeMs - lastTime) / this.edgeStep("right");
    }

    const right = this.lowerBound(timeMs);
    if (right < n && this.points[right]!.time === timeMs) return right;
    if (right <= 0) return 0;
    if (right >= n) return lastIndex;

    const left = right - 1;
    const leftTime = this.points[left]!.time;
    const rightTime = this.points[right]!.time;
    const duration = rightTime - leftTime;
    if (!(duration > 0)) return left;
    return left + (timeMs - leftTime) / duration;
  }

  /**
   * Return the timestamp in milliseconds at a fractional logical index.
   * This is the inverse of `indexAt` for the chart's continuous time axis.
   */
  timeAt(index: number): number | null {
    if (!Number.isFinite(index) || this.points.length === 0) return null;

    const n = this.points.length;
    const firstTime = this.points[0]!.time;
    if (n === 1) return firstTime + index * this.edgeStep("right");
    if (index < 0) return firstTime + index * this.edgeStep("left");

    const lastIndex = n - 1;
    const lastTime = this.points[lastIndex]!.time;
    if (index > lastIndex) {
      return lastTime + (index - lastIndex) * this.edgeStep("right");
    }

    const left = Math.floor(index);
    if (left >= lastIndex || index === left) return this.points[left]!.time;
    const fraction = index - left;
    const leftTime = this.points[left]!.time;
    const rightTime = this.points[left + 1]!.time;
    return leftTime + (rightTime - leftTime) * fraction;
  }

  /** Return the closest real bar index, clamped to the available series. */
  nearestIndex(timeMs: number): number | null {
    const logical = this.indexAt(timeMs);
    if (logical === null) return null;
    return Math.max(0, Math.min(this.points.length - 1, Math.round(logical)));
  }

  /**
   * Indices of bars that open a new session.
   *
   * A bar after a data gap (more than 1.6 bar steps since the previous bar)
   * always opens one: an overnight or weekend close, or a daily maintenance
   * break. With `timeZone`, intraday series that trade around the clock also
   * break at each local midnight of that zone. A midnight within a day of a
   * gap falls inside a gapped session (an equity session that spans Tokyo
   * midnight, a futures session that opens at 18:00) and is not a break.
   * Daily and coarser bars only break at gaps.
   *
   * `from` / `to` (inclusive, fractional allowed) limit the result to a
   * logical range, so a frame only walks its visible bars (plus a day either
   * side to find nearby gaps).
   */
  sessionBreaks(options: SessionBreakOptions = {}): number[] {
    const points = this.points;
    const n = points.length;
    if (n < 2 || this.expectedStepMs <= 0) return [];
    const zone = options.timeZone == null
      ? null
      : typeof options.timeZone === "string" ? getTimeZone(options.timeZone) : options.timeZone;
    for (const key of ["from", "to"] as const) {
      const value = options[key];
      if (value !== undefined && !Number.isFinite(value)) {
        throw new RangeError(`sessionBreaks() ${key} must be a finite logical index; received ${value}.`);
      }
    }
    const first = Math.max(1, Math.floor(options.from ?? 1));
    const last = Math.min(n - 1, Math.ceil(options.to ?? n - 1));
    if (first > last) return [];
    const limit = this.expectedStepMs * 1.6;
    const isGap = (i: number): boolean => points[i]!.time - points[i - 1]!.time > limit;
    const out: number[] = [];
    if (zone === null || this.expectedStepMs >= DAY_MS) {
      for (let i = first; i <= last; i++) if (isGap(i)) out.push(i);
      return out;
    }

    // Gap opens from a day before the range to a day after it, in time order.
    let lo = first;
    while (lo > 1 && points[lo - 1]!.time >= points[first]!.time - DAY_MS) lo--;
    let hi = last;
    while (hi < n - 1 && points[hi + 1]!.time <= points[last]!.time + DAY_MS) hi++;
    const gaps: number[] = [];
    for (let i = lo; i <= hi; i++) if (isGap(i)) gaps.push(points[i]!.time);

    let g = 0;
    let prevDay = localDay(zone, points[first - 1]!.time);
    for (let i = first; i <= last; i++) {
      const time = points[i]!.time;
      const day = localDay(zone, time);
      if (isGap(i)) {
        out.push(i);
      } else if (day !== prevDay) {
        while (g < gaps.length && gaps[g]! <= time - DAY_MS) g++;
        // gaps[g] is the first gap open after `time - DAY_MS`.
        if (!(g < gaps.length && gaps[g]! < time + DAY_MS)) out.push(i);
      }
      prevDay = day;
    }
    return out;
  }

  private lowerBound(timeMs: number): number {
    let low = 0;
    let high = this.points.length;
    while (low < high) {
      const mid = low + ((high - low) >> 1);
      if (this.points[mid]!.time < timeMs) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private edgeStep(side: "left" | "right"): number {
    if (this.expectedStepMs > 0) return this.expectedStepMs;
    const n = this.points.length;
    if (n >= 2) {
      if (side === "left") {
        for (let i = 1; i < n; i++) {
          const step = this.points[i]!.time - this.points[i - 1]!.time;
          if (step > 0) return step;
        }
      } else {
        for (let i = n - 1; i > 0; i--) {
          const step = this.points[i]!.time - this.points[i - 1]!.time;
          if (step > 0) return step;
        }
      }
    }
    // A deterministic non-zero fallback keeps the API finite for a singleton.
    return 1;
  }
}
