/** Parse TradingView-shaped `options.timeframe` into a unix-second window. */

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
  const unit = match[2]!;
  if (unit === "S") return Math.max(1, n);
  if (unit === "H") return n * 3600;
  if (unit === "D") return n * DAY;
  if (unit === "W") return n * 7 * DAY;
  if (unit === "M") return n * 30 * DAY;
  if (unit === "Y") return n * 365 * DAY;
  return null;
}

function parsePair(value: string): { from: number; to: number } | null {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 2) return null;
  const parse = (token: string): number | null => {
    if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
    const ms = Date.parse(token);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  };
  const from = parse(parts[0]!);
  const to = parse(parts[1]!);
  if (from == null || to == null) return null;
  return from <= to ? { from, to } : { from: to, to: from };
}

export function resolveTimeframe(
  timeframe: string | { value: string; type: "period-back" | "time-range" } | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): ResolvedTimeframe | null {
  if (timeframe == null) return null;
  const value = typeof timeframe === "string" ? timeframe : timeframe.value;
  const type = typeof timeframe === "string"
    ? (value.includes(",") ? "time-range" : "period-back")
    : timeframe.type;

  if (type === "time-range") {
    const pair = parsePair(value);
    return pair ? { ...pair } : null;
  }

  const period = periodSeconds(value);
  if (period === null) {
    const pair = parsePair(value);
    return pair ? { ...pair } : null;
  }
  if (period === "all") return { from: 0, to: nowSec, all: true };
  if (period === "ytd") {
    const date = new Date(nowSec * 1000);
    const from = Math.floor(Date.UTC(date.getUTCFullYear(), 0, 1) / 1000);
    return { from, to: nowSec };
  }
  return { from: nowSec - period, to: nowSec };
}

export const TIMEFRAME_PRESETS = ["1D", "1W", "1M", "3M", "YTD", "ALL"] as const;
export type TimeframePreset = (typeof TIMEFRAME_PRESETS)[number];
