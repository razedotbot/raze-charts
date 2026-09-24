// Widget constructor options: the TradingView-compatible subset plus the
// Raze-specific `raze` chrome configuration.

import type { ResolutionString, ThemeName, Timezone } from "./common";
import type { IBasicDataFeed, LibrarySymbolInfo } from "./datafeed";
import type { IndicatorPreset, StudyDefinition } from "./studies";

// ── Loading screen & overrides ──────────────────────────────────────────────
export interface LoadingScreenOptions {
  backgroundColor?: string;
  foregroundColor?: string;
}

// `overrides` and `studies_overrides` are open maps in TV; keep them permissive.
export type ChartOverrides = Record<string, string | number | boolean>;

// ── Raze chrome configuration (library-specific; unknown to TradingView) ────
export type SidebarToolId =
  | "cursor"
  | "trend_line"
  | "horizontal_line"
  | "vertical_line"
  | "ray"
  | "extended_line"
  | "measure"
  | "fib_retracement"
  | "rectangle"
  | "text";
export type SidebarActionId = "indicators" | "fit" | "screenshot" | "fullscreen" | "chart_type" | "objects_tree";
export interface SidebarCustomItem {
  id: string;
  title: string;
  /**
   * Rendered inside the 32×32 button: inline SVG (or any HTML) markup, or an
   * Element (cloned for the button). Markup is host-authored HTML, so never
   * build it from user input; with Trusted Types enforced, prefer an Element.
   */
  icon: string | Element;
  onClick: () => void;
}
export type SidebarItem = SidebarToolId | SidebarActionId | "separator" | SidebarCustomItem;

export type ChartStyleName =
  | "candles"
  | "line"
  | "area"
  | "heikin_ashi"
  | "bars"
  | "hollow_candles"
  | "baseline"
  | "columns";
export type VolumeMode = "overlay" | "pane" | "hidden";

// ── Formatters ──────────────────────────────────────────────────────────────
/** Returned by `custom_formatters.priceFormatterFactory`. */
export interface CustomSymbolValueFormatter {
  format(price: number, signPositive?: boolean): string;
}

/**
 * TradingView Advanced Charts drop-in. Return `null` to fall through to
 * `raze.format_price` (if set) or the built-in pricescale formatter.
 *
 * Called as `(symbolInfo, minTick)` — `minTick` is `minmov / pricescale`.
 */
export type PriceFormatterFactory = (
  symbolInfo: LibrarySymbolInfo | null,
  minTick: string,
) => CustomSymbolValueFormatter | null;

/** Subset of TradingView `custom_formatters`. Only price formatting is wired. */
export interface CustomFormatters {
  priceFormatterFactory?: PriceFormatterFactory;
  [key: string]: unknown;
}

// ── Timeframe ───────────────────────────────────────────────────────────────
/** A period counted back from the latest bar, such as `"3M"`, `"5D"`, `"YTD"` or `"ALL"`. */
export interface TimeFramePeriodBack {
  type: "period-back";
  value: string;
}
/** An absolute window in unix seconds. */
export interface TimeFrameTimeRange {
  type: "time-range";
  from: number;
  to: number;
}
/** TradingView `TimeFrameValue`. */
export type TimeFrameValue = TimeFramePeriodBack | TimeFrameTimeRange;
/**
 * The earlier Raze range shape, `{ type: "time-range", value: "from,to" }`.
 * @deprecated Use `{ from, to }` or `{ type: "time-range", from, to }`.
 */
export interface LegacyTimeFrameRange {
  type: "time-range";
  value: string;
}
/**
 * Initial visible range: a period string (`"3M"`), a comma-separated range
 * (`"1700000000,1700086400"`), `{ from, to }` in unix seconds (TradingView's
 * `VisibleTimeRange`) or a `TimeFrameValue`. An unusable value is ignored
 * with a console warning; it never fails the initial load.
 */
export type WidgetTimeframe = string | { from: number; to: number } | TimeFrameValue | LegacyTimeFrameRange;

// ── Multi-chart layout sync ─────────────────────────────────────────────────
/** What a `raze.layout` multi-chart grid keeps in step across its panes. */
export interface LayoutSyncOptions {
  /**
   * An interval change on any pane (header or `setResolution`) applies to
   * every pane, each firing its own `onIntervalChanged`. Default `true`, like
   * TradingView's layout interval sync.
   */
  interval?: boolean;
  /** Scrolling or zooming one pane moves the others to the same time window. Default `true`. */
  time?: boolean;
  /** The crosshair is mirrored to the other panes. Default `true`. */
  crosshair?: boolean;
}

// ── Options ─────────────────────────────────────────────────────────────────
export interface RazeChartsOptions {
  /**
   * Accessible name for the complete widget and its interactive canvas.
   * Defaults to `"<symbol> financial chart"` and stays in sync after setSymbol().
   */
  aria_label?: string;
  /**
   * Accessible chart summary. Keyboard instructions are appended automatically
   * and exposed through aria-describedby without adding visible chrome.
   */
  aria_description?: string;
  /** Container width (px) below which the left sidebar auto-hides (mobile).
   *  Default 520; 0 disables the compact behaviour. */
  compact_breakpoint?: number;
  /** Left-sidebar layout (builtin ids, "separator", custom buttons). Defaults to the full built-in set. */
  sidebar?: SidebarItem[];
  /** Styles offered by the chart-type picker. Defaults to the closed catalog. */
  chart_types?: ChartStyleName[];
  /** Rows of the Indicators panel. Defaults to EMA 9/21, SMA 20/50, RSI 14 + one row per custom study. */
  indicator_presets?: IndicatorPreset[];
  /** Extra studies available to createStudy() and the Indicators panel. */
  custom_studies?: StudyDefinition[];
  /**
   * Custom price string for the Y axis, last-price tag, OHLC legend, crosshair,
   * and shape price labels. Receives the symbol `pricescale`. Ignored when
   * `custom_formatters.priceFormatterFactory` returns a formatter. Percent-scale
   * axis ticks stay `+x.xx%`.
   */
  format_price?: (value: number, pricescale: number) => string;
  layout?: "1" | "2x1" | "2x2";
  layout_symbols?: string[];
  /** Which state the `layout` panes share. Defaults to interval, time and crosshair sync. */
  layout_sync?: LayoutSyncOptions;
  layout_child?: boolean;
  volume_mode?: VolumeMode;
  magnet?: boolean;
}

export interface ChartingLibraryWidgetOptions {
  symbol: string;
  datafeed: IBasicDataFeed;
  interval: ResolutionString;
  container: HTMLElement | string;
  library_path?: string;
  locale?: string;
  disabled_features?: string[];
  enabled_features?: string[];
  theme?: ThemeName;
  /**
   * `true` makes the chart fill its container and follow its size, ignoring
   * `width`/`height`. `false` uses `width` x `height` pixels (TradingView's
   * 800 x 500 when omitted). When unset, a given `width`/`height` is used and
   * any missing dimension fills the container.
   */
  autosize?: boolean;
  /** `true` sizes the chart to the browser viewport (`position: fixed`), overriding the other size options. */
  fullscreen?: boolean;
  timezone?: Timezone | "exchange";
  custom_font_family?: string;
  loading_screen?: LoadingScreenOptions;
  overrides?: ChartOverrides;
  studies_overrides?: ChartOverrides;
  timeframe?: WidgetTimeframe;
  /** Log developer diagnostics, such as deprecated featureset names, to the console. */
  debug?: boolean;
  /** Chart width in CSS pixels when `autosize` is not `true`. */
  width?: number;
  /** Chart height in CSS pixels when `autosize` is not `true`. */
  height?: number;
  toolbar_bg?: string;
  /** TV-compatible favorites; `intervals` lead the inline header interval row. */
  favorites?: { intervals?: ResolutionString[]; [key: string]: unknown };
  /**
   * TradingView drop-in custom formatters. Raze honours
   * `priceFormatterFactory` for every on-canvas price label (axis, last price,
   * OHLC legend, crosshair, shape tags). Return `null` from the factory to use
   * `raze.format_price` or the built-in formatter.
   */
  custom_formatters?: CustomFormatters;
  /** Raze-charts chrome configuration (ignored by the real TradingView library). */
  raze?: RazeChartsOptions;
  [key: string]: unknown;
}
