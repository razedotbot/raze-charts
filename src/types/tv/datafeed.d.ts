/**
 * Datafeed contract: bars, symbols, configuration, marks and callbacks.
 *
 * Mirrors TradingView's IBasicDataFeed so existing datafeeds compile unchanged.
 * Re-exported by src/types/charting_library.d.ts.
 */

import type { ResolutionString, SeriesFormat, Timezone } from "./common";

// ── Datafeed: bars & symbols ────────────────────────────────────────────────
export interface Bar {
  /** Milliseconds since Unix epoch (UTC). */
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
  supported_resolutions?: ResolutionString[];
  units?: Record<string, unknown>;
  currency_codes?: string[];
  supports_marks?: boolean;
  supports_timescale_marks?: boolean;
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
  noData?: boolean;
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
  getServerTime?(callback: (unixTime: number) => void): void;
}
export type IBasicDataFeed = IExternalDatafeed & IDatafeedChartApi;
