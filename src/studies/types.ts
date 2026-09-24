// Indicator plugin contract v2 (AD-03), fixed before any implementation so the
// study store (W1B-15), DOM legend (W1B-16), pane layout (W1B-17) and later the
// catalogue packs build against one interface. Built-in indicators implement
// the same contract as host indicators registered through defineIndicator().
//
// The declarations live in the public src/types/tv/studies.d.ts module (so the
// v1 `StudyDefinition`, which carries the typed input schema and the compute
// context, can reference them from the self-contained TradingView-shaped
// declaration file). This module re-exports them for internal imports and
// adds the runtime helpers.
//
// The v1 `StudyDefinition` (length/color shorthand + full-array compute) stays
// supported; the store adapts it onto this contract.

import type {
  IncrementalIndicatorDefinition,
  IndicatorDefinition,
  StudyInputSchema,
  StudyInputType,
  StudyInputValues,
  StudySource,
} from "../types/charting_library";

export type {
  ComputeIndicatorDefinition,
  IncrementalIndicatorDefinition,
  IndicatorDefinition,
  IndicatorDefinitionBase,
  StudyBoolInput,
  StudyColorInput,
  StudyComputeContext,
  StudyDependency,
  StudyFillDescriptor,
  StudyFloatInput,
  StudyInput,
  StudyInputBase,
  StudyInputPrimitive,
  StudyInputSchema,
  StudyInputType,
  StudyInputValue,
  StudyInputValues,
  StudyInputsOf,
  StudyIntInput,
  StudyLevelDescriptor,
  StudyOutputs,
  StudyPlotDescriptor,
  StudyPlotStyle,
  StudyPointValues,
  StudyPriceInput,
  StudyResolutionInput,
  StudySelectInput,
  StudySessionInput,
  StudySource,
  StudySourceInput,
  StudySymbolInput,
  StudyTextInput,
  StudyTimeInput,
  StudyUpdateFn,
  StudyUpdateInput,
  StudyUpdateMode,
  StudyValues,
} from "../types/charting_library";

// ── Inputs ──────────────────────────────────────────────────────────────────

export const STUDY_SOURCES: readonly StudySource[] = Object.freeze([
  "open",
  "high",
  "low",
  "close",
  "hl2",
  "hlc3",
  "ohlc4",
  "hlcc4",
  "volume",
]);

export const STUDY_INPUT_TYPES: readonly StudyInputType[] = Object.freeze([
  "int",
  "float",
  "bool",
  "source",
  "select",
  "color",
  "session",
  "time",
  "price",
  "symbol",
  "resolution",
  "text",
]);

// ── Store change stream (legend, objects tree, data window, persistence) ────

export type StudyChangeKind = "add" | "remove" | "inputs" | "style" | "visibility" | "values" | "order" | "error";

export interface StudyChange {
  readonly kind: StudyChangeKind;
  readonly id: string;
  /** Present for `error`: why compute/update failed (surfaced in the legend). */
  readonly error?: string;
}

/** The default value of every input in a schema. */
export function defaultInputValues<S extends StudyInputSchema>(schema: S): StudyInputValues<S> {
  const values: Record<string, unknown> = {};
  for (const [id, input] of Object.entries(schema)) values[id] = input.default;
  return values as StudyInputValues<S>;
}

/** Whether a definition advances bar by bar. */
export function isIncrementalIndicator<S extends StudyInputSchema, P extends string, TState>(
  definition: IndicatorDefinition<S, P, TState>,
): definition is IncrementalIndicatorDefinition<S, P, TState> {
  return typeof definition.update === "function";
}
