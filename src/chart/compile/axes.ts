// Layout and axes: margins, label measurement, the plot rectangle, and the
// measured tick layout of both axes.
//
// Label widths are estimated at compile time, without a DOM, so SSR, Node
// and every renderer agree on the scene. The default chart font is
// monospace, so an estimate from character counts is exact up to the font's
// advance width; proportional fonts use a per-character table.
//
// layoutAxes() sizes the margins to the labels: the value axis grows to the
// widest tick label and last-value chip, rotated category labels reserve
// bottom margin, and heatmaps make room for their row labels and colour bar.
// Margins only grow (never below the chart-family defaults) and are capped,
// so the loop converges in a few passes; labels that still do not fit are cut
// with an ellipsis. Explicit spec.margin sides are never changed.

import type { AnyScale, BandScale, LinearScale } from "../scales";
import type { SceneAxes, SceneTick } from "../sceneTypes";
import { calendarTicks, type CalendarTick, type TickFormatInput } from "../../util/time/calendarTicks";
import { ChartCompileError } from "./errors";
import { MONTHS, numericTickLabels, type AxisFormatters } from "./format";
import { isBuiltinMark, type ChartMark } from "./marks";
import { isRecord } from "./shared";
import type { AxisLabelOptions, ChartSpec, Margin, PlotRect, XScaleKind } from "./types";

export const DEFAULT_MARGIN: Margin = { top: 14, right: 56, bottom: 26, left: 10 };

/** Font size of axis tick labels in both renderers. */
export const AXIS_FONT_SIZE = 9;
/** Font size of last-value chip labels. */
const CHIP_FONT_SIZE = 10;
/** Line box of a 9px label. */
const LABEL_LINE = 11;
/** Minimum gap between neighbouring labels. */
const LABEL_GAP = 6;
/** Y labels end this far before the chart's right edge (renderers draw them at width - 7). */
const Y_LABEL_INSET = 7;
/** Minimum gap between the plot edge and the widest Y label. */
const Y_LABEL_CLEARANCE = 6;
/** Chip gutter inset (3 + 3) plus chip text padding (6 + 6). */
const CHIP_PADDING = 18;
/** Heatmap row labels end 8px left of the grid. */
const HEAT_LABEL_INSET = 8;
/** Heatmap colour bar: 10px gap, 7px bar, 5px gap before its labels. */
const COLOR_BAR_LABEL_X = 22;
/** Horizontal X labels sit on a baseline 14px below the plot; rotated ones hang from 8px below it. */
const X_LABEL_BASELINE = 14;
const X_LABEL_ROTATED_TOP = 8;
/** Clearance kept to the chart edges. */
const EDGE = 2;
/** Category axes up to this length rotate rather than drop labels. */
const ROTATE_TO_KEEP_ALL = 12;
/** Minimum spacing between calendar ticks on a time axis. */
export const TIME_TICK_SPACING = 64;
/** Largest share of the chart a measured margin may take. */
const SIDE_CAP = 0.35;
const BOTTOM_CAP = 0.35;

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

function isWide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
    || (code >= 0x20000 && code <= 0x3fffd);
}

/** Advance width in em of one character of a proportional sans-serif font. */
function proportionalAdvance(char: string, code: number): number {
  if (isWide(code)) return 1;
  if (char >= "0" && char <= "9") return 0.56;
  if (" .,:;'|!iIlj".includes(char)) return 0.28;
  if ("-()[]{}/\\ftr\"".includes(char)) return 0.36;
  if ("mwMW@%".includes(char)) return 0.86;
  if (char >= "A" && char <= "Z") return 0.68;
  if (char >= "a" && char <= "z") return 0.52;
  return 0.6;
}

/** Estimated rendered width of `text` in CSS pixels. Monospace fonts (the default) are exact up to their advance. */
export function measureText(text: string, fontSize = AXIS_FONT_SIZE, font = "monospace"): number {
  const mono = /mono|courier|consolas|menlo|monaco/i.test(font);
  let em = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    em += mono ? (isWide(code) ? 1.2 : 0.6) : proportionalAdvance(char, code);
  }
  return em * fontSize;
}

/** `label`, or its longest prefix plus "…" that fits `maxWidth`. */
export function ellipsize(label: string, maxWidth: number, measure: (text: string) => number): string {
  if (!(maxWidth < Infinity) || measure(label) <= maxWidth) return label;
  const chars = Array.from(label);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${chars.slice(0, mid).join("").trimEnd()}…`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${chars.slice(0, lo).join("").trimEnd()}…`;
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
  if (value === undefined) return { rotate: "auto", maxWidth: Infinity, interval: "auto" };
  const where = `scales.${axis}.labels`;
  if (!isRecord(value)) {
    throw new ChartCompileError("E_SCALE_TYPE", `${where} must be an object with rotate, maxWidth, or interval.`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "rotate" && key !== "maxWidth" && key !== "interval") {
      throw new ChartCompileError("E_SCALE_TYPE", `${where} does not support option "${key}". Use rotate, maxWidth, or interval.`);
    }
  }
  const { rotate, maxWidth, interval } = value;
  let angle: "auto" | number = "auto";
  if (rotate !== undefined && rotate !== "auto") {
    if (axis === "y") {
      throw new ChartCompileError("E_SCALE_TYPE", "scales.y.labels.rotate is not supported: value-axis labels are always horizontal.");
    }
    if (typeof rotate === "boolean") angle = rotate ? -45 : 0;
    else if (typeof rotate === "number" && Number.isFinite(rotate) && rotate >= -90 && rotate <= 0) angle = rotate;
    else {
      throw new ChartCompileError(
        "E_SCALE_TYPE",
        `${where}.rotate must be "auto", a boolean, or an angle from -90 to 0 degrees; received ${String(rotate)}.`,
      );
    }
  }
  if (maxWidth !== undefined && (typeof maxWidth !== "number" || !Number.isFinite(maxWidth) || maxWidth <= 0)) {
    throw new ChartCompileError("E_SCALE_TYPE", `${where}.maxWidth must be a positive number of pixels; received ${String(maxWidth)}.`);
  }
  if (interval !== undefined && interval !== "auto" && !(typeof interval === "number" && Number.isInteger(interval) && interval >= 1)) {
    throw new ChartCompileError("E_SCALE_TYPE", `${where}.interval must be "auto" or a positive integer; received ${String(interval)}.`);
  }
  return { rotate: angle, maxWidth: maxWidth ?? Infinity, interval: interval ?? "auto" };
}

// ---------------------------------------------------------------------------
// Tick drafts and placement

interface Draft {
  value: unknown;
  px: number;
  label: string;
  weight?: number;
}

interface Placed extends Draft {
  width: number;
  left: number;
  right: number;
  anchor: SceneTick["anchor"];
}

function toSceneTick(tick: Draft, anchor: SceneTick["anchor"], rotation: number): SceneTick {
  return tick.weight === undefined
    ? { value: tick.value, px: tick.px, label: tick.label, anchor, rotation }
    : { value: tick.value, px: tick.px, label: tick.label, anchor, rotation, weight: tick.weight };
}

/** Horizontal extent of a centred label, anchored start/end when it would cross the chart edges. */
function placeHorizontal(tick: Draft, width: number, lo: number, hi: number): Placed {
  let anchor: SceneTick["anchor"] = "middle";
  let left = tick.px - width / 2;
  if (left < lo) {
    anchor = "start";
    left = tick.px;
  } else if (tick.px + width / 2 > hi) {
    anchor = "end";
    left = tick.px - width;
  }
  return { ...tick, width, left, right: left + width, anchor };
}

/** Every `interval`-th tick, plus the last tick when it fits after the last kept one. */
function every<T>(items: readonly T[], interval: number, fitsAfter: (previous: T, next: T) => boolean): T[] {
  const kept: T[] = [];
  for (let index = 0; index < items.length; index += interval) kept.push(items[index]!);
  const last = items[items.length - 1];
  if (last !== undefined && kept[kept.length - 1] !== last && fitsAfter(kept[kept.length - 1]!, last)) kept.push(last);
  return kept;
}

function horizontalFits(placed: readonly Placed[]): boolean {
  for (let index = 1; index < placed.length; index++) {
    if (placed[index]!.left - placed[index - 1]!.right < LABEL_GAP) return false;
  }
  return true;
}

/** Keep labels left to right, dropping one that collides with the previous kept label (the lighter one loses). */
function dropCollisions(placed: readonly Placed[]): Placed[] {
  const kept: Placed[] = [];
  for (const tick of placed) {
    const previous = kept[kept.length - 1];
    if (previous && tick.left - previous.right < LABEL_GAP) {
      if ((tick.weight ?? 0) > (previous.weight ?? 0)) kept[kept.length - 1] = tick;
      continue;
    }
    kept.push(tick);
  }
  return kept;
}

interface XLayoutInput {
  drafts: Draft[];
  policy: LabelPolicy;
  /** Band axes may rotate automatically; generated numeric/time ticks thin instead. */
  categorical: boolean;
  measure: (text: string) => number;
  /** Horizontal extent labels must stay inside. */
  lo: number;
  hi: number;
  /** Largest vertical extent rotated labels may take below the plot. */
  bottomRoom: number;
}

interface XLayoutResult {
  ticks: SceneTick[];
  /** Space needed below the plot for the labels. */
  extent: number;
  /** Extra space rotated labels need left of `lo`. */
  leftOverflow: number;
}

/** Pixels needed between consecutive rotated labels so their lines do not touch. */
function rotatedPitch(angle: number): number {
  const sin = Math.abs(Math.sin((angle * Math.PI) / 180));
  return LABEL_LINE / Math.max(sin, 0.2) + 2;
}

function layoutHorizontal(input: XLayoutInput, interval: number | "auto"): { ticks: Placed[]; interval: number } {
  const { drafts, policy, measure, lo, hi } = input;
  const cap = Math.min(policy.maxWidth, Math.max(24, (hi - lo) / 2));
  const labelled = drafts.map((tick) => ({ ...tick, label: ellipsize(tick.label, cap, measure) }));
  const place = (tick: Draft): Placed => placeHorizontal(tick, measure(tick.label), lo, hi);
  const fitsAfter = (a: Draft, b: Draft): boolean => place(b).left - place(a).right >= LABEL_GAP;
  if (interval !== "auto") {
    // A fixed interval is honoured; labels are cut to their share of the axis.
    const kept = every(labelled, interval, () => false);
    const pitch = kept.length > 1
      ? Math.min(...kept.slice(1).map((tick, index) => Math.abs(tick.px - kept[index]!.px)))
      : hi - lo;
    const share = Math.max(8, pitch - LABEL_GAP);
    return { ticks: kept.map((tick) => place({ ...tick, label: ellipsize(tick.label, share, measure) })), interval };
  }
  for (let n = 1; n <= Math.max(1, labelled.length); n++) {
    const kept = every(labelled, n, fitsAfter).map(place);
    if (horizontalFits(kept)) return { ticks: kept, interval: n };
  }
  return { ticks: dropCollisions(labelled.map(place)), interval: labelled.length };
}

function layoutRotated(input: XLayoutInput, angle: number, interval: number | "auto"): XLayoutResult & { interval: number } {
  const { drafts, policy, measure, lo, bottomRoom } = input;
  const radians = (Math.abs(angle) * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  // Vertical room caps the label length; each label is also cut so it cannot cross the left edge.
  const byRoom = sin > 0.05 ? (bottomRoom - X_LABEL_ROTATED_TOP - LABEL_LINE * cos) / sin : Infinity;
  const cap = Math.max(12, Math.min(policy.maxWidth, byRoom, 160));
  const pitch = rotatedPitch(angle);
  const fitsAfter = (a: Draft, b: Draft): boolean => Math.abs(b.px - a.px) >= pitch;
  let n = interval === "auto" ? 1 : interval;
  if (interval === "auto") {
    while (n < drafts.length && !every(drafts, n, fitsAfter).every((tick, index, list) => index === 0 || fitsAfter(list[index - 1]!, tick))) n++;
  }
  const kept = every(drafts, n, interval === "auto" ? fitsAfter : () => false);
  let extent = 0;
  let leftOverflow = 0;
  const ticks = kept.map((tick) => {
    const label = ellipsize(tick.label, cap, measure);
    const width = measure(label);
    extent = Math.max(extent, X_LABEL_ROTATED_TOP + width * sin + LABEL_LINE * cos + EDGE);
    leftOverflow = Math.max(leftOverflow, lo - (tick.px - width * cos - (LABEL_LINE / 2) * sin));
    return toSceneTick({ ...tick, label }, "end", -Math.abs(angle));
  });
  return { ticks, extent, leftOverflow: Math.max(0, leftOverflow), interval: n };
}

/**
 * Pick the X label layout: every label, every nth label, rotated labels,
 * then ellipsis. Automatic rotation applies to categories only (generated
 * numeric and time ticks are already spaced for their labels).
 */
function layoutXLabels(input: XLayoutInput): XLayoutResult {
  const { policy, drafts } = input;
  if (!drafts.length) return { ticks: [], extent: X_LABEL_BASELINE + 4, leftOverflow: 0 };
  if (policy.rotate !== "auto" && policy.rotate !== 0) {
    return layoutRotated(input, policy.rotate, policy.interval);
  }
  const horizontal = layoutHorizontal(input, policy.interval);
  if (policy.rotate === "auto" && input.categorical && policy.interval === "auto" && horizontal.interval > 1) {
    // A short list of categories is kept whole by rotating: every label names
    // a mark. Longer lists (weeks, hours) thin horizontally to every other
    // label, and rotate only when that would show under half the labels
    // rotation can.
    const rotated = layoutRotated(input, -45, "auto");
    const keepsAll = rotated.interval === 1 && drafts.length <= ROTATE_TO_KEEP_ALL;
    if (keepsAll || (horizontal.interval > 2 && horizontal.interval > 2 * rotated.interval)) return rotated;
  }
  return {
    ticks: horizontal.ticks.map((tick) => toSceneTick(tick, tick.anchor, 0)),
    extent: X_LABEL_BASELINE + 4,
    leftOverflow: 0,
  };
}

// ---------------------------------------------------------------------------
// Tick generation

/** Calendar tick labels: 2025, Feb, 14 Feb, 09:30, 09:30:15. */
function calendarLabel(tick: TickFormatInput, fallback: string): string {
  if (tick.unit !== "day" && tick.unit !== "week") return fallback;
  const date = new Date(tick.wall);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/**
 * Calendar-aligned time ticks from the shared time core: intervals from 1s
 * to centuries, aligned to minutes, days, weeks, months and years, with
 * boundary ticks labelled by the higher unit. A month axis without a year
 * boundary names the year on its first tick ("Mar 2025").
 */
function timeDrafts(scale: LinearScale, plot: PlotRect, measure: (text: string) => number, tickFormat?: (value: unknown) => string): Draft[] {
  const [lo, hi] = scale.domain;
  let ticks: CalendarTick[];
  try {
    ticks = calendarTicks({
      from: Math.min(lo, hi),
      to: Math.max(lo, hi),
      width: plot.w,
      minSpacing: TIME_TICK_SPACING,
      maxTicks: Math.max(2, Math.floor(plot.w / TIME_TICK_SPACING) + 1),
      measure,
      labelGap: LABEL_GAP + 2,
      format: tickFormat ? (tick) => tickFormat(tick.time) : calendarLabel,
    });
  } catch (error) {
    // Instants outside the Date range cannot be calendar ticks.
    if (!(error instanceof RangeError)) throw error;
    return scale.ticks(2).map((value) => ({ value, px: scale.map(value), label: tickFormat ? tickFormat(value) : String(value) }));
  }
  const drafts: Draft[] = ticks.map((tick) => ({ value: tick.time, px: scale.map(tick.time), label: tick.label, weight: tick.weight }));
  if (!tickFormat && ticks.length && ticks.every((tick) => tick.unit === "month")) {
    const first = drafts[0]!;
    const named = `${first.label} ${new Date(ticks[0]!.time).getUTCFullYear()}`;
    const next = drafts[1];
    if (!next || Math.abs(next.px - first.px) >= (measure(named) + measure(next.label)) / 2 + LABEL_GAP + 2) {
      drafts[0] = { ...first, label: named };
    }
  }
  return drafts;
}

function numericDrafts(scale: LinearScale, count: number, log: boolean, tickFormat?: (value: unknown) => string): Draft[] {
  const values = scale.ticks(count);
  const labels = tickFormat ? values.map((value) => tickFormat(value)) : numericTickLabels(values, log);
  return values.map((value, index) => ({ value, px: scale.map(value), label: labels[index]! }));
}

function bandDrafts(scale: BandScale<string | number>, tickFormat?: (value: unknown) => string): Draft[] {
  return scale.domain.map((value) => ({
    value,
    px: scale.map(value),
    label: tickFormat ? tickFormat(value) : String(value),
  }));
}

/** Keep Y labels at least one line apart; band axes label every nth row when rows are shorter than a line. */
function thinVertical(drafts: Draft[], interval: number | "auto"): Draft[] {
  if (interval !== "auto") return every(drafts, interval, () => false);
  const pitch = LABEL_LINE + 1;
  for (let n = 1; n <= drafts.length; n++) {
    const kept = every(drafts, n, (a, b) => Math.abs(b.px - a.px) >= pitch);
    if (kept.every((tick, index) => index === 0 || Math.abs(tick.px - kept[index - 1]!.px) >= pitch)) return kept;
  }
  return drafts.slice(0, 1);
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
  /** Line/area/bar marks will draw last-value chips in the value-axis gutter. */
  chips: boolean;
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

const MAX_LAYOUT_PASSES = 4;

/** Margins sized to measured labels, the scales for the final plot, and both axes' ticks. */
export function layoutAxes(input: AxisLayoutInput): AxisLayout {
  const { spec, width, height, heatmap, polar, font } = input;
  const fixed = spec.margin ?? {};
  const xPolicy = resolveLabelPolicy("x", spec.scales?.x?.labels);
  const yPolicy = resolveLabelPolicy("y", spec.scales?.y?.labels);
  const measure = (text: string): number => measureText(text, AXIS_FONT_SIZE, font);
  const measureChip = (text: string): number => measureText(text, CHIP_FONT_SIZE, font);
  const caps: Margin = {
    top: input.margin.top,
    right: Math.max(input.margin.right, width * SIDE_CAP),
    bottom: Math.max(input.margin.bottom, height * BOTTOM_CAP),
    left: Math.max(input.margin.left, width * SIDE_CAP),
  };

  let margin: Margin = { ...input.margin };
  let result: AxisLayout | null = null;
  for (let pass = 0; pass < MAX_LAYOUT_PASSES; pass++) {
    const { plot, xScale, yScale } = input.scales(plotArea(width, height, margin), margin);
    if (polar) {
      return { margin, plot, xScale, yScale, xTicks: [], yTicks: [], axes: emptyAxes(margin) };
    }
    const right = plot.x + plot.w;
    const bottom = plot.y + plot.h;

    // Value axis: right of the plot, or left of the grid for heatmap rows.
    const yRoom = heatmap
      ? Math.max(8, (fixed.left ?? caps.left) - HEAT_LABEL_INSET - EDGE)
      : Math.max(8, (fixed.right ?? caps.right) - Y_LABEL_INSET - Y_LABEL_CLEARANCE);
    const yTickFormat = spec.scales?.y?.tickFormat;
    const yDrafts = thinVertical(
      yScale.kind === "band"
        ? bandDrafts(yScale, yTickFormat)
        : numericDrafts(yScale, Math.max(2, Math.min(6, Math.floor(plot.h / 52))), spec.scales?.y?.type === "log", yTickFormat),
      yPolicy.interval,
    );
    const yCap = Math.min(yPolicy.maxWidth, yRoom);
    const yTicks = yDrafts.map((tick) => toSceneTick({ ...tick, label: ellipsize(tick.label, yCap, measure) }, "end", 0));
    const yExtent = Math.max(0, ...yTicks.map((tick) => measure(tick.label)));

    // Category/time axis below the plot.
    const xTickFormat = spec.scales?.x?.tickFormat;
    let xDrafts: Draft[];
    if (xScale.kind === "band") xDrafts = bandDrafts(xScale, xTickFormat);
    else if (input.xType === "time") xDrafts = timeDrafts(xScale, plot, measure, xTickFormat);
    else xDrafts = numericDrafts(xScale, Math.max(2, Math.min(5, Math.floor(plot.w / 96))), input.xType === "log", xTickFormat);
    // A heatmap grid is centred in its plot, so the slack below it is room too.
    const bottomRoom = (fixed.bottom ?? caps.bottom) + (height - bottom - margin.bottom);
    const x = layoutXLabels({
      drafts: xDrafts,
      policy: xPolicy,
      categorical: xScale.kind === "band",
      measure,
      lo: EDGE,
      hi: width - EDGE,
      bottomRoom,
    });

    // Space each side needs, measured from the plot (or grid) edge.
    const needRight = heatmap
      ? (input.colorLabels?.length ? COLOR_BAR_LABEL_X + Math.max(...input.colorLabels.map(measure)) + EDGE + 2 : 0)
      : Math.max(
        yExtent + Y_LABEL_INSET + Y_LABEL_CLEARANCE,
        input.chips ? chipWidth(input, yScale, measureChip) + CHIP_PADDING : 0,
      );
    const needLeft = heatmap ? yExtent + HEAT_LABEL_INSET + EDGE : 0;
    const deficits: Margin = {
      top: 0,
      right: needRight - (width - right),
      bottom: x.extent - (height - bottom),
      left: Math.max(needLeft - plot.x, x.leftOverflow),
    };

    const xTicks = x.ticks;
    result = {
      margin, plot, xScale, yScale, xTicks, yTicks,
      axes: {
        x: { position: "bottom", size: height - bottom, labelExtent: x.extent, ticks: xTicks },
        y: {
          position: heatmap ? "left" : "right",
          size: heatmap ? plot.x : width - right,
          labelExtent: yExtent,
          ticks: yTicks,
        },
      },
    };

    const next = { ...margin };
    let grew = false;
    for (const side of ["right", "bottom", "left"] as const) {
      if (fixed[side] !== undefined || deficits[side] <= 0.5) continue;
      const target = Math.min(caps[side], Math.ceil(margin[side] + deficits[side]));
      if (target > next[side]) {
        next[side] = target;
        grew = true;
      }
    }
    if (!grew) break;
    margin = next;
  }
  return result!;
}

/** Line and area marks draw last-value chips unless disabled; bars only on request. */
export function hasValueChips(marks: readonly ChartMark[]): boolean {
  return marks.some((mark) => isBuiltinMark(mark) && (
    ((mark.kind === "line" || mark.kind === "area") && mark.lastValue !== false)
    || (mark.kind === "bar" && mark.lastValue === true)
  ));
}

/** Widest last-value chip text, estimated from the value formatter at the Y domain ends. */
function chipWidth(input: AxisLayoutInput, yScale: AnyScale, measureChip: (text: string) => number): number {
  if (yScale.kind !== "linear") return 0;
  const [lo, hi] = yScale.domain;
  return Math.max(measureChip(input.formatters.formatY(lo)), measureChip(input.formatters.formatY(hi)));
}

function emptyAxes(margin: Margin): SceneAxes {
  return {
    x: { position: "bottom", size: margin.bottom, labelExtent: 0, ticks: [] },
    y: { position: "right", size: margin.right, labelExtent: 0, ticks: [] },
  };
}
