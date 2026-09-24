// Public entry point for @razedotbot/charts/studies.
//
// The indicator kernels are pure, dependency-free functions over arrays of
// closes or OHLCV bars, so they run in Node, workers, servers and browsers
// without the financial widget. Values align 1:1 with the input; warm-up
// samples are `null`.
//
// The registry pieces are the same catalogue the widget uses: a
// `StudyDefinition` written against this entry can be passed unchanged to the
// widget through `raze.custom_studies`. This entry is bundled separately from
// the root widget, so a `StudyRegistry` constructed here is a standalone
// catalogue (for example a server-side screener); it does not register
// anything on a mounted widget.

// ── Kernels ─────────────────────────────────────────────────────────────────
export { bollinger, closesFromBars, ema, macd, rsi, sma, sourceValues, stdev, vwap } from "./calc";
export type { VwapAnchor, VwapOptions } from "./calc";

// ── Registry ────────────────────────────────────────────────────────────────
export { BUILTIN_STUDIES, StudyRegistry } from "./registry";

// ── Contract types ──────────────────────────────────────────────────────────
export type {
  Bar,
  StudyComputeResult,
  StudyDefinition,
  StudyInputs,
  StudyPaneLevel,
  StudySeries,
  StudySeriesStyle,
} from "../types/charting_library";
export type { StudySource } from "./types";
