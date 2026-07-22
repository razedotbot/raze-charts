// Study registry — the pluggable indicator catalogue. Built-ins (EMA/SMA/RSI)
// and host-registered `raze.custom_studies` share the same StudyDefinition
// shape, so every part of the chrome (createStudy, Indicators panel, legend,
// sub-pane renderer) treats them identically.

import type { StudyDefinition } from "../types/charting_library";
import { closesFromBars, ema, rsi, sma } from "./calc";

export const BUILTIN_STUDIES: StudyDefinition[] = [
  {
    name: "EMA",
    aliases: ["moving average exponential"],
    keywords: ["exponential"],
    pane: "overlay",
    defaults: { length: 9, color: "#f5a623" },
    compute: (bars, { length }) => ema(closesFromBars(bars), length),
  },
  {
    name: "SMA",
    aliases: ["ma", "moving average"],
    keywords: ["simple moving"],
    pane: "overlay",
    defaults: { length: 20, color: "#2962ff" },
    compute: (bars, { length }) => sma(closesFromBars(bars), length),
  },
  {
    name: "RSI",
    aliases: ["relative strength index"],
    keywords: ["relative strength"],
    pane: "pane",
    defaults: { length: 14, color: "#7E57C2" },
    range: { min: 0, max: 100 },
    levels: [
      { value: 30, axisLabel: true },
      { value: 50, dashed: true },
      { value: 70, axisLabel: true },
    ],
    formatValue: (v) => v.toFixed(1),
    compute: (bars, { length }) => rsi(closesFromBars(bars), length),
  },
];

export class StudyRegistry {
  private defs: StudyDefinition[] = [];

  constructor(defs: StudyDefinition[] = BUILTIN_STUDIES) {
    for (const d of defs) this.register(d);
  }

  /** Add or replace (by case-insensitive name) a study definition. */
  register(def: StudyDefinition): void {
    if (!def || typeof def.name !== "string" || !def.name.trim() || typeof def.compute !== "function") {
      console.warn("[raze-charts] ignoring invalid study definition", def);
      return;
    }
    const key = def.name.toLowerCase();
    this.defs = this.defs.filter((d) => d.name.toLowerCase() !== key);
    this.defs.push(def);
  }

  list(): StudyDefinition[] {
    return [...this.defs];
  }

  /** Case-insensitive lookup: exact name/alias first, then keyword substring. */
  resolve(name: string): StudyDefinition | null {
    const q = name.trim().toLowerCase();
    if (!q) return null;
    for (const d of this.defs) {
      if (d.name.toLowerCase() === q) return d;
      if ((d.aliases ?? []).some((a) => a.toLowerCase() === q)) return d;
    }
    for (const d of this.defs) {
      if ((d.keywords ?? []).some((k) => k && q.includes(k.toLowerCase()))) return d;
    }
    return null;
  }
}
