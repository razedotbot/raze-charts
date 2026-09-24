// Indicator definitions (built-in and `raze.custom_studies`) and the
// Indicators panel presets.

import type { Bar } from "./datafeed";

// ── Studies ─────────────────────────────────────────────────────────────────
export interface StudyPaneLevel {
  value: number;
  /** Draw the guide dashed (e.g. the RSI 50 midline). */
  dashed?: boolean;
  /** Show the value on the sub-pane's right axis. */
  axisLabel?: boolean;
}

export type StudySeriesStyle = "line" | "histogram" | "band";
export interface StudySeries {
  values: (number | null)[];
  style?: StudySeriesStyle;
  color?: string;
  name?: string;
  /** Line width in CSS pixels (default 1.25). */
  lineWidth?: number;
  /** `false` skips painting the plot; it still computes. */
  visible?: boolean;
}
export interface StudyInputs {
  length: number;
  [key: string]: number | string;
}
export type StudyComputeResult = (number | null)[] | { series: StudySeries[] };

/** A pluggable indicator: built-ins (EMA/SMA/RSI) and `raze.custom_studies` share this shape. */
export interface StudyDefinition {
  /** Canonical name — matched case-insensitively by createStudy(); shown in the legend. */
  name: string;
  /** Exact-match lookup aliases (e.g. "moving average exponential"). */
  aliases?: string[];
  /** Loose substrings that also match (e.g. "exponential" → EMA). */
  keywords?: string[];
  /** "overlay" plots on the price pane; "pane" renders in its own sub-pane. */
  pane: "overlay" | "pane";
  defaults?: { length?: number; color?: string; [key: string]: number | string | undefined };
  /** Fixed sub-pane value range (e.g. RSI 0–100). Auto-fits to visible values when omitted. */
  range?: { min: number; max: number };
  /** Horizontal guide levels drawn in the sub-pane. */
  levels?: StudyPaneLevel[];
  /** Sub-pane corner label; defaults to `name`. */
  label?: string;
  /** Legend value formatter; defaults to price formatting (overlay) or 1 decimal (pane). */
  formatValue?: (value: number) => string;
  /** Values aligned 1:1 with `bars`; null = warm-up gap. Arrays stay one line; objects carry MACD/bands. */
  compute: (bars: Bar[], inputs: StudyInputs) => StudyComputeResult;
}

export interface IndicatorPreset {
  /** Row label; defaults to `"<name> <length>"`. */
  label?: string;
  /** Study name resolved against built-ins + `custom_studies`. */
  name: string;
  length?: number;
  color?: string;
}
