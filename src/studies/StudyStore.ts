// Active studies on a chart. Recomputes when bars change; overlay studies
// share the price pane, pane studies render in per-definition sub-panes.
// Which studies exist at all is the StudyRegistry's business — this store only
// tracks live instances.
//
// Two contracts run here (docs/indicators.md):
//   - v1 StudyDefinition: full-array compute(bars, inputs, ctx), with an
//     optional typed `inputs` schema. EMA/SMA/RSI keep an O(1) tick path.
//   - v2 IndicatorDefinition (defineIndicator): typed inputs and plot
//     descriptors; incremental definitions advance with one update() call per
//     appended bar or forming-bar replacement and never recompute on ticks.
//
// Undo history stores specs (id, name, length, colour, flags, inputs), never
// computed arrays: restoring a study recomputes it.

import type {
  Bar,
  EntityId,
  StudyComputeContext,
  StudyDefinition,
  StudyInputPrimitive,
  StudyInputSchema,
  StudyInputs,
  StudyInputValues,
  StudySeries,
} from "../types/charting_library";
import { resolveTimezone, type ChartContext } from "../core/context";
import type { CommandStack } from "../core/CommandStack";
import { IdAllocator, idSlug } from "../core/ids";
import { Delegate } from "../util/delegate";
// Type-only: v2 execution code travels with defineIndicator() handles.
import type { IndicatorHandle, IndicatorRunner, StudyPlotOverride } from "./defineIndicator";
import { describeInputValue, resolveStudyInputs, StudyInputError } from "./inputs";
import { rsiState, sourceValue } from "./calc";
import { BUILTIN_STUDIES, StudyRegistry } from "./registry";
import type { StudyChange, StudyChangeKind } from "./types";

export type { StudyPlotOverride } from "./defineIndicator";

/** @deprecated Studies are registry-driven; any registered name is valid. */
export type StudyKind = string;

export interface StudySpec {
  /** Internal snapshot restore id; regular callers should let the store allocate it. */
  id?: EntityId;
  /** Study name resolved against the registry (built-ins + custom). */
  name: string;
  /** 0 / absent → the definition's default length. */
  length?: number;
  /** "" / absent → the definition's default color. */
  color?: string;
  lock?: boolean;
  forceOverlay?: boolean;
  /**
   * Input values, validated by the store. Definitions with an input schema
   * coerce them and clamp numbers to min/max; unknown ids and wrongly typed
   * values are invalid. Definitions without a schema receive numbers,
   * strings and booleans on top of their defaults; other values are invalid.
   * `invalidInputs` decides what happens to invalid inputs.
   */
  inputs?: Readonly<Record<string, unknown>>;
  /**
   * What to do with inputs that do not validate:
   * - `"throw"` (default): throw a StudyInputError and add nothing.
   * - `"default"`: drop unknown ids and use the declared default for invalid
   *   values, log one warning per study and record it on
   *   `StudyInstance.inputWarning`. load() uses this, as do restore() and
   *   undo/redo, so a plugin whose input schema evolved cannot break a saved layout.
   */
  invalidInputs?: "throw" | "default";
  /** Per-plot style overrides for v2 indicators, keyed by plot id. */
  plots?: Readonly<Record<string, StudyPlotOverride>>;
  /** Add without an undo step (TradingView `options.disableUndo`). */
  disableUndo?: boolean;
}

/** What undo history and snapshots keep for a study: its spec, never its values. */
export interface StudySnapshot {
  id: EntityId;
  name: string;
  length: number;
  color: string;
  lock: boolean;
  forceOverlay: boolean;
  inputs: Readonly<Record<string, StudyInputPrimitive>>;
  plots?: Readonly<Record<string, StudyPlotOverride>>;
}

/** Editable study properties for update(). */
export interface StudyPatch {
  /** Merged over the current inputs and validated like createStudy() inputs. */
  inputs?: Readonly<Record<string, StudyInputPrimitive>>;
  length?: number;
  color?: string;
  plots?: Readonly<Record<string, StudyPlotOverride>>;
}

export interface StudyInstance {
  id: EntityId;
  def: StudyDefinition;
  /** Canonical definition name (legend label prefix). */
  name: string;
  /**
   * Length shorthand: a schema's `length` input when it declares one;
   * otherwise the requested or default length (14 for v1 definitions without
   * a default, 0 for schema definitions without one).
   */
  length: number;
  color: string;
  /** Values aligned with context.bars; null during warm-up. */
  values: (number | null)[];
  series: StudySeries[];
  lock: boolean;
  forceOverlay: boolean;
  /** Effective inputs: definition defaults merged with the caller's values (what save() persists). */
  inputs: Record<string, StudyInputPrimitive>;
  /** Per-plot overrides (v2 indicators). */
  plots?: Readonly<Record<string, StudyPlotOverride>>;
  /** Every plot's values by plot id, including hidden plots (v2 indicators). */
  outputs?: Readonly<Record<string, (number | null)[]>>;
  /** Why the last compute/update failed, or null. */
  error: string | null;
  /**
   * Set when restored inputs no longer validated and were replaced by their
   * defaults (`invalidInputs: "default"`): which inputs, and why.
   */
  inputWarning?: string;
}

const FALLBACK_COLORS = ["#f5a623", "#26a69a", "#2962ff", "#e040fb", "#7E57C2"];
/** Minimum spacing between context-driven recomputes (pan, zoom, requestRecompute). */
export const STUDY_RECOMPUTE_THROTTLE_MS = 100;

type BuiltinKind = "ema" | "sma" | "rsi";
type BarsMutation = "none" | "append" | "replace-last" | "full";

interface BarFingerprint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | undefined;
}

interface BarsSnapshot {
  ref: Bar[];
  length: number;
  first: BarFingerprint | null;
  penultimate: BarFingerprint | null;
  last: BarFingerprint | null;
}

interface RsiRuntime {
  avgGains: (number | null)[];
  avgLosses: (number | null)[];
}

interface StudyRuntime {
  kind: BuiltinKind | null;
  rsi: RsiRuntime | null;
  ctx: StudyComputeContext;
  /** v2 indicators (defineIndicator handles). */
  runner: IndicatorRunner | null;
}

interface BuiltinDescriptor {
  kind: BuiltinKind;
  compute: StudyDefinition["compute"];
}

const BUILTIN_KINDS = new Map<StudyDefinition, BuiltinDescriptor>();
for (const definition of BUILTIN_STUDIES) {
  const name = definition.name.toLowerCase();
  if (name === "ema" || name === "sma" || name === "rsi") {
    BUILTIN_KINDS.set(definition, { kind: name, compute: definition.compute });
  }
}

function fingerprint(bar: Bar | undefined): BarFingerprint | null {
  if (!bar) return null;
  return {
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
}

function sameBar(bar: Bar | undefined, value: BarFingerprint | null): boolean {
  if (!bar || !value) return !bar && !value;
  return bar.time === value.time
    && bar.open === value.open
    && bar.high === value.high
    && bar.low === value.low
    && bar.close === value.close
    && bar.volume === value.volume;
}

/** The close as the calc kernels read it: zero/negative are values, non-finite is a gap. */
function closeOf(bar: Bar): number {
  return sourceValue(bar, "close");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInputPrimitive(value: unknown): value is StudyInputPrimitive {
  return typeof value === "number" || typeof value === "string" || typeof value === "boolean";
}

/** A StudyInputError's message without its `[raze-charts] study "X" input "y": ` prefix. */
function inputErrorDetail(error: StudyInputError): string {
  const prefix = `[raze-charts] study "${error.study}"${error.input === null ? "" : ` input "${error.input}"`}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

type InvalidInputs = NonNullable<StudySpec["invalidInputs"]>;

function copyPlots(plots: Readonly<Record<string, StudyPlotOverride>> | undefined): Record<string, StudyPlotOverride> | undefined {
  if (!plots) return undefined;
  const out: Record<string, StudyPlotOverride> = {};
  for (const [id, override] of Object.entries(plots)) out[id] = { ...override };
  return out;
}

export class StudyStore {
  /** Fires for every add, remove, input/style change, recompute and compute error. */
  readonly changed = new Delegate<[StudyChange]>();
  private items = new Map<EntityId, StudyInstance>();
  private runtimes = new Map<EntityId, StudyRuntime>();
  private readonly subscriptionOwner = {};
  private readonly ids: IdAllocator;
  private barsSnapshot: BarsSnapshot;
  private readonly pendingRecompute = new Set<EntityId>();
  private recomputeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRecomputeAt = -Infinity;
  private readonly onDataChanged = (): void => this.handleDataChanged();
  private readonly onRangeChanged = (): void => this.scheduleDependents("visibleRange");
  private readonly onTimezoneChanged = (): void => this.scheduleDependents("timezone");

  constructor(
    private readonly context: ChartContext,
    readonly registry: StudyRegistry = new StudyRegistry(),
    private readonly commands?: CommandStack,
  ) {
    // Per-widget ids (AD-10). Contexts built without the seams (tests,
    // headless hosts) get a private allocator.
    this.ids = context.ids ?? new IdAllocator();
    this.barsSnapshot = this.captureBars();
    const owner = this.subscriptionOwner;
    this.context.dataChanged.subscribe(owner, this.onDataChanged as (...args: never[]) => void);
    this.context.rangeChanged?.subscribe(owner, this.onRangeChanged as (...args: never[]) => void);
    // Drag, wheel, pinch and axis gestures still write visibleRange directly
    // and publish only viewportChanged (until every writer goes through
    // setViewport). setViewport fires both events; the pending set coalesces them.
    this.context.viewportChanged?.subscribe(owner, this.onRangeChanged as (...args: never[]) => void);
    this.context.timezoneChanged?.subscribe(owner, this.onTimezoneChanged as (...args: never[]) => void);
  }

  list(): StudyInstance[] {
    return Array.from(this.items.values());
  }

  get(id: EntityId): StudyInstance | null {
    return this.items.get(id) ?? null;
  }

  /** Distinct definitions of active sub-pane studies, in insertion order. */
  paneDefs(): StudyDefinition[] {
    const out: StudyDefinition[] = [];
    for (const s of this.items.values()) {
      if (s.def.pane === "pane" && !s.forceOverlay && !out.includes(s.def)) out.push(s.def);
    }
    return out;
  }

  /** Instances rendered in the sub-pane of `def`. */
  paneStudies(def: StudyDefinition): StudyInstance[] {
    return this.list().filter((s) => s.def === def);
  }

  /**
   * Returns the new study id, or null when `spec.name` is not in the registry
   * or `spec.id` is already live. Throws a StudyInputError for invalid inputs
   * unless `spec.invalidInputs` is `"default"`.
   */
  add(spec: StudySpec): EntityId | null {
    const def = this.registry.resolve(spec.name);
    if (!def) return null;
    if (spec.id && this.items.has(spec.id)) return null;
    const study = this.instantiate(def, spec, this.items.size, spec.invalidInputs ?? "throw");
    const id = spec.id ?? this.ids.next("study", {
      label: `study_${idSlug(def.name)}`,
      isTaken: (candidate) => this.items.has(candidate as EntityId),
    }) as EntityId;
    if (spec.id) this.ids.reserve("study", id);
    study.id = id;
    this.initialiseRuntime(study);
    this.recompute(study);
    this.items.set(id, study);
    this.context.requestPaint();
    this.emit("add", id);
    if (!spec.disableUndo) {
      const snapshot = this.snapshot(study);
      const index = this.items.size - 1;
      this.commands?.push({
        undo: () => { this.remove(id); },
        redo: () => { this.restore(snapshot, index); },
      });
    }
    return id;
  }

  remove(id: EntityId): boolean {
    const before = this.items.get(id);
    const index = Array.from(this.items.keys()).indexOf(id);
    if (!before || !this.items.delete(id)) return false;
    const snapshot = this.snapshot(before);
    this.dropRuntime(id);
    this.context.requestPaint();
    this.emit("remove", id);
    this.commands?.push({
      undo: () => { this.restore(snapshot, index); },
      redo: () => { this.remove(id); },
    });
    return true;
  }

  clear(): void {
    if (this.items.size === 0) return;
    const snapshots = this.list().map((study, index) => ({ study: this.snapshot(study), index }));
    const ids = Array.from(this.items.keys());
    this.items.clear();
    for (const id of ids) this.dropRuntime(id);
    this.context.requestPaint();
    for (const id of ids) this.emit("remove", id);
    this.commands?.push({
      undo: () => {
        for (const snapshot of snapshots) this.restore(snapshot.study, snapshot.index);
      },
      redo: () => { this.clear(); },
    });
  }

  has(id: EntityId): boolean {
    return this.items.has(id);
  }

  /**
   * Change inputs, length, colour or plot styles in place: the id is kept,
   * the study recomputes and one undo step is recorded. Returns false for an
   * unknown id; throws a StudyInputError for invalid inputs.
   */
  update(id: EntityId, patch: StudyPatch): boolean {
    const current = this.items.get(id);
    if (!current) return false;
    const before = this.snapshot(current);
    const inputs: Record<string, unknown> = { ...before.inputs, ...(patch.inputs ?? {}) };
    // A schema-declared `length` input is the length: keep the shorthand in sync.
    if (patch.length !== undefined && "length" in before.inputs && !(patch.inputs && "length" in patch.inputs)) {
      inputs.length = patch.length;
    }
    const plots = patch.plots ? { ...(before.plots ?? {}), ...copyPlots(patch.plots) } : before.plots;
    const next = this.instantiate(current.def, {
      ...before,
      inputs,
      length: patch.length ?? before.length,
      color: patch.color ?? before.color,
      ...(plots ? { plots } : {}),
    }, 0, "throw");
    next.id = id;
    const after = this.snapshot(next);
    if (JSON.stringify(after) === JSON.stringify(before)) return true;
    const inputsChanged = after.length !== before.length || JSON.stringify(after.inputs) !== JSON.stringify(before.inputs);
    this.applySnapshot(current, after);
    this.commands?.push({
      undo: () => { this.reapply(id, before); },
      redo: () => { this.reapply(id, after); },
    });
    this.emit(inputsChanged ? "inputs" : "style", id);
    return true;
  }

  /** The spec a study would be saved or restored from. */
  snapshot(study: StudyInstance): StudySnapshot {
    const out: StudySnapshot = {
      id: study.id,
      name: study.name,
      length: study.length,
      color: study.color,
      lock: study.lock,
      forceOverlay: study.forceOverlay,
      inputs: { ...study.inputs },
    };
    const plots = copyPlots(study.plots);
    if (plots) out.plots = plots;
    return out;
  }

  /**
   * Restore a snapshot without allocating a new public entity id. Inputs that
   * no longer validate fall back to their defaults with a warning
   * (`invalidInputs: "default"`).
   */
  restore(snapshot: StudySnapshot, index?: number): boolean {
    const def = this.registry.resolve(snapshot.name);
    if (!def) return false;
    const study = this.instantiate(def, snapshot, index ?? this.items.size, "default");
    study.id = snapshot.id;
    this.ids.reserve("study", study.id);
    this.initialiseRuntime(study);
    this.recompute(study);
    if (this.items.has(study.id) || index === undefined || index >= this.items.size) {
      this.items.set(study.id, study);
    } else {
      const entries = Array.from(this.items.entries());
      entries.splice(Math.max(0, index), 0, [study.id, study]);
      this.items = new Map(entries);
    }
    this.context.requestPaint();
    this.emit("add", study.id);
    return true;
  }

  // ── Instances ─────────────────────────────────────────────────────────────

  /**
   * Resolve a spec against its definition: length, colour and effective
   * inputs. `invalidInputs` decides whether invalid inputs throw or fall back
   * to their defaults (restores).
   */
  private instantiate(
    def: StudyDefinition,
    spec: Omit<StudySpec, "name">,
    paletteIndex: number,
    invalidInputs: InvalidInputs,
  ): StudyInstance {
    const schema = def.inputs ?? null;
    const defaults = def.defaults ?? {};
    // Lenient mode collects each problem instead of throwing.
    const lenient = invalidInputs === "default";
    const issues: string[] = [];
    const note = (error: StudyInputError, dropped: boolean): void => {
      issues.push(`input "${error.input ?? "?"}" ${dropped ? "dropped" : "reset to its default"}: ${inputErrorDetail(error)}`);
    };
    let inputs: Record<string, StudyInputPrimitive>;
    let length: number;
    if (schema) {
      const raw: Record<string, unknown> = { ...(spec.inputs ?? {}) };
      // The classic shorthand feeds a declared `length`/`color` input.
      if (spec.length && schema.length && raw.length === undefined) raw.length = spec.length;
      if (spec.color && schema.color?.type === "color" && raw.color === undefined) raw.color = spec.color;
      inputs = { ...resolveStudyInputs(schema, raw, def.name, {
        onClamp: ({ id, value, clamped }) =>
          console.warn(`[raze-charts] study "${def.name}" input "${id}" = ${value} is out of range; clamped to ${clamped}`),
        ...(lenient ? { onInvalid: (error: StudyInputError) => note(error, error.code === "unknown-input") } : {}),
      }) };
      const declared = inputs.length;
      length = typeof declared === "number" ? declared : Math.max(0, Math.floor(spec.length || defaults.length || 0));
    } else {
      inputs = {};
      for (const [key, value] of Object.entries(defaults)) {
        if (key !== "length" && key !== "color" && value !== undefined) inputs[key] = value;
      }
      // Without a schema any number, string or boolean is forwarded; other
      // values (objects, arrays, functions) cannot be saved or edited.
      for (const [key, value] of Object.entries(spec.inputs ?? {})) {
        if (value === undefined || value === null) continue;
        if (isInputPrimitive(value)) {
          inputs[key] = value;
          continue;
        }
        const error = new StudyInputError(
          "invalid-value",
          def.name,
          key,
          `expected a number, string or boolean, got ${describeInputValue(value)}`,
        );
        if (!lenient) throw error;
        note(error, !Object.prototype.hasOwnProperty.call(inputs, key));
      }
      length = Math.max(1, Math.floor(spec.length || defaults.length || 14));
    }
    const study: StudyInstance = {
      id: "" as EntityId,
      def,
      name: def.name,
      length,
      color: spec.color || (typeof defaults.color === "string" ? defaults.color : "")
        || FALLBACK_COLORS[paletteIndex % FALLBACK_COLORS.length]!,
      values: [],
      series: [],
      lock: spec.lock ?? false,
      forceOverlay: spec.forceOverlay ?? false,
      inputs,
      error: null,
    };
    const plots = copyPlots(spec.plots);
    if (plots) study.plots = plots;
    if (issues.length) {
      study.inputWarning = issues.join("; ");
      console.warn(
        `[raze-charts] study "${def.name}"${spec.id ? ` (${spec.id})` : ""}: saved inputs no longer match its definition — `
          + `${study.inputWarning}. Save the layout again to store the current inputs.`,
      );
    }
    return study;
  }

  /** Replace an instance's spec in place (update/undo/redo) and recompute it. */
  private applySnapshot(study: StudyInstance, snapshot: StudySnapshot): void {
    // Snapshots are history: `update()` validated them strictly already, and a
    // definition re-registered since then must not make undo/redo throw.
    const resolved = this.instantiate(study.def, snapshot, 0, "default");
    study.length = resolved.length;
    study.color = resolved.color;
    study.inputs = resolved.inputs;
    if (resolved.plots) study.plots = resolved.plots;
    else delete study.plots;
    if (resolved.inputWarning) study.inputWarning = resolved.inputWarning;
    else delete study.inputWarning;
    this.initialiseRuntime(study);
    this.recompute(study);
    this.context.requestPaint();
  }

  private reapply(id: EntityId, snapshot: StudySnapshot): void {
    const study = this.items.get(id);
    if (!study) return;
    const inputsChanged = snapshot.length !== study.length || JSON.stringify(snapshot.inputs) !== JSON.stringify(study.inputs);
    this.applySnapshot(study, snapshot);
    this.emit(inputsChanged ? "inputs" : "style", id);
  }

  private emit(kind: StudyChangeKind, id: EntityId, error?: string): void {
    if (!this.changed.hasListeners()) return;
    this.changed.fire(error === undefined ? { kind, id: String(id) } : { kind, id: String(id), error });
  }

  // ── Runtimes ──────────────────────────────────────────────────────────────

  private initialiseRuntime(study: StudyInstance): void {
    const def = study.def;
    const builtin = BUILTIN_KINDS.get(def);
    const ctx = this.createComputeContext(study.id, def);
    const handle = def as Partial<IndicatorHandle>;
    this.runtimes.set(study.id, {
      // The exported definitions are mutable for compatibility. Optimise only
      // while both object and calculator are still the canonical built-in.
      kind: builtin && builtin.compute === def.compute ? builtin.kind : null,
      rsi: null,
      ctx,
      runner: def.indicator && typeof handle.createRunner === "function"
        ? handle.createRunner(Object.freeze({ ...study.inputs }) as StudyInputValues<StudyInputSchema>, ctx, {
            color: study.color,
            palette: FALLBACK_COLORS,
            paletteOffset: FALLBACK_COLORS.indexOf(study.color) + 1,
            ...(study.plots ? { overrides: study.plots } : {}),
          })
        : null,
    });
  }

  private dropRuntime(id: EntityId): void {
    this.runtimes.delete(id);
    this.pendingRecompute.delete(id);
  }

  /** Read-only, live view of the chart for compute()/init()/update(). */
  private createComputeContext(id: EntityId, def: StudyDefinition): StudyComputeContext {
    const context = this.context;
    const wantsRange = def.dependsOn?.includes("visibleRange") ?? false;
    return Object.freeze({
      get symbol() { return context.symbol ?? ""; },
      get symbolInfo() { return context.symbolInfo ?? null; },
      get resolution() { return context.resolution ?? ("" as StudyComputeContext["resolution"]); },
      get timezone() { return resolveTimezone(context.timezone, context.symbolInfo); },
      get visibleRange() {
        const range = wantsRange ? context.visibleRange : null;
        return range ? Object.freeze({ from: range.from, to: range.to }) : null;
      },
      formatPrice: (value: number) => (context.formatPrice
        ? context.formatPrice(value, context.symbolInfo?.pricescale ?? 100)
        : String(value)),
      now: () => (context.now ? context.now() : Date.now()),
      requestRecompute: () => this.scheduleRecompute(id),
    });
  }

  private handleDataChanged(): void {
    const mutation = this.classifyBarsMutation();
    this.barsSnapshot = this.captureBars();
    if (mutation === "none" || this.items.size === 0) return;

    for (const study of this.items.values()) {
      if (mutation === "append" || mutation === "replace-last") {
        if (this.updateBuiltinLastValue(study, mutation)) {
          study.series = [{ values: study.values, style: "line", color: study.color }];
          this.emit("values", study.id);
          continue;
        }
        const runner = this.runtimes.get(study.id)?.runner;
        if (runner) {
          try {
            if (runner.tick(this.context.bars, mutation)) {
              this.emit("values", study.id);
              continue;
            }
          } catch (error) {
            this.fail(study, error, "update");
            continue;
          }
        }
      }
      this.recompute(study);
    }
    this.context.requestPaint();
  }

  private recompute(study: StudyInstance): void {
    const runtime = this.runtimes.get(study.id);
    const bars = this.context.bars;
    try {
      if (study.def.indicator) {
        if (!runtime?.runner) {
          throw new TypeError(`study "${study.name}" has an indicator definition but was not created by defineIndicator(); register the handle it returns`);
        }
        const run = runtime.runner.full(bars);
        study.series = run.series;
        study.outputs = run.outputs;
        study.values = run.values;
      } else {
        const inputs: StudyInputs = { ...study.inputs, length: study.length };
        const ctx = runtime?.ctx ?? this.createComputeContext(study.id, study.def);
        const raw = study.def.compute(bars, inputs, ctx);
        if (Array.isArray(raw)) {
          study.values = raw;
          study.series = [{ values: raw, style: "line", color: study.color }];
        } else {
          study.series = raw.series.map((item) => ({
            ...item,
            color: item.color || study.color,
          }));
          study.values = study.series[0]?.values ?? [];
        }
        if (runtime) runtime.rsi = runtime.kind === "rsi" ? this.buildRsiRuntime(study.length) : null;
      }
      study.error = null;
      this.emit("values", study.id);
    } catch (e) {
      this.fail(study, e, "compute");
    }
  }

  private fail(study: StudyInstance, error: unknown, phase: "compute" | "update"): void {
    const message = messageOf(error);
    console.warn(`[raze-charts] study "${study.name}" ${phase} failed`, error);
    study.values = [];
    study.series = [];
    study.error = message;
    const runtime = this.runtimes.get(study.id);
    if (runtime) runtime.rsi = null;
    if (study.outputs) delete study.outputs;
    this.emit("error", study.id, message);
  }

  // ── Context-driven recomputes ─────────────────────────────────────────────

  private scheduleDependents(dependency: "visibleRange" | "timezone"): void {
    for (const study of this.items.values()) {
      if (study.def.dependsOn?.includes(dependency)) this.scheduleRecompute(study.id);
    }
  }

  /** Throttled full recompute: at most one pass per STUDY_RECOMPUTE_THROTTLE_MS. */
  private scheduleRecompute(id: EntityId): void {
    if (!this.items.has(id)) return;
    this.pendingRecompute.add(id);
    if (this.recomputeTimer !== null) return;
    const wait = Math.max(0, this.lastRecomputeAt + STUDY_RECOMPUTE_THROTTLE_MS - Date.now());
    this.recomputeTimer = setTimeout(() => this.flushRecompute(), wait);
  }

  private flushRecompute(): void {
    this.recomputeTimer = null;
    this.lastRecomputeAt = Date.now();
    const ids = Array.from(this.pendingRecompute);
    this.pendingRecompute.clear();
    let changed = false;
    for (const id of ids) {
      const study = this.items.get(id);
      if (!study) continue;
      this.recompute(study);
      changed = true;
    }
    if (changed) this.context.requestPaint();
  }

  // ── Built-in O(1) ticks ───────────────────────────────────────────────────

  /**
   * Update only the forming/new sample for built-ins whose recurrence is known.
   * Custom v1 definitions keep their public, full-array `compute` contract;
   * guessing their dependency window would be incorrect.
   */
  private updateBuiltinLastValue(
    study: StudyInstance,
    mutation: Exclude<BarsMutation, "none" | "full">,
  ): boolean {
    const runtime = this.runtimes.get(study.id);
    if (!runtime?.kind) return false;
    const builtin = BUILTIN_KINDS.get(study.def);
    if (!builtin || builtin.compute !== study.def.compute) return false;
    // Extra inputs (source, offset, in_N lengths) change the recurrence, and
    // a non-finite sample is a gap only the full path skips correctly.
    if (Object.keys(study.inputs).length > 0) return false;

    const bars = this.context.bars;
    const n = bars.length;
    const previousLength = mutation === "append" ? n - 1 : n;
    if (n === 0 || study.values.length !== previousLength) return false;

    const index = n - 1;
    study.values.length = n;

    if (runtime.kind === "sma") {
      if (n < study.length) {
        study.values[index] = null;
        return true;
      }
      let sum = 0;
      for (let i = n - study.length; i < n; i++) sum += closeOf(bars[i]!);
      if (!Number.isFinite(sum)) return false;
      study.values[index] = sum / study.length;
      return true;
    }

    if (runtime.kind === "ema") {
      if (index < study.length - 1) {
        study.values[index] = null;
        return true;
      }
      if (index === study.length - 1) {
        let sum = 0;
        for (let i = 0; i < study.length; i++) sum += closeOf(bars[i]!);
        if (!Number.isFinite(sum)) return false;
        study.values[index] = sum / study.length;
        return true;
      }
      const previous = study.values[index - 1];
      const close = closeOf(bars[index]!);
      if (typeof previous !== "number" || !Number.isFinite(close)) return false;
      const weight = 2 / (study.length + 1);
      study.values[index] = close * weight + previous * (1 - weight);
      return true;
    }

    const rsi = runtime.rsi;
    if (!rsi || rsi.avgGains.length !== previousLength || rsi.avgLosses.length !== previousLength) {
      return false;
    }
    rsi.avgGains.length = n;
    rsi.avgLosses.length = n;
    if (index < study.length) {
      study.values[index] = null;
      rsi.avgGains[index] = null;
      rsi.avgLosses[index] = null;
      return true;
    }

    let avgGain: number;
    let avgLoss: number;
    if (index === study.length) {
      avgGain = 0;
      avgLoss = 0;
      for (let i = 1; i <= study.length; i++) {
        const delta = closeOf(bars[i]!) - closeOf(bars[i - 1]!);
        if (!Number.isFinite(delta)) return false;
        if (delta >= 0) avgGain += delta;
        else avgLoss -= delta;
      }
      avgGain /= study.length;
      avgLoss /= study.length;
    } else {
      const previousGain = rsi.avgGains[index - 1];
      const previousLoss = rsi.avgLosses[index - 1];
      if (typeof previousGain !== "number" || typeof previousLoss !== "number") return false;
      const delta = closeOf(bars[index]!) - closeOf(bars[index - 1]!);
      if (!Number.isFinite(delta)) return false;
      const gain = delta > 0 ? delta : 0;
      const loss = delta < 0 ? -delta : 0;
      avgGain = (previousGain * (study.length - 1) + gain) / study.length;
      avgLoss = (previousLoss * (study.length - 1) + loss) / study.length;
    }
    rsi.avgGains[index] = avgGain;
    rsi.avgLosses[index] = avgLoss;
    study.values[index] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    return true;
  }

  private buildRsiRuntime(length: number): RsiRuntime {
    const state = rsiState(this.context.bars.map(closeOf), length);
    return { avgGains: state.avgGain, avgLosses: state.avgLoss };
  }

  private classifyBarsMutation(): BarsMutation {
    const bars = this.context.bars;
    const before = this.barsSnapshot;
    if (bars !== before.ref) return "full";

    const n = bars.length;
    if (n === before.length) {
      if (sameBar(bars[0], before.first)
          && sameBar(bars[n - 2], before.penultimate)
          && sameBar(bars[n - 1], before.last)) {
        return "none";
      }
      if (n > 0
          && sameBar(bars[0], before.first)
          && sameBar(bars[n - 2], before.penultimate)
          && bars[n - 1]!.time === before.last?.time) {
        return "replace-last";
      }
      return "full";
    }

    if (n === before.length + 1
        && sameBar(bars[0], before.first)
        && sameBar(bars[n - 2], before.last)) {
      return "append";
    }
    return "full";
  }

  private captureBars(): BarsSnapshot {
    const bars = this.context.bars;
    return {
      ref: bars,
      length: bars.length,
      first: fingerprint(bars[0]),
      penultimate: fingerprint(bars[bars.length - 2]),
      last: fingerprint(bars[bars.length - 1]),
    };
  }

  destroy(): void {
    const owner = this.subscriptionOwner;
    this.context.dataChanged.unsubscribe(owner, this.onDataChanged as (...args: never[]) => void);
    this.context.rangeChanged?.unsubscribe(owner, this.onRangeChanged as (...args: never[]) => void);
    this.context.viewportChanged?.unsubscribe(owner, this.onRangeChanged as (...args: never[]) => void);
    this.context.timezoneChanged?.unsubscribe(owner, this.onTimezoneChanged as (...args: never[]) => void);
    if (this.recomputeTimer !== null) clearTimeout(this.recomputeTimer);
    this.recomputeTimer = null;
    this.pendingRecompute.clear();
    this.items.clear();
    this.runtimes.clear();
    this.changed.destroy();
  }
}

