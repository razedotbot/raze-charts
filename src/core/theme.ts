// Maps the subset of TradingView `overrides` keys that host apps commonly set onto
// our internal ThemeColors. Unknown override keys are ignored (no-op), matching
// TV's behaviour of silently accepting any override string.

import type { ChartingLibraryWidgetOptions, ThemeName } from "../types/charting_library";
import type { ThemeColors } from "./context";

function darkDefaults(): ThemeColors {
  return {
    paneBackground: "#131722",
    vertGrid: "rgba(255,255,255,0.06)",
    horzGrid: "rgba(255,255,255,0.06)",
    crosshair: "rgba(255,255,255,0.3)",
    scaleText: "#9598a1",
    scaleBackground: "#131722",
    scaleLine: "#363a45",
    candleUp: "#26a69a",
    candleDown: "#ef5350",
    borderUp: "#26a69a",
    borderDown: "#ef5350",
    wickUp: "#26a69a",
    wickDown: "#ef5350",
    volUp: "rgba(38,166,154,0.5)",
    volDown: "rgba(239,83,80,0.5)",
    showPriceScaleCrosshairLabel: true,
    showTimeScaleCrosshairLabel: true,
  };
}

function lightDefaults(): ThemeColors {
  return {
    ...darkDefaults(),
    paneBackground: "#ffffff",
    vertGrid: "rgba(0,0,0,0.06)",
    horzGrid: "rgba(0,0,0,0.06)",
    crosshair: "rgba(0,0,0,0.3)",
    scaleText: "#131722",
    scaleBackground: "#ffffff",
    scaleLine: "#e0e3eb",
  };
}

export function buildTheme(opts: ChartingLibraryWidgetOptions): ThemeColors {
  const theme: ThemeColors = (opts.theme as ThemeName) === "light" ? lightDefaults() : darkDefaults();
  const o = opts.overrides ?? {};

  const s = (key: string): string | undefined => {
    const v = o[key];
    return typeof v === "string" ? v : undefined;
  };
  const b = (key: string, fallback: boolean): boolean => {
    const v = o[key];
    return typeof v === "boolean" ? v : fallback;
  };

  theme.paneBackground = s("paneProperties.background") ?? theme.paneBackground;
  theme.vertGrid = s("paneProperties.vertGridProperties.color") ?? theme.vertGrid;
  theme.horzGrid = s("paneProperties.horzGridProperties.color") ?? theme.horzGrid;
  theme.crosshair = s("paneProperties.crossHairProperties.color") ?? theme.crosshair;

  theme.scaleText = s("scalesProperties.textColor") ?? theme.scaleText;
  theme.scaleBackground = s("scalesProperties.backgroundColor") ?? theme.scaleBackground;
  theme.scaleLine = s("scalesProperties.lineColor") ?? theme.scaleLine;
  theme.showPriceScaleCrosshairLabel = b("scalesProperties.showPriceScaleCrosshairLabel", theme.showPriceScaleCrosshairLabel);
  theme.showTimeScaleCrosshairLabel = b("scalesProperties.showTimeScaleCrosshairLabel", theme.showTimeScaleCrosshairLabel);

  const cs = "mainSeriesProperties.candleStyle.";
  theme.candleUp = s(cs + "upColor") ?? theme.candleUp;
  theme.candleDown = s(cs + "downColor") ?? theme.candleDown;
  theme.borderUp = s(cs + "borderUpColor") ?? theme.borderUp;
  theme.borderDown = s(cs + "borderDownColor") ?? theme.borderDown;
  theme.wickUp = s(cs + "wickUpColor") ?? theme.wickUp;
  theme.wickDown = s(cs + "wickDownColor") ?? theme.wickDown;

  // Line/area series colour; falls back to candleUp at draw time when unset.
  theme.lineColor = s("mainSeriesProperties.lineStyle.color")
    ?? s("mainSeriesProperties.areaStyle.linecolor")
    ?? theme.lineColor;

  // Volume colours derive from candle colours unless explicitly overridden.
  theme.volUp = s("mainSeriesProperties.volumeStyle.upColor") ?? withAlpha(theme.candleUp, 0.5);
  theme.volDown = s("mainSeriesProperties.volumeStyle.downColor") ?? withAlpha(theme.candleDown, 0.5);

  return theme;
}

/** Parse a #rgb / #rrggbb colour into channels, or null for other formats. */
function parseHex(color: string): { r: number; g: number; b: number } | null {
  const hex = color.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!hex) return null;
  let h = hex[1]!;
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function parseRgb(color: string): { r: number; g: number; b: number } | null {
  const match = color.trim().match(
    /^rgba?\(\s*([\d.]+)(%)?(?:\s*,\s*|\s+)([\d.]+)(%)?(?:\s*,\s*|\s+)([\d.]+)(%)?(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/i,
  );
  if (!match) return null;
  const channel = (raw: string, percent: string | undefined): number => {
    const value = Number(raw);
    return percent ? value * 2.55 : value;
  };
  const r = channel(match[1]!, match[2]);
  const g = channel(match[3]!, match[4]);
  const b = channel(match[5]!, match[6]);
  if (![r, g, b].every(Number.isFinite)) return null;
  return { r, g, b };
}

/** Convert a #rrggbb / #rgb colour to an rgba() string with the given alpha. */
export function withAlpha(color: string, alpha: number): string {
  const c = parseHex(color);
  if (c) return `rgba(${c.r},${c.g},${c.b},${alpha})`;
  return color.trim(); // already rgba/named — return as-is
}

/** True when a hex, rgb, or common named colour reads as a light background. */
export function isLightColor(color: string): boolean {
  const named: Record<string, { r: number; g: number; b: number }> = {
    white: { r: 255, g: 255, b: 255 },
    black: { r: 0, g: 0, b: 0 },
    ivory: { r: 255, g: 255, b: 240 },
    snow: { r: 255, g: 250, b: 250 },
  };
  const c = parseHex(color) ?? parseRgb(color) ?? named[color.trim().toLowerCase()] ?? null;
  if (!c) return false;
  // Rec. 601 luma — good enough to pick a contrasting pill colour.
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 160;
}
