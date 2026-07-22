// Active studies on a chart. Recomputes when bars change; overlay studies
// share the price pane, pane studies render in per-definition sub-panes.
// Which studies exist at all is the StudyRegistry's business — this store only
// tracks live instances.

import type { EntityId, StudyDefinition } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { StudyRegistry } from "./registry";

/** @deprecated Studies are registry-driven; any registered name is valid. */
export type StudyKind = string;

export interface StudySpec {
  /** Study name resolved against the registry (built-ins + custom). */
  name: string;
  /** 0 / absent → the definition's default length. */
  length?: number;
  /** "" / absent → the definition's default color. */
  color?: string;
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
}

const FALLBACK_COLORS = ["#f5a623", "#26a69a", "#2962ff", "#e040fb", "#7E57C2"];

let seq = 0;
function nextId(name: string): EntityId {
  seq += 1;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `study_${slug}_${seq}` as EntityId;
}

export class StudyStore {
  private items = new Map<EntityId, StudyInstance>();

  constructor(
    private readonly context: ChartContext,
    readonly registry: StudyRegistry = new StudyRegistry(),
  ) {
    this.context.dataChanged.subscribe(null, (() => this.recomputeAll()) as never);
  }

  list(): StudyInstance[] {
    return Array.from(this.items.values());
  }

  /** Distinct definitions of active sub-pane studies, in insertion order. */
  paneDefs(): StudyDefinition[] {
    const out: StudyDefinition[] = [];
    for (const s of this.items.values()) {
      if (s.def.pane === "pane" && !out.includes(s.def)) out.push(s.def);
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
    };
    this.recompute(study);
    this.items.set(id, study);
    this.context.requestPaint();
    return id;
  }

  remove(id: EntityId): boolean {
    if (!this.items.delete(id)) return false;
    this.context.requestPaint();
    return true;
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.context.requestPaint();
  }

  has(id: EntityId): boolean {
    return this.items.has(id);
  }

  private recomputeAll(): void {
    for (const s of this.items.values()) this.recompute(s);
    this.context.requestPaint();
  }

  private recompute(study: StudyInstance): void {
    try {
      const values = study.def.compute(this.context.bars, { length: study.length });
      study.values = Array.isArray(values) ? values : [];
    } catch (e) {
      console.warn(`[raze-charts] study "${study.name}" compute failed`, e);
      study.values = [];
    }
  }

  destroy(): void {
    this.items.clear();
  }
}
