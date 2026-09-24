import assert from "node:assert/strict";
import {
  ChartCompileError,
  bar,
  compileChart,
  customMark,
  defineChart,
  defineMarkPlugin,
  heatmap,
  line,
  pie,
  point,
  radar,
  scaleBand,
  scaleLinear,
  scaleLog,
  svgFromCompiled,
} from "../dist/chart.esm.js";

function compile(marks, extra = {}, size = { width: 600, height: 400 }) {
  return compileChart(defineChart({ marks, ...extra }), size);
}

function expectCode(fn, code, label) {
  assert.throws(fn, (error) => error instanceof ChartCompileError && error.code === code, label);
}

const descending = scaleBand({ domain: ["A", "B"], range: [100, 0], padding: 0.2 });
assert.equal(descending.bandwidth(), 40, "bandwidth supports descending ranges");
assert.ok(descending.map("A") > descending.map("B"), "descending band positions preserve domain order");
assert.ok(Number.isNaN(descending.map("missing")), "unknown bands never alias the first category");

const descendingLinear = scaleLinear({ domain: [9.8, 0.3], range: [0, 100], nice: true });
assert.ok(descendingLinear.domain[0] >= 9.8 && descendingLinear.domain[1] <= 0.3, "nice preserves descending-domain coverage");
assert.ok(descendingLinear.map(9.8) >= 0 && descendingLinear.map(9.8) <= 100, "descending nice keeps the high endpoint in range");
assert.ok(descendingLinear.map(0.3) >= 0 && descendingLinear.map(0.3) <= 100, "descending nice keeps the low endpoint in range");

const tinyLog = scaleLog({ domain: [1e-20, 1e-10], range: [0, 100] });
assert.ok(Math.abs(tinyLog.map(1e-20)) < 1e-9, "log scales preserve positive magnitudes below 1e-12");
assert.ok(Math.abs(tinyLog.map(1e-10) - 100) < 1e-9, "tiny log domains retain distinct endpoints");
assert.ok(Number.isNaN(tinyLog.map(0)), "log scales reject non-positive samples instead of collapsing them");

const typedCategories = compile([
  point([{ x: 1, y: 1 }, { x: "1", y: 2 }], { x: "x", y: "y" }),
], { scales: { x: { type: "band" } } });
assert.deepEqual(typedCategories.xScale.domain, [1, "1"], "band inference distinguishes number 1 from string 1");

for (const makeMark of [
  () => point([{ x: "A", y: 1 }, { x: "C", y: 2 }], { x: "x", y: "y" }),
  () => bar([{ x: "A", y: 1 }, { x: "C", y: 2 }], { x: "x", y: "y" }),
]) {
  expectCode(
    () => compile([makeMark()], { scales: { x: { type: "band", domain: ["A", "B"] } } }),
    "E_SCALE_DOMAIN",
    "explicit band domains reject omitted data categories",
  );
}
expectCode(
  () => compile([
    heatmap([{ x: "C", y: "row", z: 1 }], { x: "x", y: "y", valueKey: "z" }),
  ], { scales: { x: { type: "band", domain: ["A", "B"] }, y: { type: "band", domain: ["row"] } } }),
  "E_SCALE_DOMAIN",
  "heatmaps reject categories missing from an explicit domain",
);

const sparseHeatmap = compile([
  heatmap([{ x: "x0", y: "y0", z: 1 }], { x: "x", y: "y", valueKey: "z" }),
], {
  scales: {
    x: { type: "band", domain: Array.from({ length: 10 }, (_, i) => `x${i}`) },
    y: { type: "band", domain: Array.from({ length: 5 }, (_, i) => `y${i}`) },
  },
});
const sparseCell = sparseHeatmap.nodes.find((node) => node.type === "rect");
assert.equal(sparseHeatmap.xScale.domain.length, 10, "heatmap layout honors the configured X domain");
assert.equal(sparseHeatmap.yScale.domain.length, 5, "heatmap layout honors the configured Y domain");
assert.ok(sparseCell && Math.abs(sparseCell.w - sparseCell.h) <= 1, "sparse heatmap cells remain square");

for (const x of [5, -5]) {
  const singleton = compile([bar([{ x, y: 2 }], { x: "x", y: "y" })]);
  const rect = singleton.nodes.find((node) => node.type === "rect");
  assert.ok(rect, `single numeric bar ${x} renders`);
  assert.ok(rect.x >= singleton.plot.x && rect.x + rect.w <= singleton.plot.x + singleton.plot.w, `single numeric bar ${x} stays in plot`);
  assert.ok(Math.abs(rect.x + rect.w / 2 - (singleton.plot.x + singleton.plot.w / 2)) <= 1, `single numeric bar ${x} is centered`);
}

const normalizedStack = compile([
  bar([{ x: 1, y: 10 }], { x: "x", y: "y", stackId: "s", name: "number" }),
  bar([{ x: "1", y: 5 }], { x: "x", y: "y", stackId: "s", name: "numeric string" }),
]);
const normalizedRects = normalizedStack.nodes.filter((node) => node.type === "rect");
assert.equal(normalizedRects.length, 2);
assert.equal(normalizedRects[0].x, normalizedRects[1].x, "coincident quantitative coordinates share a stack slot");
assert.ok(Math.abs((normalizedRects[0].y) - (normalizedRects[1].y + normalizedRects[1].h)) <= 1, "numeric strings and numbers accumulate in one stack");

const epoch = 1_700_000_000_000;
const timeStack = compile([
  bar([{ x: new Date(epoch), y: 4 }], { x: "x", y: "y", stackId: "s" }),
  bar([{ x: epoch, y: 6 }], { x: "x", y: "y", stackId: "s" }),
], { scales: { x: { type: "time" } } });
const timeRects = timeStack.nodes.filter((node) => node.type === "rect");
assert.equal(timeRects[0].x, timeRects[1].x, "Date and epoch coordinates normalize into one time stack");

const diverging = compile([
  bar([{ x: "A", y: 7 }, { x: "B", y: -5 }], { x: "x", y: "y", stackId: "s" }),
  bar([{ x: "A", y: 3 }, { x: "B", y: -4 }], { x: "x", y: "y", stackId: "s" }),
]);
assert.ok(diverging.yScale.domain[0] <= -9 && diverging.yScale.domain[1] >= 10, "positive and negative stacks get independent truthful extents");

const groupedStacks = compile([
  bar([{ x: "A", y: 4 }], { x: "x", y: "y", stackId: "left" }),
  bar([{ x: "A", y: 3 }], { x: "x", y: "y", stackId: "right" }),
]);
const groupRects = groupedStacks.nodes.filter((node) => node.type === "rect");
assert.ok(groupRects[0].x + groupRects[0].w <= groupRects[1].x, "different stack IDs occupy separate group slots");

const emptyPie = compile([pie([], { valueKey: "value", labelKey: "name" })], { legend: false }, { width: 320, height: 240 });
assert.ok(emptyPie.nodes.some((node) => node.type === "text" && node.label === "No data"), "empty pies render a stable no-data state");
assert.equal(emptyPie.nodes.filter((node) => node.type === "arc").length, 0);
assert.equal(emptyPie.plot.x + emptyPie.plot.w / 2, 160, "legend-free empty pies remain centered");

const partialPie = compile([pie([
  { name: "A", value: 10 }, { name: "bad", value: Number.NaN }, { name: "B", value: 20 },
], { valueKey: "value", labelKey: "name" })], {}, { width: 420, height: 280 });
assert.equal(partialPie.nodes.filter((node) => node.type === "arc").length, 2, "non-finite pie values are represented as zero without corrupting arcs");
assert.ok(partialPie.nodes.every((node) => !JSON.stringify(node).includes("NaN")), "pie scene contains no NaN geometry");
for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
  expectCode(
    () => compile([pie([{ value: 1 }], { valueKey: "value", innerRadius: invalid })]),
    "E_MARK_CHANNEL",
    "invalid pie radii fail before rendering",
  );
}
expectCode(
  () => compile([pie([{ value: 1 }], { valueKey: "value", innerRadius: 20, outerRadius: 10 })]),
  "E_MARK_CHANNEL",
  "inverted pie radii fail before rendering",
);

expectCode(
  () => compile([radar([{ axis: "A", value: -1 }, { axis: "B", value: 1 }, { axis: "C", value: 1 }], { x: "axis", y: "value" })]),
  "E_MARK_DATA",
  "negative radar values fail instead of reversing an axis",
);
const multiRadar = compile([
  radar([{ axis: "A", value: 1 }, { axis: "B", value: 2 }, { axis: "C", value: 3 }], { x: "axis", y: "value", name: "one" }),
  radar([{ axis: "A", value: 2 }, { axis: "B", value: 1 }, { axis: "C", value: 2 }], { x: "axis", y: "value", name: "two" }),
]);
assert.equal(multiRadar.legendPlacement, "top", "multi-radar series expose their legend");
assert.equal(multiRadar.legend.length, 2);
expectCode(
  () => compile([radar([{ axis: "A", value: 1 }, { axis: "B", value: 1 }, { axis: "C", value: 1 }], { x: "axis", y: "value" })], { scales: { y: { type: "linear" } } }),
  "E_SCALE_TYPE",
  "polar charts reject ignored Cartesian scale options",
);

const dashed = compile([line([{ x: 0, y: 1 }, { x: 1, y: 2 }], { x: "x", y: "y", dashed: true })]);
assert.equal(dashed.samples.length, 2, "dashed is presentation only and preserves hover samples");
assert.equal(dashed.lastValues.length, 1, "dashed is presentation only and preserves last values");
assert.ok(dashed.nodes.some((node) => node.type === "line" && node.dashed && node.role === "line"));

const negativeBars = compile([bar([{ x: "negative", y: -5 }, { x: "positive", y: 3 }], { x: "x", y: "y" })]);
const [negativeBar, positiveBar] = negativeBars.nodes.filter((node) => node.type === "rect" && node.role === "bar");
assert.equal(negativeBar.corner, "bottom", "negative bars round their outer edge, not the zero baseline");
assert.ok(Math.abs(negativeBar.valueY - (negativeBar.y + negativeBar.h)) <= 1, "negative-bar interaction anchors to its value endpoint");
assert.equal(positiveBar.corner, "top", "positive bars keep the upper outer edge rounded");
assert.ok(Math.abs(positiveBar.valueY - positiveBar.y) <= 1, "positive-bar interaction anchors to its value endpoint");

const nullGap = compile([line([null, { x: 1, y: 2 }], { x: "x", y: "y" })]);
assert.ok(!JSON.stringify(nullGap).includes("NaN"), "null rows become truthful gaps instead of leaking invalid geometry");
assert.ok(!svgFromCompiled(nullGap).includes("NaN"), "null rows cannot leak NaN into SVG output");

for (const [extra, code, label] of [
  [{ margin: { left: Number.NaN } }, "E_CHART_SIZE", "non-finite margins"],
  [{ scales: "oops" }, "E_SCALE_TYPE", "invalid scale containers"],
  [{ scales: { x: null } }, "E_SCALE_TYPE", "null scale definitions"],
  [{ grid: "yes" }, "E_CHART_SPEC", "non-boolean chart toggles"],
  [{ theme: { background: 42 } }, "E_CHART_SPEC", "invalid theme tokens"],
  [{ performance: "fast" }, "E_CHART_PERFORMANCE", "invalid performance containers"],
  [{ mystery: true }, "E_CHART_SPEC", "unknown chart options"],
]) {
  expectCode(() => compile([line([{ x: 0, y: 1 }], { x: "x", y: "y" })], extra), code, `${label} fail at the definition boundary`);
}
expectCode(
  () => compileChart(defineChart({ marks: [] }), null),
  "E_CHART_SIZE",
  "invalid size containers fail before evaluating a definition",
);

const largeMetrics = compile([line([
  { x: 0, y: 1_000_000_000_000 },
  { x: 1, y: 1_200_000_000_000 },
], { x: "x", y: "y" })]);
assert.ok(largeMetrics.yTicks.every((tick) => !/[A-Z][a-z]{2}/.test(tick.label)), "large numeric metrics are never guessed to be dates");
assert.equal(largeMetrics.lastValues[0].label, "1.2T", "large last values use compact numeric formatting");

const epochTime = compile([line([
  { x: 0, y: 1 },
  { x: 2 * 86_400_000, y: 2 },
], { x: "x", y: "y" })], { scales: { x: { type: "time" } } });
assert.ok(epochTime.xTicks.some((tick) => tick.label.includes("Jan")), "time axes near 1970 format as dates by axis semantics");

const inferredDates = compile([line([
  { x: new Date(0), y: 1 },
  { x: new Date(2 * 86_400_000), y: 2 },
], { x: "x", y: "y" })]);
assert.ok(inferredDates.xTicks.some((tick) => tick.label.includes("Jan")), "Date objects infer a time axis without magnitude guessing");

const singletonLog = compile([line([{ x: 1, y: 100 }], { x: "x", y: "y" })], { scales: { y: { type: "log" } } });
assert.ok(singletonLog.yScale.domain[0] > 0 && singletonLog.yScale.domain[0] < 100, "singleton log domains expand multiplicatively below the value");
assert.ok(singletonLog.yScale.domain[1] > 100, "singleton log domains expand multiplicatively above the value");
assert.ok(singletonLog.yTicks.every((tick) => tick.label !== "0.00"), "log tick labels never collapse positive values to zero");

expectCode(
  () => compile([{ kind: "line", data: [{ x: 0, y: 1 }], x: "x", y: "y", innerRadius: 10 }]),
  "E_MARK_OPTION",
  "mark-inapplicable options never compile silently",
);

const badDomain = defineMarkPlugin({ kind: "bad-domain", domain: () => ({ x: 42 }), compile: () => ({ nodes: [] }) });
expectCode(() => compile([customMark(badDomain, [], {})]), "E_MARK_PLUGIN_DOMAIN", "invalid plugin domains have a stable code");

for (const [kind, result] of [
  ["bad-legend", { nodes: [], legend: {} }],
  ["null-node", { nodes: [null] }],
  ["bad-rect", { nodes: [{ type: "rect" }] }],
]) {
  const plugin = defineMarkPlugin({ kind, compile: () => result });
  expectCode(() => compile([customMark(plugin, [], {})]), "E_MARK_PLUGIN_RESULT", `${kind} fails at the plugin boundary`);
}

for (const [kind, result] of [
  ["bad-fill", { nodes: [{ type: "circle", x: 1, y: 1, r: 2, fill: 42 }] }],
  ["bad-opacity", { nodes: [{ type: "circle", x: 1, y: 1, r: 2, fillOpacity: 2 }] }],
  ["bad-size", { nodes: [{ type: "rect", x: 1, y: 1, w: -2, h: 3 }] }],
  ["bad-corner", { nodes: [{ type: "rect", x: 1, y: 1, w: 2, h: 3, corner: "sideways" }] }],
  ["bad-boolean", { nodes: [{ type: "circle", x: 1, y: 1, r: 2, dashed: "yes" }] }],
  ["bad-detail", { nodes: [], legend: [{ name: "x", color: "red", detail: 42 }] }],
]) {
  const plugin = defineMarkPlugin({ kind, compile: () => result });
  expectCode(() => compile([customMark(plugin, [], {})]), "E_MARK_PLUGIN_RESULT", `${kind} optional fields fail before a renderer can crash`);
}

const denseRows = Array.from({ length: 150_000 }, (_, x) => ({ x, y: Math.sin(x / 100) }));
const denseScene = compile([line(denseRows, { x: "x", y: "y", lastValue: false })], { legend: false, grid: false });
assert.equal(denseScene.diagnostics.sourceRows, denseRows.length, "large numeric domains compile without argument-stack overflow");

console.log("[raze-charts] chart edge-case regressions passed");
