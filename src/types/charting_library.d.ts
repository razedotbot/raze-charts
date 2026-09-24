// Public type surface for @razedotbot/charts.
//
// Hand-authored to be a STRUCTURALLY-COMPATIBLE subset of the TradingView
// Charting Library v30 type definitions — specifically the types that
// TradingView-integrated host apps typically import. The goal is that existing
// consumer imports
//
//   import { widget } from ".../charting_library.esm";
//   import type { ChartingLibraryWidgetOptions, IChartingLibraryWidget,
//     ResolutionString, ThemeName, Mark, EntityId, LibrarySymbolInfo,
//     PeriodParams, Bar, ... } from ".../charting_library.d";
//
// keep compiling unchanged when this package replaces the vendored library.
//
// Where TradingView's real types are enormous unions (e.g. every override key),
// we use permissive index signatures so consumer code that sets a handful of
// keys type-checks without us enumerating thousands of entries.
//
// The declarations are authored as domain modules under src/types/tv/ and
// collected by src/types/charting_library.d.ts. The package ships them both
// as that module tree (dist/types) and as one self-contained file
// (dist/charting_library.d.ts, aliased as dist/datafeed-api.d.ts) that
// build.mjs flattens for vendored drop-in use.

export * from "./tv/common";
export * from "./tv/datafeed";
export * from "./tv/shapes";
export * from "./tv/trading";
export * from "./tv/chart-api";
export * from "./tv/layout";
export * from "./tv/widget";
export * from "./tv/options";
export * from "./tv/studies";
