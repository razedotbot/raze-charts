// Study registry — the pluggable indicator catalogue. Built-ins (EMA/SMA/RSI)
// and host-registered `raze.custom_studies` share the same StudyDefinition
// shape, so every part of the chrome (createStudy, Indicators panel, legend,
// sub-pane renderer) treats them identically.

import type { StudyDefinition } from "../types/charting_library";
import { bollinger, closesFromBars, ema, macd, rsi, sma, vwap } from "./calc";

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
  {
    name: "VWAP",
    aliases: ["volume weighted average price"],
    keywords: ["vwap"],
    pane: "overlay",
    defaults: { color: "#e040fb" },
    compute: (bars) => vwap(bars),
  },
  {
    name: "Bollinger Bands",
    aliases: ["bb", "bollinger"],
    keywords: ["bollinger"],
    pane: "overlay",
    defaults: { length: 20, color: "#2962ff" },
    compute: (bars, { length }) => {
      const { mid, upper, lower } = bollinger(closesFromBars(bars), length, 2);
      return {
        series: [
          { values: mid, style: "line", name: "BB mid" },
          { values: upper, style: "band", name: "BB upper", color: "#2962ff66" },
          { values: lower, style: "band", name: "BB lower", color: "#2962ff66" },
        ],
      };
    },
  },
  {
    name: "MACD",
    aliases: ["moving average convergence divergence"],
    keywords: ["macd"],
    pane: "pane",
    defaults: { length: 26, color: "#2962ff" },
    compute: (bars) => {
      const result = macd(closesFromBars(bars), 12, 26, 9);
      return {
        series: [
          { values: result.macd, style: "line", name: "MACD", color: "#2962ff" },
          { values: result.signal, style: "line", name: "Signal", color: "#f5a623" },
          { values: result.hist, style: "histogram", name: "Hist", color: "#66d89e" },
        ],
      };
    },
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
