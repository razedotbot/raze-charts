// Value formatting for ticks, tooltips, legends, last-value chips and heatmap
// cells.
//
// Two kinds of number formatting are kept apart on purpose:
//
// - Tick labels take their decimals from the tick step (d3's precisionFixed):
//   a 0.0005 step prints 1.0850, 1.0855, ... and never nine copies of "1.1".
// - Value labels (tooltips, chips, heatmap cells) take their decimals from the
//   data: the most decimals any value needs, capped at MAX_VALUE_DECIMALS, so
//   a series quoted to 5 decimals reads 1.08520, not 1.0852 next to 1.08523.
//
// Magnitudes of a million and more switch to compact notation (1.5M, 1.2T)
// so axis gutters and chips stay narrow; value labels keep up to six
// significant digits there (25.0004M), so they never hide the data.
//
// Numbers print in the library's default locale (en-US, DEFAULT_LOCALE in
// src/util/intl.ts) without Intl: digits round exactly as toFixed() rounds
// (integers, the common case for x indices, counts and volumes, go through
// String(); other values use integer arithmetic away from rounding ties) and
// thousands are grouped by hand. That prints what the en-US
// Intl.NumberFormat prints at a fraction of its cost, which matters because
// formatting runs once per hover sample. A locale option for /chart would
// take its cached formatter from src/util/intl.ts.

import type { HeatmapValueFormat } from "./marks";
import type { ChartSpec, XScaleKind } from "./types";

/** Most decimals a value label shows by default. */
export const MAX_VALUE_DECIMALS = 8;
/** Most decimals a tick label may need (a 1e-12 step still gets distinct labels). */
const MAX_TICK_DECIMALS = 12;
/** Magnitudes from here on use compact notation (M/B/T). */
export const COMPACT_THRESHOLD = 1e6;
/** Significant digits a single value keeps when it has no precision of its own, and in compact notation. */
const SIGNIFICANT_DIGITS = 6;

/** English short month names; /chart labels dates in UTC and English. */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COMPACT_UNITS: readonly (readonly [number, string])[] = [[1e12, "T"], [1e9, "B"], [1e6, "M"]];

const POWERS = Array.from({ length: 22 }, (_, exponent) => 10 ** exponent);
const pow10 = (exponent: number): number => POWERS[exponent] ?? 10 ** exponent;

/**
 * Fraction digits needed to write `value` exactly, ignoring binary floating
 * point noise (0.1 + 0.2 needs 1), capped at `cap`.
 */
export function decimalsOf(value: number, cap = MAX_VALUE_DECIMALS): number {
  if (Number.isInteger(value) || !Number.isFinite(value)) return 0;
  const magnitude = Math.abs(value);
  for (let decimals = 0; decimals < cap; decimals++) {
    const scaled = magnitude * pow10(decimals);
    if (Math.abs(scaled - Math.round(scaled)) <= Math.max(1e-7, scaled * 1e-14)) return decimals;
  }
  return cap;
}

/** en-US digit grouping of an unsigned decimal string: "1234567.50" becomes "1,234,567.50". */
function group(digits: string): string {
  const dot = digits.indexOf(".");
  const end = dot < 0 ? digits.length : dot;
  let out = digits.slice(0, end % 3 || 3);
  for (let index = out.length; index < end; index += 3) out += `,${digits.slice(index, index + 3)}`;
  return out + digits.slice(end);
}

/**
 * `value` with exactly `decimals` fraction digits, grouped from 1,000 on,
 * as the en-US Intl.NumberFormat prints it. Never prints "-0.00".
 */
export function formatFixed(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return "";
  const magnitude = Math.abs(value);
  const scaled = magnitude * pow10(decimals);
  let digits = "";
  if (Number.isInteger(magnitude) || scaled >= 1e15) {
    // Integers, and values whose digits reach past a double's precision,
    // print their shortest round-trip digits padded with zeros, like Intl
    // (toFixed() would spell out binary noise, and costs far more).
    digits = String(magnitude);
    const exponent = digits.indexOf("e+");
    if (exponent >= 0) digits = digits.slice(0, exponent).replace(".", "").padEnd(Number(digits.slice(exponent + 2)) + 1, "0");
    const dot = digits.indexOf(".");
    const places = dot < 0 ? 0 : digits.length - dot - 1;
    if (places > decimals) digits = "";
    else if (places < decimals) digits += `${dot < 0 ? "." : ""}${"0".repeat(decimals - places)}`;
  } else if (scaled < 1e9) {
    // Below 1e9 the product is off by under 1.2e-7, so away from a rounding
    // tie it rounds exactly as toFixed() does, at a fraction of the cost.
    const floor = Math.floor(scaled);
    if (Math.abs(scaled - floor - 0.5) > 1e-6) {
      const units = String(scaled - floor > 0.5 ? floor + 1 : floor).padStart(decimals + 1, "0");
      digits = decimals ? `${units.slice(0, -decimals)}.${units.slice(-decimals)}` : units;
    }
  }
  digits ||= magnitude.toFixed(decimals);
  const sign = value < 0 && magnitude >= 0.5 / pow10(decimals) ? "-" : "";
  // 999.5 and up can round to four integer digits ("1,000").
  return sign + (magnitude < 999 ? digits : group(digits));
}

function compactUnit(magnitude: number): readonly [number, string] {
  return COMPACT_UNITS.find((unit) => magnitude >= unit[0]) ?? [1, ""];
}

/**
 * One value in compact notation with up to six significant digits, trailing
 * zeros dropped: 1M, 1.25B, 1.2T, 25.0004M (never 25.00M for 25,000,400).
 * Magnitudes past the trillions stay in T (1,500T).
 */
function formatCompact(value: number): string {
  const [unit, suffix] = compactUnit(Math.abs(value));
  const scaled = value / unit;
  return `${formatFixed(scaled, decimalsOf(scaled, Math.max(0, SIGNIFICANT_DIGITS - String(Math.trunc(Math.abs(scaled))).length)))}${suffix}`;
}

/** Nonzero magnitudes that `decimals` fraction digits would print as zero use three significant digits. */
function formatTiny(value: number): string {
  return String(Number(value.toPrecision(3)));
}

/**
 * Default formatting for a single value, with the value's own precision
 * (at most {@link MAX_VALUE_DECIMALS} decimals), grouping from 1,000 on and
 * compact notation from a million on.
 */
export function formatNum(value: number): string {
  if (!Number.isFinite(value)) return "";
  const magnitude = Math.abs(value);
  if (magnitude >= COMPACT_THRESHOLD) return formatCompact(value);
  if (value !== 0 && magnitude < 1e-6) return formatTiny(value);
  const decimals = decimalsOf(value, MAX_VALUE_DECIMALS + 1);
  if (decimals <= MAX_VALUE_DECIMALS) return formatFixed(value, decimals);
  // A computed float has no precision of its own: six significant digits.
  const integerDigits = magnitude < 1 ? 0 : Math.floor(Math.log10(magnitude)) + 1;
  return formatFixed(value, Math.min(MAX_VALUE_DECIMALS, Math.max(0, SIGNIFICANT_DIGITS - integerDigits)));
}

/** A number, or a Date's instant; NaN for anything else. */
function toNumber(value: unknown): number {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : NaN;
}

/** Formats numbers for display; `(value: number) => string`. */
export type NumberFormatter = (value: number) => string;

/** Extra digits beyond the data span's leading digit shown for continuous data (1/100 of the span). */
const CONTINUOUS_DIGITS = 2;

/**
 * A value formatter with data precision: every value prints with the most
 * decimals any finite value in `values` needs (capped at `cap`), so a series
 * reads uniformly (1.0850, 1.0852, 1.0855).
 *
 * Quoted data (prices, counts, rounded metrics) always fits the cap. Data
 * that does not (computed or sampled floats such as 100.60553987364) has no
 * precision of its own, so it prints at 1/100 of the data span instead of
 * showing binary noise (100.61 for a 99-101 series), never above the cap.
 * Precision is measured lazily on the first call, so an unused formatter
 * costs nothing. `values` may be raw channel values: Dates count by their
 * instant and other non-numbers are skipped, so callers need not copy them.
 */
export function valueFormatter(values: readonly unknown[], cap = MAX_VALUE_DECIMALS): NumberFormatter {
  let decimals = -1;
  const measure = (): number => {
    let most = 0;
    let lo = Infinity;
    let hi = -Infinity;
    let continuous = false;
    for (const raw of values) {
      const value = toNumber(raw);
      if (!Number.isFinite(value)) continue;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
      if (continuous || Math.abs(value) >= COMPACT_THRESHOLD) continue;
      const needed = decimalsOf(value, cap + 1);
      if (needed > cap) continuous = true;
      else if (needed > most) most = needed;
    }
    if (!continuous) return most;
    const span = hi - lo || Math.abs(hi) || 1;
    return Math.max(0, Math.min(cap, Math.ceil(-Math.log10(span)) + CONTINUOUS_DIGITS));
  };
  return (value: number): string => {
    if (!Number.isFinite(value)) return "";
    const magnitude = Math.abs(value);
    if (magnitude >= COMPACT_THRESHOLD) return formatCompact(value);
    if (decimals < 0) decimals = measure();
    if (value !== 0 && magnitude < 0.5 / pow10(decimals)) return formatTiny(value);
    return formatFixed(value, decimals);
  };
}

function allUnique(labels: readonly string[]): boolean {
  return new Set(labels).size === labels.length;
}

/**
 * Labels for numeric ticks. Decimals come from the tick step, so labels are
 * uniform and distinct (step 0.0005 gives 1.0850, 1.0855, ...). When the
 * largest tick reaches a million, every label shares one compact unit
 * (0.4T, 0.8T, 1.2T). Log ticks, which are not evenly stepped, keep three
 * significant digits (more only where needed to stay distinct).
 */
export function numericTickLabels(values: readonly number[], log = false): string[] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return values.map(() => "");
  if (log) {
    for (let digits = 3; digits <= 15; digits++) {
      const labels = values.map((value) => (Number.isFinite(value) ? formatNum(Number(value.toPrecision(digits))) : ""));
      if (allUnique(labels) || digits === 15) return labels;
    }
  }
  let step = Infinity;
  const sorted = [...finite].sort((a, b) => a - b);
  for (let index = 1; index < sorted.length; index++) {
    const gap = sorted[index]! - sorted[index - 1]!;
    if (gap > 0 && gap < step) step = gap;
  }
  const maxMagnitude = Math.max(...finite.map(Math.abs));
  const [unit, suffix] = maxMagnitude >= COMPACT_THRESHOLD ? compactUnit(maxMagnitude) : [1, ""] as const;
  let decimals = Number.isFinite(step)
    ? decimalsOf(step / unit, MAX_TICK_DECIMALS)
    : decimalsOf(finite[0]! / unit, MAX_VALUE_DECIMALS);
  for (;;) {
    const labels = values.map((value) => {
      if (!Number.isFinite(value)) return "";
      if (value === 0 && suffix) return "0";
      return `${formatFixed(value / unit, decimals)}${suffix}`;
    });
    if (allUnique(labels) || decimals >= MAX_TICK_DECIMALS) return labels;
    decimals++;
  }
}

// ---------------------------------------------------------------------------
// Dates

export const pad2 = (value: number): string => (value < 10 ? `0${value}` : String(value));

/** Finest calendar unit that distinguishes the given instants (UTC). */
type TimeResolution = "day" | "hour" | "minute" | "second" | "millisecond";

function timeResolution(times: readonly number[]): TimeResolution {
  let resolution: TimeResolution = "day";
  for (const time of times) {
    if (!Number.isFinite(time)) continue;
    if (time % 1000 !== 0) return "millisecond";
    if (time % 60_000 !== 0) resolution = "second";
    else if (resolution !== "second" && time % 3_600_000 !== 0) resolution = "minute";
    else if (resolution === "day" && time % 86_400_000 !== 0) resolution = "hour";
  }
  return resolution;
}

/**
 * Tooltip/crosshair formatter for instants: "9 Sep", plus the year when the
 * data span more than one calendar year, plus the clock ("14:30",
 * "14:30:05", "14:30:05.250") when the data carry a time of day. UTC, like
 * the time axis.
 */
export function timeValueFormatter(times: readonly number[]): (value: unknown) => string {
  const finite = times.filter(Number.isFinite);
  const resolution = timeResolution(finite);
  let lo = Infinity;
  let hi = -Infinity;
  for (const time of finite) {
    if (time < lo) lo = time;
    if (time > hi) hi = time;
  }
  const showYear = finite.length > 0 && new Date(lo).getUTCFullYear() !== new Date(hi).getUTCFullYear();
  return (value: unknown): string => {
    const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : NaN;
    const date = new Date(time);
    if (!Number.isFinite(time) || Number.isNaN(date.getTime())) return String(value ?? "");
    let out = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
    if (showYear) out += ` ${date.getUTCFullYear()}`;
    if (resolution !== "day") {
      out += ` ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
      if (resolution === "second" || resolution === "millisecond") out += `:${pad2(date.getUTCSeconds())}`;
      if (resolution === "millisecond") out += `.${String(date.getUTCMilliseconds()).padStart(3, "0")}`;
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Heatmap values

export const HEATMAP_VALUE_FORMATS = ["number", "percent", "signed", "signed-percent"] as const;

/**
 * Formatter for heatmap cell labels, tooltips and the colour bar. Presets
 * share the data precision of `values`: "number" (default) prints 1,234.5,
 * "percent" 12.5%, "signed" +12.5 / -3.0, "signed-percent" +12.5%. A
 * function receives the raw value and must return a string.
 */
export function heatmapValueFormatter(format: HeatmapValueFormat | undefined, values: readonly number[]): NumberFormatter {
  if (typeof format === "function") {
    return (value: number): string => {
      const label: unknown = format(value);
      if (typeof label !== "string") {
        throw new TypeError(`heatmap valueFormat must return a string; received ${typeof label} for ${value}.`);
      }
      return label;
    };
  }
  const base = valueFormatter(values);
  const preset = format ?? "number";
  const signed = preset === "signed" || preset === "signed-percent";
  const suffix = preset === "percent" || preset === "signed-percent" ? "%" : "";
  return (value: number): string => {
    if (!Number.isFinite(value)) return "";
    const body = base(signed ? Math.abs(value) : value);
    // A value that rounds to zero prints unsigned ("0.0", never "+0.0").
    const sign = signed && /[1-9]/.test(body) ? (value > 0 ? "+" : "-") : "";
    return `${sign}${body}${suffix}`;
  };
}

// ---------------------------------------------------------------------------
// Axis formatters

export interface AxisFormatters {
  /** Formats X values for tooltips, chips and rule labels; honors scales.x.tickFormat. */
  formatX(value: unknown): string;
  /** Formats Y values for tooltips, chips and rule labels; honors scales.y.tickFormat. */
  formatY(value: unknown): string;
  /**
   * Formats a computed Y value that is not in the data (a radar ring label):
   * as {@link AxisFormatters.formatY}, except that without a tickFormat a
   * number keeps its own precision, so the data's precision never rounds it
   * (the 2.5 ring over integer data reads 2.5, not 3).
   */
  formatYValue(value: unknown): string;
}

/** The data each axis formats, for data-precision value labels. */
export interface AxisFormatterData {
  xValues: readonly unknown[];
  yValues: readonly number[];
  /** The Y axis is a band of categories (heatmap rows): numbers print as-is, like its ticks. */
  yBand?: boolean;
}

/**
 * Value formatters for both axes. A configured `tickFormat` wins; otherwise
 * numbers use data precision, instants use {@link timeValueFormatter}, and
 * categories print as-is.
 */
export function axisFormatters(spec: ChartSpec, xType: XScaleKind, data?: AxisFormatterData): AxisFormatters {
  const xTickFormat = spec.scales?.x?.tickFormat;
  const yTickFormat = spec.scales?.y?.tickFormat;
  const xNumbers = (): number[] => (data?.xValues ?? []).map(toNumber);
  let formatXNumber: NumberFormatter | null = null;
  let formatXTime: ((value: unknown) => string) | null = null;
  let formatYNumber: NumberFormatter | null = null;
  const formatters: AxisFormatters = {
    formatX: (value: unknown): string => {
      if (xTickFormat) return xTickFormat(value);
      if (xType === "time") return (formatXTime ??= timeValueFormatter(xNumbers()))(value);
      if (value instanceof Date) return (formatXTime ??= timeValueFormatter(xNumbers()))(value);
      if (typeof value === "number") {
        if (xType === "band") return String(value);
        return (formatXNumber ??= valueFormatter(data?.xValues ?? []))(value);
      }
      return String(value ?? "");
    },
    formatY: (value: unknown): string => {
      if (yTickFormat) return yTickFormat(value);
      if (typeof value === "number" && !data?.yBand) return (formatYNumber ??= valueFormatter(data?.yValues ?? []))(value);
      return String(value ?? "");
    },
    formatYValue: (value: unknown): string => (
      !yTickFormat && typeof value === "number" && !data?.yBand ? formatNum(value) : formatters.formatY(value)
    ),
  };
  return formatters;
}
