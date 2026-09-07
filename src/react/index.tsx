import {
  type CSSProperties,
  type ReactNode,
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  area,
  bar,
  defineChart,
  heatmap,
  line,
  mountChart,
  pie,
  point,
  radar,
  ruleY,
  type ChartDefinition,
  type ChartMark,
} from "../chart";

export interface ChartProps {
  definition: ChartDefinition;
  width?: number;
  height?: number;
  ariaLabel?: string;
  style?: CSSProperties;
}

export function Chart({ definition, width, height = 320, ariaLabel, style }: ChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const def = useMemo(() => {
    if (!ariaLabel) return definition;
    return defineChart((size) => ({ ...definition.spec(size), ariaLabel }));
  }, [definition, ariaLabel]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const handle = mountChart(el, def, { width, height });
    return () => handle.destroy();
  }, [def, width, height]);

  return (
    <div
      ref={host}
      style={{ width: width ? `${width}px` : "100%", height, ...style }}
    />
  );
}

type SeriesProps = {
  dataKey: string;
  name?: string;
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
  r?: number;
  stackId?: string;
  innerRadius?: number;
  outerRadius?: number;
};

function markProps(kind: ChartMark["kind"], props: SeriesProps): ChartMark {
  return {
    kind,
    data: [],
    y: props.dataKey,
    name: props.name ?? props.dataKey,
    stroke: props.stroke,
    fill: props.fill,
    strokeWidth: props.strokeWidth,
    r: props.r,
    stackId: props.stackId,
    innerRadius: props.innerRadius,
    outerRadius: props.outerRadius,
    valueKey: props.dataKey,
  };
}

export function Line(props: SeriesProps) { void props; return null; }
export function Bar(props: SeriesProps) { void props; return null; }
export function Area(props: SeriesProps) { void props; return null; }
export function Scatter(props: SeriesProps) { void props; return null; }
export function Pie(props: SeriesProps) { void props; return null; }
export function Radar(props: SeriesProps) { void props; return null; }
export function Heatmap(props: SeriesProps) { void props; return null; }
export function XAxis(props: { dataKey?: string }) { void props; return null; }
export function YAxis(props: { dataKey?: string } = {}) { void props; return null; }
export function CartesianGrid() { return null; }
export function Tooltip() { return null; }
export function Legend() { return null; }
export function ReferenceLine(props: { y?: number; stroke?: string }) { void props; return null; }
export function Brush() { return null; }

export function ResponsiveContainer({
  children,
  width = "100%",
  height = 320,
}: {
  children: ReactNode;
  width?: number | string;
  height?: number;
}) {
  return <div style={{ width, height, position: "relative" }}>{children}</div>;
}

function specFromJsx(
  kind: "line" | "bar" | "area" | "scatter" | "pie" | "radar" | "heatmap" | "composed",
  data: readonly Record<string, unknown>[],
  children: ReactNode,
  xDefault: string,
): ChartDefinition {
  let xKey = xDefault;
  let yKey = "value";
  let grid = true;
  const marks: ChartMark[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const t = child.type;
    const p = child.props as SeriesProps & { dataKey?: string; y?: number; stroke?: string };
    if (t === XAxis && p.dataKey) xKey = p.dataKey;
    if (t === YAxis && p.dataKey) yKey = p.dataKey;
    if (t === CartesianGrid) grid = true;
    if (t === Line) marks.push({ ...markProps("line", p), data, x: xKey });
    if (t === Area) marks.push({ ...markProps("area", p), data, x: xKey });
    if (t === Bar) marks.push({ ...markProps("bar", p), data, x: xKey });
    if (t === Scatter) marks.push({ ...markProps("point", p), data, x: xKey });
    if (t === Pie) marks.push({ ...markProps("pie", p), data, x: xKey, labelKey: xKey });
    if (t === Radar) marks.push({ ...markProps("radar", p), data, x: xKey });
    if (t === Heatmap) marks.push({ ...markProps("heatmap", p), data, x: xKey, y: yKey, valueKey: p.dataKey });
    if (t === ReferenceLine && typeof p.y === "number") {
      marks.push(ruleY([p.y], { stroke: p.stroke, name: "ref" }));
    }
  });
  if (!marks.length) {
    if (kind === "pie") marks.push(pie(data, { valueKey: "value", labelKey: xKey }));
    else if (kind === "bar") marks.push(bar(data, { x: xKey, y: "value" }));
    else if (kind === "area") marks.push(area(data, { x: xKey, y: "value" }));
    else if (kind === "scatter") marks.push(point(data, { x: xKey, y: "value" }));
    else if (kind === "radar") marks.push(radar(data, { x: xKey, y: "value" }));
    else if (kind === "heatmap") marks.push(heatmap(data, { x: xKey, y: yKey, valueKey: "value" }));
    else marks.push(line(data, { x: xKey, y: "value" }));
  }
  return defineChart({ marks, grid: kind === "heatmap" ? false : grid, tooltip: true, legend: true });
}

type BoxProps = {
  data: readonly Record<string, unknown>[];
  width?: number;
  height?: number;
  children?: ReactNode;
  ariaLabel?: string;
};

function JsxChart({ data, width, height = 320, children, ariaLabel, kind, x = "name" }: BoxProps & { kind: "line" | "bar" | "area" | "scatter" | "pie" | "radar" | "heatmap" | "composed"; x?: string }) {
  const definition = useMemo(() => specFromJsx(kind, data, children, x), [kind, data, children, x]);
  return <Chart definition={definition} width={width} height={height} ariaLabel={ariaLabel} />;
}

export function LineChart(props: BoxProps) { return <JsxChart kind="line" {...props} />; }
export function BarChart(props: BoxProps) { return <JsxChart kind="bar" {...props} />; }
export function AreaChart(props: BoxProps) { return <JsxChart kind="area" {...props} />; }
export function ScatterChart(props: BoxProps) { return <JsxChart kind="scatter" {...props} />; }
export function PieChart(props: BoxProps) { return <JsxChart kind="pie" {...props} />; }
export function RadarChart(props: BoxProps) { return <JsxChart kind="radar" {...props} />; }
export function HeatmapChart(props: BoxProps) { return <JsxChart kind="heatmap" x="x" {...props} />; }
export function ComposedChart(props: BoxProps) { return <JsxChart kind="composed" {...props} />; }

export { defineChart, line, area, bar, point, ruleY, pie, radar, heatmap, compileChart } from "../chart";
