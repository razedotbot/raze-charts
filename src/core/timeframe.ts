/**
 * Parse a TradingView-shaped `timeframe` into a unix-second window.
 *
 * Accepted shapes (every TradingView spelling plus the legacy Raze one):
 *
 * - a period string: `"3M"`, `"12M"`, `"5D"`, `"1W"`, `"1Y"`, `"YTD"`, `"ALL"`;
 * - a range string: `"1700000000,1700086400"` (unix seconds or dates);
 * - `{ from, to }`, TradingView's `VisibleTimeRange`;
 * - `{ type: "time-range", from, to }`;
 * - `{ type: "period-back", value: "3M" }`;
 * - `{ type: "time-range", value: "from,to" }` (legacy Raze shape).
 *
 * Malformed input never throws: the resolver returns `null`, and
 * `describeTimeframeProblem()` says why so the widget can warn once.
 */

import type { WidgetTimeframe } from "../types/charting_library";

export interface ResolvedTimeframe {
  from: number;
  to: number;
  all?: boolean;
}

const DAY = 86_400;

function periodSeconds(token: string): number | "ytd" | "all" | null {
  const raw = token.trim().toUpperCase();
  if (!raw) return null;
  if (raw === "ALL" || raw === "MAX") return "all";
  if (raw === "YTD") return "ytd";
  const match = raw.match(/^(\d+)([SMHDWY])$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!(n > 0)) return null;
  const unit = match[2]!;
  if (unit === "S") return n;
  if (unit === "H") return n * 3600;
  if (unit === "D") return n * DAY;
  if (unit === "W") return n * 7 * DAY;
  if (unit === "M") return n * 30 * DAY;
  return n * 365 * DAY; // "Y"
}

/** Unix seconds from a number or a numeric/date string; null when unusable. */
function toSeconds(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!token) return null;
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  const ms = Date.parse(token);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function orderedRange(from: number | null, to: number | null): ResolvedTimeframe | null {
  if (from === null || to === null) return null;
  return from <= to ? { from, to } : { from: to, to: from };
}

function parsePair(value: string): ResolvedTimeframe | null {
  const parts = value.split(",");
  if (parts.length !== 2) return null;
  return orderedRange(toSeconds(parts[0]), toSeconds(parts[1]));
}

function resolvePeriod(value: string, nowSec: number): ResolvedTimeframe | null {
  const period = periodSeconds(value);
  if (period === null) return null;
  if (period === "all") return { from: 0, to: nowSec, all: true };
  if (period === "ytd") {
    const date = new Date(nowSec * 1000);
    const from = Math.floor(Date.UTC(date.getUTCFullYear(), 0, 1) / 1000);
    return { from: Math.min(from, nowSec), to: nowSec };
  }
  return { from: nowSec - period, to: nowSec };
}

function resolveString(value: string, nowSec: number): ResolvedTimeframe | null {
  return value.includes(",") ? parsePair(value) : resolvePeriod(value, nowSec) ?? parsePair(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveTimeframe(
  timeframe: WidgetTimeframe | null | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): ResolvedTimeframe | null {
  if (timeframe == null) return null;
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  const input: unknown = timeframe;
  if (typeof input === "string") return resolveString(input, now);
  if (!isRecord(input)) return null;

  const type = input.type;
  if (type !== undefined && type !== "period-back" && type !== "time-range") return null;
  // `{ from, to }` (TradingView VisibleTimeRange / TimeFrameTimeRange).
  if (type !== "period-back" && ("from" in input || "to" in input)) {
    return orderedRange(toSeconds(input.from), toSeconds(input.to));
  }
  const value = input.value;
  if (typeof value !== "string") return null;
  if (type === "time-range") return parsePair(value);
  if (type === "period-back") return resolvePeriod(value, now);
  return resolveString(value, now);
}

/**
 * Why `timeframe` cannot be applied, or null when it resolves. Used to warn
 * about an option that would otherwise be ignored silently.
 */
export function describeTimeframeProblem(timeframe: unknown): string | null {
  if (timeframe == null) return null;
  if (resolveTimeframe(timeframe as WidgetTimeframe) !== null) return null;
  let shown: string;
  try {
    shown = JSON.stringify(timeframe) ?? String(timeframe);
  } catch {
    shown = String(timeframe);
  }
  return `timeframe ${shown} is not supported; the default range is used. `
    + 'Use a period ("3M", "YTD", "ALL"), { from, to } in unix seconds, or a TimeFrameValue.';
}

export const TIMEFRAME_PRESETS = ["1D", "1W", "1M", "3M", "YTD", "ALL"] as const;
export type TimeframePreset = (typeof TIMEFRAME_PRESETS)[number];
