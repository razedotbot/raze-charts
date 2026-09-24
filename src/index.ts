// Public entry point for @razedotbot/charts.
//
// Two ways to consume this package:
//
// 1. TradingView drop-in — `import { widget } from "@razedotbot/charts"` (or vendor
//    dist/charting_library.esm.js under a bundler alias). The `widget` class
//    matches TradingView's `import { widget } from "charting_library"` usage;
//    the default export mirrors the `TradingView` namespace shape for
//    integrations that reference `TradingView.widget`.
//
// 2. À la carte — every building block is a named export: the render engine,
//    datafeed orchestration, indicator math, shape store, UI chrome and utils
//    can each be used standalone without the widget shell.

import { Widget } from "./core/Widget";

declare const __RAZE_CHARTS_VERSION__: string | undefined;

export { Widget as widget, Widget };
export const version: string =
  typeof __RAZE_CHARTS_VERSION__ !== "undefined" ? __RAZE_CHARTS_VERSION__ : "dev";

// ── TradingView-compatible public types ─────────────────────────────────────
export type * from "./types/charting_library";

// ── Core ────────────────────────────────────────────────────────────────────
export { ChartApi } from "./core/ChartApi";
export type { ChartApiDeps } from "./core/ChartApi";
export { ShapeStore } from "./core/ShapeStore";
export type { ShapeKind, StoredShape } from "./core/ShapeStore";
export { TradingStore } from "./core/TradingStore";
export type { StoredTradingLine } from "./core/TradingStore";
export { buildTheme, isLightColor, withAlpha } from "./core/theme";
export { CommandStack } from "./core/CommandStack";
export type { Command } from "./core/CommandStack";
export { resolveTimeframe, TIMEFRAME_PRESETS } from "./core/timeframe";
export type { ResolvedTimeframe, TimeframePreset } from "./core/timeframe";
export type {
  ChartContext,
  ChartStyle,
  DrawingTool,
  IndexRange,
  ThemeColors,
} from "./core/context";
// Context seams (W1A-06): reason-tagged setters and their change payloads.
export { createChartContext } from "./core/context";
export { IdAllocator } from "./core/ids";
export type { IdAllocatorOptions, IdFactory, IdNamespace, IdRequest, NextIdOptions } from "./core/ids";
export type {
  ChartContextInit,
  ChartContextState,
  CreateChartContextOptions,
  ChartContextSeams,
  ChartTypeChange,
  ChartTypeChangeReason,
  PriceScaleMode,
  ScaleChange,
  ScaleChangeReason,
  ScaleModePatch,
  ScaleState,
  SetViewportOptions,
  TimezoneSetting,
  ViewportChange,
  ViewportChangeReason,
} from "./core/context";

// ── Data ────────────────────────────────────────────────────────────────────
export { DataManager } from "./data/DataManager";
export { TimeIndex } from "./data/TimeIndex";
export type { TimePoint } from "./data/TimeIndex";
export { createDatafeed, defineDataSource } from "./data/dataSource";
export type {
  DefineDataSourceOptions,
  HistoryRequest,
  HistoryResult,
  MarksRequest,
  MaybePromise,
  RazeDataSource,
  RealtimeCleanup,
  RealtimeHandlers,
  RealtimeRequest,
  SymbolSearchRequest,
} from "./data/dataSource";

// ── Engine ──────────────────────────────────────────────────────────────────
export { ChartEngine } from "./engine/ChartEngine";
export { ChartRenderer } from "./engine/ChartRenderer";
export type { GestureHost } from "./engine/gestures";
export type { SubPaneGeom } from "./engine/layout";
export type { PlotScale } from "./engine/plotScale";
export type {
  Crosshair,
  DraftShape,
  FinanceView,
  MarkHit,
  ShapeHit,
  TradingHit,
} from "./engine/paint/view";
export type { AxisTag, AxisTagSourceKind, Rect, ScreenPoint, TimescaleMarkHit } from "./engine/paint/view";

// ── Studies (indicator math is pure and dependency-free) ────────────────────
export { bollinger, closesFromBars, ema, macd, rsi, sma, stdev, vwap } from "./studies/calc";
export { BUILTIN_STUDIES, StudyRegistry } from "./studies/registry";
export { StudyStore } from "./studies/StudyStore";
export type { StudyInstance, StudyKind, StudySpec } from "./studies/StudyStore";

// ── UI chrome ───────────────────────────────────────────────────────────────
export { Toolbar, TOOLBAR_HEIGHT } from "./ui/Toolbar";
export { DEFAULT_SIDEBAR_ITEMS, LeftSidebar, LEFT_SIDEBAR_W } from "./ui/LeftSidebar";
export type { ChartStyleId, LeftSidebarCallbacks } from "./ui/LeftSidebar";
export { DEFAULT_INDICATOR_PRESETS, IndicatorsMenu, resolveIndicatorPresets } from "./ui/IndicatorsMenu";
export type { ResolvedIndicatorPreset } from "./ui/IndicatorsMenu";
export { DEFAULT_INTERVAL_FAVORITES, IntervalSelector } from "./ui/IntervalSelector";
export { TimeframeBar } from "./ui/TimeframeBar";
export { SymbolSearch } from "./ui/SymbolSearch";
export { ObjectsTree } from "./ui/ObjectsTree";
export { ScaleBar } from "./ui/ScaleBar";
export { LoadingScreen } from "./ui/LoadingScreen";
export { closeContextMenu, showContextMenu } from "./ui/ContextMenu";
export { ensureBaseStyles, isCoarsePointer, openPopup, popupRow, popupSeparator } from "./ui/popup";
export type { PopupHandle, PopupOptions } from "./ui/popup";

// ── Utils ───────────────────────────────────────────────────────────────────
export { Delegate } from "./util/delegate";
export {
  floorToBar,
  parseResolution,
  resolutionLabel,
  resolutionToMs,
} from "./util/resolution";
export type { ParsedResolution } from "./util/resolution";
export {
  createPriceFormatter,
  decimalsFromPricescale,
  formatCompact,
  formatPrice,
  formatVolume,
} from "./util/format";
export type { PriceFormatFn } from "./util/format";
export { heikinAshi } from "./util/heikinAshi";

// Default export mirroring the TradingView namespace shape (some integrations
// reference `TradingView.widget`).
export default { widget: Widget, version };
