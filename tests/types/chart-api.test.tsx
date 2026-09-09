import {
  area,
  bar,
  customMark,
  defineChart,
  defineMarkPlugin,
  heatmap,
  line,
  pie,
  point,
  radar,
  ruleX,
  ruleY,
  type ChartMark,
  type SceneNode,
} from "../../src/chart";
import { ResponsiveContainer, createChartComponents } from "../../src/react";
import type { IChartWidgetApi, TradingLineEvent } from "../../src";

interface Datum {
  date: Date;
  close: number;
  volume: number;
}

const data: readonly Datum[] = [
  { date: new Date("2026-01-01T00:00:00Z"), close: 42, volume: 100 },
];

if (false) {
  const financialApi = null as unknown as IChartWidgetApi;
  void financialApi.createOrderLine({ side: "buy", price: 42, quantity: 3 }).then((order) => {
    order
      .setText("Limit")
      .setLineStyle(2)
      .onMoving((line) => line.getPrice())
      .onMove((line) => line.getQuantity())
      .onCancel((line) => line.remove());
  });
  void financialApi.createBracketOrder({
    side: "buy",
    entryPrice: 42,
    stopLossPrice: 40,
    takeProfitPrice: 46,
    onChange: (bracket, event: TradingLineEvent) => {
      bracket.riskRewardRatio?.toFixed(2);
      event.line.price.toFixed(2);
    },
  }).then((bracket) => bracket.stopLoss?.setPrice(39));

  // @ts-expect-error Trading side is intentionally a closed semantic union.
  financialApi.createPositionLine({ side: "long", price: 42 });
}

line(data, { x: "date", y: "close" });
line(data, { x: (row) => row.date, y: (row) => row.close });
const literalLineKind: "line" = line(data, { x: "date", y: "close" }).kind;
void literalLineKind;

pie(data, { valueKey: (row) => row.close, labelKey: (row) => row.date });
heatmap(data, { x: "date", y: "volume", valueKey: (row) => row.close });

// @ts-expect-error Pie values never come from an invented "value" property.
pie(data, {});

// @ts-expect-error Heatmap values require an explicit datum channel.
heatmap(data, { x: "date", y: "volume" });

// @ts-expect-error Unsupported channels are not accepted silently.
line(data, { x: "date", y: "close", y0: "volume" });

area(data, { x: "date", y: "close", y0: "volume", curve: "step" });
ruleX([data[0]!.date]);

// @ts-expect-error Line does not silently accept area/bar/point presentation.
line(data, { x: "date", y: "close", fill: "red", stackId: "s", r: 4, fade: true });

// @ts-expect-error Area does not accept bar stacking.
area(data, { x: "date", y: "close", stackId: "s" });

// @ts-expect-error Bar does not accept line stroke width.
bar(data, { x: "date", y: "close", strokeWidth: 2 });

// @ts-expect-error Point does not accept pie radii.
point(data, { x: "date", y: "close", innerRadius: 12 });

// @ts-expect-error Pie does not accept ignored stroke styling.
pie(data, { valueKey: "close", stroke: "red" });

// @ts-expect-error Radar does not accept point radius.
radar(data, { x: "date", y: "close", r: 4 });

// @ts-expect-error Heatmap colours are derived from values.
heatmap(data, { x: "date", y: "volume", valueKey: "close", fill: "red" });

// @ts-expect-error Rules do not accept area fill opacity.
ruleY([1], { fillOpacity: 0.2 });

// @ts-expect-error Built-in builders cannot be repurposed as custom plugin marks.
line(data, { x: "date", y: "close", plugin: { kind: "line", compile: () => ({ nodes: [] }) } });

// @ts-expect-error Unknown fields must be rejected by the framework-neutral DSL.
line(data, { x: "timestamp", y: "close" });

// @ts-expect-error Unknown fields must be rejected for every encoded channel.
line(data, { x: "date", y: "price" });

const Lollipop = defineMarkPlugin<Datum, { baseline: number }>({
  kind: "lollipop",
  domain: (rows, options) => ({
    x: rows.map((row) => row.date),
    y: [...rows.map((row) => row.close), options.baseline],
  }),
  compile: () => ({ nodes: [] }),
});

customMark(Lollipop, data, { baseline: 0 });

// @ts-expect-error Plugin options are inferred and validated.
customMark(Lollipop, data, { base: 0 });

if (false) {
  // @ts-expect-error Typed factories require real default keys instead of inventing name/value fields.
  createChartComponents<Datum>();
}

const Typed = createChartComponents<Datum>({ xKey: "date", valueKey: "close" });

// @ts-expect-error Factory defaults are constrained to actual datum keys.
createChartComponents<Datum>({ xKey: "timestamp", valueKey: "close" });

// @ts-expect-error Heatmap defaults are constrained to actual datum keys too.
createChartComponents<Datum>({ xKey: "date", valueKey: "close", heatmapYKey: "bucket" });

// @ts-expect-error Unknown mark kinds require a plugin at the type boundary.
const typoMark: ChartMark = { kind: "typo", data };
void typoMark;

// @ts-expect-error The discriminated mark union rejects kind-inapplicable fields.
const malformedLine: ChartMark = { kind: "line", data, x: "date", y: "close", innerRadius: 10 };
void malformedLine;

// @ts-expect-error Configuring X opts into an explicit scale type; omit x entirely for inference.
defineChart({ marks: [line(data, { x: "date", y: "close" })], scales: { x: {} } });

// @ts-expect-error Cartesian Y axes cannot opt into the heatmap-only band scale.
defineChart({ marks: [line(data, { x: "date", y: "close" })], scales: { y: { type: "band" } } });

const matrix = [{ column: "A", row: "one", value: 1 }] as const;
defineChart({
  marks: [heatmap(matrix, { x: "column", y: "row", valueKey: "value" })],
  scales: { x: { type: "band" }, y: { type: "band" } },
});

// @ts-expect-error Polar and Cartesian coordinate systems cannot be mixed in one definition.
defineChart({ marks: [pie(data, { valueKey: "close" }), line(data, { x: "date", y: "close" })] });

// @ts-expect-error Scene primitives require geometry appropriate to their discriminant.
const incompleteNode: SceneNode = { type: "rect" };
void incompleteNode;
Typed.Line({ dataKey: "close" });
Typed.Area({ dataKey: "close", fill: "#123456", fillOpacity: 0.25 });
Typed.Bar({ dataKey: "volume", stackId: "volume", fade: true });
Typed.Scatter({ dataKey: "close", r: 3 });
Typed.Pie({ dataKey: "close", innerRadius: 24, outerRadius: 48 });
Typed.Radar({ dataKey: "close", fillOpacity: 0.2 });
Typed.Heatmap({ dataKey: "close" });
Typed.XAxis({ dataKey: "date" });

// @ts-expect-error Line never accepts an ignored area fill.
Typed.Line({ dataKey: "close", fill: "red" });

// @ts-expect-error Area never accepts bar stacking props.
Typed.Area({ dataKey: "close", stackId: "totals" });

// @ts-expect-error Bar never accepts ignored line styling.
Typed.Bar({ dataKey: "close", strokeWidth: 2 });

// @ts-expect-error Scatter never accepts pie radii.
Typed.Scatter({ dataKey: "close", innerRadius: 12 });

// @ts-expect-error Pie never accepts ignored stroke styling.
Typed.Pie({ dataKey: "close", stroke: "red" });

// @ts-expect-error Radar never accepts point radius.
Typed.Radar({ dataKey: "close", r: 4 });

// @ts-expect-error Heatmap colors are derived from values and do not accept a static fill.
Typed.Heatmap({ dataKey: "close", fill: "red" });

// @ts-expect-error ReferenceLine cannot silently omit its only supported position.
Typed.ReferenceLine({});

// @ts-expect-error Typed React adapters reject unknown data keys.
Typed.Line({ dataKey: "price" });

// @ts-expect-error Typed axes reject unknown data keys.
Typed.XAxis({ dataKey: "timestamp" });

const typedChart = (
  <Typed.LineChart data={data} ariaLabel="Closing price">
    <Typed.XAxis dataKey="date" />
    <Typed.Line dataKey="close" />
    <Typed.Tooltip />
  </Typed.LineChart>
);

void typedChart;

const TypedFallback = createChartComponents<Datum>({ xKey: "date", valueKey: "close" });
const typedFallbackChart = <TypedFallback.LineChart data={data} />;
void typedFallbackChart;

const responsiveChart = (
  <ResponsiveContainer width="100%" height={240}>
    <Typed.LineChart data={data} />
  </ResponsiveContainer>
);
void responsiveChart;

const invalidHostStyle = (
  // @ts-expect-error Width is a chart sizing prop, never an independently divergent CSS style.
  <Typed.LineChart data={data} style={{ width: 480 }} />
);
void invalidHostStyle;

const invalidResponsiveStyle = (
  <ResponsiveContainer
    width="100%"
    height={240}
    // @ts-expect-error ResponsiveContainer sizing/position styles are implementation-owned.
    style={{ position: "absolute" }}
  >
    <Typed.LineChart data={data} />
  </ResponsiveContainer>
);
void invalidResponsiveStyle;

const readyContract = (
  <Typed.LineChart
    data={data}
    onReady={(chart) => {
      chart.getScene();
      const snapshot = chart.getSnapshot();
      if (snapshot) {
        // @ts-expect-error Snapshots are deeply readonly.
        snapshot.width = 1;
        // @ts-expect-error Snapshot collections cannot mutate renderer state.
        snapshot.nodes.push({ type: "circle" });
        // @ts-expect-error Nested theme values are readonly too.
        snapshot.theme.background = "red";
      }
      // @ts-expect-error React owns teardown; its public handle cannot destroy the mount.
      chart.destroy();
    }}
  />
);
void readyContract;
