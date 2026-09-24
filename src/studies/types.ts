// Indicator plugin contract v2 (AD-03), fixed before any implementation so the
// study store (W1B-15), DOM legend (W1B-16), pane layout (W1B-17) and later the
// catalogue packs build against one interface. Built-in indicators implement
// the same contract as host indicators registered through defineIndicator().
//
// The v1 `StudyDefinition` (length/color shorthand + full-array compute) stays
// supported; the store adapts it onto this contract.

import type { Bar, LibrarySymbolInfo, ResolutionString } from "../types/charting_library";
import type { IndexRange } from "../core/context";

// ── Inputs ──────────────────────────────────────────────────────────────────

/** Price source selectable by `source` inputs. */
export type StudySource = "open" | "high" | "low" | "close" | "hl2" | "hlc3" | "ohlc4" | "hlcc4" | "volume";

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

interface StudyInputBase<V> {
  /** Settings-dialog label (English default; translated through t()). */
  readonly title: string;
  readonly default: V;
  /** Dialog section heading. */
  readonly group?: string;
  /** Inputs sharing an `inline` key render on one dialog row. */
  readonly inline?: string;
  readonly tooltip?: string;
  /**
   * Include the value in the legend label (`MACD 12 26 hl2 9`). Defaults to
   * true for int, float and price inputs, and for a source input only while it
   * differs from its default (`EMA 9`, then `EMA 9 hl2`). See src/studies/label.ts.
   */
  readonly inLabel?: boolean;
}

export interface StudyIntInput extends StudyInputBase<number> {
  readonly type: "int";
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}
export interface StudyFloatInput extends StudyInputBase<number> {
  readonly type: "float";
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}
export interface StudyBoolInput extends StudyInputBase<boolean> {
  readonly type: "bool";
}
export interface StudySourceInput extends StudyInputBase<StudySource> {
  readonly type: "source";
}
export interface StudySelectInput<V extends string = string> extends StudyInputBase<V> {
  readonly type: "select";
  readonly options: readonly V[] | readonly { readonly value: V; readonly title: string }[];
}
export interface StudyColorInput extends StudyInputBase<string> {
  readonly type: "color";
}
/** TradingView session string, for example `0930-1600`. */
export interface StudySessionInput extends StudyInputBase<string> {
  readonly type: "session";
}
/** Unix seconds. */
export interface StudyTimeInput extends StudyInputBase<number> {
  readonly type: "time";
}
export interface StudyPriceInput extends StudyInputBase<number> {
  readonly type: "price";
}
export interface StudySymbolInput extends StudyInputBase<string> {
  readonly type: "symbol";
}
export interface StudyResolutionInput extends StudyInputBase<string> {
  readonly type: "resolution";
}
export interface StudyTextInput extends StudyInputBase<string> {
  readonly type: "text";
}

export type StudyInput =
  | StudyIntInput
  | StudyFloatInput
  | StudyBoolInput
  | StudySourceInput
  | StudySelectInput
  | StudyColorInput
  | StudySessionInput
  | StudyTimeInput
  | StudyPriceInput
  | StudySymbolInput
  | StudyResolutionInput
  | StudyTextInput;

export type StudyInputType = StudyInput["type"];

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

/** Input id -> descriptor. Ids are `[a-z][A-Za-z0-9_]*` and are stored in snapshots. */
export type StudyInputSchema = { readonly [id: string]: StudyInput };

/** The runtime value type of one input descriptor. */
export type StudyInputValue<I extends StudyInput> =
  I extends StudyBoolInput ? boolean
    : I extends StudySourceInput ? StudySource
      : I extends StudySelectInput<infer V> ? V
        : I extends StudyIntInput | StudyFloatInput | StudyTimeInput | StudyPriceInput ? number
          : string;

/** Typed input values for a schema; what compute/init/update receive. */
export type StudyInputValues<S extends StudyInputSchema> = {
  readonly [K in keyof S]: StudyInputValue<S[K]>;
};

// ── Outputs ─────────────────────────────────────────────────────────────────

/** Values aligned 1:1 with bars. null or NaN is a gap (warm-up or missing data). */
export type StudyValues = (number | null)[] | Float64Array;

export type StudyPlotStyle = "line" | "step" | "histogram" | "columns" | "area" | "circles" | "cross" | "shapes";

export interface StudyPlotDescriptor<P extends string = string> {
  readonly id: P;
  readonly title: string;
  readonly style: StudyPlotStyle;
  /** Default colour; the store rotates the palette when omitted. */
  readonly color?: string;
  readonly lineWidth?: number;
  /** TradingView numbering: 0 solid, 1 dotted, 2 dashed. */
  readonly lineStyle?: 0 | 1 | 2;
  /** Histogram/columns baseline. Defaults to 0. */
  readonly base?: number;
  /** Hidden plots still compute and appear in the data window. */
  readonly visible?: boolean;
  /** Show the latest value as an axis tag. */
  readonly trackPrice?: boolean;
  /** Include in the legend row. Defaults to true. */
  readonly inLegend?: boolean;
}

/** Fill between two plots or two levels (Bollinger/Keltner bands, RSI zone). */
export interface StudyFillDescriptor<P extends string = string> {
  readonly id: string;
  readonly title?: string;
  readonly between: readonly [P, P] | { readonly levels: readonly [number, number] };
  readonly color: string;
}

/** Horizontal guide level in the study pane. */
export interface StudyLevelDescriptor {
  readonly value: number;
  readonly title?: string;
  readonly color?: string;
  readonly dashed?: boolean;
  /** Show the level on the pane's price axis. */
  readonly axisLabel?: boolean;
}

/** Full-array result: one series per plot id. */
export type StudyOutputs<P extends string> = { readonly [K in P]: StudyValues };
/** Single-bar result from update(): one value per plot id. */
export type StudyPointValues<P extends string> = { readonly [K in P]: number | null };

// ── Execution context ───────────────────────────────────────────────────────

/** What a study may react to besides new bars. */
export type StudyDependency = "visibleRange" | "symbol" | "resolution" | "timezone";

/** Read-only environment handed to compute/init/update. */
export interface StudyComputeContext {
  readonly symbol: string;
  readonly symbolInfo: Readonly<LibrarySymbolInfo> | null;
  readonly resolution: ResolutionString;
  /** Resolved IANA zone used for session anchoring (VWAP, pivots). */
  readonly timezone: string;
  /** Present only when the definition lists `visibleRange` in `dependsOn`. */
  readonly visibleRange: Readonly<IndexRange> | null;
  /** Symbol-aware price formatter. */
  readonly formatPrice: (price: number) => string;
  /** Server-corrected wall clock in milliseconds. */
  readonly now: () => number;
  /** Ask for a throttled full recompute (for example after an async resource resolves). */
  requestRecompute(): void;
}

/** How update() is being asked to advance. */
export type StudyUpdateMode = "append" | "replace-last";

export interface StudyUpdateInput {
  readonly bar: Bar;
  readonly index: number;
  readonly bars: readonly Bar[];
  readonly mode: StudyUpdateMode;
}

/**
 * Incremental step. It must be pure: return the next state instead of
 * mutating the given one. The runtime keeps the state committed before the
 * forming bar and re-runs update() from it for every `replace-last` tick.
 */
export type StudyUpdateFn<S extends StudyInputSchema, P extends string, TState> = (
  input: StudyUpdateInput,
  state: TState,
  inputs: StudyInputValues<S>,
  ctx: StudyComputeContext,
) => { readonly state: TState; readonly values: StudyPointValues<P> };

// ── The indicator definition ────────────────────────────────────────────────

interface IndicatorDefinitionBase<S extends StudyInputSchema, P extends string> {
  /** Canonical name matched exactly (case-insensitive) by createStudy(). */
  readonly name: string;
  /** Legend/objects-tree title, for example `BB` for Bollinger Bands. */
  readonly shortTitle?: string;
  /** Exact-match aliases (TradingView names such as `Moving Average Exponential`). */
  readonly aliases?: readonly string[];
  /** Search keywords for the indicators dialog; never used for createStudy() resolution. */
  readonly keywords?: readonly string[];
  readonly description?: string;
  readonly pane: "overlay" | "pane";
  readonly inputs: S;
  readonly plots: readonly StudyPlotDescriptor<P>[];
  readonly fills?: readonly StudyFillDescriptor<P>[];
  readonly levels?: readonly StudyLevelDescriptor[];
  /** Fixed pane range (RSI 0-100); auto-fits the visible values when omitted. */
  readonly range?: { readonly min: number; readonly max: number };
  /** Legend/axis precision: decimals, or `price` to use the symbol formatter. */
  readonly precision?: number | "price";
  readonly dependsOn?: readonly StudyDependency[];
  /** Custom legend label; the default is `shortTitle` plus the `inLabel` input values. */
  formatLabel?(inputs: StudyInputValues<S>): string;
}

/** Full-array indicator: recomputed after structural data changes. */
export interface ComputeIndicatorDefinition<S extends StudyInputSchema, P extends string>
  extends IndicatorDefinitionBase<S, P> {
  compute(bars: readonly Bar[], inputs: StudyInputValues<S>, ctx: StudyComputeContext): StudyOutputs<P>;
  init?: undefined;
  update?: undefined;
}

/**
 * Incremental indicator: init() + update() per bar. `compute` is optional;
 * without it the runtime replays update() from init() for full recomputes.
 */
export interface IncrementalIndicatorDefinition<S extends StudyInputSchema, P extends string, TState>
  extends IndicatorDefinitionBase<S, P> {
  init(inputs: StudyInputValues<S>, ctx: StudyComputeContext): TState;
  update: StudyUpdateFn<S, P, TState>;
  compute?(bars: readonly Bar[], inputs: StudyInputValues<S>, ctx: StudyComputeContext): StudyOutputs<P>;
}

export type IndicatorDefinition<S extends StudyInputSchema = StudyInputSchema, P extends string = string, TState = unknown> =
  | ComputeIndicatorDefinition<S, P>
  | IncrementalIndicatorDefinition<S, P, TState>;

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
