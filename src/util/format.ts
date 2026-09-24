// Price/number formatting. Derives decimal places from the symbol's
// `pricescale` (decimals = log10(pricescale)) like TradingView, and switches to
// compact K/M/B notation for large whole-number values (market-cap mode) so the
// price axis labels stay narrow.
//
// Every label goes through a cached `Intl.NumberFormat`. Building one (which
// is what `Number#toLocaleString(locale, options)` does on each call) costs
// about 20 µs, formatting with an existing instance well under 1 µs, and the
// price axis, legend, crosshair and last-price tag format several labels per
// frame.

import type {
  ChartingLibraryWidgetOptions,
  LibrarySymbolInfo,
} from "../types/charting_library";
import { DEFAULT_LOCALE, numberFormat, resolveLocale } from "./intl";

export type PriceFormatFn = (value: number, pricescale: number) => string;

/** Largest fraction-digit count every supported Intl implementation accepts. */
export const MAX_PRICE_DECIMALS = 20;

export function decimalsFromPricescale(pricescale: number): number {
  if (!pricescale || pricescale <= 1) return 0;
  return Math.min(MAX_PRICE_DECIMALS, Math.max(0, Math.round(Math.log10(pricescale))));
}

// ── Formatter caches ────────────────────────────────────────────────────────
// Two-level maps (locale → decimals → formatter) so a hot-path lookup builds
// no string key.

type FormatterTable = Map<string, Map<number, Intl.NumberFormat>>;

const priceFormats: FormatterTable = new Map();
const fixedFormats: FormatterTable = new Map();
const integerFormats = new Map<string, Intl.NumberFormat>();

function lookup(
  table: FormatterTable,
  locale: string,
  decimals: number,
  create: () => Intl.NumberFormat,
): Intl.NumberFormat {
  let byDecimals = table.get(locale);
  if (!byDecimals) {
    byDecimals = new Map();
    table.set(locale, byDecimals);
  }
  let nf = byDecimals.get(decimals);
  if (!nf) {
    nf = create();
    byDecimals.set(decimals, nf);
  }
  return nf;
}

function integerFormat(locale: string): Intl.NumberFormat {
  let nf = integerFormats.get(locale);
  if (!nf) {
    nf = numberFormat(locale);
    integerFormats.set(locale, nf);
  }
  return nf;
}

/** Collapse `-0` (and values that round to zero) so no label reads "-0.00". */
function roundsToZero(value: number, decimals: number): boolean {
  return Math.abs(value) < 0.5 * Math.pow(10, -decimals);
}

function formatPriceIn(locale: string, value: number, pricescale: number): string {
  if (!Number.isFinite(value)) return "";
  const decimals = decimalsFromPricescale(pricescale);
  if (roundsToZero(value, decimals)) value = 0;

  // Match TradingView: full numbers with thousands separators (e.g. 89,909 /
  // 140,000), decimals taken from the symbol's pricescale. (Compact K/M/B is
  // reserved for volume only — see formatVolume.)
  if (decimals === 0) {
    return integerFormat(locale).format(Math.round(value) || 0);
  }
  // Fractional prices: show up to `decimals` places, trimming trailing zeros
  // past the second so sub-penny tokens still read cleanly.
  const minFrac = Math.min(decimals, 2);
  return lookup(priceFormats, locale, decimals, () =>
    numberFormat(locale, { minimumFractionDigits: minFrac, maximumFractionDigits: decimals }),
  ).format(value);
}

/**
 * Built-in price formatter: up to `log10(pricescale)` decimals (at least two
 * when the symbol has any), `en-US` grouping. Byte-identical to the historical
 * `toLocaleString("en-US", …)` output, except that a value which rounds to zero
 * reads `0.00` instead of `-0.00`.
 */
export function formatPrice(value: number, pricescale: number): string {
  return formatPriceIn(DEFAULT_LOCALE, value, pricescale);
}

/**
 * Format `value` with exactly `decimals` fraction digits (trailing zeros kept).
 * Used by the price axis so every label in one column shares one precision.
 */
export function formatPriceFixed(value: number, decimals: number, locale: string = DEFAULT_LOCALE): string {
  if (!Number.isFinite(value)) return "";
  const d = Math.min(MAX_PRICE_DECIMALS, Math.max(0, Math.floor(decimals)));
  if (roundsToZero(value, d)) value = 0;
  return lookup(fixedFormats, locale, d, () =>
    numberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d }),
  ).format(value);
}

// ── Built-in formatter registry ─────────────────────────────────────────────
// The price axis needs to know whether the active formatter is the built-in
// one (then it may apply one fixed precision to the whole column) or a user
// formatter (then the user owns the digits). Built-in formatters are recorded
// here with their locale.

const builtinLocales = new WeakMap<PriceFormatFn, string>([[formatPrice, DEFAULT_LOCALE]]);
const builtinByLocale = new Map<string, PriceFormatFn>([[DEFAULT_LOCALE, formatPrice]]);

/**
 * Locale of a built-in price formatter, or `undefined` when `fn` is a custom
 * formatter (`priceFormatterFactory`, `raze.format_price`, or any other
 * function).
 */
export function builtinPriceFormatLocale(fn: PriceFormatFn | null | undefined): string | undefined {
  return fn ? builtinLocales.get(fn) : undefined;
}

function builtinFormatter(locale: string): PriceFormatFn {
  let fn = builtinByLocale.get(locale);
  if (!fn) {
    const bound: PriceFormatFn = (value, pricescale) => formatPriceIn(locale, value, pricescale);
    builtinLocales.set(bound, locale);
    builtinByLocale.set(locale, bound);
    fn = bound;
  }
  return fn;
}

const warnedLocales = new Set<string>();

/**
 * Resolve a widget `locale` option to an Intl tag. Accepts BCP 47 tags and
 * TradingView's underscore form (`"zh_TW"`, `"pt_BR"`). An invalid tag warns
 * once and falls back to `en-US` instead of breaking every label.
 */
export function resolveNumberLocale(locale: unknown): string {
  if (locale === undefined || locale === null || locale === "") return DEFAULT_LOCALE;
  if (typeof locale !== "string") {
    warnLocale(String(locale), `expected a string such as "en" or "de-DE", received ${typeof locale}`);
    return DEFAULT_LOCALE;
  }
  try {
    return resolveLocale(locale.replace(/_/g, "-"));
  } catch (error) {
    warnLocale(locale, error instanceof Error ? error.message : String(error));
    return DEFAULT_LOCALE;
  }
}

function warnLocale(locale: string, reason: string): void {
  if (warnedLocales.has(locale)) return;
  warnedLocales.add(locale);
  console.warn(`[raze-charts] locale "${locale}" cannot format numbers (${reason}); price labels use en-US.`);
}

function minTickOf(info: LibrarySymbolInfo | null | undefined): string {
  if (!info || !info.pricescale) return "default";
  return String((info.minmov ?? 1) / info.pricescale);
}

function wrapCustom(
  format: (value: number, pricescale: number) => string,
  fallback: PriceFormatFn,
): PriceFormatFn {
  return (value, pricescale) => {
    try {
      const s = format(value, pricescale);
      return typeof s === "string" ? s : fallback(value, pricescale);
    } catch {
      return fallback(value, pricescale);
    }
  };
}

/**
 * Resolve the price formatter used on the Y axis, last-price tag, OHLC legend,
 * crosshair, and shape price labels.
 *
 * Order: `custom_formatters.priceFormatterFactory` (if it returns a formatter)
 * → `raze.format_price` → built-in `formatPrice` in `options.locale`
 * (`en-US` grouping when no locale is set).
 */
export function createPriceFormatter(
  options?: ChartingLibraryWidgetOptions | null,
  symbolInfo?: LibrarySymbolInfo | null,
): PriceFormatFn {
  const builtin = builtinFormatter(resolveNumberLocale(options?.locale));
  const factory = options?.custom_formatters?.priceFormatterFactory;
  if (typeof factory === "function") {
    try {
      const result = factory(symbolInfo ?? null, minTickOf(symbolInfo));
      if (result && typeof result.format === "function") {
        const fmt = result.format.bind(result);
        return wrapCustom((value, pricescale) => {
          const s = fmt(value);
          return typeof s === "string" ? s : builtin(value, pricescale);
        }, builtin);
      }
    } catch {
      /* fall through */
    }
  }

  const razeFn = options?.raze?.format_price;
  if (typeof razeFn === "function") {
    return wrapCustom(razeFn, builtin);
  }

  return builtin;
}

export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [div, suffix] of units) {
    if (abs >= div) {
      // Scale the magnitude: `sign` carries the minus, so -1500 reads "-1.5K".
      const n = abs / div;
      const s = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
      return `${sign}${trimZeros(s)}${suffix}`;
    }
  }
  return integerFormat(DEFAULT_LOCALE).format(value);
}

function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

export function formatVolume(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  return formatCompact(value);
}
