// Maps the subset of TradingView `overrides` keys that app.raze.bot sets onto
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

  // Volume colours derive from candle colours unless explicitly overridden.
  theme.volUp = s("mainSeriesProperties.volumeStyle.upColor") ?? withAlpha(theme.candleUp, 0.5);
  theme.volDown = s("mainSeriesProperties.volumeStyle.downColor") ?? withAlpha(theme.candleDown, 0.5);

  return theme;
}

/** Convert a #rrggbb / #rgb colour to an rgba() string with the given alpha. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const hex = c.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const bl = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${bl},${alpha})`;
  }
  return c; // already rgba/named — return as-is
}
