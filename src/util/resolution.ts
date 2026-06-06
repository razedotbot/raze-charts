// Resolution parsing. TradingView resolution strings:
//   "30"  → 30 minutes      "1S" → 1 second
//   "1D"  → 1 day           "1W" → 1 week        "1M" → 1 month (approx)
// A bare number is minutes. Suffix S=seconds, D=day, W=week, M=month.

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

export function parseResolution(res: string): ParsedResolution {
  const s = String(res).trim().toUpperCase();
  const m = s.match(/^(\d+)\s*([SDWM]?)$/);
  if (!m) {
    // Fallback: treat as 1 minute so we never produce ms<=0.
    return { ms: MIN, kind: "minutes", amount: 1 };
  }
  const amount = Math.max(1, parseInt(m[1]!, 10) || 1);
  const unit = m[2] || ""; // empty = minutes
  switch (unit) {
    case "S":
      return { ms: amount * 1000, kind: "seconds", amount };
    case "D":
      return { ms: amount * DAY, kind: "days", amount };
    case "W":
      return { ms: amount * 7 * DAY, kind: "weeks", amount };
    case "M":
      return { ms: amount * 30 * DAY, kind: "months", amount };
    default: {
      // minutes — promote to "hours" kind at >= 60 for nicer axis labels
      const ms = amount * MIN;
      return { ms, kind: amount >= 60 && amount % 60 === 0 ? "hours" : "minutes", amount };
    }
  }
}

export function resolutionToMs(res: string): number {
  return parseResolution(res).ms;
}

/** Floor a unix-ms timestamp to its bar boundary for the given resolution. */
export function floorToBar(timeMs: number, res: string): number {
  const ms = resolutionToMs(res);
  return Math.floor(timeMs / ms) * ms;
}

/** Human label for the resolution, e.g. "1m", "1h", "1D". */
export function resolutionLabel(res: string): string {
  const p = parseResolution(res);
  switch (p.kind) {
    case "seconds": return `${p.amount}s`;
    case "minutes": return `${p.amount}m`;
    case "hours":   return `${p.amount / 60}h`;
    case "days":    return `${p.amount}D`;
    case "weeks":   return `${p.amount}W`;
    case "months":  return `${p.amount}M`;
  }
}
