// Public entry point for @raze/charts.
//
// Two ways to consume this package:
//
// 1. TradingView drop-in — `import { widget } from "@raze/charts"` (or vendor
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
export { buildTheme, isLightColor, withAlpha } from "./core/theme";
export { buildFeatureSet } from "./core/context";
export type {
  ChartContext,
  ChartStyle,
  DrawingTool,
  IndexRange,
  ThemeColors,
} from "./core/context";

// ── Data ────────────────────────────────────────────────────────────────────
export { DataManager } from "./data/DataManager";

// ── Engine ──────────────────────────────────────────────────────────────────
export { ChartEngine } from "./engine/ChartEngine";
export { ChartRenderer } from "./engine/ChartRenderer";

// ── Studies (indicator math is pure and dependency-free) ────────────────────
export { closesFromBars, ema, rsi, sma } from "./studies/calc";
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
export { ScaleBar } from "./ui/ScaleBar";
export { LoadingScreen } from "./ui/LoadingScreen";
export { closeContextMenu, showContextMenu } from "./ui/ContextMenu";
export { openPopup, popupRow } from "./ui/popup";
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
  decimalsFromPricescale,
  formatCompact,
  formatPrice,
  formatVolume,
} from "./util/format";
export { heikinAshi } from "./util/heikinAshi";

// Default export mirroring the TradingView namespace shape (some integrations
// reference `TradingView.widget`).
export default { widget: Widget, version };
