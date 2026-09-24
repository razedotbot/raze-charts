// Datafeed contract: bars, symbols, configuration, marks and callbacks.
//
// Mirrors TradingView's IBasicDataFeed so existing datafeeds compile unchanged.

import type { ResolutionString, SeriesFormat, Timezone } from "./common";

// ── Datafeed: bars & symbols ────────────────────────────────────────────────
export interface Bar {
  /**
   * Milliseconds since Unix epoch (UTC). Values below 1e11 look like seconds
   * and are reported (or multiplied by 1000 with `raze.coerce_bars`).
   */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface PeriodParams {
  /** Unix timestamp (seconds) — leftmost requested bar. */
  from: number;
  /** Unix timestamp (seconds) — rightmost requested bar (exclusive). */
  to: number;
  /** Number of bars the library expects, if known. */
  countBack: number;
  /** True only for the very first getBars call for a (symbol, resolution). */
  firstDataRequest: boolean;
}

export interface LibrarySymbolInfo {
  name: string;
  ticker?: string;
  description?: string;
  type?: string;
  session: string;
  timezone: Timezone;
  exchange: string;
  listed_exchange?: string;
  format?: SeriesFormat;
  minmov: number;
  pricescale: number;
  fractional?: boolean;
  minmove2?: number;
  has_intraday?: boolean;
  has_seconds?: boolean;
  has_daily?: boolean;
  has_weekly_and_monthly?: boolean;
  seconds_multipliers?: string[];
  intraday_multipliers?: string[];
  daily_multipliers?: string[];
  supported_resolutions?: ResolutionString[];
  volume_precision?: number;
  data_status?: "streaming" | "endofday" | "delayed_streaming";
  full_name?: string;
  [key: string]: unknown;
}

export interface Exchange {
  value: string;
  name: string;
  desc: string;
}
export interface DatafeedSymbolType {
  name: string;
  value: string;
}

export interface DatafeedConfiguration {
  exchanges?: Exchange[];
  /** Invalid entries are dropped with a warning that lists the accepted forms. */
  supported_resolutions?: ResolutionString[];
  units?: Record<string, unknown>;
  currency_codes?: string[];
  /** `getMarks` is called (and bar marks render) only when this is true. */
  supports_marks?: boolean;
  /** `getTimescaleMarks` is called only when this is true. */
  supports_timescale_marks?: boolean;
  /**
   * When true, `getServerTime` is called at boot and every five minutes. The
   * offset drives the first history window, the countdown and time presets.
   */
  supports_time?: boolean;
  symbols_types?: DatafeedSymbolType[];
  [key: string]: unknown;
}

// ── Marks ───────────────────────────────────────────────────────────────────
export interface MarkCustomColor {
  border: string;
  background: string;
}
export type MarkConstColors = "red" | "green" | "blue" | "yellow";

export interface Mark {
  id: string | number;
  /** Unix timestamp in SECONDS. */
  time: number;
  color: MarkConstColors | MarkCustomColor;
  text: string;
  label: string;
  labelFontColor: string;
  minSize: number;
  borderWidth?: number;
  hoveredBorderWidth?: number;
}

export interface TimescaleMark {
  id: string | number;
  time: number;
  color: MarkConstColors | string;
  label: string;
  tooltip: string[];
  [key: string]: unknown;
}

// ── Datafeed callbacks ──────────────────────────────────────────────────────
export type OnReadyCallback = (configuration: DatafeedConfiguration) => void;
export type ResolveCallback = (symbolInfo: LibrarySymbolInfo) => void;
export type DatafeedErrorCallback = (reason: string) => void;
export interface HistoryMetadata {
  /** No bars exist before the requested window (unless `nextTime` is set). */
  noData?: boolean;
  /**
   * With an empty result: older data exists and ends at this time, so the
   * window was a gap. Raze re-requests with `to = nextTime` (bounded). Unix
   * seconds; millisecond values are converted.
   */
  nextTime?: number | null;
}
export type HistoryCallback = (bars: Bar[], meta?: HistoryMetadata) => void;
export type SubscribeBarsCallback = (bar: Bar) => void;
export type GetMarksCallback<T> = (marks: T[]) => void;
export interface SearchSymbolResultItem {
  symbol: string;
  full_name: string;
  description: string;
  exchange: string;
  ticker?: string;
  type: string;
}
export type SearchSymbolsCallback = (items: SearchSymbolResultItem[]) => void;

export interface IExternalDatafeed {
  onReady(callback: OnReadyCallback): void;
}
export interface IDatafeedChartApi {
  searchSymbols(
    userInput: string,
    exchange: string,
    symbolType: string,
    onResult: SearchSymbolsCallback,
  ): void;
  resolveSymbol(
    symbolName: string,
    onResolve: ResolveCallback,
    onError: DatafeedErrorCallback,
    extension?: unknown,
  ): void;
  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: DatafeedErrorCallback,
  ): void;
  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
    onResetCacheNeededCallback: () => void,
  ): void;
  unsubscribeBars(listenerGuid: string): void;
  getMarks?(
    symbolInfo: LibrarySymbolInfo,
    from: number,
    to: number,
    onDataCallback: GetMarksCallback<Mark>,
    resolution: ResolutionString,
  ): void;
  getTimescaleMarks?(
    symbolInfo: LibrarySymbolInfo,
    from: number,
    to: number,
    onDataCallback: GetMarksCallback<TimescaleMark>,
    resolution: ResolutionString,
  ): void;
  /** Called only when `DatafeedConfiguration.supports_time` is true. Unix seconds. */
  getServerTime?(callback: (unixTime: number) => void): void;
}
export type IBasicDataFeed = IExternalDatafeed & IDatafeedChartApi;

// ── Interval change payload ─────────────────────────────────────────────────
/** A time window in Unix seconds. */
export interface TimeFrameTimeRange {
  type: "time-range";
  from: number;
  to: number;
}
/** A window ending now, such as `"12M"`, `"5D"`, `"YTD"` or `"ALL"`. */
export interface TimeFramePeriodBack {
  type: "period-back";
  value: string;
}
export type TimeFrameValue = TimeFrameTimeRange | TimeFramePeriodBack;
/**
 * Second argument of `onIntervalChanged` listeners. `timeframe` holds the
 * range the new interval will show; assign another `TimeFrameValue` (or edit
 * `from`/`to`) inside the listener to choose the range applied before the
 * new interval's first paint.
 */
export interface IntervalChangedParameters {
  timeframe: TimeFrameValue;
}
