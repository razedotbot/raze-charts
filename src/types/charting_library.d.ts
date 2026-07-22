/**
 * Public type surface for @raze/charts.
 *
 * Hand-authored to be a STRUCTURALLY-COMPATIBLE subset of the TradingView
 * Charting Library v30 type definitions — specifically the types that
 * TradingView-integrated host apps typically import. The goal is that existing
 * consumer imports
 *
 *   import { widget } from ".../charting_library.esm";
 *   import type { ChartingLibraryWidgetOptions, IChartingLibraryWidget,
 *     ResolutionString, ThemeName, Mark, EntityId, LibrarySymbolInfo,
 *     PeriodParams, Bar, ... } from ".../charting_library.d";
 *
 * keep compiling unchanged when this package replaces the vendored library.
 *
 * Where TradingView's real types are enormous unions (e.g. every override key),
 * we use permissive index signatures so consumer code that sets a handful of
 * keys type-checks without us enumerating thousands of entries.
 */

// ── Branded primitives (match TV's Nominal brand so assignments are compatible) ──
export type Nominal<T, Name extends string> = T & {
  [Symbol.species]?: Name;
};
export type ResolutionString = Nominal<string, "ResolutionString">;
export type EntityId = Nominal<string, "EntityId">;
export type ThemeName = "light" | "dark";
export type SeriesFormat = "price" | "volume";
export type Timezone = string;

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

// ── Subscriptions ───────────────────────────────────────────────────────────
export interface ISubscription<TFunc extends (...args: never[]) => void = (...args: never[]) => void> {
  subscribe(
    obj: object | null,
    member: TFunc,
    singleshot?: boolean,
  ): void;
  unsubscribe(obj: object | null, member: TFunc): void;
  unsubscribeAll(obj: object | null): void;
}

// ── Shapes ──────────────────────────────────────────────────────────────────
export interface ShapePoint {
  time: number;
  price?: number;
  channel?: string;
}
export type ShapeStyle = string;
export type DrawingEventType = "click" | "move" | "remove" | "hide" | "show" | "create" | "points_changed" | "properties_changed";

export interface CreateShapeOptions<TOverrides extends object = Record<string, unknown>> {
  shape?: string;
  text?: string;
  lock?: boolean;
  disableSelection?: boolean;
  disableSave?: boolean;
  disableUndo?: boolean;
  showInObjectsTree?: boolean;
  zOrder?: "top" | "bottom";
  overrides?: TOverrides;
  [key: string]: unknown;
}

export interface ILineDataSourceApi {
  getPoints(): ShapePoint[];
  setPoints(points: ShapePoint[]): void;
  setPriceLevel?(price: number): void;
  bringToFront(): void;
  sendToBack(): void;
  getProperties(): Record<string, unknown>;
  setProperties(props: Record<string, unknown>): void;
}

// ── Context menu ────────────────────────────────────────────────────────────
export interface ContextMenuItem {
  position: "top" | "bottom";
  text: string;
  click: () => void;
}
export type ContextMenuCallback = (unixTime: number, price: number) => ContextMenuItem[] | Promise<ContextMenuItem[]>;

// ── Chart API ───────────────────────────────────────────────────────────────
export interface IChartWidgetApi {
  resolution(): ResolutionString;
  setResolution(resolution: ResolutionString, callback?: () => void): void;
  onIntervalChanged(): ISubscription<(interval: ResolutionString, timeframeObj: unknown) => void>;
  setVisibleRange(range: { from: number; to: number }): Promise<void>;
  getVisibleRange(): { from: number; to: number };
  createShape<TOverrides extends object>(
    point: ShapePoint,
    options: CreateShapeOptions<TOverrides>,
  ): Promise<EntityId>;
  createMultipointShape<TOverrides extends object>(
    points: ShapePoint[],
    options: CreateShapeOptions<TOverrides>,
  ): Promise<EntityId>;
  getShapeById(entityId: EntityId): ILineDataSourceApi;
  removeEntity(entityId: EntityId): void;
  removeAllShapes(): void;
  /** Add a study — built-in (EMA / SMA / RSI) or registered via `raze.custom_studies`. Returns an entity id removable via removeEntity. */
  createStudy(
    name: string,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: Record<string, unknown>,
  ): Promise<EntityId>;
  refreshMarks(): void;
  clearMarks(): void;
  resetData(): void;
  setSymbol(symbol: string, callback?: () => void): void;
  symbol(): string;
}

// ── Header button ───────────────────────────────────────────────────────────
export interface CreateButtonOptions {
  align?: "left" | "right";
  useTradingViewStyle?: boolean;
  title?: string;
}

// ── Widget ──────────────────────────────────────────────────────────────────
export interface IChartingLibraryWidget {
  onChartReady(callback: () => void): void;
  headerReady(): Promise<void>;
  activeChart(): IChartWidgetApi;
  chart(index?: number): IChartWidgetApi;
  createButton(options?: CreateButtonOptions): HTMLElement;
  setCSSCustomProperty(customPropertyName: string, value: string): void;
  subscribe(event: DrawingEventType | string, callback: (...args: never[]) => void): void;
  unsubscribe(event: string, callback: (...args: never[]) => void): void;
  onContextMenu(callback: ContextMenuCallback): void;
  setSymbol(symbol: string, interval: ResolutionString, callback?: () => void): void;
  remove(): void;
}

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
  | "fib_retracement"
  | "rectangle"
  | "text";
export type SidebarActionId = "indicators" | "fit" | "screenshot" | "fullscreen" | "chart_type";
export interface SidebarCustomItem {
  id: string;
  title: string;
  /** Inline SVG (or any HTML) rendered inside the 32×32 button. */
  icon: string;
  onClick: () => void;
}
export type SidebarItem = SidebarToolId | SidebarActionId | "separator" | SidebarCustomItem;

export type ChartStyleName = "candles" | "line" | "area" | "heikin_ashi";

export interface StudyPaneLevel {
  value: number;
  /** Draw the guide dashed (e.g. the RSI 50 midline). */
  dashed?: boolean;
  /** Show the value on the sub-pane's right axis. */
  axisLabel?: boolean;
}

/** A pluggable indicator: built-ins (EMA/SMA/RSI) and `raze.custom_studies` share this shape. */
export interface StudyDefinition {
  /** Canonical name — matched case-insensitively by createStudy(); shown in the legend. */
  name: string;
  /** Exact-match lookup aliases (e.g. "moving average exponential"). */
  aliases?: string[];
  /** Loose substrings that also match (e.g. "exponential" → EMA). */
  keywords?: string[];
  /** "overlay" plots on the price pane; "pane" renders in its own sub-pane. */
  pane: "overlay" | "pane";
  defaults?: { length?: number; color?: string };
  /** Fixed sub-pane value range (e.g. RSI 0–100). Auto-fits to visible values when omitted. */
  range?: { min: number; max: number };
  /** Horizontal guide levels drawn in the sub-pane. */
  levels?: StudyPaneLevel[];
  /** Sub-pane corner label; defaults to `name`. */
  label?: string;
  /** Legend value formatter; defaults to price formatting (overlay) or 1 decimal (pane). */
  formatValue?: (value: number) => string;
  /** Values aligned 1:1 with `bars`; null = warm-up gap. Must be pure. */
  compute: (bars: Bar[], inputs: { length: number }) => (number | null)[];
}

export interface IndicatorPreset {
  /** Row label; defaults to `"<name> <length>"`. */
  label?: string;
  /** Study name resolved against built-ins + `custom_studies`. */
  name: string;
  length?: number;
  color?: string;
}

export interface RazeChartsOptions {
  /** Container width (px) below which the left sidebar auto-hides (mobile).
   *  Default 520; 0 disables the compact behaviour. */
  compact_breakpoint?: number;
  /** Left-sidebar layout (builtin ids, "separator", custom buttons). Defaults to the full built-in set. */
  sidebar?: SidebarItem[];
  /** Styles offered by the chart-type picker. Defaults to all four. */
  chart_types?: ChartStyleName[];
  /** Rows of the Indicators panel. Defaults to EMA 9/21, SMA 20/50, RSI 14 + one row per custom study. */
  indicator_presets?: IndicatorPreset[];
  /** Extra studies available to createStudy() and the Indicators panel. */
  custom_studies?: StudyDefinition[];
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
  autosize?: boolean;
  fullscreen?: boolean;
  timezone?: Timezone | "exchange";
  custom_font_family?: string;
  loading_screen?: LoadingScreenOptions;
  overrides?: ChartOverrides;
  studies_overrides?: ChartOverrides;
  timeframe?: string | { value: string; type: "period-back" | "time-range" };
  debug?: boolean;
  width?: number;
  height?: number;
  toolbar_bg?: string;
  /** TV-compatible favorites; `intervals` drives the header interval row. */
  favorites?: { intervals?: ResolutionString[]; [key: string]: unknown };
  /** Raze-charts chrome configuration (ignored by the real TradingView library). */
  raze?: RazeChartsOptions;
  [key: string]: unknown;
}

// ── The widget constructor (runtime export) ─────────────────────────────────
export declare class widget implements IChartingLibraryWidget {
  constructor(options: ChartingLibraryWidgetOptions);
  onChartReady(callback: () => void): void;
  headerReady(): Promise<void>;
  activeChart(): IChartWidgetApi;
  chart(index?: number): IChartWidgetApi;
  createButton(options?: CreateButtonOptions): HTMLElement;
  setCSSCustomProperty(customPropertyName: string, value: string): void;
  subscribe(event: DrawingEventType | string, callback: (...args: never[]) => void): void;
  unsubscribe(event: string, callback: (...args: never[]) => void): void;
  onContextMenu(callback: ContextMenuCallback): void;
  setSymbol(symbol: string, interval: ResolutionString, callback?: () => void): void;
  remove(): void;
}

export declare const version: string;
