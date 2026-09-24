// Public native grammar contracts: channels, chart specs, scale specs, the
// renderer-neutral scene, and the custom-mark plugin boundary. Mark shapes and
// builders live in ./marks.

import type { AnyScale } from "../scales";
import type { ChartThemeInput, DashboardTheme } from "../theme";
import type { ChartMark } from "./marks";

export type Accessor<T> = keyof T & string | ((row: T) => unknown);

export type MarkKind = "line" | "area" | "bar" | "point" | "ruleY" | "ruleX" | "pie" | "radar" | "heatmap";
export type ChartCurve = "monotone" | "linear" | "step";
export type ChartViewportX = readonly [number | Date, number | Date] | readonly (string | number)[];
export interface ChartViewport {
  x?: ChartViewportX;
  y?: readonly [number, number];
}

export interface MarkDomainContribution {
  x?: readonly unknown[];
  y?: readonly number[];
  /** Include zero in the inferred quantitative Y domain. */
  includeZero?: boolean;
}

export interface ChartMarkPluginResult {
  nodes: SceneNode[];
  legend?: { name: string; color: string; detail?: string }[];
  samples?: HoverSample[];
  lastValues?: LastValue[];
}

export interface ChartMarkPluginLinearScale {
  readonly kind: "linear";
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  map(value: number): number;
  invert(px: number): number;
  ticks(count?: number): number[];
  copy(): ChartMarkPluginLinearScale;
}

export interface ChartMarkPluginBandScale {
  readonly kind: "band";
  readonly domain: readonly (string | number)[];
  readonly range: readonly [number, number];
  readonly padding: number;
  map(value: string | number): number;
  start(value: string | number): number;
  bandwidth(): number;
  copy(): ChartMarkPluginBandScale;
}

export type ChartMarkPluginScale = ChartMarkPluginLinearScale | ChartMarkPluginBandScale;

export interface ChartMarkPluginContext<TDatum, TOptions> {
  data: readonly TDatum[];
  options: TOptions;
  width: number;
  height: number;
  plot: Readonly<{ x: number; y: number; w: number; h: number }>;
  xScale: ChartMarkPluginScale;
  yScale: ChartMarkPluginScale;
  theme: Readonly<DashboardTheme>;
  color: string;
  name: string;
  mapX(value: unknown): number;
  mapY(value: unknown): number;
}

/** Renderer-neutral extension point for product-specific chart layers. */
export interface ChartMarkPlugin<TDatum, TOptions = Record<string, never>> {
  readonly kind: string;
  domain?(data: readonly TDatum[], options: TOptions): MarkDomainContribution;
  compile(context: ChartMarkPluginContext<TDatum, TOptions>): ChartMarkPluginResult;
}

export type ErasedMarkPlugin = ChartMarkPlugin<unknown, unknown>;

export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface LinearScaleSpec {
  type: "linear";
  nice?: boolean;
  padding?: never;
  domain?: readonly [number, number];
  tickFormat?: (value: unknown) => string;
}

export interface AutoLinearScaleSpec {
  type?: undefined;
  nice?: boolean;
  padding?: never;
  domain?: readonly [number, number];
  tickFormat?: (value: unknown) => string;
}

export interface LogScaleSpec {
  type: "log";
  nice?: never;
  padding?: never;
  domain?: readonly [number, number];
  tickFormat?: (value: unknown) => string;
}

export interface TimeScaleSpec {
  type: "time";
  nice?: never;
  padding?: never;
  domain?: readonly [number | Date, number | Date];
  tickFormat?: (value: unknown) => string;
}

export interface BandScaleSpec {
  type: "band";
  nice?: never;
  padding?: number;
  domain?: readonly (string | number)[];
  tickFormat?: (value: unknown) => string;
}

export type XScaleSpec = LinearScaleSpec | LogScaleSpec | TimeScaleSpec | BandScaleSpec;
export type YScaleSpec = AutoLinearScaleSpec | LinearScaleSpec | LogScaleSpec;
export type HeatmapYScaleSpec = BandScaleSpec;
/** @deprecated Prefer the axis-specific XScaleSpec or YScaleSpec. */
export type ScaleSpec = XScaleSpec | YScaleSpec | HeatmapYScaleSpec;
/** Resolved X scale family after explicit configuration or inference. */
export type XScaleKind = XScaleSpec["type"];

export interface ChartSpec {
  marks: readonly ChartMark[];
  scales?: { x?: XScaleSpec; y?: YScaleSpec | HeatmapYScaleSpec };
  width?: number;
  height?: number;
  margin?: Partial<Margin>;
  grid?: boolean;
  tooltip?: boolean;
  legend?: boolean;
  ariaLabel?: string;
  /** Longer screen-reader description. Visual renderers do not display it. */
  ariaDescription?: string;
  performance?: ChartPerformanceOptions;
  /** `"dark"` (default) matches the raze trading widget pane. */
  theme?: ChartThemeInput;
  /** Visible X/Y window applied before geometry and decimation. */
  viewport?: ChartViewport;
  /** Series names omitted from geometry (legend toggle). */
  hiddenSeries?: readonly string[];
}

export interface ChartPerformanceOptions {
  /**
   * Dense line/area geometry is reduced to a pixel-aware extrema envelope by
   * default. Set to `"none"` when every source point must become an SVG/Canvas
   * path point (for example, for offline geometry processing).
   */
  decimation?: "auto" | "none";
  /** Maximum source-derived path samples per line/area series while decimation is enabled. Defaults to 2 per plot px. */
  maxRenderedPoints?: number;
}

export interface ChartDefinition {
  spec(input: { width: number; height: number }): ChartSpec;
}

export interface ScenePoint {
  x: number;
  y: number;
}

export interface SceneNodeBase {
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  w?: number;
  h?: number;
  r?: number;
  innerR?: number;
  startAngle?: number;
  endAngle?: number;
  points?: ScenePoint[];
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
  dashed?: boolean;
  datum?: unknown;
  series?: string;
  label?: string;
  anchor?: "start" | "middle" | "end";
  fontSize?: number;
  corner?: "all" | "top" | "bottom" | "none";
  tip?: string;
  clip?: boolean;
  hit?: boolean;
  role?: string;
  idx?: number;
  highlight?: boolean;
  /** Plot-space endpoint representing the datum value (for example a negative bar bottom). */
  valueY?: number;
  curve?: ChartCurve;
}

/** Renderer-neutral geometry with required fields encoded by primitive kind. */
export type SceneNode = SceneNodeBase & (
  | { type: "line" | "area" | "polygon"; points: ScenePoint[] }
  | { type: "rect"; x: number; y: number; w: number; h: number }
  | { type: "circle"; x: number; y: number; r: number }
  | { type: "rule"; x: number; y: number; x2: number; y2: number }
  | { type: "arc"; x: number; y: number; r: number; innerR: number; startAngle: number; endAngle: number }
  | { type: "text"; x: number; y: number; label: string }
);

export interface HoverSample {
  x: number;
  y: number;
  series: string;
  color: string;
  tip: string;
  kind: "line" | "point" | "radar";
}

export interface LastValue {
  y: number;
  label: string;
  color: string;
  dash?: boolean;
}

/** One legend row. Plugins may contribute their own rows. */
export interface LegendEntry {
  name: string;
  color: string;
  detail?: string;
}

/** One axis tick: source value, plot-space pixel, and formatted label. */
export interface AxisTick {
  value: unknown;
  px: number;
  label: string;
}

export interface CompiledChart {
  width: number;
  height: number;
  margin: Margin;
  plot: { x: number; y: number; w: number; h: number };
  xScale: AnyScale;
  yScale: AnyScale;
  xTicks: { value: unknown; px: number; label: string }[];
  yTicks: { value: unknown; px: number; label: string }[];
  grid: boolean;
  legend: { name: string; color: string; detail?: string }[];
  nodes: SceneNode[];
  tooltip: boolean;
  ariaLabel: string;
  ariaDescription: string;
  polar: boolean;
  theme: DashboardTheme;
  lastValues: LastValue[];
  heatmap: boolean;
  colorBar: { min: number; max: number } | null;
  legendPlacement: "top" | "right" | "hidden";
  samples: HoverSample[];
  diagnostics: ChartDiagnostics;
  viewport: ChartViewport | null;
}

export interface ChartDiagnostics {
  /** Rows presented to all marks, before validity filtering or decimation. */
  sourceRows: number;
  /** Rows retained after viewport windowing. */
  visibleRows: number;
  /** Renderer-neutral primitives emitted by the compiler. */
  renderedNodes: number;
  /** Interactive samples retained for nearest-point lookup. */
  hoverSamples: number;
  /** Valid line/area points omitted from geometry by extrema decimation. */
  decimatedPoints: number;
}

/** Plot rectangle in scene coordinates. */
export type PlotRect = CompiledChart["plot"];
