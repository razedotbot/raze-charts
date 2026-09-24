// Mark grammar: typed built-in mark shapes, their option interfaces, the
// builder functions, and the custom-mark plugin entry points.

import { ChartCompileError } from "./errors";
import type { Accessor, ChartCurve, ChartMarkPlugin, ErasedMarkPlugin, MarkKind } from "./types";

/** Presentation and channel fields shared by built-in and plugin-authored marks. */
export interface ChartMarkBase {
  data: readonly unknown[];
  x?: Accessor<never> | string;
  y?: Accessor<never> | string;
  name?: string;
  /** Stable series id for legends, `hiddenSeries` and hover payloads. Defaults to `mark-<index>`. */
  id?: string;
  key?: Accessor<never> | string;
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
  r?: number;
  stackId?: string;
  innerRadius?: number;
  outerRadius?: number;
  angleKey?: Accessor<never> | string;
  valueKey?: Accessor<never> | string;
  labelKey?: Accessor<never> | string;
  /** Draw the last-value chip + dashed level. Default true for line/area. */
  lastValue?: boolean;
  dashed?: boolean;
  /** Histogram fade: later bars read as “now”. */
  fade?: boolean;
  curve?: ChartCurve;
  y0?: Accessor<never> | string;
  /** Ranged-area lower-edge stroke: `true` for the series colour, or a CSS colour. */
  stroke0?: string | boolean;
  /** Minimum painted height, in pixels, for non-zero bars. Zero stays empty. */
  minBarHeight?: number;
  /** Reference-rule label text, or `false` for none. */
  label?: string | false;
  /** Where a reference-rule label sits along the rule. */
  labelPosition?: RuleLabelPosition;
}

/** Reference-rule label placement along the rule: its start (left/top), middle, or end (right/bottom). */
export type RuleLabelPosition = "start" | "middle" | "end";

type BuiltinBase = Omit<
  ChartMarkBase,
  "x" | "y" | "key" | "stroke" | "fill" | "fillOpacity" | "strokeWidth" | "r"
  | "stackId" | "innerRadius" | "outerRadius" | "angleKey" | "valueKey" | "labelKey"
  | "lastValue" | "dashed" | "fade" | "curve" | "y0" | "stroke0" | "minBarHeight" | "label" | "labelPosition"
> & { plugin?: never; pluginOptions?: never };
type BuiltinCartesian = BuiltinBase & { x: Accessor<never> | string; y: Accessor<never> | string };

export type LineChartMark = BuiltinCartesian & {
  kind: "line";
  stroke?: string;
  strokeWidth?: number;
  lastValue?: boolean;
  dashed?: boolean;
  curve?: ChartCurve;
};
export type AreaChartMark = BuiltinCartesian & {
  kind: "area";
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
  lastValue?: boolean;
  dashed?: boolean;
  curve?: ChartCurve;
  y0?: Accessor<never> | string;
  stroke0?: string | boolean;
};
export type BarChartMark = BuiltinCartesian & {
  kind: "bar";
  fill?: string;
  stackId?: string;
  lastValue?: boolean;
  fade?: boolean;
  minBarHeight?: number;
};
export type PointChartMark = BuiltinCartesian & {
  kind: "point";
  fill?: string;
  fillOpacity?: number;
  r?: number;
};
export type RuleYChartMark = BuiltinBase & {
  kind: "ruleY";
  y: Accessor<never> | string;
  stroke?: string;
  strokeWidth?: number;
  dashed?: boolean;
  label?: string | false;
  labelPosition?: RuleLabelPosition;
};
export type RuleXChartMark = BuiltinBase & {
  kind: "ruleX";
  x: Accessor<never> | string;
  stroke?: string;
  strokeWidth?: number;
  dashed?: boolean;
  label?: string | false;
  labelPosition?: RuleLabelPosition;
};
export type PieChartMark = BuiltinBase & {
  kind: "pie";
  valueKey: Accessor<never> | string;
  labelKey?: Accessor<never> | string;
  innerRadius?: number;
  outerRadius?: number;
};
export type RadarChartMark = BuiltinCartesian & {
  kind: "radar";
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
};
/**
 * How heatmap values print in cells, tooltips and the colour bar: "number"
 * (default, data precision), "percent" (12.5%), "signed" (+12.5),
 * "signed-percent" (+12.5%), or a function of the raw value. Percent presets
 * treat values as percentage points (12.5 prints 12.5%).
 */
export type HeatmapValueFormat = "number" | "percent" | "signed" | "signed-percent" | ((value: number) => string);

export type HeatmapChartMark = BuiltinCartesian & {
  kind: "heatmap";
  valueKey: Accessor<never> | string;
  valueFormat?: HeatmapValueFormat;
};

/** Built-ins form a discriminated union, so mark-specific fields fail at the type boundary. */
export type BuiltinChartMark =
  | LineChartMark
  | AreaChartMark
  | BarChartMark
  | PointChartMark
  | RuleYChartMark
  | RuleXChartMark
  | PieChartMark
  | RadarChartMark
  | HeatmapChartMark;

/** A custom layer. Use customMark() so data and options remain inferred. */
export type PluginChartMark = Pick<ChartMarkBase, "data" | "name" | "id"> & {
  kind: string;
  plugin: ErasedMarkPlugin;
  pluginOptions: unknown;
  stroke?: string;
  fill?: string;
};

/** Unknown kinds must carry a plugin; typos therefore fail during type checking. */
export type ChartMark = BuiltinChartMark | PluginChartMark;

/** Marks positioned by x/y channels on Cartesian (or polar/heatmap) scales. */
export type XYChartMark = LineChartMark | AreaChartMark | BarChartMark | PointChartMark | RadarChartMark | HeatmapChartMark;
/** Marks that contribute Cartesian x values and y extents. */
export type CartesianChartMark = LineChartMark | AreaChartMark | BarChartMark | PointChartMark;

export const BUILTIN_MARK_KINDS = new Set<MarkKind>([
  "line", "area", "bar", "point", "ruleY", "ruleX", "pie", "radar", "heatmap",
]);

export function isPluginMark(mark: ChartMark): mark is PluginChartMark {
  return mark.plugin != null;
}

export function isBuiltinMark(mark: ChartMark): mark is BuiltinChartMark {
  return !isPluginMark(mark);
}

export function isBuiltinKind<K extends MarkKind>(
  mark: ChartMark,
  kind: K,
): mark is Extract<BuiltinChartMark, { kind: K }> {
  return isBuiltinMark(mark) && mark.kind === kind;
}

interface NamedMarkOptions {
  /** Series name shown in the legend and tooltips. Defaults to the y accessor name or the mark kind. */
  name?: string;
  /**
   * Stable series id: the key `hiddenSeries`, legend toggles and hover
   * payloads use. Defaults to `mark-<index>`; ids must be unique per chart.
   */
  id?: string;
}

export interface CartesianMarkOptions<T> extends NamedMarkOptions {
  x: Accessor<T>;
  y: Accessor<T>;
}

export interface LineMarkOptions<T> extends CartesianMarkOptions<T> {
  stroke?: string;
  strokeWidth?: number;
  lastValue?: boolean;
  dashed?: boolean;
  curve?: ChartCurve;
}

export interface AreaMarkOptions<T> extends CartesianMarkOptions<T> {
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
  lastValue?: boolean;
  dashed?: boolean;
  curve?: ChartCurve;
  /** Lower edge of a ranged area (a band between `y0` and `y`). */
  y0?: Accessor<T>;
  /** Stroke the ranged area's lower edge: `true` uses the series colour, a string sets it. */
  stroke0?: string | boolean;
}

export interface BarMarkOptions<T> extends CartesianMarkOptions<T> {
  fill?: string;
  stackId?: string;
  lastValue?: boolean;
  /** Earlier bars fade toward the chart background so later bars read as “now”. */
  fade?: boolean;
  /**
   * Minimum painted height in pixels for non-zero values (Recharts'
   * `minPointSize`). Off by default: a zero value paints nothing and a
   * sub-pixel value rounds to nothing; both stay hoverable.
   */
  minBarHeight?: number;
}

export interface PointMarkOptions<T> extends CartesianMarkOptions<T> {
  fill?: string;
  fillOpacity?: number;
  r?: number;
}

/** Options shared by ruleY and ruleX. */
export interface RuleMarkOptions extends NamedMarkOptions {
  stroke?: string;
  strokeWidth?: number;
  /** Dashed (default) or solid rule. */
  dashed?: boolean;
  /**
   * Label text. Defaults to the formatted value, prefixed by `name` when one
   * is set; `false` draws no label.
   */
  label?: string | false;
  /** Label placement along the rule. Defaults to `"start"` (left for ruleY, top for ruleX). */
  labelPosition?: RuleLabelPosition;
}

export interface RuleYMarkOptions extends RuleMarkOptions {}

export interface RuleXMarkOptions extends RuleMarkOptions {}

export interface PieMarkOptions<T> extends NamedMarkOptions {
  valueKey: Accessor<T>;
  labelKey?: Accessor<T>;
  innerRadius?: number;
  outerRadius?: number;
}

export interface RadarMarkOptions<T> extends CartesianMarkOptions<T> {
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
}

export interface HeatmapMarkOptions<T> extends NamedMarkOptions {
  x: Accessor<T>;
  y: Accessor<T>;
  valueKey: Accessor<T>;
  /** Cell, tooltip and colour-bar value format. Default "number" (no sign, no %). */
  valueFormat?: HeatmapValueFormat;
}

export function line<T>(data: readonly T[], opts: LineMarkOptions<T>): LineChartMark {
  return { kind: "line", data, ...opts } as LineChartMark;
}
export function area<T>(data: readonly T[], opts: AreaMarkOptions<T>): AreaChartMark {
  return { kind: "area", data, ...opts } as AreaChartMark;
}
export function bar<T>(data: readonly T[], opts: BarMarkOptions<T>): BarChartMark {
  return { kind: "bar", data, ...opts } as BarChartMark;
}
export function point<T>(data: readonly T[], opts: PointMarkOptions<T>): PointChartMark {
  return { kind: "point", data, ...opts } as PointChartMark;
}
export function ruleY(values: readonly number[], opts?: RuleYMarkOptions): RuleYChartMark {
  return { kind: "ruleY", data: values.map((y) => ({ y })), y: "y", ...opts };
}
export function ruleX(
  values: readonly (number | string | Date)[],
  opts?: RuleXMarkOptions,
): RuleXChartMark {
  return { kind: "ruleX", data: values.map((x) => ({ x })), x: "x", ...opts };
}
export function pie<T>(data: readonly T[], opts: PieMarkOptions<T>): PieChartMark {
  return { kind: "pie", data, ...opts } as PieChartMark;
}
export function radar<T>(data: readonly T[], opts: RadarMarkOptions<T>): RadarChartMark {
  return { kind: "radar", data, ...opts } as RadarChartMark;
}
export function heatmap<T>(data: readonly T[], opts: HeatmapMarkOptions<T>): HeatmapChartMark {
  return { kind: "heatmap", data, ...opts } as HeatmapChartMark;
}

function assertCustomKind(plugin: { kind?: unknown } | null | undefined): void {
  if (!plugin || typeof plugin.kind !== "string" || !plugin.kind.trim()) {
    throw new ChartCompileError("E_MARK_PLUGIN_KIND", "A mark plugin requires a non-empty kind.");
  }
  if (BUILTIN_MARK_KINDS.has(plugin.kind as MarkKind)) {
    throw new ChartCompileError(
      "E_MARK_PLUGIN_KIND",
      `Custom mark kind "${plugin.kind}" is reserved by the built-in grammar. Choose a product-specific kind.`,
    );
  }
}

export function defineMarkPlugin<TDatum, TOptions>(
  plugin: ChartMarkPlugin<TDatum, TOptions>,
): ChartMarkPlugin<TDatum, TOptions> {
  assertCustomKind(plugin);
  return plugin;
}

export function customMark<TDatum, TOptions>(
  plugin: ChartMarkPlugin<TDatum, TOptions>,
  data: readonly TDatum[],
  options: TOptions,
): PluginChartMark {
  assertCustomKind(plugin);
  return {
    kind: plugin.kind,
    data,
    plugin: plugin as unknown as ErasedMarkPlugin,
    pluginOptions: options,
  };
}
