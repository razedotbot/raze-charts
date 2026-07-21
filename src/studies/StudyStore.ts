// Active studies on a chart. Recomputes when bars change; overlays (EMA/SMA)
// share the price pane, RSI gets a dedicated sub-pane.

import type { EntityId } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { closesFromBars, ema, rsi, sma } from "./calc";

export type StudyKind = "SMA" | "EMA" | "RSI";

export interface StudySpec {
  kind: StudyKind;
  length: number;
  color: string;
}

export interface StudyInstance extends StudySpec {
  id: EntityId;
  /** Values aligned with context.bars; null during warm-up. */
  values: (number | null)[];
  pane: "overlay" | "rsi";
}

const DEFAULT_COLORS: Record<StudyKind, string> = {
  EMA: "#f5a623",
  SMA: "#2962ff",
  RSI: "#7E57C2",
};

let seq = 0;
function nextId(kind: StudyKind): EntityId {
  seq += 1;
  return `study_${kind.toLowerCase()}_${seq}` as EntityId;
}

export class StudyStore {
  private items = new Map<EntityId, StudyInstance>();

  constructor(private readonly context: ChartContext) {
    this.context.dataChanged.subscribe(null, (() => this.recomputeAll()) as never);
  }

  list(): StudyInstance[] {
    return Array.from(this.items.values());
  }

  hasRsi(): boolean {
    for (const s of this.items.values()) if (s.kind === "RSI") return true;
    return false;
  }

  add(spec: StudySpec): EntityId {
    const id = nextId(spec.kind);
    const color = spec.color || DEFAULT_COLORS[spec.kind];
    const pane = spec.kind === "RSI" ? "rsi" : "overlay";
    const study: StudyInstance = {
      id,
      kind: spec.kind,
      length: Math.max(1, Math.floor(spec.length)),
      color,
      values: [],
      pane,
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

  /** Map TV study names / short aliases → kind. */
  static parseName(name: string): StudyKind | null {
    const n = name.trim().toLowerCase();
    if (n === "ema" || n.includes("exponential") || n === "moving average exponential") return "EMA";
    if (n === "sma" || n === "ma" || n === "moving average" || n.includes("simple moving")) return "SMA";
    if (n === "rsi" || n.includes("relative strength")) return "RSI";
    return null;
  }

  static defaultLength(kind: StudyKind): number {
    return kind === "RSI" ? 14 : kind === "EMA" ? 9 : 20;
  }

  private recomputeAll(): void {
    for (const s of this.items.values()) this.recompute(s);
    this.context.requestPaint();
  }

  private recompute(study: StudyInstance): void {
    const closes = closesFromBars(this.context.bars);
    if (study.kind === "SMA") study.values = sma(closes, study.length);
    else if (study.kind === "EMA") study.values = ema(closes, study.length);
    else study.values = rsi(closes, study.length);
  }

  destroy(): void {
    this.items.clear();
  }
}
