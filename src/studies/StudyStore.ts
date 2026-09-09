// Active studies on a chart. Recomputes when bars change; overlay studies
// share the price pane, pane studies render in per-definition sub-panes.
// Which studies exist at all is the StudyRegistry's business — this store only
// tracks live instances.

import type { Bar, EntityId, StudyDefinition, StudySeries } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { BUILTIN_STUDIES, StudyRegistry } from "./registry";

/** @deprecated Studies are registry-driven; any registered name is valid. */
export type StudyKind = string;

export interface StudySpec {
  /** Study name resolved against the registry (built-ins + custom). */
  name: string;
  /** 0 / absent → the definition's default length. */
  length?: number;
  /** "" / absent → the definition's default color. */
  color?: string;
  lock?: boolean;
  forceOverlay?: boolean;
  inputs?: Record<string, number | string>;
}

export interface StudyInstance {
  id: EntityId;
  def: StudyDefinition;
  /** Canonical definition name (legend label prefix). */
  name: string;
  length: number;
  color: string;
  /** Values aligned with context.bars; null during warm-up. */
  values: (number | null)[];
  series: StudySeries[];
  lock: boolean;
  forceOverlay: boolean;
  inputs: Record<string, number | string>;
}

const FALLBACK_COLORS = ["#f5a623", "#26a69a", "#2962ff", "#e040fb", "#7E57C2"];

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

function closeOf(bar: Bar): number {
  return bar.close > 0 ? bar.close : bar.open;
}

let seq = 0;
function nextId(name: string): EntityId {
  seq += 1;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `study_${slug}_${seq}` as EntityId;
}

export class StudyStore {
  private items = new Map<EntityId, StudyInstance>();
  private runtimes = new Map<EntityId, StudyRuntime>();
  private readonly subscriptionOwner = {};
  private barsSnapshot: BarsSnapshot;
  private readonly onDataChanged = (): void => this.handleDataChanged();

  constructor(
    private readonly context: ChartContext,
    readonly registry: StudyRegistry = new StudyRegistry(),
  ) {
    this.barsSnapshot = this.captureBars();
    this.context.dataChanged.subscribe(
      this.subscriptionOwner,
      this.onDataChanged as (...args: never[]) => void,
    );
  }

  list(): StudyInstance[] {
    return Array.from(this.items.values());
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

  /** Returns the new study id, or null when `spec.name` is not in the registry. */
  add(spec: StudySpec): EntityId | null {
    const def = this.registry.resolve(spec.name);
    if (!def) return null;
    const id = nextId(def.name);
    const rawLength = spec.length || def.defaults?.length || 14;
    const study: StudyInstance = {
      id,
      def,
      name: def.name,
      length: Math.max(1, Math.floor(rawLength)),
      color: spec.color || def.defaults?.color || FALLBACK_COLORS[this.items.size % FALLBACK_COLORS.length]!,
      values: [],
      series: [],
      lock: spec.lock ?? false,
      forceOverlay: spec.forceOverlay ?? false,
      inputs: spec.inputs ?? {},
    };
    const builtin = BUILTIN_KINDS.get(def);
    this.runtimes.set(id, {
      // The exported definitions are mutable for compatibility. Optimise only
      // while both object and calculator are still the canonical built-in.
      kind: builtin && builtin.compute === def.compute ? builtin.kind : null,
      rsi: null,
    });
    this.recompute(study);
    this.items.set(id, study);
    this.context.requestPaint();
    return id;
  }

  remove(id: EntityId): boolean {
    if (!this.items.delete(id)) return false;
    this.runtimes.delete(id);
    this.context.requestPaint();
    return true;
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.runtimes.clear();
    this.context.requestPaint();
  }

  has(id: EntityId): boolean {
    return this.items.has(id);
  }

  private handleDataChanged(): void {
    const mutation = this.classifyBarsMutation();
    this.barsSnapshot = this.captureBars();
    if (mutation === "none" || this.items.size === 0) return;

    for (const study of this.items.values()) {
      if ((mutation === "append" || mutation === "replace-last")
          && this.updateBuiltinLastValue(study, mutation)) {
        study.series = [{ values: study.values, style: "line", color: study.color }];
        continue;
      }
      this.recompute(study);
    }
    this.context.requestPaint();
  }

  private recompute(study: StudyInstance): void {
    try {
      const raw = study.def.compute(this.context.bars, { length: study.length, ...study.inputs });
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
      const runtime = this.runtimes.get(study.id);
      if (runtime) {
        runtime.rsi = runtime.kind === "rsi" ? this.buildRsiRuntime(study.length) : null;
      }
    } catch (e) {
      console.warn(`[raze-charts] study "${study.name}" compute failed`, e);
      study.values = [];
      study.series = [];
      const runtime = this.runtimes.get(study.id);
      if (runtime) runtime.rsi = null;
    }
  }

  /**
   * Update only the forming/new sample for built-ins whose recurrence is known.
   * Custom definitions intentionally keep using their public, full-array
   * `compute` contract; guessing their dependency window would be incorrect.
   */
  private updateBuiltinLastValue(
    study: StudyInstance,
    mutation: Exclude<BarsMutation, "none" | "full">,
  ): boolean {
    const runtime = this.runtimes.get(study.id);
    if (!runtime?.kind) return false;
    const builtin = BUILTIN_KINDS.get(study.def);
    if (!builtin || builtin.compute !== study.def.compute) return false;

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
        study.values[index] = sum / study.length;
        return true;
      }
      const previous = study.values[index - 1];
      if (typeof previous !== "number") return false;
      const weight = 2 / (study.length + 1);
      study.values[index] = closeOf(bars[index]!) * weight + previous * (1 - weight);
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
    const bars = this.context.bars;
    const avgGains: (number | null)[] = new Array(bars.length).fill(null);
    const avgLosses: (number | null)[] = new Array(bars.length).fill(null);
    if (bars.length < length + 1) return { avgGains, avgLosses };

    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= length; i++) {
      const delta = closeOf(bars[i]!) - closeOf(bars[i - 1]!);
      if (delta >= 0) avgGain += delta;
      else avgLoss -= delta;
    }
    avgGain /= length;
    avgLoss /= length;
    avgGains[length] = avgGain;
    avgLosses[length] = avgLoss;

    for (let i = length + 1; i < bars.length; i++) {
      const delta = closeOf(bars[i]!) - closeOf(bars[i - 1]!);
      const gain = delta > 0 ? delta : 0;
      const loss = delta < 0 ? -delta : 0;
      avgGain = (avgGain * (length - 1) + gain) / length;
      avgLoss = (avgLoss * (length - 1) + loss) / length;
      avgGains[i] = avgGain;
      avgLosses[i] = avgLoss;
    }
    return { avgGains, avgLosses };
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
    this.context.dataChanged.unsubscribe(
      this.subscriptionOwner,
      this.onDataChanged as (...args: never[]) => void,
    );
    this.items.clear();
    this.runtimes.clear();
  }
}
