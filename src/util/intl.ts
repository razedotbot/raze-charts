/**
 * Shared Intl formatter cache for both runtimes.
 *
 * Constructing an `Intl.NumberFormat` / `Intl.DateTimeFormat` (which is what
 * `Number#toLocaleString(locale, options)` does on every call) costs roughly
 * 20 µs, while formatting with an existing instance costs well under 1 µs.
 * Axis, legend, crosshair and tooltip labels are formatted many times per
 * frame, so every formatter in the library is built once per
 * (kind, locale, options) key and reused here.
 *
 * The caches are bounded: a pathological caller that feeds ever-changing
 * option objects cannot grow memory without limit. Eviction is
 * least-recently-used. Hot paths should keep the returned formatter instance
 * (for example per axis or per symbol) instead of looking it up per label:
 * building the cache key still costs an options walk.
 */

/** Locale used when a caller does not pass one. Matches the historical `toLocaleString("en-US")` output. */
export const DEFAULT_LOCALE = "en-US";

/** Maximum number of cached formatters per kind before the oldest are evicted. */
export const INTL_CACHE_LIMIT = 128;

type Cache<T> = Map<string, T>;

const numberFormats: Cache<Intl.NumberFormat> = new Map();
const dateTimeFormats: Cache<Intl.DateTimeFormat> = new Map();
const pluralRules: Cache<Intl.PluralRules> = new Map();
const canonicalLocales: Cache<string> = new Map();

function remember<T>(cache: Cache<T>, key: string, create: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh recency so frequently used formatters survive eviction.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const value = create();
  if (cache.size >= INTL_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
  return value;
}

/**
 * Stable cache key for an options bag. Keys are sorted so `{a, b}` and
 * `{b, a}` share an entry; `undefined` values are dropped because Intl
 * treats them as absent.
 */
function optionsKey(options: object | undefined): string {
  if (!options) return "";
  const record = options as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  let out = "";
  for (const key of keys) out += `${key}=${String(record[key])};`;
  return out;
}

/**
 * Resolve a BCP 47 locale tag to its canonical form.
 *
 * Throws a `RangeError` that names the bad tag (instead of Intl's terse
 * "Incorrect locale information provided") so configuration mistakes are
 * visible at the call site. `undefined` and `""` resolve to {@link DEFAULT_LOCALE}.
 */
export function resolveLocale(locale?: string | null): string {
  if (locale === undefined || locale === null || locale === "") return DEFAULT_LOCALE;
  if (typeof locale !== "string") {
    throw new TypeError(`Locale must be a BCP 47 string such as "en-US"; received ${typeof locale}.`);
  }
  return remember(canonicalLocales, locale, () => {
    try {
      const [canonical] = Intl.getCanonicalLocales(locale);
      return canonical ?? DEFAULT_LOCALE;
    } catch {
      throw new RangeError(
        `Invalid locale "${locale}". Use a BCP 47 language tag such as "en-US", "de-DE" or "ja-JP".`,
      );
    }
  });
}

/** Cached `Intl.NumberFormat` for `(locale, options)`. */
export function numberFormat(locale?: string | null, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const tag = resolveLocale(locale);
  return remember(numberFormats, `${tag}|${optionsKey(options)}`, () => new Intl.NumberFormat(tag, options));
}

/** `true` when Intl accepts `timeZone` on its own. */
function isIntlTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(DEFAULT_LOCALE, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cached `Intl.DateTimeFormat` for `(locale, options)`.
 *
 * An invalid `options.timeZone` throws a `RangeError` naming the zone. Any
 * other invalid option throws a `RangeError` that quotes the option bag, so
 * a valid zone is never blamed for, say, a bad `hourCycle`.
 */
export function dateTimeFormat(locale?: string | null, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const tag = resolveLocale(locale);
  const key = optionsKey(options);
  return remember(dateTimeFormats, `${tag}|${key}`, () => {
    try {
      return new Intl.DateTimeFormat(tag, options);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      const timeZone = options?.timeZone;
      if (timeZone !== undefined && !isIntlTimeZone(String(timeZone))) {
        throw new RangeError(
          `Unknown time zone "${timeZone}". Use an IANA zone name such as "America/New_York" or "Etc/UTC".`,
        );
      }
      throw new RangeError(`Invalid Intl.DateTimeFormat options for "${tag}" (${key}): ${error.message}`);
    }
  });
}

/** Cached `Intl.PluralRules` for `(locale, options)`. */
export function pluralRulesFor(locale?: string | null, options?: Intl.PluralRulesOptions): Intl.PluralRules {
  const tag = resolveLocale(locale);
  return remember(pluralRules, `${tag}|${optionsKey(options)}`, () => new Intl.PluralRules(tag, options));
}

/**
 * Format a number through the shared cache.
 *
 * Output is byte-identical to `value.toLocaleString(locale, options)`, which
 * lets existing call sites switch without changing a single label.
 */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions, locale?: string | null): string {
  return numberFormat(locale, options).format(value);
}

/** Format an instant (epoch milliseconds or `Date`) through the shared cache. */
export function formatDateTime(
  value: number | Date,
  options?: Intl.DateTimeFormatOptions,
  locale?: string | null,
): string {
  return dateTimeFormat(locale, options).format(value);
}

/** Drop every cached formatter. Intended for tests and locale-pack hot reload. */
export function clearIntlCache(): void {
  numberFormats.clear();
  dateTimeFormats.clear();
  pluralRules.clear();
  canonicalLocales.clear();
}

/** Number of cached formatters per kind (diagnostics and tests). */
export function intlCacheSize(): { number: number; dateTime: number; plural: number } {
  return { number: numberFormats.size, dateTime: dateTimeFormats.size, plural: pluralRules.size };
}
