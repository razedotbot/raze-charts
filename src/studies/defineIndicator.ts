// defineIndicator(): the v2 indicator contract (AD-03) as a registrable
// StudyDefinition. The returned handle is a frozen v1-compatible adapter
// (name, pane, levels, defaults, a full-array `compute`) that also carries
// the validated v2 definition on `indicator`, so the registry, the
// Indicators menu, the legend and the painters keep working unchanged while
// the StudyStore runs typed inputs, plot descriptors and incremental update().
//
//   const Momentum = defineIndicator({
//     name: "Momentum",
//     pane: "pane",
//     inputs: { length: int(10, { min: 1 }), src: source("close") },
//     plots: [{ id: "mom", title: "Momentum", style: "line" }],
//     compute: (bars, { length, src }) => ({ mom: … }),
//   });
//   widget({ …, raze: { custom_studies: [Momentum] } });

import type {
  Bar,
  IncrementalIndicatorDefinition,
  IndicatorDefinition,
  ResolutionString,
  StudyComputeContext,
  StudyDefinition,
  StudyDependency,
  StudyFillDescriptor,
  StudyInputPrimitive,
  StudyInputSchema,
  StudyInputs,
  StudyInputValues,
  StudyLevelDescriptor,
  StudyOutputs,
  StudyPaneLevel,
  StudyPlotDescriptor,
  StudyPlotStyle,
  StudySeries,
  StudyUpdateMode,
} from "../types/charting_library";
import { humanizeInputId, normalizeInputSchema, resolveStudyInputs } from "./inputs";

/**
 * A registrable indicator: a v1 StudyDefinition adapter carrying its typed v2
 * definition. The bare `IndicatorHandle` accepts any handle (for lists of
 * indicators); the type parameters are inferred by defineIndicator().
 */
export interface IndicatorHandle<S extends StudyInputSchema = any, P extends string = string, TState = any>
  extends StudyDefinition {
  readonly indicator: IndicatorDefinition<S, P, TState>;
  readonly inputs: S;
  /**
   * Runs one study instance (the protocol between handles and the widget's
   * StudyStore). The execution code travels with the handle, so widgets that
   * never register a v2 indicator do not bundle it.
   */
  createRunner(inputs: StudyInputValues<StudyInputSchema>, ctx: StudyComputeContext, style: IndicatorSeriesStyle): IndicatorRunner;
}

/** The painted series, every plot's outputs and the primary values of one full run. */
export interface IndicatorRun {
  readonly series: StudySeries[];
  readonly outputs: IndicatorOutputArrays;
  /** The first painted (non-fill) series' values, for legacy single-value readers. */
  readonly values: (number | null)[];
}

/** Executes one study instance: full recomputes and single-bar incremental steps. */
export interface IndicatorRunner {
  /** Recompute every bar. Throws when compute()/update() fails or the outputs are misaligned. */
  full(bars: readonly Bar[]): IndicatorRun;
  /**
   * Advance by exactly one update() call for an appended bar or a replaced
   * forming bar, updating the arrays returned by full() in place. Returns
   * false when only a full recompute can bring the outputs up to date.
   */
  tick(bars: readonly Bar[], mode: StudyUpdateMode): boolean;
}

/** Per-plot style overrides applied on top of the plot descriptors. */
export interface StudyPlotOverride {
  color?: string;
  lineWidth?: number;
  /** TradingView numbering: 0 solid, 1 dotted, 2 dashed. */
  lineStyle?: 0 | 1 | 2;
  visible?: boolean;
}

/** Any concrete definition, for helpers that do not depend on its type parameters. */
export type AnyIndicatorDefinition = IndicatorDefinition<any, string, any>;

/** Full-array outputs, one aligned array per plot id. */
export type IndicatorOutputArrays = Record<string, (number | null)[]>;

const PLOT_STYLES: readonly StudyPlotStyle[] = ["line", "step", "histogram", "columns", "area", "circles", "cross", "shapes"];
const DEPENDENCIES: readonly StudyDependency[] = ["visibleRange", "symbol", "resolution", "timezone"];
const PLOT_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const warnedFills = new WeakSet<object>();

// ── Execution context ───────────────────────────────────────────────────────

/**
 * Build a read-only compute context for running a definition outside a
 * widget (tests, servers, screeners). Unset fields get neutral defaults.
 */
export function createStudyContext(fields: Partial<Omit<StudyComputeContext, "requestRecompute">> & {
  requestRecompute?: () => void;
} = {}): StudyComputeContext {
  return Object.freeze({
    symbol: fields.symbol ?? "",
    symbolInfo: fields.symbolInfo ?? null,
    resolution: fields.resolution ?? ("" as ResolutionString),
    timezone: fields.timezone ?? "Etc/UTC",
    visibleRange: fields.visibleRange ?? null,
    formatPrice: fields.formatPrice ?? ((value: number) => String(value)),
    now: fields.now ?? Date.now,
    requestRecompute: fields.requestRecompute ?? (() => {}),
  });
}

// ── Definition ──────────────────────────────────────────────────────────────

/**
 * Validate a v2 indicator definition and return a registrable handle. Throws
 * a TypeError (or a StudyInputError for the input schema) that names the
 * problem and the fix, so a malformed plugin fails at registration instead of
 * drawing nothing.
 */
export function defineIndicator<const S extends StudyInputSchema, P extends string, TState = unknown>(
  definition: IndicatorDefinition<S, P, TState>,
): IndicatorHandle<S, P, TState> {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("[raze-charts] defineIndicator() needs a definition object");
  }
  const name = typeof definition.name === "string" ? definition.name.trim() : "";
  if (!name) throw new TypeError("[raze-charts] defineIndicator() needs a non-empty name");
  const fail = (message: string): never => {
    throw new TypeError(`[raze-charts] defineIndicator("${name}"): ${message}`);
  };

  if (definition.pane !== "overlay" && definition.pane !== "pane") fail('pane must be "overlay" or "pane"');
  const inputs = normalizeInputSchema(definition.inputs ?? {}, name) as S;

  const incremental = typeof definition.update === "function";
  if (incremental && typeof definition.init !== "function") fail("update() needs an init(inputs, ctx) that returns the initial state");
  if (!incremental && definition.init !== undefined) fail("init() is only used together with update(); add update() or remove init()");
  if (!incremental && typeof definition.compute !== "function") {
    fail("provide compute(bars, inputs, ctx) for full-array studies, or init() + update() for incremental ones");
  }
  if (definition.compute !== undefined && typeof definition.compute !== "function") fail("compute must be a function");
  if (definition.formatLabel !== undefined && typeof definition.formatLabel !== "function") fail("formatLabel must be a function");

  const plots = normalizePlots(definition.plots, fail);
  const plotIds = new Set(plots.map((plot) => plot.id));
  const fills = normalizeFills(definition.fills, plotIds, fail);
  const levels = (definition.levels ?? []).map((level) => {
    if (!level || !Number.isFinite(level.value)) fail("every level needs a finite value");
    return Object.freeze({ ...level });
  });
  if (definition.range !== undefined) {
    const { min, max } = definition.range;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) fail("range needs finite min < max");
  }
  const { precision } = definition;
  if (precision !== undefined && precision !== "price" && !(Number.isInteger(precision) && precision >= 0 && precision <= 16)) {
    fail('precision must be an integer from 0 to 16 or "price"');
  }
  for (const dependency of definition.dependsOn ?? []) {
    if (!DEPENDENCIES.includes(dependency)) fail(`unknown dependency "${dependency}". Supported: ${DEPENDENCIES.join(", ")}`);
  }
  for (const key of ["aliases", "keywords"] as const) {
    const list = definition[key];
    if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== "string"))) fail(`${key} must be an array of strings`);
  }

  const indicator = Object.freeze({
    ...definition,
    name,
    inputs,
    plots: Object.freeze(plots),
    ...(fills.length ? { fills: Object.freeze(fills) } : {}),
    ...(levels.length ? { levels: Object.freeze(levels) } : {}),
  }) as IndicatorDefinition<S, P, TState>;

  if (fills.length > 1 && !warnedFills.has(definition)) {
    warnedFills.add(definition);
    console.warn(
      `[raze-charts] defineIndicator("${name}"): only the first fill ("${fills[0]!.id}") is painted today; ` +
        "the others are kept on the definition for the plot painter (see docs/capabilities.md).",
    );
  }

  const defaults: Record<string, StudyInputPrimitive> = {};
  for (const [id, input] of Object.entries(inputs)) defaults[id] = input.default;
  const firstColor = plots[0]?.color;
  if (firstColor) defaults.color = firstColor;

  const handle: IndicatorHandle<S, P, TState> = {
    name,
    pane: definition.pane,
    aliases: [...(definition.aliases ?? [])],
    keywords: [...(definition.keywords ?? [])],
    defaults,
    inputs,
    indicator,
    compute: (bars: Bar[], values: StudyInputs, ctx?: StudyComputeContext) => {
      const outputs = runIndicator(indicator, bars, stripLength(inputs, values), ctx);
      return { series: indicatorSeries(indicator, outputs, bars.length, { color: firstColor ?? "" }).series };
    },
    createRunner: (values, ctx, style) => createIndicatorRunner(indicator, values, ctx, style),
  };
  if (definition.shortTitle) {
    handle.shortTitle = definition.shortTitle;
    handle.label = definition.shortTitle;
  }
  if (definition.dependsOn?.length) handle.dependsOn = Object.freeze([...definition.dependsOn]);
  if (definition.range) handle.range = { min: definition.range.min, max: definition.range.max };
  if (levels.length) handle.levels = levels.map(toPaneLevel);
  if (typeof precision === "number") handle.formatValue = (value) => value.toFixed(precision);
  const formatLabel = definition.formatLabel;
  if (formatLabel) {
    handle.formatLabel = (values) => formatLabel.call(indicator, resolveStudyInputs(inputs, stripLength(inputs, values), name));
  }
  return Object.freeze(handle);
}

function normalizePlots<P extends string>(
  plots: readonly StudyPlotDescriptor<P>[] | undefined,
  fail: (message: string) => never,
): StudyPlotDescriptor<P>[] {
  if (!Array.isArray(plots) || plots.length === 0) fail("plots must list at least one { id, title, style } descriptor");
  const seen = new Set<string>();
  return plots!.map((plot) => {
    if (!plot || typeof plot !== "object") fail("every plot must be a descriptor object");
    if (typeof plot.id !== "string" || !PLOT_ID.test(plot.id)) fail(`plot id "${String(plot.id)}" must match [A-Za-z][A-Za-z0-9_]*`);
    if (seen.has(plot.id)) fail(`plot id "${plot.id}" is declared twice`);
    seen.add(plot.id);
    if (!PLOT_STYLES.includes(plot.style)) fail(`plot "${plot.id}" has unknown style "${String(plot.style)}". Supported: ${PLOT_STYLES.join(", ")}`);
    if (plot.color !== undefined && (typeof plot.color !== "string" || !plot.color)) fail(`plot "${plot.id}" color must be a CSS colour string`);
    if (plot.lineWidth !== undefined && !(Number.isFinite(plot.lineWidth) && plot.lineWidth > 0)) fail(`plot "${plot.id}" lineWidth must be positive`);
    if (plot.lineStyle !== undefined && plot.lineStyle !== 0 && plot.lineStyle !== 1 && plot.lineStyle !== 2) {
      fail(`plot "${plot.id}" lineStyle must be 0 (solid), 1 (dotted) or 2 (dashed)`);
    }
    if (plot.base !== undefined && !Number.isFinite(plot.base)) fail(`plot "${plot.id}" base must be finite`);
    return Object.freeze({ ...plot, title: plot.title || humanizeInputId(plot.id) });
  });
}

function normalizeFills<P extends string>(
  fills: readonly StudyFillDescriptor<P>[] | undefined,
  plotIds: ReadonlySet<string>,
  fail: (message: string) => never,
): StudyFillDescriptor<P>[] {
  const seen = new Set<string>();
  return (fills ?? []).map((fill) => {
    if (!fill || typeof fill.id !== "string" || !fill.id) fail("every fill needs a string id");
    if (seen.has(fill.id)) fail(`fill id "${fill.id}" is declared twice`);
    seen.add(fill.id);
    if (typeof fill.color !== "string" || !fill.color) fail(`fill "${fill.id}" needs a CSS colour`);
    const between = fill.between;
    if (Array.isArray(between)) {
      const [a, b] = between as readonly string[];
      if (!plotIds.has(a!) || !plotIds.has(b!) || a === b) {
        fail(`fill "${fill.id}" must name two different plots (declared: ${[...plotIds].join(", ")})`);
      }
    } else {
      const bounds = (between as { levels?: readonly number[] } | undefined)?.levels;
      if (!Array.isArray(bounds) || bounds.length !== 2 || !bounds.every(Number.isFinite)) {
        fail(`fill "${fill.id}" needs between: [plotA, plotB] or between: { levels: [a, b] }`);
      }
    }
    return Object.freeze({ ...fill });
  });
}

function toPaneLevel(level: StudyLevelDescriptor): StudyPaneLevel {
  const out: StudyPaneLevel = { value: level.value };
  if (level.dashed) out.dashed = true;
  if (level.axisLabel) out.axisLabel = true;
  return out;
}

/** v1 callers always pass `length`; drop it unless the schema declares it. */
function stripLength(schema: StudyInputSchema, values: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(values ?? {}) };
  if (!Object.prototype.hasOwnProperty.call(schema, "length")) delete out.length;
  return out;
}

// ── Running ─────────────────────────────────────────────────────────────────

function toNullable(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Check a compute() result and convert every plot to an aligned (number | null)[]. */
export function normalizeOutputs(
  definition: AnyIndicatorDefinition,
  raw: StudyOutputs<string> | null | undefined,
  length: number,
): IndicatorOutputArrays {
  if (!raw || typeof raw !== "object") {
    throw new TypeError(`[raze-charts] study "${definition.name}" compute() must return { ${definition.plots.map((p) => `${p.id}: values`).join(", ")} }`);
  }
  const out: IndicatorOutputArrays = {};
  for (const plot of definition.plots) {
    const values = raw[plot.id] as ArrayLike<number | null> | undefined;
    if (!values || typeof values.length !== "number") {
      throw new TypeError(`[raze-charts] study "${definition.name}" compute() returned no values for plot "${plot.id}"`);
    }
    if (values.length !== length) {
      throw new RangeError(`[raze-charts] study "${definition.name}" plot "${plot.id}" has ${values.length} values for ${length} bars; outputs must align 1:1 with bars`);
    }
    out[plot.id] = Array.isArray(values) ? values : Array.from(values, toNullable);
  }
  return out;
}

type UpdateStep = { readonly state: unknown; readonly values: Readonly<Record<string, number | null>> };

/** update() must return `{ state, values }`; anything else fails loudly. */
function checkStep(definition: AnyIndicatorDefinition, step: unknown): UpdateStep {
  if (!step || typeof step !== "object" || !("state" in step) || !(step as UpdateStep).values || typeof (step as UpdateStep).values !== "object") {
    throw new TypeError(`[raze-charts] study "${definition.name}" update() must return { state, values: { ${definition.plots.map((p) => p.id).join(", ")} } }`);
  }
  return step as UpdateStep;
}

/** State and outputs after replaying init()/update() over every bar. */
export interface IndicatorReplay {
  readonly outputs: IndicatorOutputArrays;
  /** State after every bar except the last (the forming bar's base). */
  readonly committed: unknown;
  /** State after the last bar. */
  readonly forming: unknown;
}

/** Run an incremental definition over `bars` from init(). */
export function replayIndicator(
  definition: IncrementalIndicatorDefinition<StudyInputSchema, string, unknown>,
  bars: readonly Bar[],
  inputs: StudyInputValues<StudyInputSchema>,
  ctx: StudyComputeContext,
): IndicatorReplay {
  const n = bars.length;
  const outputs: IndicatorOutputArrays = {};
  for (const plot of definition.plots) outputs[plot.id] = new Array<number | null>(n);
  let state = definition.init(inputs, ctx);
  let committed = state;
  for (let index = 0; index < n; index++) {
    if (index === n - 1) committed = state;
    const step = checkStep(definition, definition.update({ bar: bars[index]!, index, bars, mode: "append" }, state, inputs, ctx));
    state = step.state;
    for (const plot of definition.plots) outputs[plot.id]![index] = toNullable(step.values[plot.id]);
  }
  return { outputs, committed, forming: state };
}

/**
 * Run a definition (or a defineIndicator handle) over `bars` and return one
 * aligned array per plot. Inputs are resolved against the schema (defaults,
 * clamping, documented errors). Incremental definitions without compute()
 * replay update() from init().
 */
export function runIndicator<S extends StudyInputSchema, P extends string, TState>(
  definition: IndicatorDefinition<S, P, TState> | IndicatorHandle<S, P, TState>,
  bars: readonly Bar[],
  inputs?: Readonly<Record<string, unknown>>,
  ctx: StudyComputeContext = createStudyContext(),
): { [K in P]: (number | null)[] } {
  const target = ("indicator" in definition && definition.indicator ? definition.indicator : definition) as AnyIndicatorDefinition;
  const schema = normalizeInputSchema(target.inputs ?? {}, target.name);
  const values = resolveStudyInputs(schema, inputs, target.name);
  const outputs = typeof target.compute === "function"
    ? normalizeOutputs(target, target.compute(bars, values, ctx), bars.length)
    : replayIndicator(target as IncrementalIndicatorDefinition<StudyInputSchema, string, unknown>, bars, values, ctx).outputs;
  return outputs as { [K in P]: (number | null)[] };
}

/** Shallow freeze so an update() that mutates its input state fails loudly instead of corrupting replace-last ticks. */
function freezeState(state: unknown): unknown {
  return state !== null && typeof state === "object" ? Object.freeze(state) : state;
}

/**
 * The runner behind IndicatorHandle.createRunner(). Incremental definitions
 * keep two states: `committed` (every bar before the forming one) and
 * `forming` (after the last bar). A replaced forming bar re-runs update()
 * from `committed`; an appended bar promotes `forming` to `committed` first.
 */
export function createIndicatorRunner(
  definition: AnyIndicatorDefinition,
  inputs: StudyInputValues<StudyInputSchema>,
  ctx: StudyComputeContext,
  style: IndicatorSeriesStyle,
): IndicatorRunner {
  let outputs: IndicatorOutputArrays = {};
  let constants: ConstantSeries[] = [];
  let committed: unknown;
  let forming: unknown;
  /** Bars the outputs and states describe; -1 while they are stale. */
  let length = -1;
  return {
    full(bars) {
      length = -1;
      if (typeof definition.update === "function") {
        const replay = replayIndicator(definition as IncrementalIndicatorDefinition<StudyInputSchema, string, unknown>, bars, inputs, ctx);
        outputs = replay.outputs;
        committed = freezeState(replay.committed);
        forming = replay.forming;
      } else {
        outputs = normalizeOutputs(definition, definition.compute!(bars, inputs, ctx), bars.length);
      }
      length = bars.length;
      const built = indicatorSeries(definition, outputs, bars.length, style);
      constants = built.constants;
      const values = built.series.find((item) => item.style !== "band")?.values ?? outputs[definition.plots[0]!.id] ?? [];
      return { series: built.series, outputs, values };
    },
    tick(bars, mode) {
      const n = bars.length;
      if (typeof definition.update !== "function" || n === 0 || length !== (mode === "append" ? n - 1 : n)) return false;
      // After an append the old forming bar is final: its state becomes the base.
      const base = mode === "append" ? freezeState(forming) : committed;
      const index = n - 1;
      let step: UpdateStep;
      try {
        step = checkStep(definition, definition.update({ bar: bars[index]!, index, bars, mode }, base, inputs, ctx));
      } catch (error) {
        length = -1;
        if (error instanceof TypeError && Object.isFrozen(base) && !error.message.startsWith("[raze-charts]")) {
          throw new TypeError(`${error.message} (update() must return a new state instead of mutating the one it receives)`);
        }
        throw error;
      }
      if (mode === "append") committed = base;
      forming = step.state;
      for (const plot of definition.plots) {
        const values = outputs[plot.id]!;
        values.length = n;
        values[index] = toNullable(step.values[plot.id]);
      }
      for (const constant of constants) {
        constant.values.length = n;
        constant.values[index] = constant.value;
      }
      length = n;
      return true;
    },
  };
}

// ── Series ──────────────────────────────────────────────────────────────────

/** Style inputs for indicatorSeries(). */
export interface IndicatorSeriesStyle {
  /** Colour of the first plot (the study colour); other plots use their own or the palette. */
  color: string;
  palette?: readonly string[];
  /** Palette index of the first plot. */
  paletteOffset?: number;
  overrides?: Readonly<Record<string, StudyPlotOverride>>;
}

/** Level-fill edges that must grow with the bars. */
export interface ConstantSeries {
  readonly values: (number | null)[];
  readonly value: number;
}

/**
 * Map plot outputs onto painter series. Hidden plots stay in the outputs but
 * are not painted; `histogram`/`columns` paint as bars and every other style
 * as a line (the requested style travels on `plotStyle`). The first fill
 * becomes a `band` pair sharing the plot arrays, which the painter fills.
 */
export function indicatorSeries(
  definition: AnyIndicatorDefinition,
  outputs: IndicatorOutputArrays,
  length: number,
  style: IndicatorSeriesStyle,
): { series: StudySeries[]; constants: ConstantSeries[] } {
  const palette = style.palette ?? [];
  const series: StudySeries[] = [];
  definition.plots.forEach((plot, index) => {
    const override = style.overrides?.[plot.id];
    if ((override?.visible ?? plot.visible) === false) return;
    const paletteColor = palette.length ? palette[((style.paletteOffset ?? 0) + index) % palette.length] : undefined;
    const item: StudySeries = {
      id: plot.id,
      name: plot.title,
      values: outputs[plot.id] ?? [],
      style: plot.style === "histogram" || plot.style === "columns" ? "histogram" : "line",
      plotStyle: plot.style,
      color: override?.color || (index === 0 && style.color) || plot.color || paletteColor || style.color,
    };
    const lineWidth = override?.lineWidth ?? plot.lineWidth;
    const lineStyle = override?.lineStyle ?? plot.lineStyle;
    if (lineWidth !== undefined) item.lineWidth = lineWidth;
    if (lineStyle !== undefined) item.lineStyle = lineStyle;
    if (plot.base !== undefined) item.base = plot.base;
    if (plot.inLegend === false) item.inLegend = false;
    series.push(item);
  });

  const constants: ConstantSeries[] = [];
  const fill = definition.fills?.[0];
  if (fill) {
    const edge = (values: (number | null)[]): StudySeries => ({ values, style: "band", color: fill.color, inLegend: false, fill: fill.id, ...(fill.title ? { name: fill.title } : {}) });
    if (Array.isArray(fill.between)) {
      const [a, b] = fill.between as readonly string[];
      series.push(edge(outputs[a!] ?? []), edge(outputs[b!] ?? []));
    } else {
      const [a, b] = (fill.between as { levels: readonly [number, number] }).levels;
      for (const value of [a, b]) {
        const values = new Array<number | null>(length).fill(value);
        constants.push({ values, value });
        series.push(edge(values));
      }
    }
  }
  return { series, constants };
}
