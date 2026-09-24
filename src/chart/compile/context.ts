// Shared state handed to every mark compiler: resolved layout, scales,
// formatters, and the scene being accumulated.

import type { AnyScale } from "../scales";
import type { DashboardTheme } from "../theme";
import type { AxisFormatters } from "./format";
import type { LegendRowInput } from "./legend";
import type { RuleYChartMark, XYChartMark } from "./marks";
import { asNumber, readChannel } from "./shared";
import type {
  ChartSpec,
  HoverSample,
  LastValue,
  PlotRect,
  SceneNode,
  XScaleKind,
} from "./types";

/** Scene output accumulated in mark order (flattened onto the mark context). */
export interface SceneOutput {
  nodes: SceneNode[];
  /** Rows in mark order; the pipeline stamps series ids onto plugin rows. */
  legend: LegendRowInput[];
  lastValues: LastValue[];
  samples: HoverSample[];
  /** Valid line/area points omitted by extrema decimation. */
  decimatedPoints: number;
  colorBar: { min: number; max: number } | null;
}

export interface MarkCompileContext extends AxisFormatters, SceneOutput {
  spec: ChartSpec;
  width: number;
  height: number;
  plot: PlotRect;
  theme: DashboardTheme;
  xScale: AnyScale;
  yScale: AnyScale;
  xType: XScaleKind;
  /** Map a row's x channel through the X scale. */
  mapX(row: unknown, mark: XYChartMark): number;
  /** Map a row's y channel through the Y scale. */
  mapY(row: unknown, mark: XYChartMark | RuleYChartMark): number;
  /** Map a raw x value through the X scale. */
  mapXValue(raw: unknown): number;
  /** Map a raw y value through the Y scale. */
  mapYValue(raw: unknown): number;
}

export type MarkCompileContextInput = Omit<MarkCompileContext, keyof SceneOutput | "mapX" | "mapY" | "mapXValue" | "mapYValue">;

/** Context with an empty scene; mark compilers append to it in mark order. */
export function createMarkContext(input: MarkCompileContextInput): MarkCompileContext {
  const { xScale, yScale } = input;
  return {
    ...input,
    nodes: [],
    legend: [],
    lastValues: [],
    samples: [],
    decimatedPoints: 0,
    colorBar: null,
    mapX: (row, m) => {
      const raw = readChannel(row as never, m.x as never);
      if (xScale.kind === "band") return xScale.map(raw as string);
      return xScale.map(asNumber(raw));
    },
    mapY: (row, m) => {
      const raw = readChannel(row as never, m.y as never);
      if (yScale.kind === "band") return yScale.map(raw as string);
      return yScale.map(asNumber(raw));
    },
    mapXValue: (raw) => {
      if (xScale.kind === "band") return xScale.map(raw as string);
      return xScale.map(asNumber(raw));
    },
    mapYValue: (raw) => {
      if (yScale.kind === "band") return yScale.map(raw as string);
      return yScale.map(asNumber(raw));
    },
  };
}
