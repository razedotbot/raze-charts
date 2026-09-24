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
export { bollinger, closesFromBars, ema, macd, rsi, sma, stdev, vwap } from "./calc";

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

// ── Indicator contract v2 (defineIndicator) ─────────────────────────────────
// Typed input schemas, plot/fill/level descriptors, a read-only compute
// context and incremental init()/update(). A handle from defineIndicator() is
// a StudyDefinition: pass it to `raze.custom_studies` or a StudyRegistry.
export { createStudyContext, defineIndicator, runIndicator } from "./defineIndicator";
export type { IndicatorHandle, StudyPlotOverride } from "./defineIndicator";
export {
  bool,
  color,
  float,
  humanizeInputId,
  int,
  normalizeInputSchema,
  positionalStudyInputs,
  price,
  resolution,
  resolveStudyInputs,
  select,
  session,
  source,
  sourceValue,
  StudyInputError,
  studyInputFields,
  symbol,
  text,
  time,
} from "./inputs";
export type {
  ResolveInputsOptions,
  StudyInputClamp,
  StudyInputControl,
  StudyInputErrorCode,
  StudyInputField,
  StudyInputOptions,
  StudyNumberInputOptions,
} from "./inputs";
export { STUDY_INPUT_TYPES, STUDY_SOURCES } from "./types";
export type {
  ComputeIndicatorDefinition,
  IncrementalIndicatorDefinition,
  IndicatorDefinition,
  StudyChange,
  StudyChangeKind,
  StudyComputeContext,
  StudyDependency,
  StudyFillDescriptor,
  StudyInput,
  StudyInputPrimitive,
  StudyInputSchema,
  StudyInputsOf,
  StudyInputType,
  StudyInputValue,
  StudyInputValues,
  StudyLevelDescriptor,
  StudyOutputs,
  StudyPlotDescriptor,
  StudyPlotStyle,
  StudyPointValues,
  StudySource,
  StudyUpdateFn,
  StudyUpdateInput,
  StudyUpdateMode,
  StudyValues,
} from "./types";
