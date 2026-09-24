// defineChart(): the typed entry point that turns marks into a ChartDefinition.
// Composition rules (single heatmap/pie, radar-only overlays) are encoded in
// the types here and enforced at runtime by ./validate.

import type { ChartMark, HeatmapChartMark, PieChartMark, RadarChartMark } from "./marks";
import type { BandScaleSpec, ChartDefinition, ChartSpec, HeatmapYScaleSpec, XScaleSpec, YScaleSpec } from "./types";

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
