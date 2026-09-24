// Indicator definitions (built-in and `raze.custom_studies`), the typed input
// schema and execution context shared by both study contracts, and the
// Indicators panel presets.
//
// Two contracts are supported:
//   - v1 `StudyDefinition`: length/color shorthand plus a full-array compute().
//     It may declare a typed `inputs` schema that validates, clamps and
//     forwards every input.
//   - v2 `IndicatorDefinition` (registered through `defineIndicator()` from
//     `@razedotbot/charts/studies`): typed inputs, plot/fill/level
//     descriptors, and either a full-array compute() or pure init()/update()
//     steps that run once per tick.

import type { ResolutionString } from "./common";
import type { Bar, LibrarySymbolInfo } from "./datafeed";

// ── Input schema ────────────────────────────────────────────────────────────

/** Price source selectable by `source` inputs. */
export type StudySource = "open" | "high" | "low" | "close" | "hl2" | "hlc3" | "ohlc4" | "hlcc4" | "volume";

/** Any value an input can hold (after validation). */
export type StudyInputPrimitive = number | string | boolean;

/** Fields shared by every input descriptor. */
export interface StudyInputBase<V> {
  /**
   * Settings-dialog label, shown verbatim: plugins localise their own titles,
   * groups and tooltips. An empty title is filled from the input id
   * (`fastLength` -> `Fast length`) when the definition is registered.
   */
  readonly title: string;
  readonly default: V;
  /** Dialog section heading. */
  readonly group?: string;
  /** Inputs sharing an `inline` key render on one dialog row. */
  readonly inline?: string;
  readonly tooltip?: string;
  /** Include the value in the legend label (`MACD 12 26 close 9`). Defaults to true for numeric and source inputs. */
  readonly inLabel?: boolean;
}

/** Integer input. Out-of-range values clamp to `min`/`max`; fractions round to the nearest integer. */
export interface StudyIntInput extends StudyInputBase<number> {
  readonly type: "int";
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}
/** Decimal input. Out-of-range values clamp to `min`/`max`. */
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
/** One of a fixed list of string values. */
export interface StudySelectInput<V extends string = string> extends StudyInputBase<V> {
  readonly type: "select";
  readonly options: readonly V[] | readonly { readonly value: V; readonly title: string }[];
}
/** CSS colour string. */
export interface StudyColorInput extends StudyInputBase<string> {
  readonly type: "color";
}
/** TradingView session string, for example `0930-1600`, `0930-1600:23456` or `24x7`. */
export interface StudySessionInput extends StudyInputBase<string> {
  readonly type: "session";
}
/** Unix seconds. */
export interface StudyTimeInput extends StudyInputBase<number> {
  readonly type: "time";
}
/** A price level in the symbol's units. */
export interface StudyPriceInput extends StudyInputBase<number> {
  readonly type: "price";
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
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

/** Input id -> descriptor. Ids are `[A-Za-z][A-Za-z0-9_]*` and are stored in snapshots. */
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

/**
 * The typed input values of a definition: `StudyInputsOf<typeof MyIndicator>`.
 * Use it to register a custom study's inputs in `StudyInputsRegistry`.
 */
export type StudyInputsOf<D> = D extends { readonly inputs?: infer S }
  ? S extends StudyInputSchema ? StudyInputValues<S> : never
  : never;

/**
 * Study name -> input values, used to type `createStudy(name, …, inputs)`.
 * Empty by default; augment it for your registered studies so typos and
 * wrongly typed inputs fail to compile:
 *
 * ```ts
 * declare module "@razedotbot/charts" {
 *   interface StudyInputsRegistry { "My Indicator": StudyInputsOf<typeof MyIndicator> }
 * }
 * ```
 */
export interface StudyInputsRegistry {}

/**
 * The `inputs` argument accepted by createStudy() for a study name. Registered
 * names take a partial, exactly typed input object (missing inputs use their
 * defaults); any other name takes an open map of numbers, strings and
 * booleans (objects and arrays reject at runtime).
 */
export type StudyCreateInputs<N extends string> = N extends keyof StudyInputsRegistry
  ? { readonly [K in keyof StudyInputsRegistry[N]]?: StudyInputsRegistry[N][K] }
  : Readonly<Record<string, StudyInputPrimitive | undefined>>;

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
  /**
   * Visible bar-index window (fractional). Present only when the definition
   * lists `visibleRange` in `dependsOn`; such studies recompute (throttled)
   * when the chart pans or zooms.
   */
  readonly visibleRange: Readonly<{ from: number; to: number }> | null;
  /** Symbol-aware price formatter. */
  readonly formatPrice: (price: number) => string;
  /** Server-corrected wall clock in milliseconds. */
  readonly now: () => number;
  /** Ask for a throttled full recompute (for example after an async resource resolves). */
  requestRecompute(): void;
}

// ── Plots, fills and levels ─────────────────────────────────────────────────

/**
 * How a plot is drawn. The current study painter draws `histogram` and
 * `columns` as bars and every other style as a line (see docs/capabilities.md);
 * the requested style travels on `StudySeries.plotStyle`.
 */
export type StudyPlotStyle = "line" | "step" | "histogram" | "columns" | "area" | "circles" | "cross" | "shapes";

// ── v1 contract ─────────────────────────────────────────────────────────────

export interface StudyPaneLevel {
  value: number;
  /** Draw the guide dashed (e.g. the RSI 50 midline). */
  dashed?: boolean;
  /** Show the value on the sub-pane's right axis. */
  axisLabel?: boolean;
}

/** Painter style: `band` pairs fill between the first two band series. */
export type StudySeriesStyle = "line" | "histogram" | "band";
export interface StudySeries {
  values: (number | null)[];
  style?: StudySeriesStyle;
  color?: string;
  name?: string;
  /** Plot id from the definition (v2 indicators). */
  id?: string;
  /** Requested plot style (v2 indicators); `style` is the painter fallback. */
  plotStyle?: StudyPlotStyle;
  lineWidth?: number;
  /** TradingView numbering: 0 solid, 1 dotted, 2 dashed. */
  lineStyle?: 0 | 1 | 2;
  /** Histogram/columns baseline. */
  base?: number;
  /** false hides the plot while keeping its values (data window, legend). */
  visible?: boolean;
  /** false keeps the series out of legend value lists (fill edges, helper series). */
  inLegend?: boolean;
  /** Set on the two `band` series that paint a fill: the fill descriptor id. */
  fill?: string;
}
/** Input bag handed to a v1 compute(): every declared input plus the length shorthand. */
export interface StudyInputs {
  length: number;
  [key: string]: StudyInputPrimitive;
}
export type StudyComputeResult = (number | null)[] | { series: StudySeries[] };

/** A pluggable indicator: built-ins (EMA/SMA/RSI) and `raze.custom_studies` share this shape. */
export interface StudyDefinition {
  /** Canonical name — matched case-insensitively by createStudy(); shown in the legend. */
  name: string;
  /** Legend/objects-tree title, for example `BB` for Bollinger Bands. Defaults to `name`. */
  shortTitle?: string;
  /** Exact-match lookup aliases (e.g. "moving average exponential"). */
  aliases?: string[];
  /** Search terms for pickers (`searchStudies()` from `@razedotbot/charts/studies`); never used to resolve createStudy()/load() names. */
  keywords?: string[];
  /** "overlay" plots on the price pane; "pane" renders in its own sub-pane. */
  pane: "overlay" | "pane";
  /**
   * Default input values. `length` and `color` are the classic shorthand;
   * every other entry is forwarded to compute() unless the caller overrides it.
   */
  defaults?: { length?: number; color?: string; [key: string]: StudyInputPrimitive | undefined };
  /**
   * Typed input schema. When present, createStudy()/load() inputs are
   * validated against it: unknown ids and wrongly typed values throw a
   * `StudyInputError`, numbers clamp to `min`/`max` (with a warning), and
   * compute() receives every input with its default filled in.
   */
  inputs?: StudyInputSchema;
  /** Recompute on these changes as well as on new bars. */
  dependsOn?: readonly StudyDependency[];
  /** Fixed sub-pane value range (e.g. RSI 0–100). Auto-fits to visible values when omitted. */
  range?: { min: number; max: number };
  /** Horizontal guide levels drawn in the sub-pane. */
  levels?: StudyPaneLevel[];
  /** Sub-pane corner label; defaults to `name`. */
  label?: string;
  /** Legend value formatter; defaults to price formatting (overlay) or 1 decimal (pane). */
  formatValue?: (value: number) => string;
  /** Custom legend label from the effective inputs; the default is `shortTitle` plus the `inLabel` input values. */
  formatLabel?: (inputs: StudyInputs) => string;
  /**
   * Values aligned 1:1 with `bars`; null = warm-up gap. Arrays stay one line;
   * objects carry MACD/bands. `ctx` exposes the symbol, resolution, timezone
   * and (for `dependsOn: ["visibleRange"]`) the visible range. The store
   * always passes it; code that calls compute() itself builds one with
   * `createStudyContext()` from `@razedotbot/charts/studies`.
   */
  compute: (bars: Bar[], inputs: StudyInputs, ctx: StudyComputeContext) => StudyComputeResult;
  /**
   * The v2 definition behind an adapter returned by `defineIndicator()`. The
   * store runs it directly (typed inputs, plot descriptors, incremental
   * update()); `compute` above is its full-array fallback.
   */
  readonly indicator?: IndicatorDefinition<any, any, any>;
}

// ── v2 contract ─────────────────────────────────────────────────────────────

/** Values aligned 1:1 with bars. null or NaN is a gap (warm-up or missing data). */
export type StudyValues = (number | null)[] | Float64Array;

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

export interface IndicatorDefinitionBase<S extends StudyInputSchema, P extends string> {
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

// ── Presets ─────────────────────────────────────────────────────────────────

export interface IndicatorPreset {
  /** Row label; defaults to `"<name> <length>"`. */
  label?: string;
  /** Study name resolved against built-ins + `custom_studies`. */
  name: string;
  length?: number;
  color?: string;
}
