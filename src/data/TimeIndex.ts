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
   * always opens one: an overnight or weekend close, a daily maintenance
   * break or an outage. With `timeZone`, intraday bars also break at each
   * local midnight of that zone inside a round-the-clock session: a gap-free
   * run of bars that spans more than a day, such as a forex week or 24x7
   * crypto between two outages. A session of a day or less (a 6.5 h equity
   * session across Tokyo midnight, a 23 h futures session) breaks only at its
   * open. A session cut off by the start or end of the loaded bars is judged
   * by its neighbour across the gap, and counts as round-the-clock when no
   * gap is near enough to judge by. Daily and coarser bars only break at gaps.
   *
   * `from` / `to` (inclusive, fractional allowed) limit the result to a
   * logical range. Judging a session reads at most about two days of bars
   * beyond the range.
   */
  sessionBreaks(options: SessionBreakOptions = {}): number[] {
    const points = this.points;
    const n = points.length;
    if (n < 2 || this.expectedStepMs <= 0) return [];
    let zone = options.timeZone == null
      ? null
      : typeof options.timeZone === "string" ? getTimeZone(options.timeZone) : options.timeZone;
    for (const key of ["from", "to"] as const) {
      const value = options[key];
      if (value !== undefined && !Number.isFinite(value)) {
        throw new RangeError(`sessionBreaks() ${key} must be a finite logical index; received ${value}.`);
      }
    }
    if (this.expectedStepMs >= DAY_MS) zone = null;
    const first = Math.max(1, Math.floor(options.from ?? 1));
    const last = Math.min(n - 1, Math.ceil(options.to ?? n - 1));
    const out: number[] = [];
    let prevDay = zone && first <= last ? localDay(zone, points[first - 1]!.time) : 0;
    // Whether the session the walk is in runs round the clock; judged at its first midnight.
    let roundTheClock: boolean | undefined;
    for (let i = first; i <= last; i++) {
      const day = zone ? localDay(zone, points[i]!.time) : 0;
      if (this.isGap(i)) {
        out.push(i);
        roundTheClock = undefined;
      } else if (day !== prevDay) {
        if (roundTheClock === undefined) roundTheClock = this.isRoundTheClock(i);
        if (roundTheClock) out.push(i);
      }
      prevDay = day;
    }
    return out;
  }

  /** `true` when more than 1.6 bar steps separate bar `i` from the bar before it. */
  private isGap(i: number): boolean {
    return this.points[i]!.time - this.points[i - 1]!.time > this.expectedStepMs * 1.6;
  }

  /**
   * The last bar reached walking from bar `i` in direction `dir` without
   * crossing a gap. The walk stops early at the first bar more than `limit`
   * ms away from bar `i`.
   */
  private reach(i: number, dir: 1 | -1, limit: number): number {
    const points = this.points;
    let k = i;
    for (let next = k + dir; next >= 0 && next < points.length; next += dir) {
      if (Math.abs(points[k]!.time - points[i]!.time) > limit || this.isGap(dir > 0 ? next : k)) break;
      k = next;
    }
    return k;
  }

  /**
   * Whether the session holding bars `i - 1` and `i` runs round the clock:
   * it spans more than a day (plus two bar steps of slack). A session cut
   * off by the edge of the loaded bars takes the verdict of its neighbour
   * across the gap; with no complete neighbour it counts as round-the-clock.
   */
  private isRoundTheClock(i: number): boolean {
    const points = this.points;
    const last = points.length - 1;
    const long = DAY_MS + 2 * this.expectedStepMs;
    const spansDay = (a: number, b: number): boolean => Math.abs(points[b]!.time - points[a]!.time) > long;
    const start = this.reach(i - 1, -1, long);
    if (spansDay(start, i - 1)) return true;
    const end = this.reach(start, 1, long);
    if (spansDay(start, end)) return true;
    if (start > 0 && end < last) return false;
    // An edge session: its neighbour across the gap decides.
    if (start > 0) {
      const neighbour = this.reach(start - 1, -1, long);
      return spansDay(neighbour, start - 1) || neighbour === 0;
    }
    if (end < last) {
      const neighbour = this.reach(end + 1, 1, long);
      return spansDay(end + 1, neighbour) || neighbour === last;
    }
    return true;
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
