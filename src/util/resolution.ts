// Resolution parsing. TradingView resolution strings:
//   "30"  → 30 minutes      "1S" → 1 second       "240" → 4 hours
//   "1D"  → 1 day           "1W" → 1 week         "1M"  → 1 calendar month
//   "D", "W", "M" are shorthand for "1D", "1W" and "1M".
// A bare number is minutes. Suffix S=seconds, D=day, W=week, M=month.
//
// Parsing is strict: anything else throws a RangeError that names the value
// and lists the accepted forms, so a typo such as "4h" can never silently
// become a one-minute chart.

import { floorToCalendar, getTimeZone, type TickUnit } from "./time";

export interface ParsedResolution {
  /** Normalised milliseconds-per-bar (months use a 30-day approximation). */
  ms: number;
  kind: "seconds" | "minutes" | "hours" | "days" | "weeks" | "months";
  /** Numeric multiplier (the "5" in "5S" or "5"). */
  amount: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Human-readable list of every accepted resolution form, used in errors. */
export const RESOLUTION_FORMS =
  '"<n>S" seconds (e.g. "1S", "30S"), "<n>" minutes (e.g. "1", "15", "240" for 4 hours), '
  + '"<n>D" or "D" days, "<n>W" or "W" weeks, "<n>M" or "M" months (e.g. "3M", "12M")';

const PATTERN = /^(\d*)([SDWMsdw]?)$/;
const cache = new Map<string, { parsed: ParsedResolution; canonical: string }>();
const CACHE_LIMIT = 64;

function invalid(value: unknown, hint?: string): RangeError {
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  return new RangeError(
    `[raze-charts] invalid resolution ${shown}.${hint ? ` ${hint}` : ""} Accepted forms: ${RESOLUTION_FORMS}.`,
  );
}

/** Explain the most common mistakes before listing the accepted forms. */
function hintFor(text: string): string | undefined {
  const hours = text.match(/^(\d*)\s*[hH]$/);
  if (hours) {
    const n = Math.max(1, Number(hours[1] || "1"));
    return `Hours are written in minutes: use "${n * 60}" for ${n} hour${n === 1 ? "" : "s"}.`;
  }
  if (/^\d*m$/.test(text)) {
    const n = text.slice(0, -1) || "1";
    return `Lower-case "m" is ambiguous: use "${n}" for ${n} minute(s) or "${n}M" for ${n} month(s).`;
  }
  if (/^\d*[tT]$/.test(text)) return "Tick resolutions are not supported.";
  if (/^\d*[yY]$/.test(text)) {
    const n = Math.max(1, Number(text.slice(0, -1) || "1"));
    return `Years are written in months: use "${n * 12}M".`;
  }
  if (/^0+[SDWMsdw]?$/.test(text)) return "The multiplier must be a positive integer.";
  return undefined;
}

function parse(res: unknown): { parsed: ParsedResolution; canonical: string } {
  if (typeof res === "number" && Number.isInteger(res) && res > 0) res = String(res);
  if (typeof res !== "string") throw invalid(res, "A resolution must be a string.");
  const hit = cache.get(res);
  if (hit) return hit;

  const text = res.trim();
  const m = text.match(PATTERN);
  if (!m || (m[1] === "" && m[2] === "")) throw invalid(res, hintFor(text));
  const unit = m[2]!.toUpperCase();
  // Bare "S" has no TradingView meaning; every other bare unit means 1.
  if (m[1] === "" && unit === "S") throw invalid(res, 'Use "1S" for one second.');
  const amount = m[1] === "" ? 1 : Number(m[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) throw invalid(res, hintFor(text));

  let parsed: ParsedResolution;
  switch (unit) {
    case "S":
      parsed = { ms: amount * 1000, kind: "seconds", amount };
      break;
    case "D":
      parsed = { ms: amount * DAY, kind: "days", amount };
      break;
    case "W":
      parsed = { ms: amount * 7 * DAY, kind: "weeks", amount };
      break;
    case "M":
      parsed = { ms: amount * 30 * DAY, kind: "months", amount };
      break;
    default:
      // Minutes, promoted to the "hours" kind at whole hours for axis labels.
      parsed = { ms: amount * MIN, kind: amount >= 60 && amount % 60 === 0 ? "hours" : "minutes", amount };
  }
  const entry = { parsed, canonical: `${amount}${unit}` };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(res, entry);
  return entry;
}

/**
 * Parse a TradingView resolution string. Throws a RangeError naming the value
 * and listing {@link RESOLUTION_FORMS} for anything else (for example "1H",
 * "4h", "1T" or "").
 */
export function parseResolution(res: string): ParsedResolution {
  const { parsed } = parse(res);
  return { ...parsed };
}

/**
 * Canonical spelling of a resolution: "D" → "1D", "w" → "1W", " 15 " → "15".
 * Minute resolutions stay in minutes ("60" is not rewritten to "1H", which
 * TradingView does not accept). Throws like {@link parseResolution}.
 */
export function normalizeResolution(res: string): string {
  return parse(res).canonical;
}

/** True when {@link parseResolution} accepts `res`. */
export function isValidResolution(res: unknown): boolean {
  try {
    parse(res);
    return true;
  } catch {
    return false;
  }
}

export function resolutionToMs(res: string): number {
  return parse(res).parsed.ms;
}

export interface FloorToBarOptions {
  /**
   * IANA zone the bar boundaries are aligned in (for example the symbol's
   * `timezone`). Defaults to UTC. Daily, weekly and monthly bars start at local
   * midnight in this zone, across DST changes.
   */
  timezone?: string | null;
  /** First day of a weekly bar: 0 = Sunday … 6 = Saturday. Defaults to 1 (Monday, ISO). */
  weekStart?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Floor a unix-ms timestamp to the start of the bar that contains it.
 *
 * Seconds, minutes and hours align to the epoch in wall time. `1D` floors to
 * midnight, `nD` to epoch-aligned n-day buckets, `1W` to Monday 00:00 (see
 * `weekStart`), and `1M`, `3M` and `12M` to calendar months, quarters and
 * years. Every boundary is computed in `options.timezone` (UTC by default).
 */
export function floorToBar(timeMs: number, res: string, options: FloorToBarOptions = {}): number {
  const { parsed } = parse(res);
  const zone = options.timezone ?? null;
  const [unit, step] = calendarStep(parsed);
  const start = floorToCalendar(timeMs, unit, step, zone, options.weekStart);
  if (zone === null || !Number.isFinite(start)) return start;
  // In a repeated wall hour (DST fall-back) the calendar floor resolves the
  // wall start to its first occurrence; a bar that opened at the second
  // occurrence starts one offset change later and still contains `timeMs`.
  const tz = getTimeZone(zone);
  const later = tz.fromWall(tz.toWall(start), "later");
  return later > start && later <= timeMs ? later : start;
}

function calendarStep(parsed: ParsedResolution): [TickUnit, number] {
  switch (parsed.kind) {
    case "seconds": return ["second", parsed.amount];
    case "minutes":
    case "hours": return ["minute", parsed.amount];
    // floorToCalendar's multi-day steps count days of the month (a tick
    // rule); n-day bars are plain epoch-aligned day buckets, which a 24n-hour
    // wall-time step gives exactly.
    case "days": return parsed.amount === 1 ? ["day", 1] : ["hour", 24 * parsed.amount];
    case "weeks": return ["week", parsed.amount];
    case "months": return ["month", parsed.amount];
  }
}

/** Human label for the resolution, e.g. "1m", "1h", "1D". Throws like {@link parseResolution}. */
export function resolutionLabel(res: string): string {
  const p = parse(res).parsed;
  switch (p.kind) {
    case "seconds": return `${p.amount}s`;
    case "minutes": return `${p.amount}m`;
    case "hours":   return `${p.amount / 60}h`;
    case "days":    return `${p.amount}D`;
    case "weeks":   return `${p.amount}W`;
    case "months":  return `${p.amount}M`;
  }
}
