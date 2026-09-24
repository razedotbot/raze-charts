// Stable facade for the native grammar and compiler. The implementation lives
// in ./compile/* (one module per concern; see docs/architecture.md). Internal
// modules and the public ./index barrel may import from here without knowing
// that layout.

export type { ChartCompileErrorCode } from "./compile/errors";
export { ChartCompileError } from "./compile/errors";
export { asNumber, readChannel } from "./compile/shared";
export type {
  Accessor,
  AutoLinearScaleSpec,
  AxisLabelOptions,
  BandScaleSpec,
  ChartCurve,
  ChartDefinition,
  ChartDiagnostics,
  ChartMarkPlugin,
  ChartMarkPluginBandScale,
  ChartMarkPluginContext,
  ChartMarkPluginLinearScale,
  ChartMarkPluginResult,
  ChartMarkPluginScale,
  ChartPerformanceOptions,
  ChartSpec,
  ChartViewport,
  ChartViewportX,
  CompiledChart,
  HeatmapYScaleSpec,
  HoverSample,
  LastValue,
  LinearScaleSpec,
  LogScaleSpec,
  Margin,
  MarkDomainContribution,
  MarkKind,
  SceneNode,
  SceneNodeBase,
  ScenePoint,
  ScaleSpec,
  TimeScaleSpec,
  XScaleSpec,
  YScaleSpec,
} from "./compile/types";
export type {
  AreaChartMark,
  AreaMarkOptions,
  BarChartMark,
  BarMarkOptions,
  BuiltinChartMark,
  CartesianMarkOptions,
  ChartMark,
  ChartMarkBase,
  HeatmapChartMark,
  HeatmapMarkOptions,
  HeatmapValueFormat,
  LineChartMark,
  LineMarkOptions,
  PieChartMark,
  PieMarkOptions,
  PluginChartMark,
  PointChartMark,
  PointMarkOptions,
  RadarChartMark,
  RadarMarkOptions,
  RuleXChartMark,
  RuleXMarkOptions,
  RuleYChartMark,
  RuleYMarkOptions,
} from "./compile/marks";
export {
  area,
  bar,
  customMark,
  defineMarkPlugin,
  heatmap,
  line,
  pie,
  point,
  radar,
  ruleX,
  ruleY,
} from "./compile/marks";
export type { TypedChartSpec } from "./compile/define";
export { defineChart } from "./compile/define";
export { compileChart } from "./compile/chart";
