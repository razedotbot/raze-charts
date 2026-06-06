// Price/number formatting. Derives decimal places from the symbol's
// `pricescale` (decimals = log10(pricescale)) like TradingView, and switches to
// compact K/M/B notation for large whole-number values (market-cap mode) so the
// price axis labels stay narrow.

export function decimalsFromPricescale(pricescale: number): number {
  if (!pricescale || pricescale <= 1) return 0;
  return Math.max(0, Math.round(Math.log10(pricescale)));
}

export function formatPrice(value: number, pricescale: number): string {
  if (!Number.isFinite(value)) return "";
  const decimals = decimalsFromPricescale(pricescale);
  const abs = Math.abs(value);

  // Large values (typical of market-cap display) → compact notation.
  if (decimals === 0 && abs >= 1000) {
    return formatCompact(value);
  }
  // Mid-range whole numbers get thousands separators.
  if (decimals === 0) {
    return Math.round(value).toLocaleString("en-US");
  }
  // Small fractional prices: trim trailing zeros but keep at least 2 dp.
  const fixed = value.toFixed(decimals);
  return trimZeros(fixed);
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
