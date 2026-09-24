/**
 * DST-correct IANA time-zone arithmetic without dependencies.
 *
 * Every conversion goes through "wall milliseconds": a UTC timestamp shifted
 * by the zone offset so that its `getUTC*` fields (or {@link civilFromDays})
 * read the local calendar date and clock time. Wall time has no DST — every
 * wall day is exactly 86 400 000 ms — which makes calendar flooring and
 * boundary detection plain integer math. Converting a wall time back to an
 * instant ({@link TimeZone.fromWall}) resolves skipped and repeated local
 * times with Temporal's disambiguation rules.
 *
 * Offsets come from a cached `Intl.DateTimeFormat#formatToParts` and are
 * memoised per UTC day. A day whose start and end offsets differ is searched
 * to the exact second of its transition(s), so a lookup is a Map hit plus one
 * comparison and the result is independent of the process time zone (`TZ`).
 *
 * Instants outside the ECMAScript Date range ({@link MAX_DATE_MS}, about
 * 273,790 years either side of 1970) have no offset: `offset`, `toWall` and
 * `fromWall` return `NaN` for them, like `new Date(9e15).getTime()`.
 */

import { dateTimeFormat } from "../intl";

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Largest instant a `Date` can hold, in either direction (±8.64e15 ms). */
export const MAX_DATE_MS = 8.64e15;

/** `true` for a finite instant inside the Date range. */
function inDateRange(utcMs: number): boolean {
  return utcMs >= -MAX_DATE_MS && utcMs <= MAX_DATE_MS;
}

/** Clamp an Intl probe instant into the Date range (formatToParts throws outside it). */
function clampToDateRange(utcMs: number): number {
  return Math.min(MAX_DATE_MS, Math.max(-MAX_DATE_MS, utcMs));
}

/** Canonical id used for UTC throughout the library (TradingView spelling). */
export const UTC_ZONE_ID = "Etc/UTC";

/** How {@link TimeZone.fromWall} resolves a local time that is skipped or repeated by a transition. */
export type Disambiguation = "compatible" | "earlier" | "later" | "reject";

/** Local calendar fields of an instant. `month` is 0-based like `Date`; `weekday` is 0 = Sunday. */
export interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: number;
}

export interface TimeZone {
  /** Canonical IANA id as resolved by Intl (for example "America/New_York" or "UTC"). */
  readonly id: string;
  /** Offset in milliseconds when the zone never changes offset (UTC, Etc/GMT±N, ±HH:MM), else `null`. */
  readonly fixedOffset: number | null;
  /** Milliseconds to add to a UTC instant to obtain its local wall time. `NaN` outside the Date range. */
  offset(utcMs: number): number;
  /** UTC instant → wall milliseconds (read the fields with `getUTC*` or {@link civilFromDays}). */
  toWall(utcMs: number): number;
  /**
   * Wall milliseconds → UTC instant, resolving DST gaps and overlaps with
   * `disambiguation` (default "compatible"). `NaN` when the instant would lie
   * outside the Date range.
   */
  fromWall(wallMs: number, disambiguation?: Disambiguation): number;
  /** Local calendar fields of a UTC instant. */
  wallParts(utcMs: number): WallParts;
}

// ---------------------------------------------------------------------------
// Proleptic Gregorian day arithmetic (Howard Hinnant's civil algorithms).
// These avoid Date allocations in hot loops and, unlike Date.UTC, treat years
// 0-99 literally instead of mapping them to 1900-1999.
// ---------------------------------------------------------------------------

/** Days since 1970-01-01 for a proleptic Gregorian date (`month` 1-12). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Calendar date for a count of days since 1970-01-01 (`month` 1-12). */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** Wall milliseconds for local calendar fields (`month` 0-based, overflow normalised like `Date.UTC`). */
export function wallFromFields(
  year: number,
  month: number,
  day = 1,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number {
  const y = year + Math.floor(month / 12);
  const m = ((month % 12) + 12) % 12;
  return daysFromCivil(y, m + 1, 1) * DAY_MS
    + (day - 1) * DAY_MS + hour * HOUR_MS + minute * MINUTE_MS + second * SECOND_MS + millisecond;
}

/** Split wall milliseconds into calendar fields. */
export function fieldsFromWall(wallMs: number): WallParts {
  const days = Math.floor(wallMs / DAY_MS);
  const civil = civilFromDays(days);
  let rest = wallMs - days * DAY_MS;
  const hour = Math.floor(rest / HOUR_MS);
  rest -= hour * HOUR_MS;
  const minute = Math.floor(rest / MINUTE_MS);
  rest -= minute * MINUTE_MS;
  const second = Math.floor(rest / SECOND_MS);
  return {
    year: civil.year,
    month: civil.month - 1,
    day: civil.day,
    hour,
    minute,
    second,
    millisecond: rest - second * SECOND_MS,
    // 1970-01-01 was a Thursday (4).
    weekday: (((days + 4) % 7) + 7) % 7,
  };
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

const UTC_ALIASES = new Set([
  "UTC", "ETC/UTC", "ETC/UCT", "UCT", "ETC/UNIVERSAL", "UNIVERSAL", "ETC/ZULU", "ZULU",
  "GMT", "ETC/GMT", "ETC/GMT0", "ETC/GMT+0", "ETC/GMT-0", "GMT0", "GMT+0", "GMT-0", "ETC/GREENWICH", "GREENWICH",
]);

/** Cached offsets per UTC day: a constant, or a list of transitions inside that day. */
type DayOffsets = number | { at: number[]; offsets: number[] };

/** Bound on memoised days per zone (~270 years); the memo is reset when exceeded. */
const MAX_CACHED_DAYS = 100_000;

class FixedZone implements TimeZone {
  constructor(readonly id: string, readonly fixedOffset: number) {}

  offset(utcMs: number): number {
    return inDateRange(utcMs) ? this.fixedOffset : NaN;
  }

  toWall(utcMs: number): number {
    return utcMs + this.offset(utcMs);
  }

  fromWall(wallMs: number): number {
    const utc = wallMs - this.fixedOffset;
    return inDateRange(utc) ? utc : NaN;
  }

  wallParts(utcMs: number): WallParts {
    return fieldsFromWall(this.toWall(utcMs));
  }
}

class IntlZone implements TimeZone {
  readonly fixedOffset = null;
  private readonly days = new Map<number, DayOffsets>();
  private readonly format: Intl.DateTimeFormat;

  constructor(readonly id: string) {
    this.format = dateTimeFormat("en-US", {
      timeZone: id,
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  }

  offset(utcMs: number): number {
    if (!inDateRange(utcMs)) return NaN;
    const day = Math.floor(utcMs / DAY_MS);
    let entry = this.days.get(day);
    if (entry === undefined) entry = this.fillDay(day);
    if (typeof entry === "number") return entry;
    const { at, offsets } = entry;
    let i = 0;
    while (i < at.length && utcMs >= at[i]!) i++;
    return offsets[i]!;
  }

  toWall(utcMs: number): number {
    return utcMs + this.offset(utcMs);
  }

  fromWall(wallMs: number, disambiguation: Disambiguation = "compatible"): number {
    // Real-world offsets are far below a day, so a wall time more than a day
    // outside the Date range cannot map into it.
    if (!(Math.abs(wallMs) <= MAX_DATE_MS + DAY_MS)) return NaN;
    const utc = this.resolveWall(wallMs, disambiguation);
    return inDateRange(utc) ? utc : NaN;
  }

  private resolveWall(wallMs: number, disambiguation: Disambiguation): number {
    // The offsets in force a day either side bracket any transition near this
    // wall time (real-world offsets never move by more than a day). Probes
    // are clamped so wall times at the ends of the Date range still resolve.
    const before = this.offset(clampToDateRange(wallMs - DAY_MS));
    const after = this.offset(clampToDateRange(wallMs + DAY_MS));
    const candidates: number[] = [];
    const consider = (offset: number): void => {
      const utc = wallMs - offset;
      if (this.offset(utc) === offset && !candidates.includes(utc)) candidates.push(utc);
    };
    consider(before);
    if (after !== before) consider(after);
    if (candidates.length === 0) {
      // Two transitions within two days: fall back to the offset at the first guess.
      consider(this.offset(clampToDateRange(wallMs - before)));
    }
    candidates.sort((a, b) => a - b);

    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) {
      // Repeated local time (fall-back overlap).
      if (disambiguation === "reject") {
        throw new RangeError(
          `${describeWall(wallMs)} occurs twice in ${this.id} (clocks fall back). ` +
          'Pass disambiguation "earlier" or "later" to choose one.',
        );
      }
      return disambiguation === "later" ? candidates[candidates.length - 1]! : candidates[0]!;
    }
    // Skipped local time (spring-forward gap).
    if (disambiguation === "reject") {
      throw new RangeError(
        `${describeWall(wallMs)} does not exist in ${this.id} (clocks spring forward). ` +
        'Pass disambiguation "compatible", "earlier" or "later" to shift it.',
      );
    }
    // "compatible"/"later" move forward by the gap; "earlier" moves back.
    return disambiguation === "earlier" ? wallMs - after : wallMs - before;
  }

  wallParts(utcMs: number): WallParts {
    return fieldsFromWall(this.toWall(utcMs));
  }

  /** Offset at a whole UTC second, straight from Intl. */
  private rawOffset(utcSecondMs: number): number {
    let era = "";
    let year = 0;
    let month = 1;
    let day = 1;
    let hour = 0;
    let minute = 0;
    let second = 0;
    for (const part of this.format.formatToParts(utcSecondMs)) {
      switch (part.type) {
        case "era": era = part.value; break;
        case "year": year = Number(part.value); break;
        case "month": month = Number(part.value); break;
        case "day": day = Number(part.value); break;
        case "hour": hour = Number(part.value) % 24; break;
        case "minute": minute = Number(part.value); break;
        case "second": second = Number(part.value); break;
        default: break;
      }
    }
    // en-US eras are "AD"/"BC"; BC 1 is proleptic year 0.
    if (era.startsWith("B")) year = 1 - year;
    const wall = daysFromCivil(year, month, day) * DAY_MS + hour * HOUR_MS + minute * MINUTE_MS + second * SECOND_MS;
    return wall - utcSecondMs;
  }

  private fillDay(day: number): DayOffsets {
    if (this.days.size >= MAX_CACHED_DAYS) this.days.clear();
    // The first and last UTC days of the Date range are partial.
    const start = clampToDateRange(day * DAY_MS);
    const last = clampToDateRange(day * DAY_MS + DAY_MS - SECOND_MS);
    const first = this.rawOffset(start);
    const end = this.rawOffset(last);
    let entry: DayOffsets = first;
    if (first !== end) {
      const at: number[] = [];
      const offsets: number[] = [first];
      let lo = start;
      let current = first;
      // Find each transition to the second. Offsets never return to a value
      // within one day, so "offset === current" is monotone on [lo, last].
      while (current !== end && at.length < 4) {
        let hi = last;
        while (hi - lo > SECOND_MS) {
          const mid = lo + Math.floor((hi - lo) / (2 * SECOND_MS)) * SECOND_MS;
          if (this.rawOffset(mid) === current) lo = mid;
          else hi = mid;
        }
        current = this.rawOffset(hi);
        at.push(hi);
        offsets.push(current);
        lo = hi;
      }
      entry = { at, offsets };
    }
    this.days.set(day, entry);
    return entry;
  }
}

function describeWall(wallMs: number): string {
  const f = fieldsFromWall(wallMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${f.year}-${pad(f.month + 1)}-${pad(f.day)} ${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}`;
}

const FIXED_OFFSET_ID = /^([+-])(\d{2}):?(\d{2})$/;
const ETC_GMT_ID = /^Etc\/GMT([+-])(\d{1,2})$/i;

function fixedOffsetOf(id: string): number | null {
  if (UTC_ALIASES.has(id.toUpperCase())) return 0;
  const iso = FIXED_OFFSET_ID.exec(id);
  if (iso && Number(iso[2]) <= 23 && Number(iso[3]) <= 59) {
    const sign = iso[1] === "-" ? -1 : 1;
    return sign * (Number(iso[2]) * HOUR_MS + Number(iso[3]) * MINUTE_MS);
  }
  const etc = ETC_GMT_ID.exec(id);
  // POSIX-style: Etc/GMT+5 is five hours *behind* UTC. tzdb spans GMT-14..GMT+12.
  if (etc && Number(etc[2]) <= (etc[1] === "+" ? 12 : 14)) {
    return (etc[1] === "+" ? -1 : 1) * Number(etc[2]) * HOUR_MS;
  }
  return null;
}

const zones = new Map<string, TimeZone>();
const UTC_ZONE: TimeZone = new FixedZone(UTC_ZONE_ID, 0);

function unknownZone(id: string): RangeError {
  return new RangeError(
    `Unknown time zone "${id}". Use an IANA zone name such as "America/New_York", "Asia/Tokyo" or "Etc/UTC", ` +
    'or "exchange" to follow the symbol\'s timezone.',
  );
}

/**
 * The shared {@link TimeZone} for an IANA id (cached per id).
 *
 * `undefined`, `null` and `""` return UTC. Offset spellings "+05:30" /
 * "-0800" and `Etc/GMT±N` are supported as fixed zones. An unknown id throws
 * a `RangeError` with guidance instead of silently falling back to UTC.
 */
export function getTimeZone(id?: string | null): TimeZone {
  if (id === undefined || id === null || id === "") return UTC_ZONE;
  if (typeof id !== "string") {
    throw new TypeError(`Time zone must be an IANA name string such as "America/New_York"; received ${typeof id}.`);
  }
  const cached = zones.get(id);
  if (cached) return cached;

  let zone: TimeZone;
  const fixed = fixedOffsetOf(id);
  if (fixed === 0) {
    zone = UTC_ZONE;
  } else if (fixed !== null) {
    zone = new FixedZone(id, fixed);
  } else {
    let canonical: string;
    try {
      canonical = dateTimeFormat("en-US", { timeZone: id }).resolvedOptions().timeZone;
    } catch {
      throw unknownZone(id);
    }
    const resolvedFixed = fixedOffsetOf(canonical);
    const existing = zones.get(canonical);
    zone = existing
      ?? (resolvedFixed === 0 ? UTC_ZONE : resolvedFixed !== null ? new FixedZone(canonical, resolvedFixed) : new IntlZone(canonical));
    zones.set(canonical, zone);
  }
  zones.set(id, zone);
  return zone;
}

/** `true` when {@link getTimeZone} accepts `id`. */
export function isValidTimeZone(id: unknown): boolean {
  if (typeof id !== "string" || id === "") return false;
  try {
    getTimeZone(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a widget `timezone` option to a concrete IANA id.
 *
 * `"exchange"` follows the symbol's `timezone` (UTC when unknown); an empty
 * option also follows the symbol, then UTC. This is the one place both the
 * axis labels and the timezone caption resolve the display zone.
 */
export function resolveTimeZoneId(option: string | null | undefined, exchangeTimeZone?: string | null): string {
  if (option === "exchange") return exchangeTimeZone || UTC_ZONE_ID;
  return option || exchangeTimeZone || UTC_ZONE_ID;
}
