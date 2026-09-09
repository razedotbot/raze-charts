import { extent, scaleBand, scaleLinear, scaleLog, scaleTime, type AnyScale, type BandScale, type LinearScale } from "./scales";
import { chartPalette, heatFill, heatLabelColor, mixHex, rampFill, resolveChartTheme, type ChartThemeInput, type DashboardTheme } from "./theme";

export type Accessor<T> = keyof T & string | ((row: T) => unknown);

export function readChannel<T>(row: T, channel: Accessor<T> | undefined): unknown {
  if (channel == null) return undefined;
  if (row == null) return undefined;
  if (typeof channel === "function") return channel(row);
  return (row as Record<string, unknown>)[channel];
}

export function asNumber(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "" && Number.isFinite(+value)) return +value;
  return NaN;
}

export type MarkKind = "line" | "area" | "bar" | "point" | "ruleY" | "ruleX" | "pie" | "radar" | "heatmap";
export type ChartCurve = "monotone" | "linear" | "step";
export type ChartViewportX = readonly [number | Date, number | Date] | readonly (string | number)[];
export interface ChartViewport {
  x?: ChartViewportX;
  y?: readonly [number, number];
}

export type ChartCompileErrorCode =
  | "E_CHART_SPEC"
  | "E_CHART_SIZE"
  | "E_CHART_PERFORMANCE"
  | "E_CHART_COMPOSITION"
  | "E_SCALE_TYPE"
  | "E_SCALE_DOMAIN"
  | "E_MARK_DATA"
  | "E_MARK_KIND"
  | "E_MARK_CHANNEL"
  | "E_MARK_OPTION"
  | "E_MARK_PLUGIN_KIND"
  | "E_MARK_PLUGIN_MISMATCH"
  | "E_MARK_PLUGIN_DOMAIN"
  | "E_MARK_PLUGIN_COMPILE"
  | "E_MARK_PLUGIN_RESULT";

export class ChartCompileError extends Error {
  override readonly name = "ChartCompileError";
  readonly cause: unknown;

  constructor(
    readonly code: ChartCompileErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[raze-charts:${code}] ${message}`);
    this.cause = options?.cause;
  }
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

type ErasedMarkPlugin = ChartMarkPlugin<unknown, unknown>;

/** Presentation and channel fields shared by built-in and plugin-authored marks. */
export interface ChartMarkBase {
  data: readonly unknown[];
  x?: Accessor<never> | string;
  y?: Accessor<never> | string;
  name?: string;
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
}

type BuiltinBase = Omit<
  ChartMarkBase,
  "x" | "y" | "key" | "stroke" | "fill" | "fillOpacity" | "strokeWidth" | "r"
  | "stackId" | "innerRadius" | "outerRadius" | "angleKey" | "valueKey" | "labelKey"
  | "lastValue" | "dashed" | "fade" | "curve" | "y0"
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
};
export type BarChartMark = BuiltinCartesian & {
  kind: "bar";
  fill?: string;
  stackId?: string;
  lastValue?: boolean;
  fade?: boolean;
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
};
export type RuleXChartMark = BuiltinBase & {
  kind: "ruleX";
  x: Accessor<never> | string;
  stroke?: string;
  strokeWidth?: number;
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
export type HeatmapChartMark = BuiltinCartesian & {
  kind: "heatmap";
  valueKey: Accessor<never> | string;
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
export type PluginChartMark = Pick<ChartMarkBase, "data" | "name"> & {
  kind: string;
  plugin: ErasedMarkPlugin;
  pluginOptions: unknown;
  stroke?: string;
  fill?: string;
};

/** Unknown kinds must carry a plugin; typos therefore fail during type checking. */
export type ChartMark = BuiltinChartMark | PluginChartMark;

function isPluginMark(mark: ChartMark): mark is PluginChartMark {
  return mark.plugin != null;
}

function isBuiltinMark(mark: ChartMark): mark is BuiltinChartMark {
  return !isPluginMark(mark);
}

function isBuiltinKind<K extends MarkKind>(
  mark: ChartMark,
  kind: K,
): mark is Extract<BuiltinChartMark, { kind: K }> {
  return isBuiltinMark(mark) && mark.kind === kind;
}

interface NamedMarkOptions {
  name?: string;
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
  y0?: Accessor<T>;
}

export interface BarMarkOptions<T> extends CartesianMarkOptions<T> {
  fill?: string;
  stackId?: string;
  lastValue?: boolean;
  fade?: boolean;
}

export interface PointMarkOptions<T> extends CartesianMarkOptions<T> {
  fill?: string;
  fillOpacity?: number;
  r?: number;
}

export interface RuleYMarkOptions extends NamedMarkOptions {
  stroke?: string;
  strokeWidth?: number;
}

export interface RuleXMarkOptions extends NamedMarkOptions {
  stroke?: string;
  strokeWidth?: number;
}

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

export function defineMarkPlugin<TDatum, TOptions>(
  plugin: ChartMarkPlugin<TDatum, TOptions>,
): ChartMarkPlugin<TDatum, TOptions> {
  if (!plugin || typeof plugin.kind !== "string" || !plugin.kind.trim()) {
    throw new ChartCompileError("E_MARK_PLUGIN_KIND", "A mark plugin requires a non-empty kind.");
  }
  if (BUILTIN_MARK_KINDS.has(plugin.kind as MarkKind)) {
    throw new ChartCompileError(
      "E_MARK_PLUGIN_KIND",
      `Custom mark kind "${plugin.kind}" is reserved by the built-in grammar. Choose a product-specific kind.`,
    );
  }
  return plugin;
}

export function customMark<TDatum, TOptions>(
  plugin: ChartMarkPlugin<TDatum, TOptions>,
  data: readonly TDatum[],
  options: TOptions,
): PluginChartMark {
  if (!plugin || typeof plugin.kind !== "string" || !plugin.kind.trim()) {
    throw new ChartCompileError("E_MARK_PLUGIN_KIND", "A mark plugin requires a non-empty kind.");
  }
  if (BUILTIN_MARK_KINDS.has(plugin.kind as MarkKind)) {
    throw new ChartCompileError(
      "E_MARK_PLUGIN_KIND",
      `Custom mark kind "${plugin.kind}" is reserved by the built-in grammar. Choose a product-specific kind.`,
    );
  }
  return {
    kind: plugin.kind,
    data,
    plugin: plugin as unknown as ErasedMarkPlugin,
    pluginOptions: options,
  };
}

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

type PolarOrHeatmapMark = PieChartMark | RadarChartMark | HeatmapChartMark;
type ValidMarkComposition<TMarks extends readonly ChartMark[]> = number extends TMarks["length"]
  ? TMarks
  : TMarks extends readonly [HeatmapChartMark] | readonly [PieChartMark] | readonly [RadarChartMark, ...RadarChartMark[]]
    ? TMarks
    : Extract<TMarks[number], PolarOrHeatmapMark> extends never
      ? TMarks
      : never;
type ScalesForMarks<TMarks extends readonly ChartMark[]> = number extends TMarks["length"]
  ? { x?: XScaleSpec; y?: YScaleSpec | HeatmapYScaleSpec }
  : TMarks extends readonly [HeatmapChartMark]
    ? { x?: BandScaleSpec; y?: HeatmapYScaleSpec }
    : TMarks extends readonly [PieChartMark] | readonly [RadarChartMark, ...RadarChartMark[]]
      ? never
      : { x?: XScaleSpec; y?: YScaleSpec };
export type TypedChartSpec<TMarks extends readonly ChartMark[]> = Omit<ChartSpec, "marks" | "scales"> & {
  marks: ValidMarkComposition<TMarks>;
  scales?: ScalesForMarks<TMarks>;
};

export function defineChart<const TMarks extends readonly ChartMark[]>(spec: TypedChartSpec<TMarks>): ChartDefinition;
export function defineChart(spec: (input: { width: number; height: number }) => ChartSpec): ChartDefinition;
export function defineChart(spec: ChartSpec | ((input: { width: number; height: number }) => ChartSpec)): ChartDefinition {
  if (typeof spec === "function") return { spec };
  return { spec: () => spec };
}

const DEFAULT_MARGIN: Margin = { top: 14, right: 56, bottom: 26, left: 10 };
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

function unique<T>(xs: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function finiteBounds(values: readonly number[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

function isBandCategory(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function markStroke(mark: ChartMark): string | undefined {
  return "stroke" in mark && typeof mark.stroke === "string" ? mark.stroke : undefined;
}

function markFill(mark: ChartMark): string | undefined {
  return "fill" in mark && typeof mark.fill === "string" ? mark.fill : undefined;
}

function seriesColor(mark: ChartMark, i: number, theme: DashboardTheme): string {
  const palette = chartPalette(theme);
  return markStroke(mark) || markFill(mark) || palette[i % palette.length]!;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatNum(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (value !== 0 && Math.abs(value) < 0.01) return String(Number(value.toPrecision(3)));
  if (Number.isInteger(value)) return Math.abs(value) >= 1000 ? value.toLocaleString("en-US") : String(value);
  if (Math.abs(value) >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return value.toFixed(Math.abs(value) < 1 ? 2 : 1);
}

function formatDateTick(value: unknown): string {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : NaN;
  const date = new Date(timestamp);
  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) return String(value ?? "");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function formatTick(value: unknown): string {
  if (typeof value === "number") return formatNum(value);
  if (value instanceof Date) return formatDateTick(value);
  return String(value ?? "");
}

function formatSigned(value: number): string {
  const body = Math.abs(value).toFixed(1);
  if (value > 0) return `+${body}`;
  if (value < 0) return `-${body}`;
  return body;
}

function snapRect(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const x1 = Math.round(x + w);
  const y1 = Math.round(y + h);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * mag;
}

function utcTimeTicks(lo: number, hi: number, maxTicks = 5): number[] {
  const span = Math.max(1, hi - lo);
  const day = 86400000;
  const days = span / day;
  let stepDays = 1;
  if (days > 10) stepDays = 2;
  if (days > 18) stepDays = 4;
  if (days > 28) stepDays = 7;
  if (days > 50) stepDays = 14;
  if (days > 120) stepDays = 30;
  const build = (step: number): number[] => {
    const startDate = new Date(lo);
    const start = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
    const out: number[] = [];
    for (let t = start; t <= hi + step / 4; t += step) {
      if (t >= lo - step / 8 && t <= hi + step / 8) out.push(t);
    }
    return out;
  };
  let out = build(stepDays * day);
  while (out.length > maxTicks && stepDays < 60) {
    stepDays = stepDays < 7 ? 7 : stepDays < 14 ? 14 : stepDays * 2;
    out = build(stepDays * day);
  }
  if (out.length < 2) out = [lo, hi];
  return out;
}

function thinBandTicks<T>(domain: T[], plotW: number, heatmap: boolean): T[] {
  if (heatmap || domain.length <= 2) return domain;
  const maxLabels = Math.max(2, Math.floor(plotW / 64));
  if (domain.length <= maxLabels) return domain;
  const step = Math.max(1, Math.ceil((domain.length - 1) / (maxLabels - 1)));
  const out: T[] = [];
  for (let i = 0; i < domain.length; i += step) out.push(domain[i]!);
  const last = domain[domain.length - 1]!;
  if (out[out.length - 1] !== last) {
    if (out.length >= 2 && domain.indexOf(last) - domain.indexOf(out[out.length - 1]!) < step * 0.6) {
      out[out.length - 1] = last;
    } else {
      out.push(last);
    }
  }
  return out;
}

function groupBarSlot(
  start: number, end: number, groupIndex: number, nGroup: number, gap: number,
): { x: number; w: number } {
  const a = Math.round(start);
  const b = Math.round(end);
  const avail = Math.max(1, b - a);
  if (nGroup <= 1) return { x: a, w: avail };
  const barW = Math.max(1, Math.floor((avail - gap * (nGroup - 1)) / nGroup));
  const used = barW * nGroup + gap * (nGroup - 1);
  const ox = a + Math.floor((avail - used) / 2);
  return { x: ox + groupIndex * (barW + gap), w: barW };
}

function decimateExtrema<T>(
  points: readonly { x: number; y: number }[],
  rows: readonly T[],
  limit: number,
  options: { preserveTail?: boolean; preferredY?: readonly number[] } = {},
): { points: { x: number; y: number }[]; rows: T[] } {
  if (limit <= 0 || points.length === 0) return { points: [], rows: [] };
  if (limit === 1) {
    const preferred = !options.preserveTail
      ? points.findIndex((point) => options.preferredY?.includes(point.y))
      : -1;
    const index = preferred >= 0 ? preferred : points.length - 1;
    return { points: [points[index]!], rows: [rows[index]!] };
  }
  if (limit === 2 && points.length > 2) {
    let minIndex = 0;
    let maxIndex = 0;
    for (let index = 1; index < points.length; index++) {
      if (points[index]!.y < points[minIndex]!.y) minIndex = index;
      if (points[index]!.y > points[maxIndex]!.y) maxIndex = index;
    }
    if (options.preserveTail) {
      const finalIndex = points.length - 1;
      let contextIndex: number;
      const preferred = points.findIndex((point, index) => (
        index !== finalIndex && options.preferredY?.includes(point.y)
      ));
      if (preferred >= 0) contextIndex = preferred;
      else if (minIndex === finalIndex) contextIndex = maxIndex;
      else if (maxIndex === finalIndex) contextIndex = minIndex;
      else {
        const finalY = points[finalIndex]!.y;
        contextIndex = Math.abs(points[minIndex]!.y - finalY) >= Math.abs(points[maxIndex]!.y - finalY)
          ? minIndex
          : maxIndex;
      }
      if (contextIndex === finalIndex) contextIndex = 0;
      return {
        points: [points[contextIndex]!, points[finalIndex]!],
        rows: [rows[contextIndex]!, rows[finalIndex]!],
      };
    }
    if (minIndex === maxIndex) {
      const finalIndex = points.length - 1;
      return { points: [points[0]!, points[finalIndex]!], rows: [rows[0]!, rows[finalIndex]!] };
    }
    const first = Math.min(minIndex, maxIndex);
    const second = Math.max(minIndex, maxIndex);
    return { points: [points[first]!, points[second]!], rows: [rows[first]!, rows[second]!] };
  }
  if (limit === 3 && points.length > 3) {
    let minIndex = 0;
    let maxIndex = 0;
    for (let index = 1; index < points.length; index++) {
      if (points[index]!.y < points[minIndex]!.y) minIndex = index;
      if (points[index]!.y > points[maxIndex]!.y) maxIndex = index;
    }
    const selected = new Set<number>(options.preserveTail
      ? [minIndex, maxIndex, points.length - 1]
      : [0, minIndex, maxIndex]);
    for (const index of [0, points.length - 1]) {
      if (selected.size < 3) selected.add(index);
    }
    const indices = Array.from(selected).sort((a, b) => a - b).slice(0, 3);
    return {
      points: indices.map((index) => points[index]!),
      rows: indices.map((index) => rows[index]!),
    };
  }
  if (points.length <= limit || points.length <= 2) {
    return { points: Array.from(points), rows: Array.from(rows) };
  }

  // Two extrema per bucket retain spikes and troughs that a simple stride can
  // erase. Indices are emitted in source order, so paths never fold backwards.
  const bucketCount = Math.floor((limit - 2) / 2);
  if (bucketCount <= 0) {
    const index = points.length - 1;
    return { points: [points[0]!, points[index]!], rows: [rows[0]!, rows[index]!] };
  }
  const interior = points.length - 2;
  const outPoints: { x: number; y: number }[] = [points[0]!];
  const outRows: T[] = [rows[0]!];
  let lastIndex = 0;

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const from = 1 + Math.floor((bucket * interior) / bucketCount);
    const to = 1 + Math.floor(((bucket + 1) * interior) / bucketCount);
    if (from >= to) continue;
    let minIndex = from;
    let maxIndex = from;
    for (let index = from + 1; index < to; index++) {
      if (points[index]!.y < points[minIndex]!.y) minIndex = index;
      if (points[index]!.y > points[maxIndex]!.y) maxIndex = index;
    }
    const ordered = minIndex === maxIndex
      ? [minIndex]
      : minIndex < maxIndex
        ? [minIndex, maxIndex]
        : [maxIndex, minIndex];
    for (const index of ordered) {
      if (index === lastIndex) continue;
      outPoints.push(points[index]!);
      outRows.push(rows[index]!);
      lastIndex = index;
    }
  }

  const finalIndex = points.length - 1;
  if (lastIndex !== finalIndex) {
    outPoints.push(points[finalIndex]!);
    outRows.push(rows[finalIndex]!);
  }
  return { points: outPoints, rows: outRows };
}

const BUILTIN_MARK_KINDS = new Set<MarkKind>([
  "line", "area", "bar", "point", "ruleY", "ruleX", "pie", "radar", "heatmap",
]);

const BUILTIN_MARK_KEYS: Record<MarkKind, ReadonlySet<string>> = {
  line: new Set(["kind", "data", "x", "y", "name", "stroke", "strokeWidth", "lastValue", "dashed", "curve"]),
  area: new Set(["kind", "data", "x", "y", "y0", "name", "stroke", "fill", "fillOpacity", "strokeWidth", "lastValue", "dashed", "curve"]),
  bar: new Set(["kind", "data", "x", "y", "name", "fill", "stackId", "lastValue", "fade"]),
  point: new Set(["kind", "data", "x", "y", "name", "fill", "fillOpacity", "r"]),
  ruleY: new Set(["kind", "data", "y", "name", "stroke", "strokeWidth"]),
  ruleX: new Set(["kind", "data", "x", "name", "stroke", "strokeWidth"]),
  pie: new Set(["kind", "data", "name", "valueKey", "labelKey", "innerRadius", "outerRadius"]),
  radar: new Set(["kind", "data", "x", "y", "name", "stroke", "fill", "fillOpacity", "strokeWidth"]),
  heatmap: new Set(["kind", "data", "x", "y", "name", "valueKey"]),
};

function validateBuiltinMarkOptions(mark: BuiltinChartMark, index: number): void {
  const allowed = BUILTIN_MARK_KEYS[mark.kind];
  const values = mark as unknown as Record<string, unknown>;
  for (const key of Object.keys(mark)) {
    if (!allowed.has(key)) {
      throw new ChartCompileError(
        "E_MARK_OPTION",
        `marks[${index}] (${mark.kind}) does not support option "${key}". Use a compatible mark or a custom plugin.`,
      );
    }
  }
  for (const key of ["x", "y", "valueKey", "labelKey"] as const) {
    const value = values[key];
    if (value !== undefined && typeof value !== "string" && typeof value !== "function") {
      throw new ChartCompileError("E_MARK_CHANNEL", `marks[${index}].${key} must be a property name or accessor function.`);
    }
  }
  if (mark.name !== undefined && typeof mark.name !== "string") {
    throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].name must be a string.`);
  }
  for (const key of ["stroke", "fill"] as const) {
    const value = values[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].${key} must be a non-empty CSS color string.`);
    }
  }
  const stackId = values.stackId;
  if (stackId !== undefined && (typeof stackId !== "string" || !stackId.trim())) {
    throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].stackId must be a non-empty string.`);
  }
  for (const key of ["strokeWidth", "r"] as const) {
    const value = values[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].${key} must be a finite non-negative number.`);
    }
  }
  const fillOpacity = values.fillOpacity;
  if (fillOpacity !== undefined && (
    typeof fillOpacity !== "number" || !Number.isFinite(fillOpacity) || fillOpacity < 0 || fillOpacity > 1
  )) {
    throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].fillOpacity must be a finite number in [0, 1].`);
  }
  for (const key of ["lastValue", "dashed", "fade"] as const) {
    const value = values[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].${key} must be boolean.`);
    }
  }
  const curve = values.curve;
  if (curve !== undefined && curve !== "monotone" && curve !== "linear" && curve !== "step") {
    throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].curve must be "monotone", "linear", or "step".`);
  }
  if (values.y0 !== undefined && typeof values.y0 !== "string" && typeof values.y0 !== "function") {
    throw new ChartCompileError("E_MARK_CHANNEL", `marks[${index}].y0 must be a property name or accessor function.`);
  }
}

function stackKey(stackId: string, value: unknown, quantitative = false): string {
  const normalized = quantitative ? asNumber(value) : value instanceof Date ? value.getTime() : value;
  const scalar = normalized == null || typeof normalized !== "object"
    ? normalized
    : String(normalized);
  return JSON.stringify([stackId, quantitative ? "number" : value instanceof Date ? "date" : typeof normalized, scalar]);
}

function isolatePluginScale(scale: AnyScale): ChartMarkPluginScale {
  const snapshot = scale.copy();
  if (snapshot.kind === "band") {
    const band = snapshot as BandScale<string | number>;
    const domain = Object.freeze([...band.domain]) as readonly (string | number)[];
    const range = Object.freeze([...band.range]) as unknown as readonly [number, number];
    return Object.freeze({
      kind: "band" as const,
      domain,
      range,
      padding: band.padding,
      map: (value: string | number) => band.map(value),
      start: (value: string | number) => band.start(value),
      bandwidth: () => band.bandwidth(),
      copy: () => isolatePluginScale(band.copy()) as ChartMarkPluginBandScale,
    });
  }
  const linear = snapshot as LinearScale;
  const domain = Object.freeze([...linear.domain]) as unknown as readonly [number, number];
  const range = Object.freeze([...linear.range]) as unknown as readonly [number, number];
  return Object.freeze({
    kind: "linear" as const,
    domain,
    range,
    map: (value: number) => linear.map(value),
    invert: (px: number) => linear.invert(px),
    ticks: (count?: number) => linear.ticks(count),
    copy: () => isolatePluginScale(linear.copy()) as ChartMarkPluginLinearScale,
  });
}

function validatePluginDomainContribution(value: unknown): MarkDomainContribution {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("domain() must return an object.");
  }
  const domain = value as { x?: unknown; y?: unknown; includeZero?: unknown };
  for (const key of Object.keys(value)) {
    if (!new Set(["x", "y", "includeZero"]).has(key)) {
      throw new TypeError(`domain() returned unsupported field "${key}".`);
    }
  }
  if (domain.x !== undefined) {
    if (!Array.isArray(domain.x)) throw new TypeError("domain().x must be an array.");
    for (const entry of domain.x) {
      if (!isBandCategory(entry) && !(entry instanceof Date)) {
        throw new TypeError(`domain().x contains an unsupported value (${String(entry)}).`);
      }
    }
  }
  if (domain.y !== undefined) {
    if (!Array.isArray(domain.y)) throw new TypeError("domain().y must be an array.");
    if (!domain.y.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      throw new TypeError("domain().y must contain finite numbers only.");
    }
  }
  if (domain.includeZero !== undefined && typeof domain.includeZero !== "boolean") {
    throw new TypeError("domain().includeZero must be boolean.");
  }
  return domain as MarkDomainContribution;
}

const SCENE_NODE_TYPES = new Set(["line", "area", "rect", "circle", "rule", "arc", "polygon", "text"]);
const SCENE_NODE_KEYS = new Set([
  "type", "x", "y", "x2", "y2", "w", "h", "r", "innerR", "startAngle", "endAngle", "points",
  "stroke", "fill", "fillOpacity", "strokeWidth", "dashed", "datum", "series", "label", "anchor",
  "fontSize", "corner", "tip", "clip", "hit", "role", "idx", "highlight", "valueY",
]);

function pluginResultError(kind: string, detail: string): never {
  throw new ChartCompileError("E_MARK_PLUGIN_RESULT", `Mark plugin "${kind}" ${detail}`);
}

function validatePluginResult(value: unknown, kind: string): asserts value is ChartMarkPluginResult {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    pluginResultError(kind, "must return an object.");
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!["nodes", "legend", "samples", "lastValues"].includes(key)) {
      pluginResultError(kind, `returned unsupported field "${key}".`);
    }
  }
  if (!Array.isArray(result.nodes)) pluginResultError(kind, "must return a nodes array.");
  for (let index = 0; index < result.nodes.length; index++) {
    const raw = result.nodes[index];
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      pluginResultError(kind, `returned an invalid node at index ${index}.`);
    }
    const node = raw as Record<string, unknown>;
    for (const key of Object.keys(node)) {
      if (!SCENE_NODE_KEYS.has(key)) {
        pluginResultError(kind, `returned unsupported node field "${key}" at index ${index}.`);
      }
    }
    if (!SCENE_NODE_TYPES.has(node.type as string)) {
      pluginResultError(kind, `returned an unknown node type at index ${index} (${String(node.type)}).`);
    }
    const requiredByType: Record<string, readonly string[]> = {
      line: ["points"], area: ["points"], polygon: ["points"],
      rect: ["x", "y", "w", "h"], circle: ["x", "y", "r"],
      rule: ["x", "y", "x2", "y2"],
      arc: ["x", "y", "r", "innerR", "startAngle", "endAngle"],
      text: ["x", "y", "label"],
    };
    const nodeType = node.type as string;
    if (nodeType === "line" || nodeType === "area" || nodeType === "polygon") {
      if (!Array.isArray(node.points) || node.points.length === 0 || node.points.some((point) => (
        point == null
        || typeof point !== "object"
        || !Number.isFinite((point as { x?: unknown }).x)
        || !Number.isFinite((point as { y?: unknown }).y)
      ))) {
        pluginResultError(kind, `returned invalid points for ${nodeType} node ${index}.`);
      }
    } else {
      for (const field of requiredByType[nodeType] ?? []) {
        if (field === "label") {
          if (typeof node[field] !== "string") pluginResultError(kind, `requires a string ${field} on node ${index}.`);
        } else if (typeof node[field] !== "number" || !Number.isFinite(node[field])) {
          pluginResultError(kind, `requires a finite ${field} on node ${index}.`);
        }
      }
    }
    if (node.points !== undefined && nodeType !== "line" && nodeType !== "area" && nodeType !== "polygon") {
      pluginResultError(kind, `returned points for incompatible ${nodeType} node ${index}.`);
    }
    for (const field of ["x", "y", "x2", "y2", "w", "h", "r", "innerR", "startAngle", "endAngle", "fillOpacity", "strokeWidth", "fontSize", "idx", "valueY"] as const) {
      if (node[field] !== undefined && (typeof node[field] !== "number" || !Number.isFinite(node[field]))) {
        pluginResultError(kind, `returned non-finite ${field} on node ${index}.`);
      }
    }
    for (const field of ["w", "h", "r", "innerR", "strokeWidth", "fontSize"] as const) {
      if (typeof node[field] === "number" && node[field] < 0) {
        pluginResultError(kind, `returned negative ${field} on node ${index}.`);
      }
    }
    if (typeof node.fillOpacity === "number" && (node.fillOpacity < 0 || node.fillOpacity > 1)) {
      pluginResultError(kind, `returned fillOpacity outside [0, 1] on node ${index}.`);
    }
    if (typeof node.idx === "number" && (!Number.isInteger(node.idx) || node.idx < 0)) {
      pluginResultError(kind, `returned a non-integer or negative idx on node ${index}.`);
    }
    for (const field of ["stroke", "fill", "series", "label", "tip", "role"] as const) {
      if (node[field] !== undefined && typeof node[field] !== "string") {
        pluginResultError(kind, `returned a non-string ${field} on node ${index}.`);
      }
    }
    if (node.anchor !== undefined && !["start", "middle", "end"].includes(node.anchor as string)) {
      pluginResultError(kind, `returned an invalid anchor on node ${index}.`);
    }
    if (node.corner !== undefined && !["all", "top", "bottom", "none"].includes(node.corner as string)) {
      pluginResultError(kind, `returned an invalid corner on node ${index}.`);
    }
    for (const field of ["dashed", "clip", "hit", "highlight"] as const) {
      if (node[field] !== undefined && typeof node[field] !== "boolean") {
        pluginResultError(kind, `returned a non-boolean ${field} on node ${index}.`);
      }
    }
    if ((nodeType === "circle" || nodeType === "arc") && (node.r as number) < 0) {
      pluginResultError(kind, `returned a negative radius on node ${index}.`);
    }
    if (nodeType === "arc" && ((node.innerR as number) < 0 || (node.innerR as number) > (node.r as number))) {
      pluginResultError(kind, `returned an invalid inner radius on node ${index}.`);
    }
  }
  for (const field of ["legend", "samples", "lastValues"] as const) {
    if (result[field] !== undefined && !Array.isArray(result[field])) {
      pluginResultError(kind, `must return ${field} as an array when provided.`);
    }
  }
  for (const item of (result.legend as unknown[] | undefined) ?? []) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      pluginResultError(kind, "returned an invalid legend item.");
    }
    const candidate = item as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => !["name", "color", "detail"].includes(key))
      || typeof candidate.name !== "string"
      || typeof candidate.color !== "string"
      || (candidate.detail !== undefined && typeof candidate.detail !== "string")) {
      pluginResultError(kind, "returned an invalid legend item.");
    }
  }
  for (const sample of (result.samples as unknown[] | undefined) ?? []) {
    const candidate = sample as (Partial<HoverSample> & Record<string, unknown>) | null;
    if (!candidate
      || Array.isArray(candidate)
      || Object.keys(candidate).some((key) => !["x", "y", "series", "color", "tip", "kind"].includes(key))
      || !Number.isFinite(candidate.x)
      || !Number.isFinite(candidate.y)
      || typeof candidate.series !== "string"
      || typeof candidate.color !== "string"
      || typeof candidate.tip !== "string"
      || !["line", "point", "radar"].includes(candidate.kind as string)) {
      pluginResultError(kind, "returned an invalid hover sample.");
    }
  }
  for (const last of (result.lastValues as unknown[] | undefined) ?? []) {
    const candidate = last as (Partial<LastValue> & Record<string, unknown>) | null;
    if (!candidate
      || Array.isArray(candidate)
      || Object.keys(candidate).some((key) => !["y", "label", "color", "dash"].includes(key))
      || !Number.isFinite(candidate.y)
      || typeof candidate.label !== "string"
      || typeof candidate.color !== "string"
      || (candidate.dash !== undefined && typeof candidate.dash !== "boolean")) {
      pluginResultError(kind, "returned an invalid last value.");
    }
  }
}

// Unlike Array.isArray's type predicate, this runtime-only check does not
// widen an already typed readonly array to any[].
function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

type RuntimeScaleSpec = {
  type?: unknown;
  nice?: unknown;
  padding?: unknown;
  domain?: unknown;
  tickFormat?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validateScaleSpec(
  axis: "x" | "y",
  value: unknown,
  heatmap: boolean,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis} must be a scale configuration object.`);
  }
  const scale = value as RuntimeScaleSpec;
  for (const key of Object.keys(value)) {
    if (!["type", "nice", "padding", "domain", "tickFormat"].includes(key)) {
      throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis} does not support option "${key}".`);
    }
  }
  const type = scale.type;
  const allowed = heatmap
    ? new Set<unknown>(axis === "x" ? ["band"] : ["band"])
    : axis === "x"
      ? new Set<unknown>(["linear", "band", "time", "log"])
      : new Set<unknown>([undefined, "linear", "log"]);
  if (!allowed.has(type)) {
    const supported = heatmap
      ? '"band"'
      : axis === "x"
        ? '"linear", "band", "time", or "log"'
        : '"linear" or "log"';
    throw new ChartCompileError(
      "E_SCALE_TYPE",
      `scales.${axis}.type must be ${supported}; received ${String(type)}.`,
    );
  }
  const isBand = heatmap || type === "band";
  if (isBand) {
    if (scale.nice !== undefined) {
      throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis}.nice is not supported by band scales.`);
    }
    if (
      scale.padding !== undefined
      && (typeof scale.padding !== "number" || !Number.isFinite(scale.padding) || scale.padding < 0 || scale.padding >= 1)
    ) {
      throw new ChartCompileError(
        "E_SCALE_DOMAIN",
        `scales.${axis}.padding must be a finite number in [0, 1); received ${String(scale.padding)}.`,
      );
    }
    if (scale.domain !== undefined) {
      if (!isRuntimeArray(scale.domain)) {
        throw new ChartCompileError("E_SCALE_DOMAIN", `scales.${axis}.domain must be an array for a band scale.`);
      }
      for (const entry of scale.domain as readonly unknown[]) {
        if ((typeof entry !== "string" && typeof entry !== "number") || (typeof entry === "number" && !Number.isFinite(entry))) {
          throw new ChartCompileError(
            "E_SCALE_DOMAIN",
            `scales.${axis}.domain contains an invalid category (${String(entry)}). Use finite numbers or strings.`,
          );
        }
      }
      const categories = scale.domain as readonly (string | number)[];
      if (new Set(categories).size !== categories.length) {
        throw new ChartCompileError("E_SCALE_DOMAIN", `scales.${axis}.domain cannot contain duplicate categories.`);
      }
    }
    validateTickFormat(axis, scale.tickFormat);
    return;
  }
  if (scale.padding !== undefined) {
    throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis}.padding is supported by band scales only.`);
  }
  if ((type === "log" || type === "time") && scale.nice !== undefined) {
    throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis}.nice is not supported by ${type} scales.`);
  }
  if (scale.nice !== undefined && typeof scale.nice !== "boolean") {
    throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis}.nice must be boolean when provided.`);
  }
  if (scale.domain !== undefined) {
    if (!isRuntimeArray(scale.domain) || (scale.domain as readonly unknown[]).length !== 2) {
      throw new ChartCompileError(
        "E_SCALE_DOMAIN",
        `scales.${axis}.domain must contain exactly two endpoints for a quantitative scale.`,
      );
    }
    const endpoints = scale.domain as readonly unknown[];
    const numeric = endpoints.map(asNumber);
    if (!numeric.every(Number.isFinite)) {
      throw new ChartCompileError(
        "E_SCALE_DOMAIN",
        `scales.${axis}.domain endpoints must be finite numbers or Dates.`,
      );
    }
    if (numeric[0] === numeric[1]) {
      throw new ChartCompileError(
        "E_SCALE_DOMAIN",
        `scales.${axis}.domain endpoints must be distinct.`,
      );
    }
    if (type === "log" && numeric.some((entry) => entry <= 0)) {
      throw new ChartCompileError(
        "E_SCALE_DOMAIN",
        `scales.${axis}.domain endpoints must be greater than zero for a log scale.`,
      );
    }
  }
  validateTickFormat(axis, scale.tickFormat);
}

function validateTickFormat(axis: "x" | "y", tickFormat: unknown): void {
  if (tickFormat !== undefined && typeof tickFormat !== "function") {
    throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis}.tickFormat must be a function when provided.`);
  }
}

function validateChartSpec(spec: ChartSpec, width: number, height: number): void {
  if (!isRecord(spec) || !isRuntimeArray(spec.marks)) {
    throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.marks must be an array.");
  }
  const allowedSpecKeys = new Set([
    "marks", "scales", "width", "height", "margin", "grid", "tooltip", "legend",
    "ariaLabel", "ariaDescription", "performance", "theme", "viewport", "hiddenSeries",
  ]);
  for (const key of Object.keys(spec)) {
    if (!allowedSpecKeys.has(key)) {
      throw new ChartCompileError("E_CHART_SPEC", `ChartSpec does not support option "${key}".`);
    }
  }
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new ChartCompileError(
      "E_CHART_SIZE",
      `Chart width and height must be finite positive numbers; received ${String(width)}×${String(height)}.`,
    );
  }
  for (const key of ["width", "height"] as const) {
    const value = spec[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      throw new ChartCompileError("E_CHART_SIZE", `ChartSpec.${key} must be a finite positive number when provided.`);
    }
  }
  for (const key of ["grid", "tooltip", "legend"] as const) {
    const value = spec[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new ChartCompileError("E_CHART_SPEC", `ChartSpec.${key} must be boolean when provided.`);
    }
  }
  if (spec.margin !== undefined) {
    if (!isRecord(spec.margin)) {
      throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.margin must be an object when provided.");
    }
    for (const key of Object.keys(spec.margin)) {
      if (!["top", "right", "bottom", "left"].includes(key)) {
        throw new ChartCompileError("E_CHART_SPEC", `ChartSpec.margin does not support option "${key}".`);
      }
      const value = (spec.margin as Record<string, unknown>)[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new ChartCompileError("E_CHART_SIZE", `ChartSpec.margin.${key} must be a finite non-negative number.`);
      }
    }
  }
  if (spec.scales !== undefined) {
    if (!isRecord(spec.scales)) {
      throw new ChartCompileError("E_SCALE_TYPE", "ChartSpec.scales must be an object when provided.");
    }
    for (const key of Object.keys(spec.scales)) {
      if (key !== "x" && key !== "y") {
        throw new ChartCompileError("E_SCALE_TYPE", `ChartSpec.scales does not support axis "${key}".`);
      }
    }
  }
  if (spec.performance !== undefined) {
    if (!isRecord(spec.performance)) {
      throw new ChartCompileError("E_CHART_PERFORMANCE", "ChartSpec.performance must be an object when provided.");
    }
    for (const key of Object.keys(spec.performance)) {
      if (key !== "decimation" && key !== "maxRenderedPoints") {
        throw new ChartCompileError("E_CHART_PERFORMANCE", `ChartSpec.performance does not support option "${key}".`);
      }
    }
  }
  if (spec.theme !== undefined && spec.theme !== "dark" && spec.theme !== "light") {
    if (!isRecord(spec.theme)) {
      throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.theme must be \"dark\", \"light\", or a theme object.");
    }
    const themeKeys = new Set([
      "background", "text", "muted", "grid", "axis", "crosshair", "font", "accent", "down", "gold", "sky",
      "heatZero", "chipBg", "chipFg", "lastChipFg",
    ]);
    for (const key of Object.keys(spec.theme)) {
      const value = (spec.theme as Record<string, unknown>)[key];
      if (!themeKeys.has(key)) {
        throw new ChartCompileError("E_CHART_SPEC", `ChartSpec.theme does not support token "${key}".`);
      }
      if (typeof value !== "string" || !value.trim()) {
        throw new ChartCompileError("E_CHART_SPEC", `ChartSpec.theme.${key} must be a non-empty string.`);
      }
    }
  }
  if (spec.ariaLabel !== undefined && typeof spec.ariaLabel !== "string") {
    throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.ariaLabel must be a string when provided.");
  }
  if (spec.ariaDescription !== undefined && typeof spec.ariaDescription !== "string") {
    throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.ariaDescription must be a string when provided.");
  }
  if (spec.hiddenSeries !== undefined) {
    if (!isRuntimeArray(spec.hiddenSeries) || spec.hiddenSeries.some((name) => typeof name !== "string")) {
      throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.hiddenSeries must be an array of strings when provided.");
    }
  }
  if (spec.viewport !== undefined) {
    const viewport = spec.viewport;
    for (const key of Object.keys(viewport)) {
      if (key !== "x" && key !== "y") {
        throw new ChartCompileError("E_CHART_SPEC", `ChartSpec.viewport does not support option "${key}".`);
      }
    }
    if (viewport.x !== undefined) {
      if (!isRuntimeArray(viewport.x) || viewport.x.length < 1) {
        throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.viewport.x must be a non-empty range.");
      }
    }
    if (viewport.y !== undefined) {
      const y = viewport.y;
      if (!isRuntimeArray(y) || y.length !== 2 || !y.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.viewport.y must be a [min, max] numeric pair.");
      }
    }
  }
  const performance = spec.performance as ChartPerformanceOptions | undefined;
  const maxRenderedPoints = performance?.maxRenderedPoints;
  const decimation = performance?.decimation;
  if (decimation !== undefined && decimation !== "auto" && decimation !== "none") {
    throw new ChartCompileError(
      "E_CHART_PERFORMANCE",
      `performance.decimation must be "auto" or "none"; received ${String(decimation)}.`,
    );
  }
  if (
    maxRenderedPoints !== undefined
    && (!Number.isFinite(maxRenderedPoints) || maxRenderedPoints < 1)
  ) {
    throw new ChartCompileError(
      "E_CHART_PERFORMANCE",
      `performance.maxRenderedPoints must be a finite number greater than or equal to 1; received ${String(maxRenderedPoints)}.`,
    );
  }
  const hasHeatmap = spec.marks.some((mark) => mark?.kind === "heatmap");
  validateScaleSpec("x", spec.scales?.x, hasHeatmap);
  validateScaleSpec("y", spec.scales?.y, hasHeatmap);
  for (let index = 0; index < spec.marks.length; index++) {
    const mark = spec.marks[index];
    if (!mark || !isRuntimeArray(mark.data)) {
      throw new ChartCompileError("E_MARK_DATA", `marks[${index}].data must be an array.`);
    }
    if (!BUILTIN_MARK_KINDS.has(mark.kind as MarkKind) && !mark.plugin) {
      throw new ChartCompileError(
        "E_MARK_KIND",
        `marks[${index}] uses unknown kind "${String(mark.kind)}". Register it with defineMarkPlugin() and customMark().`,
      );
    }
    if (isPluginMark(mark)) {
      if (
        typeof mark.kind !== "string"
        || !mark.kind.trim()
        || typeof mark.plugin.kind !== "string"
        || !mark.plugin.kind.trim()
        || BUILTIN_MARK_KINDS.has(mark.kind as MarkKind)
      ) {
        throw new ChartCompileError(
          "E_MARK_PLUGIN_KIND",
          `marks[${index}] must use a non-empty custom kind that does not collide with the built-in grammar.`,
        );
      }
      if (mark.plugin.kind !== mark.kind) {
        throw new ChartCompileError(
          "E_MARK_PLUGIN_MISMATCH",
          `Mark kind "${mark.kind}" does not match plugin kind "${mark.plugin.kind}".`,
        );
      }
      const pluginKeys = new Set(["kind", "data", "plugin", "pluginOptions", "name", "stroke", "fill"]);
      for (const key of Object.keys(mark)) {
        if (!pluginKeys.has(key)) {
          throw new ChartCompileError(
            "E_MARK_OPTION",
            `marks[${index}] (${mark.kind}) must pass custom fields inside pluginOptions; unsupported top-level field "${key}".`,
          );
        }
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(mark, "y0") && mark.kind !== "area") {
      throw new ChartCompileError(
        "E_MARK_CHANNEL",
        `marks[${index}] (${mark.kind}) uses unsupported channel y0. Model ranged areas with an area mark or a custom mark plugin.`,
      );
    }
    validateBuiltinMarkOptions(mark as BuiltinChartMark, index);
    const needsXY = mark.kind === "line"
      || mark.kind === "area"
      || mark.kind === "bar"
      || mark.kind === "point"
      || mark.kind === "radar"
      || mark.kind === "heatmap";
    if (needsXY && (mark.x == null || mark.y == null)) {
      throw new ChartCompileError(
        "E_MARK_CHANNEL",
        `marks[${index}] (${mark.kind}) requires both x and y channels. Use the typed ${mark.kind}() builder when possible.`,
      );
    }
    if (mark.kind === "ruleY" && mark.y == null) {
      throw new ChartCompileError("E_MARK_CHANNEL", `marks[${index}] (ruleY) requires a y channel.`);
    }
    if (mark.kind === "ruleX" && mark.x == null) {
      throw new ChartCompileError("E_MARK_CHANNEL", `marks[${index}] (ruleX) requires an x channel.`);
    }
    if (mark.kind === "pie" && mark.valueKey == null) {
      throw new ChartCompileError(
        "E_MARK_CHANNEL",
        `marks[${index}] (pie) requires valueKey. Use pie(data, { valueKey, labelKey }).`,
      );
    }
    if (mark.kind === "heatmap" && mark.valueKey == null) {
      throw new ChartCompileError(
        "E_MARK_CHANNEL",
        `marks[${index}] (heatmap) requires valueKey in addition to x and y.`,
      );
    }
    if (mark.kind === "pie") {
      for (const radius of ["innerRadius", "outerRadius"] as const) {
        const value = mark[radius];
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          throw new ChartCompileError(
            "E_MARK_CHANNEL",
            `marks[${index}].${radius} must be a finite non-negative number; received ${String(value)}.`,
          );
        }
      }
      if (
        mark.innerRadius !== undefined
        && mark.outerRadius !== undefined
        && mark.innerRadius > mark.outerRadius
      ) {
        throw new ChartCompileError(
          "E_MARK_CHANNEL",
          `marks[${index}].innerRadius cannot exceed outerRadius.`,
        );
      }
      for (let rowIndex = 0; rowIndex < mark.data.length; rowIndex++) {
        const value = asNumber(readChannel(mark.data[rowIndex] as never, mark.valueKey as never));
        if (Number.isFinite(value) && value < 0) {
          throw new ChartCompileError(
            "E_MARK_DATA",
            `marks[${index}] (pie) requires non-negative values; row ${rowIndex} resolved to ${String(value)}.`,
          );
        }
      }
    }
    if (mark.kind === "radar") {
      if (mark.data.length > 0 && mark.data.length < 3) {
        throw new ChartCompileError("E_MARK_DATA", `marks[${index}] (radar) requires at least three axes.`);
      }
      const axes = new Set<string>();
      for (let rowIndex = 0; rowIndex < mark.data.length; rowIndex++) {
        const axis = readChannel(mark.data[rowIndex] as never, mark.x as never);
        if (!isBandCategory(axis)) {
          throw new ChartCompileError(
            "E_MARK_DATA",
            `marks[${index}] (radar) requires string or finite-number axis labels; row ${rowIndex} is invalid.`,
          );
        }
        const axisKey = stackKey("radar-axis", axis);
        if (axes.has(axisKey)) {
          throw new ChartCompileError("E_MARK_DATA", `marks[${index}] (radar) contains duplicate axis ${JSON.stringify(axis)}.`);
        }
        axes.add(axisKey);
        const value = asNumber(readChannel(mark.data[rowIndex] as never, mark.y as never));
        if (!Number.isFinite(value) || value < 0) {
          throw new ChartCompileError(
            "E_MARK_DATA",
            `marks[${index}] (radar) requires finite non-negative values; row ${rowIndex} resolved to ${String(value)}.`,
          );
        }
      }
    }
  }
  const heatmaps = spec.marks.filter((mark) => isBuiltinKind(mark, "heatmap"));
  if (heatmaps.length && (heatmaps.length !== 1 || spec.marks.length !== 1)) {
    throw new ChartCompileError(
      "E_CHART_COMPOSITION",
      "Heatmap uses two categorical axes and must be the chart's only mark. Compose annotations inside a custom mark plugin or a sibling chart.",
    );
  }
  const pies = spec.marks.filter((mark) => isBuiltinKind(mark, "pie"));
  if (pies.length && (pies.length !== 1 || spec.marks.length !== 1)) {
    throw new ChartCompileError(
      "E_CHART_COMPOSITION",
      "Pie uses polar layout and must be the chart's only mark. Use one pie per chart mount.",
    );
  }
  const radars = spec.marks.filter((mark) => isBuiltinKind(mark, "radar"));
  if (radars.length && radars.length !== spec.marks.length) {
    throw new ChartCompileError(
      "E_CHART_COMPOSITION",
      "Radar marks can overlay other radar series, but cannot share a chart with Cartesian, heatmap, pie, or plugin marks.",
    );
  }
  if (radars.length > 1) {
    const canonicalAxes = radars[0]!.data.map((row) => stackKey(
      "radar-axis",
      readChannel(row as never, radars[0]!.x as never),
    ));
    for (let index = 1; index < radars.length; index++) {
      const axes = radars[index]!.data.map((row) => stackKey(
        "radar-axis",
        readChannel(row as never, radars[index]!.x as never),
      ));
      if (axes.length !== canonicalAxes.length || axes.some((axis, at) => axis !== canonicalAxes[at])) {
        throw new ChartCompileError(
          "E_CHART_COMPOSITION",
          `Radar series ${index + 1} must use the same category order as the first radar series.`,
        );
      }
    }
  }
  if ((pies.length || radars.length) && (spec.scales?.x !== undefined || spec.scales?.y !== undefined)) {
    throw new ChartCompileError(
      "E_SCALE_TYPE",
      "Polar charts derive their geometry from values and do not accept Cartesian scales. Remove ChartSpec.scales.",
    );
  }
}

function isQuantitativeViewportX(
  x: NonNullable<ChartViewport["x"]>,
): x is readonly [number | Date, number | Date] {
  return x.length === 2 && Number.isFinite(asNumber(x[0])) && Number.isFinite(asNumber(x[1]));
}

function markSeriesName(mark: ChartMark): string {
  return mark.name ?? ("y" in mark && typeof mark.y === "string" ? mark.y : mark.kind);
}

function rowXValue(mark: ChartMark, row: unknown): unknown {
  if (isPluginMark(mark) || mark.kind === "ruleY" || mark.kind === "pie") return undefined;
  const x = "x" in mark ? mark.x : undefined;
  if (x == null) return undefined;
  return readChannel(row as never, x as never);
}

function windowMarkData(mark: ChartMark, viewport: ChartViewport | undefined): readonly unknown[] {
  if (!viewport?.x) return mark.data;
  const xWin = viewport.x;
  if (isQuantitativeViewportX(xWin)) {
    const lo = Math.min(asNumber(xWin[0]), asNumber(xWin[1]));
    const hi = Math.max(asNumber(xWin[0]), asNumber(xWin[1]));
    const values = mark.data.map((row) => asNumber(rowXValue(mark, row)));
    const keep = new Set<number>();
    for (let i = 0; i < values.length; i++) {
      const x = values[i]!;
      if (Number.isFinite(x) && x >= lo && x <= hi) keep.add(i);
    }
    if (mark.kind === "line" || mark.kind === "area") {
      const indices = Array.from(keep).sort((a, b) => a - b);
      if (indices.length) {
        const first = indices[0]!;
        const last = indices[indices.length - 1]!;
        if (first > 0 && Number.isFinite(values[first - 1])) keep.add(first - 1);
        if (last < values.length - 1 && Number.isFinite(values[last + 1])) keep.add(last + 1);
      }
    }
    return mark.data.filter((_, index) => keep.has(index));
  }
  const allowed = new Set(xWin.map(String));
  return mark.data.filter((row) => {
    const x = rowXValue(mark, row);
    return x == null || !isBandCategory(x) || allowed.has(String(x));
  });
}

function windowChartSpec(spec: ChartSpec): ChartSpec {
  const hidden = new Set(spec.hiddenSeries ?? []);
  let marks = spec.marks;
  if (hidden.size) {
    marks = marks.filter((mark) => !hidden.has(markSeriesName(mark)));
  }
  const viewport = spec.viewport;
  if (!viewport?.x && !viewport?.y && marks === spec.marks) return spec;
  marks = marks.map((mark) => ({ ...mark, data: windowMarkData(mark, viewport) }));
  const scales = { ...spec.scales };
  if (viewport?.x) {
    if (isQuantitativeViewportX(viewport.x)) {
      const lo = Math.min(asNumber(viewport.x[0]), asNumber(viewport.x[1]));
      const hi = Math.max(asNumber(viewport.x[0]), asNumber(viewport.x[1]));
      const type = spec.scales?.x?.type ?? (lo > 1e11 ? "time" : "linear");
      scales.x = {
        ...scales.x,
        type,
        domain: [lo, hi],
      } as XScaleSpec;
    } else {
      scales.x = {
        type: "band",
        ...(spec.scales?.x?.type === "band" ? spec.scales.x : {}),
        domain: [...viewport.x],
      };
    }
  }
  if (viewport?.y) {
    const yLo = Math.min(viewport.y[0], viewport.y[1]);
    const yHi = Math.max(viewport.y[0], viewport.y[1]);
    scales.y = { ...scales.y, domain: [yLo, yHi] };
  }
  return { ...spec, marks, scales };
}

export function compileChart(definition: ChartDefinition, size: { width: number; height: number }): CompiledChart {
  if (!definition || typeof definition.spec !== "function") {
    throw new ChartCompileError("E_CHART_SPEC", "compileChart() requires a definition created by defineChart().");
  }
  if (!isRecord(size) || typeof size.width !== "number" || typeof size.height !== "number") {
    throw new ChartCompileError("E_CHART_SIZE", "compileChart() requires numeric width and height.");
  }
  const inputSpec = definition.spec(size);
  if (!inputSpec || !isRuntimeArray(inputSpec.marks)) {
    throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.marks must be an array.");
  }
  const width = inputSpec.width ?? size.width;
  const height = inputSpec.height ?? size.height;
  validateChartSpec(inputSpec, width, height);
  const polarPreview = inputSpec.marks.some((m) => m.kind === "pie" || m.kind === "radar");
  const heatmapPreview = inputSpec.marks.some((m) => m.kind === "heatmap");
  if (inputSpec.viewport && (polarPreview || heatmapPreview)) {
    throw new ChartCompileError("E_CHART_SPEC", "viewport is supported on Cartesian charts only.");
  }
  const sourceRows = inputSpec.marks.reduce((total, mark) => total + mark.data.length, 0);
  const spec = windowChartSpec(inputSpec);
  const visibleRows = spec.marks.reduce((total, mark) => total + mark.data.length, 0);
  // Every compiled scene owns its theme. Exported presets are immutable
  // inputs, never shared mutable runtime state.
  const theme: DashboardTheme = { ...resolveChartTheme(spec.theme) };
  const polar = spec.marks.some((m) => m.kind === "pie" || m.kind === "radar");
  const heatmap = spec.marks.some((m) => m.kind === "heatmap");
  const isPie = spec.marks.some((m) => m.kind === "pie");
  const isRadar = spec.marks.some((m) => m.kind === "radar");
  const hideLegend = spec.legend === false;
  const pieHasLegendRows = isPie && spec.marks.some((mark) => mark.kind === "pie" && mark.data.length > 0);
  const hasBar = spec.marks.some((m) => m.kind === "bar");
  const hasArea = spec.marks.some((m) => m.kind === "area");
  const barMarks = spec.marks.filter((mark) => isBuiltinKind(mark, "bar"));
  const barGroupByMark = new Map<ChartMark, number>();
  const barGroupByStack = new Map<string, number>();
  let barGroupCount = 0;
  for (const mark of barMarks) {
    if (mark.stackId) {
      let group = barGroupByStack.get(mark.stackId);
      if (group == null) {
        group = barGroupCount++;
        barGroupByStack.set(mark.stackId, group);
      }
      barGroupByMark.set(mark, group);
    } else {
      barGroupByMark.set(mark, barGroupCount++);
    }
  }
  const nBarGroups = Math.max(1, barGroupCount);
  const isHist = barMarks.length === 1 && !barMarks[0]!.stackId;
  const pluginDomains = new Map<ChartMark, MarkDomainContribution>();
  for (const mark of spec.marks) {
    if (!isPluginMark(mark)) continue;
    if (mark.plugin.kind !== mark.kind) {
      throw new ChartCompileError(
        "E_MARK_PLUGIN_MISMATCH",
        `Mark kind "${mark.kind}" does not match plugin kind "${mark.plugin.kind}".`,
      );
    }
    try {
      const contribution = mark.plugin.domain
        ? mark.plugin.domain(mark.data, mark.pluginOptions)
        : {};
      pluginDomains.set(mark, validatePluginDomainContribution(contribution));
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      throw new ChartCompileError(
        "E_MARK_PLUGIN_DOMAIN",
        `Failed to resolve domain for "${mark.kind}".${detail}`,
        { cause: error },
      );
    }
  }

  const margin: Margin = polar
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

  let plot = {
    x: margin.left,
    y: margin.top,
    w: Math.max(1, width - margin.left - margin.right),
    h: Math.max(1, height - margin.top - margin.bottom),
  };

  const cartesianMarks = spec.marks.filter((mark): mark is LineChartMark | AreaChartMark | BarChartMark | PointChartMark => (
    isBuiltinMark(mark) && (mark.kind === "line" || mark.kind === "area" || mark.kind === "bar" || mark.kind === "point")
  ));

  const xValues: unknown[] = [];
  const yValues: number[] = [];
  for (const m of cartesianMarks) {
    for (const row of m.data) {
      const x = readChannel(row as never, m.x as never);
      // Nullable/object category accessors represent gaps, not anonymous bands.
      if (!isBandCategory(x) && !(x instanceof Date)) continue;
      xValues.push(x);
      const y = asNumber(readChannel(row as never, m.y as never));
      if (Number.isFinite(y)) yValues.push(y);
      if (m.kind === "area" && m.y0 != null) {
        const y0 = asNumber(readChannel(row as never, m.y0 as never));
        if (Number.isFinite(y0)) yValues.push(y0);
      }
    }
  }
  for (const contribution of pluginDomains.values()) {
    if (contribution.x) {
      for (const value of contribution.x) xValues.push(value);
    }
    if (contribution.y) {
      for (const value of contribution.y) {
        if (Number.isFinite(value)) yValues.push(value);
      }
    }
  }
  for (const m of spec.marks.filter((mark) => isBuiltinKind(mark, "ruleY"))) {
    for (const row of m.data) {
      const y = asNumber(readChannel(row as never, m.y as never));
      if (Number.isFinite(y)) yValues.push(y);
    }
  }
  for (const m of spec.marks.filter((mark) => isBuiltinKind(mark, "ruleX"))) {
    for (const row of m.data) {
      const x = readChannel(row as never, m.x as never);
      if (isBandCategory(x) || x instanceof Date) xValues.push(x);
    }
  }
  const explicitXType = spec.scales?.x?.type;
  const configuredXDomain = spec.scales?.x?.domain as readonly unknown[] | undefined;
  const configuredDomainIsQuantitative = configuredXDomain?.length === 2
    && configuredXDomain.every((value) => Number.isFinite(asNumber(value)));
  const xIsNumeric = xValues.length > 0 && xValues.every((value) => Number.isFinite(asNumber(value)));
  const xIsTime = xValues.length > 0 && xValues.every((value) => value instanceof Date);
  const xType = explicitXType ?? (
    xIsTime ? "time" : !xIsNumeric && !configuredDomainIsQuantitative ? "band" : "linear"
  );
  const formatX = (value: unknown): string => {
    if (spec.scales?.x?.tickFormat) return spec.scales.x.tickFormat(value);
    return xType === "time" ? formatDateTick(value) : formatTick(value);
  };
  const formatY = (value: unknown): string => {
    if (spec.scales?.y?.tickFormat) return spec.scales.y.tickFormat(value);
    return typeof value === "number" ? formatNum(value) : formatTick(value);
  };

  const stackTotals = new Map<string, { positive: number; negative: number }>();
  for (const m of spec.marks.filter((mark): mark is BarChartMark => isBuiltinKind(mark, "bar") && !!mark.stackId)) {
    for (const row of m.data) {
      const rawX = readChannel(row as never, m.x as never);
      const y = asNumber(readChannel(row as never, m.y as never));
      const validX = xType === "band" ? isBandCategory(rawX) : Number.isFinite(asNumber(rawX));
      if (!validX || !Number.isFinite(y)) continue;
      const key = stackKey(m.stackId!, rawX, xType !== "band");
      const total = stackTotals.get(key) ?? { positive: 0, negative: 0 };
      if (y >= 0) total.positive += y;
      else total.negative += y;
      stackTotals.set(key, total);
    }
  }
  for (const total of stackTotals.values()) yValues.push(total.positive, total.negative);
  if (
    !heatmap
    && xType !== "band"
    && xValues.some((value) => !Number.isFinite(asNumber(value)))
  ) {
    throw new ChartCompileError(
      "E_SCALE_DOMAIN",
      `scales.x.type "${xType}" requires numeric or Date-compatible x values. Use type "band" for categories.`,
    );
  }
  if (!heatmap && xType !== "band" && configuredXDomain !== undefined) {
    if (configuredXDomain.length !== 2 || !configuredXDomain.every((value) => Number.isFinite(asNumber(value)))) {
      throw new ChartCompileError(
        "E_SCALE_DOMAIN",
        "A quantitative scales.x.domain must contain exactly two finite number or Date endpoints.",
      );
    }
  }
  if (!heatmap && xType === "band" && configuredXDomain !== undefined) {
    for (const category of configuredXDomain) {
      if ((typeof category !== "string" && typeof category !== "number") || (typeof category === "number" && !Number.isFinite(category))) {
        throw new ChartCompileError(
          "E_SCALE_DOMAIN",
          `A band scales.x.domain contains an invalid category (${String(category)}).`,
        );
      }
    }
    for (const mark of cartesianMarks) {
      for (const row of mark.data) {
        const category = readChannel(row as never, mark.x as never);
        if (isBandCategory(category) && !configuredXDomain.includes(category)) {
          throw new ChartCompileError(
            "E_SCALE_DOMAIN",
            `scales.x.domain does not contain category ${JSON.stringify(category)} used by a ${mark.kind} mark.`,
          );
        }
      }
    }
    for (const contribution of pluginDomains.values()) {
      for (const category of contribution.x ?? []) {
        if (isBandCategory(category) && !configuredXDomain.includes(category)) {
          throw new ChartCompileError(
            "E_SCALE_DOMAIN",
            `scales.x.domain does not contain category ${JSON.stringify(category)} contributed by a plugin.`,
          );
        }
      }
    }
  }
  if (!heatmap && xType === "band" && spec.scales?.x?.nice !== undefined) {
    throw new ChartCompileError("E_SCALE_TYPE", "scales.x.nice is not supported when the inferred scale is band.");
  }
  if (!heatmap && xType !== "band" && spec.scales?.x?.padding !== undefined) {
    throw new ChartCompileError("E_SCALE_TYPE", "scales.x.padding requires a band scale or categorical data.");
  }
  if (
    !heatmap
    && xType === "log"
    && xValues.some((value) => Number.isFinite(asNumber(value)) && asNumber(value) <= 0)
  ) {
    throw new ChartCompileError("E_SCALE_DOMAIN", "A log x scale requires every finite x value to be greater than zero.");
  }
  if (!heatmap && spec.scales?.y?.type === "log") {
    if (hasBar || hasArea) {
      throw new ChartCompileError(
        "E_SCALE_TYPE",
        "Bar and area marks require a zero baseline and cannot use a log y scale. Use line/point marks or a linear y scale.",
      );
    }
    if (yValues.some((value) => value <= 0)) {
      throw new ChartCompileError("E_SCALE_DOMAIN", "A log y scale requires every finite y value to be greater than zero.");
    }
  }

  let xScale: AnyScale;
  let yScale: AnyScale = scaleLinear({ range: [plot.y + plot.h, plot.y] });

  if (heatmap) {
    const hm = spec.marks.find((mark) => isBuiltinKind(mark, "heatmap"))!;
    const observedXs = unique(hm.data
      .map((row) => readChannel(row as never, hm.x as never))
      .filter(isBandCategory));
    const observedYs = unique(hm.data
      .map((row) => readChannel(row as never, hm.y as never))
      .filter(isBandCategory));
    const xs = (spec.scales?.x?.domain as readonly (string | number)[] | undefined) ?? observedXs;
    const ys = (spec.scales?.y?.domain as readonly (string | number)[] | undefined) ?? observedYs;
    for (const value of observedXs) {
      if (!xs.includes(value)) {
        throw new ChartCompileError("E_SCALE_DOMAIN", `scales.x.domain does not contain heatmap category ${JSON.stringify(value)}.`);
      }
    }
    for (const value of observedYs) {
      if (!ys.includes(value)) {
        throw new ChartCompileError("E_SCALE_DOMAIN", `scales.y.domain does not contain heatmap category ${JSON.stringify(value)}.`);
      }
    }
    const nX = Math.max(1, xs.length);
    const nY = Math.max(1, ys.length);
    const gap = 2;
    const cell = Math.max(1, Math.min(
      Math.floor((plot.w - (nX - 1) * gap) / nX),
      Math.floor((plot.h - (nY - 1) * gap) / nY),
    ));
    const gridW = nX * (cell + gap);
    const gridH = nY * (cell + gap);
    plot = {
      x: margin.left + Math.floor((plot.w - gridW) / 2),
      y: margin.top + Math.floor((plot.h - gridH) / 2),
      w: gridW,
      h: gridH,
    };
    const pad = gap / (cell + gap);
    xScale = scaleBand({
      domain: xs,
      range: [plot.x, plot.x + plot.w],
      padding: spec.scales?.x?.padding ?? pad,
    });
    yScale = scaleBand({
      domain: ys,
      range: [plot.y, plot.y + plot.h],
      padding: spec.scales?.y?.padding ?? pad,
    });
  } else if (xType === "band") {
    const domain = (spec.scales?.x?.domain as (string | number)[] | undefined) ?? unique(xValues.map((v) => v as string | number));
    const pad = spec.scales?.x?.padding ?? (nBarGroups > 1 ? 0.22 : isHist ? 0.14 : 0.26);
    xScale = scaleBand({
      domain,
      range: [plot.x, plot.x + plot.w],
      padding: pad,
    });
  } else {
    const xs = xValues.map(asNumber).filter(Number.isFinite);
    const configured = spec.scales?.x?.domain as readonly unknown[] | undefined;
    const raw = configured
      ? [asNumber(configured[0]), asNumber(configured[1])] as [number, number]
      : undefined;
    let lo: number;
    let hi: number;
    if (raw) {
      lo = raw[0];
      hi = raw[1];
    } else {
      const dataBounds = finiteBounds(xs);
      const dataLo = dataBounds?.[0] ?? (xType === "log" ? 1 : 0);
      const dataHi = dataBounds?.[1] ?? (xType === "log" ? 10 : 1);
      const span = dataHi - dataLo;
      if (hasBar) {
        const barXs = unique(barMarks.flatMap((mark) => mark.data
          .map((row) => asNumber(readChannel(row as never, mark.x as never)))
          .filter(Number.isFinite))).sort((a, b) => a - b);
        if (xType === "log") {
          let ratio = 2;
          for (let index = 1; index < barXs.length; index++) {
            const candidate = barXs[index]! / barXs[index - 1]!;
            if (candidate > 1 && candidate < ratio) ratio = candidate;
          }
          const factor = Math.sqrt(ratio);
          const firstBar = barXs[0] ?? dataLo;
          const lastBar = barXs[barXs.length - 1] ?? Math.max(dataHi, firstBar);
          const lowerBar = firstBar / factor || firstBar;
          const upperBar = Number.isFinite(lastBar * factor) ? lastBar * factor : lastBar;
          lo = Math.min(dataLo, lowerBar);
          hi = Math.max(dataHi, upperBar);
        } else {
          let spacing = Infinity;
          if (barXs.length === 1) {
            const value = barXs[0]!;
            const half = xType === "time" ? 86_400_000 : Math.max(Math.abs(value) * 0.1, 1);
            spacing = half * 2;
          } else {
            for (let index = 1; index < barXs.length; index++) {
              const candidate = barXs[index]! - barXs[index - 1]!;
              if (candidate > 0 && candidate < spacing) spacing = candidate;
            }
          }
          if (!Number.isFinite(spacing)) spacing = span || (xType === "time" ? 172_800_000 : 2);
          const firstBar = barXs[0] ?? dataLo;
          const lastBar = barXs[barXs.length - 1] ?? dataHi;
          lo = Math.min(dataLo, firstBar - spacing / 2);
          hi = Math.max(dataHi, lastBar + spacing / 2);
        }
      } else {
        if (dataLo === dataHi) {
          if (xType === "log") {
            lo = dataLo;
            hi = dataHi;
          } else {
            const pad = xType === "time" ? 86_400_000 : Math.max(Math.abs(dataLo) * 0.06, 1);
            lo = dataLo - pad;
            hi = dataHi + pad;
          }
        } else {
          const pad = hasArea ? 0 : span * 0.06;
          lo = dataLo - pad;
          hi = dataHi + pad;
        }
      }
    }
    const xRange: [number, number] = [plot.x, plot.x + plot.w];
    if (xType === "log") {
      xScale = scaleLog({ domain: [lo, hi], range: xRange });
    } else if (xType === "time") {
      xScale = scaleTime({ domain: [lo, hi], range: xRange });
    } else {
      xScale = scaleLinear({ domain: [lo, hi], range: xRange, nice: spec.scales?.x?.nice ?? false });
    }
  }

  if (!heatmap) {
    if (spec.scales?.y?.type === "log") {
      const configured = spec.scales.y.domain as readonly unknown[] | undefined;
      const bounds = configured
        ? [asNumber(configured[0]), asNumber(configured[1])]
        : (finiteBounds(yValues) ?? [1, 10]);
      yScale = scaleLog({
        domain: [bounds[0], bounds[1]],
        range: [plot.y + plot.h, plot.y],
      });
    } else {
      const includeZero = hasBar || hasArea || Array.from(pluginDomains.values()).some((domain) => domain.includeZero);
      const configured = spec.scales?.y?.domain as readonly unknown[] | undefined;
      const raw = configured
        ? [asNumber(configured[0]), asNumber(configured[1])] as [number, number]
        : undefined;
      let yLo: number;
      let yHi: number;
      if (raw) {
        yLo = raw[0];
        yHi = raw[1];
      } else {
        let ext = extent(yValues);
        if (includeZero) ext = [Math.min(0, ext[0]), Math.max(0, ext[1])];
        const span = (ext[1] - ext[0]) || 1;
        const pad = includeZero ? span * 0.06 : span * 0.1;
        yLo = includeZero ? Math.min(0, ext[0]) : ext[0] - pad;
        yHi = ext[1] + pad;
      }
      yScale = scaleLinear({
        domain: [yLo, yHi],
        range: [plot.y + plot.h, plot.y],
        nice: spec.scales?.y?.nice ?? includeZero,
      });
    }
  }

  const xTickBudget = Math.max(2, Math.min(5, Math.floor(plot.w / 96)));
  const yTickBudget = Math.max(2, Math.min(6, Math.floor(plot.h / 52)));
  const xTicks = xScale.kind === "band"
    ? thinBandTicks((xScale as BandScale).domain, plot.w, heatmap).map((value) => ({
      value, px: xScale.map(value), label: formatX(value),
    }))
    : (xType === "time"
      ? utcTimeTicks((xScale as LinearScale).domain[0], (xScale as LinearScale).domain[1], xTickBudget)
      : (xScale as LinearScale).ticks(xTickBudget)
    ).map((value) => ({
      value, px: xScale.map(value), label: formatX(value),
    }));

  const yTicks = yScale.kind === "band"
    ? (yScale as BandScale).domain.map((value) => ({ value, px: yScale.map(value), label: formatY(value) }))
    : (yScale as LinearScale).ticks(yTickBudget).map((value) => ({
      value, px: yScale.map(value), label: formatY(value),
    }));

  let numericBarClusterWidth = Math.max(2, plot.w * 0.62);
  if (hasBar && xScale.kind !== "band") {
    const positions = unique(barMarks.flatMap((mark) => mark.data
      .map((row) => xScale.map(asNumber(readChannel(row as never, mark.x as never))))
      .filter(Number.isFinite))).sort((a, b) => a - b);
    if (positions.length > 1) {
      let spacing = Infinity;
      for (let index = 1; index < positions.length; index++) {
        const candidate = positions[index]! - positions[index - 1]!;
        if (candidate > 0 && candidate < spacing) spacing = candidate;
      }
      if (Number.isFinite(spacing)) numericBarClusterWidth = Math.max(2, spacing * 0.62);
    }
  }

  const stackCursor = new Map<string, { positive: number; negative: number }>();
  const nodes: SceneNode[] = [];
  const legend: { name: string; color: string; detail?: string }[] = [];
  const lastValues: LastValue[] = [];
  const samples: HoverSample[] = [];
  let decimatedPoints = 0;
  let colorBar: { min: number; max: number } | null = null;
  let colorI = 0;
  let radarAxesDrawn = false;
  const radarRawMax = Math.max(
    1,
    ...spec.marks.filter((mark) => isBuiltinKind(mark, "radar")).flatMap((mm) =>
      mm.data.map((row) => asNumber(readChannel(row as never, mm.y as never))),
    ).filter(Number.isFinite),
  );
  const radarMax = niceCeil(radarRawMax);

  type XYMark = LineChartMark | AreaChartMark | BarChartMark | PointChartMark | RadarChartMark | HeatmapChartMark;
  const mapX = (row: unknown, m: XYMark): number => {
    const raw = readChannel(row as never, m.x as never);
    if (xScale.kind === "band") return xScale.map(raw as string);
    return xScale.map(asNumber(raw));
  };
  const mapY = (row: unknown, m: XYMark | RuleYChartMark): number => {
    const raw = readChannel(row as never, m.y as never);
    if (yScale.kind === "band") return yScale.map(raw as string);
    return yScale.map(asNumber(raw));
  };
  const mapXValue = (raw: unknown): number => {
    if (xScale.kind === "band") return xScale.map(raw as string);
    return xScale.map(asNumber(raw));
  };
  const mapYValue = (raw: unknown): number => {
    if (yScale.kind === "band") return yScale.map(raw as string);
    return yScale.map(asNumber(raw));
  };

  for (const m of spec.marks) {
    const color = seriesColor(m, colorI++, theme);
    const name = m.name ?? ("y" in m && typeof m.y === "string" ? m.y : m.kind);
    if (isPluginMark(m)) {
      let output: unknown;
      try {
        output = m.plugin.compile({
          data: m.data,
          options: m.pluginOptions,
          width,
          height,
          plot: Object.freeze({ ...plot }),
          xScale: isolatePluginScale(xScale),
          yScale: isolatePluginScale(yScale),
          theme: Object.freeze({ ...theme }),
          color,
          name,
          mapX: mapXValue,
          mapY: mapYValue,
        });
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : "";
        throw new ChartCompileError(
          "E_MARK_PLUGIN_COMPILE",
          `Failed to compile "${m.kind}".${detail}`,
          { cause: error },
        );
      }
      validatePluginResult(output, m.kind);
      for (const node of output.nodes) nodes.push(node);
      for (const item of output.legend ?? [{ name, color }]) legend.push(item);
      if (output.samples) for (const sample of output.samples) samples.push(sample);
      if (output.lastValues) for (const value of output.lastValues) lastValues.push(value);
      continue;
    }
    if (m.kind !== "ruleY" && m.kind !== "ruleX" && m.kind !== "pie" && m.kind !== "heatmap") legend.push({ name, color: markFill(m) || color });

    if (m.kind === "line" || m.kind === "area") {
      const rawSegments: { points: { x: number; y: number }[]; rows: unknown[] }[] = [];
      let segment = { points: [] as { x: number; y: number }[], rows: [] as unknown[] };
      for (const row of m.data) {
        const x = mapX(row, m);
        const y = mapY(row, m);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          if (segment.points.length) rawSegments.push(segment);
          segment = { points: [], rows: [] };
          continue;
        }
        segment.points.push({ x, y });
        segment.rows.push(row);
      }
      if (segment.points.length) rawSegments.push(segment);
      const rawFinalSegment = rawSegments[rawSegments.length - 1];

      const requested = spec.performance?.maxRenderedPoints;
      const seriesLimit = requested !== undefined
        ? Math.max(1, Math.floor(requested))
        : Math.max(1, Math.floor(plot.w * 2));
      const validPointCount = rawSegments.reduce((total, item) => total + item.points.length, 0);
      let segments = rawSegments;
      if (spec.performance?.decimation !== "none" && validPointCount > seriesLimit) {
        // Select and allocate together. Every retained gap segment initially
        // costs one point, while the latest segment and global-extrema segments
        // receive enough context first. This both honors tiny hard caps and
        // avoids wasting half the budget on singleton segments.
        let minY = Infinity;
        let maxY = -Infinity;
        let minSegment = 0;
        let maxSegment = 0;
        for (let index = 0; index < rawSegments.length; index++) {
          for (const point of rawSegments[index]!.points) {
            if (point.y < minY) { minY = point.y; minSegment = index; }
            if (point.y > maxY) { maxY = point.y; maxSegment = index; }
          }
        }
        const finalSegment = rawSegments.length - 1;
        const quotas = new Map<number, number>();
        let unallocated = seriesLimit;
        const allocate = (index: number, preferred: number): void => {
          if (index < 0 || index >= rawSegments.length || unallocated <= 0) return;
          const previous = quotas.get(index) ?? 0;
          const desired = Math.min(preferred, rawSegments[index]!.points.length);
          const addition = Math.min(Math.max(0, desired - previous), unallocated);
          if (addition <= 0) return;
          quotas.set(index, previous + addition);
          unallocated -= addition;
        };
        const finalExtrema = Number(finalSegment === minSegment) + Number(finalSegment === maxSegment);
        allocate(finalSegment, finalExtrema > 0 ? 3 : 2);
        allocate(minSegment, 2);
        allocate(maxSegment, 2);
        allocate(0, 1);

        const targetSegments = Math.min(rawSegments.length, quotas.size + unallocated);
        if (targetSegments === 1) allocate(finalSegment, 1);
        else {
          for (let slot = 0; slot < targetSegments && unallocated > 0; slot++) {
            allocate(Math.round((slot * (rawSegments.length - 1)) / (targetSegments - 1)), 1);
          }
        }
        for (let index = 0; index < rawSegments.length && unallocated > 0; index++) allocate(index, 1);

        const selectedIndices = Array.from(quotas.keys()).sort((a, b) => a - b);
        let remainingCapacity = selectedIndices.reduce(
          (total, index) => total + Math.max(0, rawSegments[index]!.points.length - quotas.get(index)!),
          0,
        );
        for (const index of selectedIndices) {
          const currentQuota = quotas.get(index)!;
          const capacity = Math.max(0, rawSegments[index]!.points.length - currentQuota);
          const extra = remainingCapacity > 0
            ? Math.min(capacity, Math.floor((unallocated * capacity) / remainingCapacity))
            : 0;
          quotas.set(index, currentQuota + extra);
          unallocated -= extra;
          remainingCapacity -= capacity;
        }
        segments = selectedIndices.map((index) => decimateExtrema(
          rawSegments[index]!.points,
          rawSegments[index]!.rows,
          quotas.get(index)!,
          {
            preserveTail: index === finalSegment,
            preferredY: [
              ...(index === minSegment ? [minY] : []),
              ...(index === maxSegment ? [maxY] : []),
            ],
          },
        ));
        const renderedPointCount = segments.reduce((total, item) => total + item.points.length, 0);
        decimatedPoints += validPointCount - renderedPointCount;
      }

      for (const current of segments) {
        const { points: pts, rows } = current;
        const curve = m.curve ?? "monotone";
        if (m.kind === "area" && pts.length) {
          const mappedZero = yScale.kind === "linear" ? yScale.map(0) : plot.y + plot.h;
          const baseline = Math.max(plot.y, Math.min(plot.y + plot.h, mappedZero));
          if (m.y0) {
            const lower: { x: number; y: number }[] = [];
            for (let i = 0; i < pts.length; i++) {
              const y0 = asNumber(readChannel(rows[i] as never, m.y0 as never));
              const y = Number.isFinite(y0) && yScale.kind === "linear" ? yScale.map(y0) : baseline;
              lower.push({ x: pts[i]!.x, y });
            }
            nodes.push({
              type: "area",
              points: [...pts, ...lower.slice().reverse()],
              fill: m.fill || color,
              fillOpacity: m.fillOpacity ?? 0.28,
              stroke: "none",
              series: name,
              hit: false,
              role: "ranged-area",
              curve: "linear",
            });
          } else {
            nodes.push({
              type: "area",
              points: [
                { x: pts[0]!.x, y: baseline },
                ...pts,
                { x: pts[pts.length - 1]!.x, y: baseline },
              ],
              fill: m.fill || color,
              fillOpacity: m.fillOpacity ?? 0.28,
              stroke: "none",
              series: name,
              hit: false,
              role: "area",
              curve,
            });
          }
        }
        nodes.push({
          type: "line",
          points: pts,
          stroke: color,
          strokeWidth: m.strokeWidth ?? (m.dashed ? 1.15 : 1.85),
          fill: "none",
          dashed: m.dashed,
          series: name,
          hit: true,
          role: "line",
          curve,
        });
        if (pts.length === 1) {
          const row = rows[0];
          const xv = readChannel(row as never, m.x as never);
          const yv = asNumber(readChannel(row as never, m.y as never));
          nodes.push({
            type: "circle",
            x: pts[0]!.x,
            y: pts[0]!.y,
            r: 2.6,
            fill: color,
            stroke: theme.background,
            strokeWidth: 1.2,
            datum: row,
            series: name,
            tip: `${name}\n${formatX(xv)}   ${formatNum(yv)}`,
            role: "point",
          });
        }
        for (let i = 0; i < pts.length; i++) {
          const row = rows[i];
          const xv = readChannel(row as never, m.x as never);
          const yv = asNumber(readChannel(row as never, m.y as never));
          const tip = `${name}\n${formatX(xv)}   ${formatNum(yv)}`;
          samples.push({ x: pts[i]!.x, y: pts[i]!.y, series: name, color, tip, kind: "line" });
        }
      }

      // Presentation budgets may choose extrema over the final sample. The
      // last-value chip and endpoint still describe the actual source tail.
      const lastPt = rawFinalSegment?.points[rawFinalSegment.points.length - 1];
      const lastRow = rawFinalSegment?.rows[rawFinalSegment.rows.length - 1];
      if (lastPt && lastRow != null && m.lastValue !== false) {
        lastValues.push({
          y: lastPt.y,
          label: formatNum(asNumber(readChannel(lastRow as never, m.y as never))),
          color,
          dash: true,
        });
        nodes.push({
          type: "circle",
          x: lastPt.x,
          y: lastPt.y,
          r: 3.4,
          fill: color,
          stroke: theme.background,
          strokeWidth: 1.6,
          datum: lastRow,
          series: name,
          hit: false,
          role: "endpoint",
        });
      }
    } else if (m.kind === "point") {
      const yDom = yScale.kind === "linear" ? (yScale as LinearScale).domain : [0, 1];
      const ySpan = yDom[1] - yDom[0] || 1;
      const xs = m.data.map((row) => asNumber(readChannel(row as never, m.x as never))).filter(Number.isFinite);
      const ys = m.data.map((row) => asNumber(readChannel(row as never, m.y as never))).filter(Number.isFinite);
      const [xLo, xHi] = extent(xs);
      const [yLo, yHi] = extent(ys);
      for (const row of m.data) {
        const x = mapX(row, m);
        const y = mapY(row, m);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const rawX = readChannel(row as never, m.x as never);
        const xv = asNumber(rawX);
        const yv = asNumber(readChannel(row as never, m.y as never));
        const yt = (yv - yLo) / ((yHi - yLo) || 1);
        const xt = Number.isFinite(xv)
          ? (xv - xLo) / ((xHi - xLo) || 1)
          : (x - plot.x) / (plot.w || 1);
        const fill = m.fill
          || rampFill((yv - yDom[0]) / ySpan, theme);
        const requestedRadius = m.r ?? (2.15 + 2.5 * yt + 0.4 * xt);
        const r = Number.isFinite(requestedRadius) ? Math.max(0, requestedRadius) : 3;
        const tip = `${name}\n${formatX(rawX)}   ·   ${formatNum(yv)}`;
        nodes.push({
          type: "circle",
          x, y, r,
          fill,
          fillOpacity: m.fillOpacity ?? 0.78,
          stroke: "none",
          datum: row,
          series: name,
          tip,
          role: "point",
        });
        samples.push({ x, y, series: name, color: fill, tip, kind: "point" });
      }
    } else if (m.kind === "ruleY") {
      for (const row of m.data) {
        const y = mapY(row, m);
        if (!Number.isFinite(y)) continue;
        const yv = asNumber(readChannel(row as never, m.y as never));
        nodes.push({
          type: "rule",
          x: plot.x, y, x2: plot.x + plot.w, y2: y,
          stroke: m.stroke || color,
          strokeWidth: m.strokeWidth ?? 1,
          dashed: true,
          series: name,
          hit: false,
          role: "rule",
        });
        nodes.push({
          type: "text",
          x: plot.x + 6,
          y: y - 7,
          label: `${name}  ${formatNum(yv)}`,
          fill: m.stroke || theme.gold,
          fontSize: 9,
          anchor: "start",
          hit: false,
          clip: true,
        });
        lastValues.push({
          y,
          label: formatNum(yv),
          color: m.stroke || color,
          dash: false,
        });
      }
    } else if (m.kind === "ruleX") {
      for (const row of m.data) {
        const x = mapXValue(readChannel(row as never, m.x as never));
        if (!Number.isFinite(x)) continue;
        const xv = readChannel(row as never, m.x as never);
        nodes.push({
          type: "rule",
          x, y: plot.y, x2: x, y2: plot.y + plot.h,
          stroke: m.stroke || color,
          strokeWidth: m.strokeWidth ?? 1,
          dashed: true,
          series: name,
          hit: false,
          role: "rule",
        });
        nodes.push({
          type: "text",
          x: x + 6,
          y: plot.y + 12,
          label: `${name}  ${formatX(xv)}`,
          fill: m.stroke || theme.gold,
          fontSize: 9,
          anchor: "start",
          hit: false,
          clip: true,
        });
      }
    } else if (m.kind === "bar") {
      const stacked = !!m.stackId;
      const groupIndex = barGroupByMark.get(m) ?? 0;
      const nGroup = nBarGroups;
      const innerGap = nGroup > 1 ? 3 : 0;
      let lastBar: SceneNode | null = null;
      let lastBarEndpointY: number | null = null;
      let lastBarValue: number | null = null;
      const nRows = m.data.length;
      for (let ri = 0; ri < nRows; ri++) {
        const row = m.data[ri]!;
        const rawX = readChannel(row as never, m.x as never);
        const yv = asNumber(readChannel(row as never, m.y as never));
        if (!Number.isFinite(yv)) continue;
        const mappedBarX = xScale.kind === "band"
          ? (xScale as BandScale<string | number>).start(rawX as string | number)
          : xScale.map(asNumber(rawX));
        if (!Number.isFinite(mappedBarX)) continue;
        const key = stackKey(m.stackId ?? "", rawX, xType !== "band");
        const cursor = stackCursor.get(key) ?? { positive: 0, negative: 0 };
        const base = stacked ? (yv >= 0 ? cursor.positive : cursor.negative) : 0;
        if (stacked) {
          if (yv >= 0) cursor.positive = base + yv;
          else cursor.negative = base + yv;
          stackCursor.set(key, cursor);
        }
        const y1 = yScale.map(base);
        const y2 = yScale.map(stacked ? base + yv : yv);
        const top = Math.min(y1, y2);
        const h = Math.max(1, Math.abs(y2 - y1));
        let x: number;
        let w: number;
        if (xScale.kind === "band") {
          const xb = xScale as BandScale<string | number>;
          const slot0 = mappedBarX;
          const slot1 = slot0 + xb.bandwidth();
          const slot = groupBarSlot(slot0, slot1, groupIndex, nGroup, innerGap);
          const snapped = snapRect(slot.x, top, slot.w, h);
          x = snapped.x;
          w = snapped.w;
        } else {
          const center = mappedBarX;
          const slot = groupBarSlot(
            center - numericBarClusterWidth / 2,
            center + numericBarClusterWidth / 2,
            groupIndex,
            nGroup,
            innerGap,
          );
          const snapped = snapRect(slot.x, top, slot.w, h);
          x = snapped.x;
          w = snapped.w;
        }
        const tFade = nRows <= 1 ? 1 : ri / (nRows - 1);
        const fill = m.fade
          ? mixHex("#1b1e20", m.fill || color, 0.22 + 0.78 * tFade)
          : (m.fill || color);
        const tip = `${name}\n${formatX(rawX)}   ${formatNum(yv)}`;
        lastBar = {
          type: "rect",
          x, y: Math.round(top), w, h: Math.max(1, Math.round(top + h) - Math.round(top)),
          fill,
          stroke: "none",
          corner: stacked ? "all" : (yv >= 0 ? "top" : "bottom"),
          valueY: y2,
          datum: row,
          series: name,
          tip,
          role: "bar",
          highlight: !stacked,
        };
        nodes.push(lastBar);
        lastBarEndpointY = y2;
        lastBarValue = yv;
      }
      if (lastBar && m.lastValue === true && lastBarEndpointY != null && lastBarValue != null) {
        lastValues.push({
          y: lastBarEndpointY,
          label: formatNum(lastBarValue),
          color: m.fill || color,
          dash: true,
        });
      }
    } else if (m.kind === "heatmap") {
      const xb = xScale as BandScale<string | number>;
      const yb = yScale as BandScale<string | number>;
      const validRows = m.data.map((row) => ({
        row,
        x: xb.start(readChannel(row as never, m.x as never) as string | number),
        y: yb.start(readChannel(row as never, m.y as never) as string | number),
        z: asNumber(readChannel(row as never, m.valueKey as never)),
      })).filter((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y) && Number.isFinite(entry.z));
      const zs = validRows.map((entry) => entry.z);
      let [zLo, zHi] = extent(zs);
      if (zLo < 0 && zHi > 0) {
        const mag = Math.max(Math.abs(zLo), zHi);
        zLo = -mag;
        zHi = mag;
      }
      colorBar = { min: zLo, max: zHi };
      for (const entry of validRows) {
        const { row, x, y, z: zv } = entry;
        const xv = readChannel(row as never, m.x as never);
        const yv = readChannel(row as never, m.y as never);
        const snapped = snapRect(x, y, xb.bandwidth(), yb.bandwidth());
        const fill = heatFill(zv, zLo, zHi, theme);
        const tip = `${String(yv)}  ·  ${String(xv)}\n${formatSigned(zv)}%`;
        nodes.push({
          type: "rect",
          ...snapped,
          fill,
          stroke: "none",
          corner: "none",
          datum: row,
          series: String(yv),
          label: formatSigned(zv),
          tip,
          role: "heat",
        });
        if (snapped.w >= 34 && snapped.h >= 18) {
          nodes.push({
            type: "text",
            x: snapped.x + snapped.w / 2,
            y: snapped.y + snapped.h / 2,
            label: formatSigned(zv),
            fill: heatLabelColor(fill, theme),
            fontSize: 9,
            anchor: "middle",
            hit: false,
          });
        }
      }
    } else if (m.kind === "pie") {
      const cx = plot.x + Math.round(plot.w / 2);
      const cy = plot.y + Math.round(plot.h / 2);
      const R = Math.max(1, Math.min(plot.w, plot.h) / 2 - 6);
      const outer = Math.min(R, m.outerRadius ?? R);
      const inner = Math.min(outer, m.innerRadius ?? outer * 0.66);
      const vals = m.data.map((row) => {
        const value = asNumber(readChannel(row as never, m.valueKey as never));
        return Number.isFinite(value) ? Math.max(0, value) : 0;
      });
      const total = vals.reduce((a, b) => a + b, 0);
      if (total <= 0) {
        for (let index = 0; index < m.data.length; index++) {
          const row = m.data[index];
          const label = String(readChannel(row as never, m.labelKey as never) ?? index);
          const palette = chartPalette(theme);
          legend.push({ name: label, color: palette[index % palette.length]!, detail: "0%" });
        }
        nodes.push({
          type: "text",
          x: cx,
          y: cy,
          label: "No data",
          fill: theme.muted,
          fontSize: 11,
          anchor: "middle",
          hit: false,
          role: "hole",
        });
        continue;
      }
      let a0 = -Math.PI / 2;
      let topI = 0;
      vals.forEach((val, i) => { if (val > vals[topI]!) topI = i; });
      vals.forEach((val, i) => {
        const span = (val / total) * Math.PI * 2;
        const a1 = a0 + span;
        const half = Math.min(0.036, span * 0.4);
        const row = m.data[i];
        const label = String(readChannel(row as never, m.labelKey as never) ?? i);
        const palette = chartPalette(theme);
        const sliceColor = palette[i % palette.length]!;
        const pct = Math.round((val / total) * 100);
        const same = Math.abs(val - pct) < 0.51 && Math.abs(total - 100) < 0.51;
        legend.push({ name: label, color: sliceColor, detail: same ? `${pct}%` : `${pct}%  ·  ${formatNum(val)}` });
        if (span <= 0) {
          a0 = a1;
          return;
        }
        nodes.push({
          type: "arc",
          x: cx, y: cy, r: outer, innerR: inner,
          startAngle: a0 + half, endAngle: a1 - half,
          fill: sliceColor,
          stroke: "none",
          datum: row,
          series: label,
          label: `${label}  ${pct}%`,
          tip: `${label}\n${pct}%`,
          role: "slice",
          idx: i,
        });
        a0 = a1;
      });
      const topLabel = String(readChannel(m.data[topI] as never, m.labelKey as never) ?? topI);
      const topPct = Math.round((vals[topI]! / total) * 100);
      nodes.push({
        type: "text",
        x: cx, y: cy - 7,
        label: `${topPct}%`,
        fill: theme.text,
        fontSize: 20,
        anchor: "middle",
        series: name,
        hit: false,
        role: "hole",
      });
      nodes.push({
        type: "text",
        x: cx, y: cy + 12,
        label: topLabel,
        fill: theme.muted,
        fontSize: 10,
        anchor: "middle",
        hit: false,
        role: "hole",
      });
    } else if (m.kind === "radar") {
      const cx = plot.x + plot.w / 2;
      const cy = plot.y + plot.h / 2;
      const R = Math.max(1, Math.min(plot.w, plot.h) / 2 - 22);
      const n = m.data.length || 1;
      const maxY = radarMax;
      if (!radarAxesDrawn) {
        radarAxesDrawn = true;
        for (const frac of [0.25, 0.5, 0.75, 1]) {
          const ring: { x: number; y: number }[] = [];
          for (let i = 0; i < n; i++) {
            const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
            ring.push({ x: cx + Math.cos(ang) * R * frac, y: cy + Math.sin(ang) * R * frac });
          }
          nodes.push({
            type: "polygon",
            points: ring,
            fill: "none",
            stroke: frac === 1 ? theme.axis : theme.grid,
            strokeWidth: frac === 1 ? 1.15 : 1,
            hit: false,
            role: "ring",
          });
        }
        m.data.forEach((row, i) => {
          const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
          nodes.push({
            type: "rule",
            x: cx, y: cy,
            x2: cx + Math.cos(ang) * R, y2: cy + Math.sin(ang) * R,
            stroke: theme.grid,
            strokeWidth: 1,
            dashed: false,
            hit: false,
            role: "spoke",
          });
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          const lx = cx + ca * (R + 16);
          const ly = cy + sa * (R + 16) + (Math.abs(ca) < 0.35 ? (sa < 0 ? -1 : 3) : 0);
          nodes.push({
            type: "text",
            x: lx, y: ly,
            label: String(readChannel(row as never, m.x as never) ?? i),
            fill: theme.text,
            fontSize: 10,
            anchor: Math.abs(ca) < 0.35 ? "middle" : ca > 0 ? "start" : "end",
            hit: false,
            clip: false,
          });
        });
        for (const frac of [0.5, 1]) {
          nodes.push({
            type: "text",
            x: cx + 5,
            y: cy - R * frac,
            label: formatNum(maxY * frac),
            fill: theme.muted,
            fontSize: 8,
            anchor: "start",
            hit: false,
            clip: false,
          });
        }
      }
      const pts: { x: number; y: number }[] = [];
      m.data.forEach((row, i) => {
        const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
        const yv = asNumber(readChannel(row as never, m.y as never));
        const rr = R * (Number.isFinite(yv) ? yv / maxY : 0);
        pts.push({ x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr });
      });
      nodes.push({
        type: "polygon",
        points: pts,
        fill: m.fill || color,
        fillOpacity: m.fillOpacity ?? 0.12,
        stroke: color,
        strokeWidth: m.strokeWidth ?? 1.7,
        series: name,
        hit: false,
        role: "radar",
      });
      m.data.forEach((row, i) => {
        const p = pts[i]!;
        const axis = String(readChannel(row as never, m.x as never) ?? i);
        const yv = asNumber(readChannel(row as never, m.y as never));
        const tip = `${name}\n${axis}   ${formatNum(yv)}`;
        nodes.push({
          type: "circle",
          x: p.x, y: p.y, r: 2.85,
          fill: color,
          stroke: theme.background,
          strokeWidth: 1.25,
          series: name,
          tip,
          role: "vertex",
        });
        samples.push({ x: p.x, y: p.y, series: name, color, tip, kind: "radar" });
      });
    }
  }

  const legendPlacement: CompiledChart["legendPlacement"] = hideLegend
    ? "hidden"
    : isPie
      ? "right"
    : isRadar
        ? "top"
        : "top";

  return {
    width, height, margin, plot,
    xScale, yScale, xTicks, yTicks,
    grid: heatmap ? spec.grid === true : spec.grid !== false,
    legend: hideLegend ? [] : unique(legend.map((l) => l.name)).map((n) => legend.find((l) => l.name === n)!),
    legendPlacement,
    nodes,
    tooltip: spec.tooltip !== false,
    ariaLabel: spec.ariaLabel?.trim() || "Chart",
    ariaDescription: spec.ariaDescription?.trim() ?? "",
    polar,
    heatmap,
    colorBar,
    theme,
    lastValues,
    samples,
    viewport: inputSpec.viewport ?? null,
    diagnostics: {
      sourceRows,
      visibleRows,
      renderedNodes: nodes.length,
      hoverSamples: samples.length,
      decimatedPoints,
    },
  };
}
