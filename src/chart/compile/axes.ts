// Layout and axes: margins, label measurement, the plot rectangle, and the
// measured tick layout of both axes.
//
// Label widths are estimated at compile time, without a DOM, so SSR, Node
// and every renderer agree on the scene. The default chart font is
// monospace, so an estimate from character counts is exact up to the font's
// advance width; proportional fonts use rough per-character classes.
//
// layoutAxes() sizes the margins to the labels: the value axis grows to the
// widest tick label and last-value chip, rotated category labels reserve
// bottom margin, and heatmaps make room for their row labels and colour bar.
// Margins only grow (never below the chart-family defaults) and are capped,
// so the loop converges in a few passes; labels that still do not fit are cut
// with an ellipsis. Explicit spec.margin sides are never changed.

import type { AnyScale, BandScale, LinearScale } from "../scales";
import type { SceneAxes, SceneTick } from "../sceneTypes";
import { ChartCompileError } from "./errors";
import { MONTHS, numericTickLabels, pad2, type AxisFormatters } from "./format";
import { isBuiltinMark, type AreaChartMark, type BarChartMark, type ChartMark, type LineChartMark } from "./marks";
import { asNumber, isRecord, readChannel } from "./shared";
import type { AxisLabelOptions, ChartSpec, Margin, PlotRect, XScaleKind } from "./types";

export const DEFAULT_MARGIN: Margin = { top: 14, right: 56, bottom: 26, left: 10 };

/** Font size of axis tick labels in both renderers. */
export const AXIS_FONT_SIZE = 9;
/** Line box of a 9px label. */
const LABEL_LINE = 11;
/** Minimum gap between neighbouring labels. */
const LABEL_GAP = 6;
/** Minimum spacing between calendar ticks on a time axis. */
export const TIME_TICK_SPACING = 64;
/** Largest share of the chart a measured side margin may take. */
const CAP = 0.35;
/** Clearance kept to the chart edges. */
const EDGE = 2;
// Other layout constants, inline below:
//   Y labels end 7px before the chart's right edge (renderers draw them at
//   width - 7) and keep 6px from the plot; last-value chips add 18px (a 3px
//   gutter inset each side plus 6px of text padding each side) to 10px text.
//   Heatmap row labels end 8px left of the grid; colour-bar labels start 22px
//   right of it (10px gap, 7px bar, 5px gap). Horizontal X labels sit on a
//   baseline 14px below the plot (18px of margin); rotated ones hang from 8px
//   below it.

export interface MarginLayout {
  polar: boolean;
  isPie: boolean;
  heatmap: boolean;
  hideLegend: boolean;
  /** A pie with rows reserves room for its right-hand legend. */
  pieHasLegendRows: boolean;
  /** A single unstacked bar mark reads as a histogram. */
  isHist: boolean;
}

/** Chart-family default margins, overridden field by field by spec.margin. */
export function resolveMargin(spec: ChartSpec, layout: MarginLayout): Margin {
  const { polar, isPie, heatmap, hideLegend, pieHasLegendRows, isHist } = layout;
  return polar
    ? isPie
      ? { top: 8, right: !hideLegend && pieHasLegendRows ? 152 : 8, bottom: 8, left: 8, ...spec.margin }
      : { top: 44, right: 28, bottom: 42, left: 28, ...spec.margin }
    : heatmap
      ? { top: 16, right: 54, bottom: 28, left: 46, ...spec.margin }
      : {
        top: hideLegend ? 12 : 28,
        right: DEFAULT_MARGIN.right,
        bottom: isHist ? 28 : DEFAULT_MARGIN.bottom,
        left: DEFAULT_MARGIN.left,
        ...spec.margin,
      };
}

export function plotArea(width: number, height: number, margin: Margin): PlotRect {
  return {
    x: margin.left,
    y: margin.top,
    w: Math.max(1, width - margin.left - margin.right),
    h: Math.max(1, height - margin.top - margin.bottom),
  };
}

// ---------------------------------------------------------------------------
// Measurement

/** East Asian wide characters and emoji take two monospace cells (one em in proportional fonts). */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

/** Advance in em of one character of a proportional sans-serif font, by rough class. */
function proportional(char: string): number {
  return /\d/.test(char) ? 0.56
    : /[ .,:;'|!iIlj]/.test(char) ? 0.28
      : /[-()[\]{}/\\ftr"]/.test(char) ? 0.36
        : /[mwMW@%]/.test(char) ? 0.86
          : /[A-Z]/.test(char) ? 0.68
            : /[a-z]/.test(char) ? 0.52 : 0.6;
}

/** Estimated rendered width of `text` in CSS pixels. Monospace fonts (the default) are exact up to their advance. */
export function measureText(text: string, fontSize = AXIS_FONT_SIZE, font = "monospace"): number {
  const mono = /mono|courier|consolas|menlo|monaco/i.test(font);
  let em = 0;
  for (const char of text) {
    // Only characters from U+1100 on can be wide; skip the class test for the rest.
    em += char.charCodeAt(0) >= 0x1100 && WIDE.test(char) ? (mono ? 1.2 : 1) : mono ? 0.6 : proportional(char);
  }
  return em * fontSize;
}

/** measureText for one font, memoised per label for the length of one layout. */
function measurer(font: string): (text: string) => number {
  const widths = new Map<string, number>();
  return (text) => {
    let width = widths.get(text);
    if (width === undefined) widths.set(text, (width = measureText(text, AXIS_FONT_SIZE, font)));
    return width;
  };
}

/** `label`, or its longest prefix plus "…" that fits `maxWidth`. */
export function ellipsize(label: string, maxWidth: number, measure: (text: string) => number): string {
  if (!(maxWidth < Infinity) || measure(label) <= maxWidth) return label;
  const chars = Array.from(label);
  const cut = (count: number): string => `${chars.slice(0, count).join("").trimEnd()}…`;
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(cut(mid)) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

// ---------------------------------------------------------------------------
// Label options

interface LabelPolicy {
  /** "auto" or a fixed angle in degrees (0 = horizontal, -90 = vertical). */
  rotate: "auto" | number;
  maxWidth: number;
  interval: number | "auto";
}

function resolveLabelPolicy(axis: "x" | "y", value: AxisLabelOptions | undefined): LabelPolicy {
  const where = `scales.${axis}.labels`;
  const fail: (message: string) => never = (message) => {
    throw new ChartCompileError("E_SCALE_TYPE", `${where}${message}`);
  };
  if (value === undefined) return { rotate: "auto", maxWidth: Infinity, interval: "auto" };
  if (!isRecord(value)) fail(" must be an object with rotate, maxWidth, or interval.");
  for (const key of Object.keys(value)) {
    if (key !== "rotate" && key !== "maxWidth" && key !== "interval") fail(` does not support option "${key}". Use rotate, maxWidth, or interval.`);
  }
  const { rotate = "auto", maxWidth = Infinity, interval = "auto" } = value as AxisLabelOptions;
  let angle = rotate;
  if (rotate !== "auto") {
    if (axis === "y") fail(".rotate is not supported: value-axis labels are always horizontal.");
    if (typeof rotate === "boolean") angle = rotate ? -45 : 0;
    else if (!(typeof rotate === "number" && rotate >= -90 && rotate <= 0)) {
      fail(`.rotate must be "auto", a boolean, or an angle from -90 to 0 degrees; received ${String(rotate)}.`);
    }
  }
  if (!(typeof maxWidth === "number" && maxWidth > 0)) fail(`.maxWidth must be a positive number of pixels; received ${String(maxWidth)}.`);
  if (interval !== "auto" && !(Number.isInteger(interval) && interval >= 1)) {
    fail(`.interval must be "auto" or a positive integer; received ${String(interval)}.`);
  }
  return { rotate: angle as "auto" | number, maxWidth, interval };
}

// ---------------------------------------------------------------------------
// Tick drafts and placement

interface Draft {
  value: unknown;
  px: number;
  label: string;
  weight?: number;
}

/** A draft with its (ellipsized) label's measured width. */
interface Sized extends Draft {
  width: number;
}

function toSceneTick({ value, px, label, weight }: Draft, anchor: SceneTick["anchor"], rotation: number): SceneTick {
  return weight === undefined ? { value, px, label, anchor, rotation } : { value, px, label, anchor, rotation, weight };
}

/** Anchor of a centred label: start/end where it would cross the chart edges `lo`/`hi`. */
function anchorOf({ px, width }: Sized, lo: number, hi: number): SceneTick["anchor"] {
  return px - width / 2 < lo ? "start" : px + width / 2 > hi ? "end" : "middle";
}

/** Left edge of a horizontal label placed with {@link anchorOf}. */
function leftOf(tick: Sized, lo: number, hi: number): number {
  const anchor = anchorOf(tick, lo, hi);
  return anchor === "start" ? tick.px : anchor === "end" ? tick.px - tick.width : tick.px - tick.width / 2;
}

/** Every nth item, plus the last one when `fits` accepts it after the last kept one. */
function every<T>(items: readonly T[], n: number, fits?: (a: T, b: T) => boolean): T[] {
  const kept: T[] = [];
  for (let index = 0; index < items.length; index += n) kept.push(items[index]!);
  const last = items[items.length - 1];
  const previous = kept[kept.length - 1];
  if (fits && previous !== last && fits(previous!, last!)) kept.push(last!);
  return kept;
}

/**
 * The densest every-nth selection whose neighbours all fit; a fixed
 * `interval` is honoured as given.
 *
 * `reach` is a centre distance no two fitting labels can be closer than.
 * Every nth item spans at most n of the widest neighbour gaps, so each n that
 * cannot span `reach` fails at its first pair and is skipped. The search then
 * starts near the answer and checks each candidate with an early-exit strided
 * walk, which keeps thinning near-linear on thousands of categories while
 * returning exactly what trying every n from 1 would.
 */
function thin<T extends Draft>(items: readonly T[], interval: number | "auto", fits: (a: T, b: T) => boolean, reach: number): [T[], number] {
  if (interval !== "auto") return [every(items, interval), interval];
  let widest = 0;
  for (let index = 1; index < items.length; index++) widest = Math.max(widest, Math.abs(items[index]!.px - items[index - 1]!.px));
  // The small epsilon keeps float error from skipping an exact fit.
  let n = widest > 0 ? Math.max(1, Math.ceil(reach / widest - 1e-9)) : 1;
  for (; n < items.length; n++) {
    let ok = true;
    for (let index = n; ok && index < items.length; index += n) ok = fits(items[index - n]!, items[index]!);
    if (ok) break;
  }
  n = Math.max(1, Math.min(n, items.length));
  return [every(items, n, fits), n];
}

interface XLayoutInput {
  drafts: Draft[];
  policy: LabelPolicy;
  /** Band axes may rotate automatically; generated numeric/time ticks thin instead. */
  categorical: boolean;
  measure: (text: string) => number;
  /** Chart width; labels stay EDGE px inside it. */
  width: number;
  /** Largest vertical extent rotated labels may take below the plot. */
  bottomRoom: number;
}

interface XLayout {
  ticks: SceneTick[];
  /** Space needed below the plot for the labels. */
  extent: number;
  /** Extra space rotated labels need left of the chart edge. */
  leftOverflow: number;
  interval: number;
}

function layoutHorizontal(input: XLayoutInput, interval: number | "auto"): XLayout {
  const { drafts, policy, measure, width } = input;
  const cap = Math.min(policy.maxWidth, Math.max(24, width / 2 - EDGE));
  const lo = EDGE;
  const hi = width - EDGE;
  const size = (tick: Draft, maxWidth: number): Sized => {
    const label = ellipsize(tick.label, maxWidth, measure);
    return { ...tick, label, width: measure(label) };
  };
  const cut = drafts.map((tick) => size(tick, cap));
  let narrowest = Infinity;
  let widest = 0;
  for (const tick of cut) {
    narrowest = Math.min(narrowest, tick.width);
    widest = Math.max(widest, tick.width);
  }
  // Two fitting labels are at least half the narrower label plus the gap
  // apart: at most one of them can be anchored away from the other, and
  // only both at once (start and end) when a label spans the whole axis.
  const reach = widest <= hi - lo ? narrowest / 2 + LABEL_GAP : 0;
  let [kept, n] = thin(cut, interval, (a, b) => leftOf(b, lo, hi) - (leftOf(a, lo, hi) + a.width) >= LABEL_GAP, reach);
  if (interval !== "auto" && kept.length > 1) {
    // A fixed interval is honoured; labels are cut to their share of the axis.
    let closest = Infinity;
    for (let index = 1; index < kept.length; index++) closest = Math.min(closest, Math.abs(kept[index]!.px - kept[index - 1]!.px));
    const share = Math.max(8, closest - LABEL_GAP);
    kept = kept.map((tick) => size(tick, share));
  }
  return { ticks: kept.map((tick) => toSceneTick(tick, anchorOf(tick, lo, hi), 0)), extent: 18, leftOverflow: 0, interval: n };
}

function layoutRotated(input: XLayoutInput, angle: number, interval: number | "auto"): XLayout {
  const { drafts, policy, measure, bottomRoom } = input;
  const sin = Math.sin((Math.abs(angle) * Math.PI) / 180);
  const cos = Math.sqrt(1 - sin * sin);
  // Vertical room caps the label length; consecutive labels keep a line apart.
  const cap = Math.max(12, Math.min(policy.maxWidth, sin > 0.05 ? (bottomRoom - 8 - LABEL_LINE * cos) / sin : Infinity, 160));
  const pitch = LABEL_LINE / Math.max(sin, 0.2) + 2;
  const [kept, n] = thin(drafts, interval, (a, b) => Math.abs(b.px - a.px) >= pitch, pitch);
  let extent = 0;
  let leftOverflow = 0;
  const ticks = kept.map((tick) => {
    const label = ellipsize(tick.label, cap, measure);
    const width = measure(label);
    extent = Math.max(extent, 8 + width * sin + LABEL_LINE * cos + EDGE);
    leftOverflow = Math.max(leftOverflow, EDGE - (tick.px - width * cos - (LABEL_LINE / 2) * sin));
    return toSceneTick({ ...tick, label }, "end", -Math.abs(angle));
  });
  return { ticks, extent, leftOverflow, interval: n };
}

/**
 * Pick the X label layout: every label, every nth label, rotated labels,
 * then ellipsis. Automatic rotation applies to categories only (generated
 * numeric and time ticks are already spaced for their labels).
 */
function layoutXLabels(input: XLayoutInput): XLayout {
  const { policy } = input;
  if (policy.rotate !== "auto" && policy.rotate !== 0) return layoutRotated(input, policy.rotate, policy.interval);
  const horizontal = layoutHorizontal(input, policy.interval);
  if (policy.rotate === "auto" && input.categorical && policy.interval === "auto" && horizontal.interval > 1) {
    // A short list of categories is kept whole by rotating: every label names
    // a mark. Longer lists (weeks, hours) thin horizontally to every other
    // label, and rotate only when that would show under half the labels
    // rotation can.
    const rotated = layoutRotated(input, -45, "auto");
    const keepsAll = rotated.interval === 1 && input.drafts.length <= 12;
    if (keepsAll || (horizontal.interval > 2 && horizontal.interval > 2 * rotated.interval)) return rotated;
  }
  return horizontal;
}

// ---------------------------------------------------------------------------
// Time ticks

const SECOND = 1e3;
const MINUTE = 6e4;
const HOUR = 36e5;
const DAY = 864e5;

/**
 * The calendar ladder. Positive rungs are fixed lengths in ms (weeks start
 * on Monday); negative rungs count months: half months (the 1st and the
 * 15th), 1, 3 and 6 months, then 1, 2 and 5 years and their multiples of ten.
 */
const RUNGS = [
  1, 5, 10, 50, 100, 500,
  SECOND, 5 * SECOND, 15 * SECOND, 30 * SECOND,
  MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY,
  -0.5, -1, -3, -6,
];
for (let years = 12; years < 1e7; years *= 10) RUNGS.push(-years, -2 * years, -5 * years);

/** Shortest length of a rung: a half month is at least 14 days, n months n × 30.44 - 2.5 (28, a quarter 89, a year 365). */
const rungLength = (rung: number): number => (rung > 0 ? rung : Math.max(14, -rung * 30.44 - 2.5) * DAY);

/** Rung boundaries in [lo, hi] (UTC). */
function rungTicks(rung: number, lo: number, hi: number): number[] {
  const out: number[] = [];
  if (rung > 0) {
    // 1970-01-05 was the first Monday.
    const offset = rung === 7 * DAY ? 4 * DAY : 0;
    for (let t = Math.ceil((lo - offset) / rung) * rung + offset; t <= hi; t += rung) out.push(t);
    return out;
  }
  const start = new Date(lo);
  const step = Math.max(1, -rung);
  // Month index (year * 12 + month) of the step boundary at or before lo.
  for (let m = Math.floor((start.getUTCFullYear() * 12 + start.getUTCMonth()) / step) * step, t = -Infinity; t <= hi; m += step) {
    for (const day of rung === -0.5 ? [1, 15] : [1]) {
      t = new Date(0).setUTCFullYear(0, m, day);
      if (t >= lo && t <= hi) out.push(t);
    }
  }
  return out;
}

/**
 * Label and calendar weight of a tick, from the highest boundary it sits
 * on: 2025 (year), Feb (month), 14 Feb (day), 09:30, 09:30:15, 09:30:15.250.
 * Weights match the shared time core's unit weights (year > month > day ...).
 */
function calendarLabel(t: number): [string, number] {
  const date = new Date(t);
  if (t % DAY) {
    let label = `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
    if (t % MINUTE) label += `:${pad2(date.getUTCSeconds())}`;
    if (t % SECOND) label += `.${String(date.getUTCMilliseconds()).padStart(3, "0")}`;
    return [label, t % SECOND ? 1 : t % MINUTE ? 10 : t % HOUR ? 16 : 22];
  }
  const month = MONTHS[date.getUTCMonth()]!;
  return date.getUTCDate() > 1
    ? [`${date.getUTCDate()} ${month}`, 27]
    : date.getUTCMonth() ? [month, 31] : [String(date.getUTCFullYear()), 34];
}

/**
 * Calendar-aligned UTC time ticks: the finest ladder rung, from 1 ms to
 * millennia, whose ticks are at least TIME_TICK_SPACING apart and whose
 * measured labels do not touch. Boundary ticks name the higher unit, and a
 * month axis without a year boundary names the year on its first tick
 * ("Mar 2025").
 *
 * TODO(W1B-05): this is a compact UTC-only ladder. /chart should use
 * calendarTicks() from src/util/time once the core's rung tables are built
 * lazily and UTC callers can skip the IANA zone machinery: today importing it
 * costs about 7.5 KiB gzip, more than /chart's whole 50 KiB budget leaves.
 */
function timeDrafts(scale: LinearScale, plot: PlotRect, measure: (text: string) => number, tickFormat?: (value: unknown) => string): Draft[] {
  const lo = Math.min(...scale.domain);
  const hi = Math.max(...scale.domain);
  if (!(Math.max(-lo, hi) < 8.64e15 - DAY)) {
    // Instants outside the Date range cannot be calendar ticks.
    return scale.ticks(2).map((value) => ({ value, px: scale.map(value), label: tickFormat ? tickFormat(value) : String(value) }));
  }
  const pxPerMs = plot.w / (hi - lo || 1);
  const pick = (spacing: number): Draft[] => {
    for (const rung of RUNGS) {
      const gap = rungLength(rung) * pxPerMs;
      if (gap < spacing) continue;
      const drafts = rungTicks(rung, lo, hi).map((value): Draft => {
        const [label, weight] = calendarLabel(value);
        return { value, px: scale.map(value), label: tickFormat ? tickFormat(value) : label, weight };
      });
      if (drafts.every((tick, i) => !i || gap >= (measure(tick.label) + measure(drafts[i - 1]!.label)) / 2 + LABEL_GAP + 2)) return drafts;
    }
    return [];
  };
  let drafts = pick(TIME_TICK_SPACING);
  if (drafts.length < 2) {
    // A narrow axis: two ticks closer than the usual spacing beat a lone label.
    const loose = pick(24);
    if (loose.length > drafts.length) drafts = loose;
  }
  const [first, next] = drafts;
  if (!tickFormat && first && drafts.every((tick) => tick.weight === 31)) {
    const named = `${first.label} ${new Date(first.value as number).getUTCFullYear()}`;
    if (!next || next.px - first.px >= (measure(named) + measure(next.label)) / 2 + LABEL_GAP + 2) drafts[0] = { ...first, label: named };
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Numeric and band ticks

function numericDrafts(scale: LinearScale, count: number, log: boolean, tickFormat?: (value: unknown) => string): Draft[] {
  const values = scale.ticks(count);
  const labels = tickFormat ? values.map((value) => tickFormat(value)) : numericTickLabels(values, log);
  return values.map((value, index) => ({ value, px: scale.map(value), label: labels[index]! }));
}

/** Band categories and their labels, per domain: read once per layout, not once per pass. */
type BandLabels = WeakMap<readonly unknown[], { values: (string | number)[]; labels: string[] }>;

function bandDrafts(scale: BandScale<string | number>, cache: BandLabels, tickFormat?: (value: unknown) => string): Draft[] {
  let entry = cache.get(scale.domain);
  if (!entry) {
    const values = Array.from(scale.domain);
    entry = { values, labels: values.map((value) => (tickFormat ? tickFormat(value) : String(value))) };
    cache.set(scale.domain, entry);
  }
  const { values, labels } = entry;
  return values.map((value, index) => ({ value, px: scale.map(value), label: labels[index]! }));
}

// ---------------------------------------------------------------------------
// Layout

export interface AxisScales {
  /** Plot rectangle the scales map into (the square-cell grid for heatmaps). */
  plot: PlotRect;
  xScale: AnyScale;
  yScale: AnyScale;
}

export interface AxisLayoutInput {
  spec: ChartSpec;
  width: number;
  height: number;
  /** Chart-family default margin with spec.margin applied (see resolveMargin). */
  margin: Margin;
  xType: XScaleKind;
  heatmap: boolean;
  polar: boolean;
  /** Label font (the theme font). */
  font: string;
  formatters: AxisFormatters;
  /** Heatmap colour-bar labels, for the right margin. */
  colorLabels?: readonly string[];
  /** Build scales for a candidate plot; called once per layout pass. */
  scales(plot: PlotRect, margin: Margin): AxisScales;
}

export interface AxisLayout extends AxisScales {
  margin: Margin;
  xTicks: SceneTick[];
  yTicks: SceneTick[];
  axes: SceneAxes;
}

/** Margins sized to measured labels, the scales for the final plot, and both axes' ticks. */
export function layoutAxes(input: AxisLayoutInput): AxisLayout {
  const { spec, width, height, heatmap, font } = input;
  const fixed = spec.margin ?? {};
  const xPolicy = resolveLabelPolicy("x", spec.scales?.x?.labels);
  const yPolicy = resolveLabelPolicy("y", spec.scales?.y?.labels);
  // Every pass re-measures the same labels (and ellipsis cuts); measure each once.
  const measure = measurer(font);
  const bandLabels: BandLabels = new WeakMap();
  const caps: Margin = {
    top: input.margin.top,
    right: Math.max(input.margin.right, width * CAP),
    bottom: Math.max(input.margin.bottom, height * CAP),
    left: Math.max(input.margin.left, width * CAP),
  };
  const chipTexts = lastValueTexts(spec.marks, input.formatters.formatY);

  let margin: Margin = { ...input.margin };
  for (let pass = 0; ; pass++) {
    const { plot, xScale, yScale } = input.scales(plotArea(width, height, margin), margin);
    if (input.polar) return { margin, plot, xScale, yScale, xTicks: [], yTicks: [], axes: emptyAxes(margin) };
    const right = plot.x + plot.w;
    const bottom = plot.y + plot.h;

    // Value axis: right of the plot, or left of the grid for heatmap rows.
    const yTickFormat = spec.scales?.y?.tickFormat;
    const [yDrafts] = thin(
      yScale.kind === "band"
        ? bandDrafts(yScale, bandLabels, yTickFormat)
        : numericDrafts(yScale, Math.max(2, Math.min(6, Math.floor(plot.h / 52))), spec.scales?.y?.type === "log", yTickFormat),
      yPolicy.interval,
      (a, b) => Math.abs(b.px - a.px) >= LABEL_LINE + 1,
      LABEL_LINE + 1,
    );
    const yCap = Math.min(yPolicy.maxWidth, Math.max(8, heatmap ? (fixed.left ?? caps.left) - 8 - EDGE : (fixed.right ?? caps.right) - 13));
    const yTicks = yDrafts.map((tick) => toSceneTick({ ...tick, label: ellipsize(tick.label, yCap, measure) }, "end", 0));
    let yExtent = 0;
    for (const tick of yTicks) yExtent = Math.max(yExtent, measure(tick.label));

    // Category/time axis below the plot.
    const xTickFormat = spec.scales?.x?.tickFormat;
    const x = layoutXLabels({
      drafts: xScale.kind === "band"
        ? bandDrafts(xScale, bandLabels, xTickFormat)
        : input.xType === "time"
          ? timeDrafts(xScale, plot, measure, xTickFormat)
          : numericDrafts(xScale, Math.max(2, Math.min(5, Math.floor(plot.w / 96))), input.xType === "log", xTickFormat),
      policy: xPolicy,
      categorical: xScale.kind === "band",
      measure,
      width,
      // A heatmap grid is centred in its plot, so the slack below it is room too.
      bottomRoom: (fixed.bottom ?? caps.bottom) + height - bottom - margin.bottom,
    });

    // Space each side needs, measured from the plot (or grid) edge.
    let needRight = yExtent + 13;
    if (heatmap) needRight = input.colorLabels?.length ? 22 + Math.max(...input.colorLabels.map(measure)) + EDGE + 2 : 0;
    else if (chipTexts.length && yScale.kind === "linear") {
      // Chips show the last values; value labels (formatY) are measured at the domain ends too.
      const texts = [...chipTexts, ...yScale.domain.map((value) => input.formatters.formatY(value))];
      needRight = Math.max(needRight, 18 + Math.max(...texts.map((text) => measureText(text, 10, font))));
    }
    // A heatmap grid fits its area (heatmapLayout drops the cell gaps rather
    // than spill past it), so a wider margin moves the grid's edge too.
    const deficits: Margin = {
      top: 0,
      right: needRight - (width - right),
      bottom: x.extent - (height - bottom),
      left: Math.max(heatmap ? yExtent + 8 + EDGE - plot.x : 0, x.leftOverflow),
    };

    const next = { ...margin };
    let grew = false;
    for (const side of ["right", "bottom", "left"] as const) {
      const target = Math.min(caps[side], Math.ceil(margin[side] + deficits[side]));
      if (fixed[side] === undefined && deficits[side] > 0.5 && target > next[side]) {
        next[side] = target;
        grew = true;
      }
    }
    if (!grew || pass === 3) {
      return {
        margin, plot, xScale, yScale, xTicks: x.ticks, yTicks,
        axes: {
          x: { position: "bottom", size: height - bottom, labelExtent: x.extent, ticks: x.ticks },
          y: { position: heatmap ? "left" : "right", size: heatmap ? plot.x : width - right, labelExtent: yExtent, ticks: yTicks },
        },
      };
    }
    margin = next;
  }
}

/** Line and area marks draw last-value chips unless disabled; bars only on request. */
function hasChip(mark: ChartMark): mark is LineChartMark | AreaChartMark | BarChartMark {
  return isBuiltinMark(mark) && (
    ((mark.kind === "line" || mark.kind === "area") && mark.lastValue !== false)
    || (mark.kind === "bar" && mark.lastValue === true)
  );
}

/**
 * Text of every last-value chip: each chip mark's last finite value, printed
 * through the Y value formatter exactly as the mark compilers print the chip.
 * Chips are measured from their own text so computed series (1.08523,
 * -0.366479) never spill into the plot.
 */
function lastValueTexts(marks: readonly ChartMark[], formatY: AxisFormatters["formatY"]): string[] {
  const texts: string[] = [];
  for (const mark of marks) {
    if (!hasChip(mark)) continue;
    const rows = mark.data;
    for (let index = rows.length; index--;) {
      const value = asNumber(readChannel(rows[index] as never, mark.y as never));
      if (Number.isFinite(value)) {
        texts.push(formatY(value));
        break;
      }
    }
  }
  return texts;
}

function emptyAxes(margin: Margin): SceneAxes {
  return {
    x: { position: "bottom", size: margin.bottom, labelExtent: 0, ticks: [] },
    y: { position: "right", size: margin.right, labelExtent: 0, ticks: [] },
  };
}
