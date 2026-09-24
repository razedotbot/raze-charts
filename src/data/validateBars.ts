// Bar validation for datafeed input (history pages and live ticks).
//
// Datafeed mistakes otherwise render silently wrong charts: seconds instead of
// milliseconds put every bar in 1970, numeric strings from JSON leave the
// legend blank, NaN OHLC poisons autoscale and study math, and an inverted
// high/low draws a full-height wick. validateBars() drops what cannot be drawn,
// keeps what can, and summarises each problem class so the caller can warn
// once with the offending field and the first bad index. With `coerce`, the
// unambiguous mistakes are repaired instead.

import type { Bar } from "../types/charting_library";

/** A class of datafeed mistake. Each class is reported at most once per request. */
export type BarProblem =
  /** Not an object: dropped. */
  | "shape"
  /** Missing or non-finite `time`: dropped. */
  | "time"
  /** A numeric string where a number belongs: dropped unless coerced. */
  | "string"
  /** Missing, non-numeric or non-finite open/high/low/close: dropped. */
  | "ohlc"
  /** `time` below 1e11, which reads as seconds: kept unless coerced to ms. */
  | "seconds"
  /** `low` above `high`: kept unless coerced (swapped). */
  | "range"
  /** Non-finite `volume`: the bar is kept without its volume. */
  | "volume";

export interface BarIssue {
  readonly problem: BarProblem;
  /** Bars affected in this batch. */
  count: number;
  /** Index (in the batch as delivered) of the first affected bar. */
  readonly index: number;
  /** Field of the first affected bar (for example "high"). */
  readonly field: string;
  /** Offending value of the first affected bar. */
  readonly value: unknown;
  /** True when `coerce` repaired the bars instead of dropping or keeping them. */
  readonly repaired: boolean;
}

export interface ValidatedBars {
  /** Bars that can be drawn, in delivery order. Untouched bars keep their identity. */
  bars: Bar[];
  /** One entry per problem class found, in first-seen order. */
  issues: BarIssue[];
}

/** Times below this many milliseconds (1973-03-03) are assumed to be seconds. */
export const SECONDS_THRESHOLD = 1e11;

const NUMERIC_FIELDS = ["time", "open", "high", "low", "close"] as const;
type NumericField = (typeof NUMERIC_FIELDS)[number];

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isNumericString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));

class IssueLog {
  readonly list: BarIssue[] = [];
  private readonly byProblem = new Map<BarProblem, BarIssue>();
  /** Last bar index counted per problem, so several bad fields count one bar. */
  private readonly lastIndex = new Map<BarProblem, number>();

  add(problem: BarProblem, index: number, field: string, value: unknown, repaired = false): void {
    const existing = this.byProblem.get(problem);
    if (existing) {
      if (this.lastIndex.get(problem) !== index) existing.count += 1;
      this.lastIndex.set(problem, index);
      return;
    }
    this.lastIndex.set(problem, index);
    const issue: BarIssue = { problem, count: 1, index, field, value, repaired };
    this.byProblem.set(problem, issue);
    this.list.push(issue);
  }
}

/**
 * Validate a batch of bars. Drops bars that cannot be drawn and reports every
 * problem class once with its count, field and first index.
 */
export function validateBars(batch: readonly unknown[], coerce = false): ValidatedBars {
  const out: Bar[] = [];
  const log = new IssueLog();
  for (let i = 0; i < batch.length; i++) {
    const bar = validateBar(batch[i], i, coerce, log);
    if (bar) out.push(bar);
  }
  return { bars: out, issues: log.list };
}

function validateBar(raw: unknown, index: number, coerce: boolean, log: IssueLog): Bar | null {
  if (raw === null || typeof raw !== "object") {
    log.add("shape", index, "bar", raw);
    return null;
  }
  const source = raw as Record<string, unknown>;
  // Fast path: a well-formed bar is returned as-is without allocating.
  const { time, open, high, low, close, volume } = source;
  if (
    finite(time) && finite(open) && finite(high) && finite(low) && finite(close)
    && (volume === undefined || volume === null || finite(volume))
    && !(time >= 0 && time < SECONDS_THRESHOLD)
    && low <= high
  ) {
    return raw as Bar;
  }

  let patch: Partial<Record<NumericField | "volume", number | undefined>> | null = null;
  const values = {} as Record<NumericField, number>;

  for (const field of NUMERIC_FIELDS) {
    const value = source[field];
    if (finite(value)) {
      values[field] = value;
      continue;
    }
    if (isNumericString(value)) {
      if (!coerce) {
        log.add("string", index, field, value);
        return null;
      }
      values[field] = Number(value);
      (patch ??= {})[field] = values[field];
      log.add("string", index, field, value, true);
      continue;
    }
    log.add(field === "time" ? "time" : "ohlc", index, field, value);
    return null;
  }

  if (volume !== undefined && volume !== null && !finite(volume)) {
    if (isNumericString(volume)) {
      if (!coerce) {
        log.add("string", index, "volume", volume);
        return null;
      }
      (patch ??= {}).volume = Number(volume);
      log.add("string", index, "volume", volume, true);
    } else {
      (patch ??= {}).volume = undefined;
      log.add("volume", index, "volume", volume);
    }
  }

  if (values.time >= 0 && values.time < SECONDS_THRESHOLD) {
    log.add("seconds", index, "time", values.time, coerce);
    if (coerce) (patch ??= {}).time = values.time * 1000;
  }

  if (values.low > values.high) {
    log.add("range", index, "low", { low: values.low, high: values.high }, coerce);
    if (coerce) {
      patch ??= {};
      patch.high = values.low;
      patch.low = values.high;
    }
  }

  if (!patch) return raw as Bar;
  const bar = { ...source, ...patch } as Record<string, unknown>;
  if ("volume" in patch && patch.volume === undefined) delete bar.volume;
  return bar as unknown as Bar;
}

const show = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return typeof value;
};

const countBars = (n: number): string => `${n} bar${n === 1 ? "" : "s"}`;

/**
 * One actionable sentence for an issue. `origin` names the datafeed call, for
 * example "getBars" or "subscribeBars".
 */
export function describeBarIssue(issue: BarIssue, origin: string): string {
  const at = `${origin} bar ${issue.index}`;
  const n = countBars(issue.count);
  const value = show(issue.value);
  const repair = issue.repaired ? " (raze.coerce_bars)" : "; or set raze.coerce_bars: true";
  switch (issue.problem) {
    case "shape":
      return `[raze-charts] ${at} is not a Bar object; dropped ${n}.`;
    case "time":
    case "ohlc":
      return `[raze-charts] ${at}: Bar.${issue.field} ${value} is not a finite number; dropped ${n}.`;
    case "string":
      return issue.repaired
        ? `[raze-charts] ${at}: Bar.${issue.field} is the string ${value}; converted ${n}${repair}.`
        : `[raze-charts] ${at}: Bar.${issue.field} is the string ${value}, not a number; dropped ${n}. Use Number()${repair}.`;
    case "seconds":
      return `[raze-charts] Bar.time looks like seconds; expected milliseconds (${at}: ${value}, ${n}). `
        + (issue.repaired ? `Multiplied by 1000${repair}.` : `Multiply by 1000${repair}.`);
    case "range": {
      const { low, high } = issue.value as { low: number; high: number };
      return `[raze-charts] ${at}: Bar.low ${low} is above Bar.high ${high} (${n}). `
        + (issue.repaired ? `Swapped${repair}.` : `Swap them${repair}.`);
    }
    case "volume":
      return `[raze-charts] ${at}: Bar.volume ${value} is not a finite number; removed from ${n}.`;
  }
}
