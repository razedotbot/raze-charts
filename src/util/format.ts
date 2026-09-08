// Price/number formatting. Derives decimal places from the symbol's
// `pricescale` (decimals = log10(pricescale)) like TradingView, and switches to
// compact K/M/B notation for large whole-number values (market-cap mode) so the
// price axis labels stay narrow.

import type {
  ChartingLibraryWidgetOptions,
  LibrarySymbolInfo,
} from "../types/charting_library";

export type PriceFormatFn = (value: number, pricescale: number) => string;

export function decimalsFromPricescale(pricescale: number): number {
  if (!pricescale || pricescale <= 1) return 0;
  return Math.max(0, Math.round(Math.log10(pricescale)));
}

export function formatPrice(value: number, pricescale: number): string {
  if (!Number.isFinite(value)) return "";
  const decimals = decimalsFromPricescale(pricescale);

  // Match TradingView: full numbers with thousands separators (e.g. 89,909 /
  // 140,000), decimals taken from the symbol's pricescale. (Compact K/M/B is
  // reserved for volume only — see formatVolume.)
  if (decimals === 0) {
    return Math.round(value).toLocaleString("en-US");
  }
  // Fractional prices: show up to `decimals` places, trimming trailing zeros
  // past the second so sub-penny tokens still read cleanly.
  const minFrac = Math.min(decimals, 2);
  const s = value.toLocaleString("en-US", { minimumFractionDigits: minFrac, maximumFractionDigits: decimals });
  return s;
}

function minTickOf(info: LibrarySymbolInfo | null | undefined): string {
  if (!info || !info.pricescale) return "default";
  return String((info.minmov ?? 1) / info.pricescale);
}

function wrapCustom(
  format: (value: number, pricescale: number) => string,
): PriceFormatFn {
  return (value, pricescale) => {
    try {
      const s = format(value, pricescale);
      return typeof s === "string" ? s : formatPrice(value, pricescale);
    } catch {
      return formatPrice(value, pricescale);
    }
  };
}

/**
 * Resolve the price formatter used on the Y axis, last-price tag, OHLC legend,
 * crosshair, and shape price labels.
 *
 * Order: `custom_formatters.priceFormatterFactory` (if it returns a formatter)
 * → `raze.format_price` → built-in `formatPrice`.
 */
export function createPriceFormatter(
  options?: ChartingLibraryWidgetOptions | null,
  symbolInfo?: LibrarySymbolInfo | null,
): PriceFormatFn {
  const factory = options?.custom_formatters?.priceFormatterFactory;
  if (typeof factory === "function") {
    try {
      const result = factory(symbolInfo ?? null, minTickOf(symbolInfo));
      if (result && typeof result.format === "function") {
        const fmt = result.format.bind(result);
        return wrapCustom((value, pricescale) => {
          const s = fmt(value);
          return typeof s === "string" ? s : formatPrice(value, pricescale);
        });
      }
    } catch {
      /* fall through */
    }
  }

  const razeFn = options?.raze?.format_price;
  if (typeof razeFn === "function") {
    return wrapCustom(razeFn);
  }

  return formatPrice;
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
      const n = value / div;
      const s = Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);
      return `${sign}${trimZeros(s)}${suffix}`;
    }
  }
  return value.toLocaleString("en-US");
}

function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

export function formatVolume(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  return formatCompact(value);
}
