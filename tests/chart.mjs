import { defineChart, defineMarkPlugin, customMark, line, bar, area, point, ruleY, pie, radar, heatmap, compileChart, renderChartSvg, scaleLinear, scaleBand, scaleLog, scaleTime, hitTestCompiled } from "../dist/chart.esm.js";

const assert = (cond, msg) => {
  if (!cond) { console.error("✗ " + msg); process.exitCode = 1; }
  else console.log("✓ " + msg);
};

const lin = scaleLinear({ domain: [0, 10], range: [0, 100] });
assert(lin.map(5) === 50, "scaleLinear maps midpoint");
assert(Math.abs(lin.invert(50) - 5) < 1e-9, "scaleLinear invert");

const band = scaleBand({ domain: ["a", "b"], range: [0, 100], padding: 0.2 });
assert(band.domain.length === 2, "scaleBand domain");
assert(band.bandwidth() > 0, "scaleBand bandwidth");

const rows = [
  { month: "Jan", value: 10, other: 4 },
  { month: "Feb", value: 20, other: 8 },
  { month: "Mar", value: 15, other: 6 },
];

const def = defineChart({
  marks: [
    bar(rows, { x: "month", y: "value", fill: "#2563eb", name: "Sales" }),
    line(rows, { x: "month", y: "other", stroke: "#16a34a", name: "Other" }),
    ruleY([12], { stroke: "#dc2626" }),
  ],
  ariaLabel: "Sales",
});
const compiled = compileChart(def, { width: 640, height: 320 });
assert(compiled.nodes.some((n) => n.type === "rect"), "bar marks emit rects");
assert(compiled.nodes.some((n) => n.type === "line"), "line marks emit polylines");
assert(compiled.nodes.some((n) => n.type === "rule"), "ruleY emits a reference line");
assert(compiled.xTicks.length >= 3, "categorical x ticks");
assert(compiled.legend.some((l) => l.name === "Sales"), "legend includes series name");

const svg = renderChartSvg(def, { width: 640, height: 320 });
assert(svg.startsWith("<svg"), "renderChartSvg returns svg");
assert(svg.includes("aria-label=\"Sales\""), "svg has aria-label");
assert(svg.includes("<rect"), "svg contains bars");
assert(svg.includes("<path"), "svg contains series paths");
assert(svg.includes("#181615"), "dark pane matches the trading widget");

const stacked = defineChart({
  marks: [
    bar(rows, { x: "month", y: "value", stackId: "s", name: "A" }),
    bar(rows, { x: "month", y: "other", stackId: "s", name: "B" }),
  ],
});
const sc = compileChart(stacked, { width: 400, height: 200 });
assert(sc.nodes.filter((n) => n.type === "rect").length === 6, "stacked bars emit one rect per row per series");

const pieDef = defineChart({
  marks: [pie([{ name: "A", value: 30 }, { name: "B", value: 70 }], { valueKey: "value", labelKey: "name" })],
});
const pc = compileChart(pieDef, { width: 320, height: 320 });
assert(pc.polar && pc.nodes.some((n) => n.type === "arc"), "pie compiles to polar arcs");
assert(pc.legendPlacement === "right", "pie legend sits on the right");
assert(pc.legend.some((l) => l.detail), "pie legend includes percent detail");

const areaDef = defineChart({
  marks: [area(rows, { x: "month", y: "value" }), point(rows, { x: "month", y: "value" })],
});
const ac = compileChart(areaDef, { width: 400, height: 200 });
assert(ac.nodes.some((n) => n.type === "area") && ac.nodes.some((n) => n.type === "circle"), "area + points");

const rect = sc.nodes.find((n) => n.type === "rect");
assert(rect && hitTestCompiled(sc, rect.x + 1, rect.y + 1)?.type === "rect", "hitTestCompiled finds a stacked bar");

const timed = scaleTime({ domain: [0, 1000], range: [0, 100] });
assert(Math.abs(timed.map(500) - 50) < 1e-9, "scaleTime maps midpoint");
const logged = scaleLog({ domain: [1, 100], range: [0, 2] });
assert(Math.abs(logged.map(10) - 1) < 1e-9, "scaleLog maps 10 to midpoint of 1..100");

const radarDef = defineChart({
  marks: [radar([{ name: "A", value: 3 }, { name: "B", value: 5 }, { name: "C", value: 4 }], { x: "name", y: "value" })],
});
const rc = compileChart(radarDef, { width: 240, height: 240 });
assert(rc.polar && rc.nodes.some((n) => n.type === "polygon"), "radar compiles to a polygon");

const heatRows = [
  { x: "5m", y: "SOL", value: 2.4 },
  { x: "1h", y: "SOL", value: -1.1 },
  { x: "5m", y: "ETH", value: 0.6 },
  { x: "1h", y: "ETH", value: 3.2 },
];
const heatDef = defineChart({
  marks: [heatmap(heatRows, { x: "x", y: "y", valueKey: "value" })],
});
const hc = compileChart(heatDef, { width: 400, height: 200 });
assert(hc.heatmap && hc.nodes.filter((n) => n.type === "rect").length === 4, "heatmap emits a cell per row");
assert(hc.colorBar && hc.colorBar.min < 0 && hc.colorBar.max > 0, "heatmap diverging color bar");
assert(hc.yScale.kind === "band" && hc.xScale.kind === "band", "heatmap uses band scales");
const heatCell = hc.nodes.find((n) => n.type === "rect");
assert(heatCell && Math.abs((heatCell.w ?? 0) - (heatCell.h ?? 0)) <= 1, "heatmap cells are square");
const heatSvg = renderChartSvg(heatDef, { width: 400, height: 200 });
assert(heatSvg.includes("<rect"), "heatmap svg has cells");
assert(heatSvg.includes("+2.4"), "heatmap labels are signed");
const heatHit = hc.nodes.find((n) => n.type === "rect" && n.tip);
assert(heatHit && heatHit.tip.includes("%"), "heatmap tooltip includes percent");

const fitDef = defineChart({
  marks: [line([{ x: 0, y: 1 }, { x: 2, y: 3 }], { x: "x", y: "y", dashed: true, lastValue: false, name: "Fit" })],
});
const fc = compileChart(fitDef, { width: 200, height: 120 });
assert(fc.lastValues.length === 0, "dashed fit line skips last-value chips");
assert(fc.nodes.some((n) => n.type === "line" && n.dashed), "dashed line flag reaches the scene");

const lollipop = defineMarkPlugin({
  kind: "lollipop",
  domain: (data) => ({ x: data.map((d) => d.month), y: data.map((d) => d.value), includeZero: true }),
  compile: ({ data, mapX, mapY, color }) => ({
    nodes: data.flatMap((d) => {
      const x = mapX(d.month);
      const y = mapY(d.value);
      return [
        { type: "rule", x, y, x2: x, y2: mapY(0), stroke: color, dashed: false, hit: false },
        { type: "circle", x, y, r: 4, fill: color, datum: d, tip: `${d.month}\n${d.value}`, role: "lollipop" },
      ];
    }),
  }),
});
const pluginDef = defineChart({
  marks: [customMark(lollipop, rows, {})],
  ariaLabel: "Plugin chart",
  ariaDescription: "A custom lollipop series.",
});
const pluginChart = compileChart(pluginDef, { width: 400, height: 220 });
assert(pluginChart.nodes.filter((n) => n.role === "lollipop").length === rows.length, "custom mark plugin emits renderer-neutral nodes");
assert(pluginChart.yScale.map(0) <= pluginChart.plot.y + pluginChart.plot.h + 1, "custom mark contributes an inferred domain");
const pluginSvg = renderChartSvg(pluginDef, { width: 400, height: 220 }, { idPrefix: "plugin-test" });
assert(pluginSvg.includes('aria-describedby="raze-description-plugin-test"'), "SVG links its accessible description");
assert(pluginSvg.includes("A custom lollipop series."), "SVG includes its accessible description");
assert(pluginSvg === renderChartSvg(pluginDef, { width: 400, height: 220 }, { idPrefix: "plugin-test" }), "stable SVG id prefix produces deterministic output");

const denseRows = Array.from({ length: 10_000 }, (_, index) => ({
  x: index,
  y: index === 4_321 ? 10_000 : Math.sin(index / 20),
}));
const dense = compileChart(defineChart({
  marks: [line(denseRows, { x: "x", y: "y" })],
  performance: { maxRenderedPoints: 128 },
}), { width: 320, height: 180 });
const densePath = dense.nodes.find((node) => node.type === "line");
assert((densePath?.points?.length ?? Infinity) <= 128, "dense line geometry respects the render budget");
assert(dense.diagnostics.decimatedPoints > 9_800, "compiled diagnostics report automatic decimation");
assert(densePath?.points?.some((point) => point.y === dense.yScale.map(10_000)), "extrema decimation preserves a narrow spike");

const exact = compileChart(defineChart({
  marks: [line(denseRows, { x: "x", y: "y" })],
  performance: { decimation: "none" },
}), { width: 320, height: 180 });
assert(exact.nodes.find((node) => node.type === "line")?.points?.length === denseRows.length, "decimation has an explicit exact-geometry opt-out");
assert(exact.diagnostics.decimatedPoints === 0, "exact geometry reports zero decimated points");

const withGap = compileChart(defineChart({
  marks: [line([
    { x: 0, y: 1 },
    { x: 1, y: 2 },
    { x: 2, y: Number.NaN },
    { x: 3, y: 4 },
    { x: 4, y: 5 },
  ], { x: "x", y: "y" })],
}), { width: 320, height: 180 });
assert(withGap.nodes.filter((node) => node.type === "line").length === 2, "invalid values create truthful line gaps instead of invented connections");

const fragmentedRows = [];
for (let segment = 0; segment < 100; segment += 1) {
  for (let point = 0; point < 100; point += 1) {
    fragmentedRows.push({ x: fragmentedRows.length, y: Math.sin(point) + segment });
  }
  fragmentedRows.push({ x: fragmentedRows.length, y: Number.NaN });
}
const fragmented = compileChart(defineChart({
  marks: [line(fragmentedRows, { x: "x", y: "y" })],
  performance: { maxRenderedPoints: 128 },
}), { width: 320, height: 180 });
const fragmentedPointCount = fragmented.nodes
  .filter((node) => node.type === "line")
  .reduce((total, node) => total + (node.points?.length ?? 0), 0);
assert(fragmentedPointCount <= 128, "dense gapped series honor a global per-series point budget");

const isolatedSpikeRows = [];
for (let segment = 0; segment < 100; segment += 1) {
  isolatedSpikeRows.push({ x: segment * 2, y: segment === 50 ? 10_000 : 1 });
  isolatedSpikeRows.push({ x: segment * 2 + 1, y: Number.NaN });
}
const isolatedSpike = compileChart(defineChart({
  marks: [line(isolatedSpikeRows, { x: "x", y: "y" })],
  performance: { maxRenderedPoints: 16 },
}), { width: 320, height: 180 });
assert(
  isolatedSpike.nodes.some((node) => node.type === "circle" && node.y === isolatedSpike.yScale.map(10_000)),
  "segment selection keeps extrema that define the full-data domain",
);

const internalSpikeRows = [];
for (let segment = 0; segment < 100; segment += 1) {
  for (let point = 0; point < 100; point += 1) {
    internalSpikeRows.push({
      x: internalSpikeRows.length,
      y: segment === 50 && point === 50 ? 20_000 : segment + point / 100,
    });
  }
  internalSpikeRows.push({ x: internalSpikeRows.length, y: Number.NaN });
}
const internalSpike = compileChart(defineChart({
  marks: [line(internalSpikeRows, { x: "x", y: "y" })],
  performance: { maxRenderedPoints: 16 },
}), { width: 320, height: 180 });
assert(
  internalSpike.nodes.some((node) => node.type === "line" && node.points?.some((point) => point.y === internalSpike.yScale.map(20_000))),
  "tight multi-gap budgets preserve extrema inside retained segments",
);

const lastValueRows = [];
for (let segment = 0; segment < 100; segment += 1) {
  const values = segment === 50
    ? [2, 2, 20_000, 2, 2]
    : segment === 99
      ? [5, 1, 4, 2, 3]
      : [2, 2, 2, 2, 2];
  for (const y of values) lastValueRows.push({ x: lastValueRows.length, y });
  lastValueRows.push({ x: lastValueRows.length, y: Number.NaN });
}
const lastValueChart = compileChart(defineChart({
  marks: [line(lastValueRows, { x: "x", y: "y" })],
  performance: { maxRenderedPoints: 16 },
}), { width: 320, height: 180 });
const lastValidRow = lastValueRows[lastValueRows.length - 2];
const endpoint = lastValueChart.nodes.find((node) => node.role === "endpoint");
assert(lastValueChart.lastValues[0]?.label === "3", "last-value label always uses the final valid source sample");
assert(endpoint?.x === lastValueChart.xScale.map(lastValidRow.x), "last-value endpoint stays anchored to the source tail after decimation");
assert(
  lastValueChart.samples.some((sample) => sample.x === lastValueChart.xScale.map(lastValidRow.x)),
  "the true source tail remains connected and hoverable after decimation",
);

for (const cap of [1, 15, 16]) {
  const capped = compileChart(defineChart({
    marks: [line(denseRows, { x: "x", y: "y" })],
    performance: { maxRenderedPoints: cap },
  }), { width: 320, height: 180 });
  const rendered = capped.nodes
    .filter((node) => node.type === "line")
    .reduce((total, node) => total + (node.points?.length ?? 0), 0);
  assert(rendered <= cap, `maxRenderedPoints=${cap} is honored as a hard cap`);
}

const singletonRows = Array.from({ length: 17 }, (_, index) => [
  { x: index * 2, y: index },
  { x: index * 2 + 1, y: Number.NaN },
]).flat();
const singletonChart = compileChart(defineChart({
  marks: [line(singletonRows, { x: "x", y: "y" })],
  performance: { maxRenderedPoints: 16 },
}), { width: 320, height: 180 });
const singletonRendered = singletonChart.nodes
  .filter((node) => node.type === "line")
  .reduce((total, node) => total + (node.points?.length ?? 0), 0);
assert(singletonRendered === 16, "fragmented singleton data uses the available budget without overshooting it");

const finalExtremeChart = compileChart(defineChart({
  marks: [line([
    { x: 0, y: -1 }, { x: 1, y: -0.5 }, { x: 2, y: Number.NaN },
    { x: 3, y: 0 }, { x: 4, y: 100 }, { x: 5, y: 60 },
  ], { x: "x", y: "y" })],
  performance: { maxRenderedPoints: 4 },
}), { width: 320, height: 180 });
assert(
  finalExtremeChart.nodes.some((node) => node.type === "line" && node.points?.some((p) => p.y === finalExtremeChart.yScale.map(100))),
  "a final segment retains its global extremum as well as the true tail",
);

const narrowDefault = compileChart(defineChart({ marks: [line(denseRows, { x: "x", y: "y" })] }), {
  width: 80,
  height: 180,
});
const narrowRendered = narrowDefault.nodes
  .filter((node) => node.type === "line")
  .reduce((total, node) => total + (node.points?.length ?? 0), 0);
assert(narrowRendered <= Math.max(1, Math.floor(narrowDefault.plot.w * 2)), "the automatic budget is exactly pixel-aware on narrow plots");

for (const invalidBudget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  let budgetError;
  try {
    compileChart(defineChart({
      marks: [line(rows, { x: "month", y: "value" })],
      performance: { maxRenderedPoints: invalidBudget },
    }), { width: 320, height: 180 });
  } catch (error) {
    budgetError = error;
  }
  assert(budgetError?.code === "E_CHART_PERFORMANCE", `invalid render budget ${String(invalidBudget)} has a stable error code`);
}

let unsupportedChannelError;
try {
  compileChart(defineChart({
    marks: [{ kind: "area", data: rows, x: "month", y: "value", y0: "other" }],
  }), { width: 320, height: 180 });
} catch (error) {
  unsupportedChannelError = error;
}
assert(unsupportedChannelError?.code === "E_MARK_CHANNEL", "unsupported mark channels fail explicitly instead of rendering misleading geometry");

let reservedKindError;
try {
  defineMarkPlugin({ kind: "line", compile: () => ({ nodes: [] }) });
} catch (error) {
  reservedKindError = error;
}
assert(reservedKindError?.code === "E_MARK_PLUGIN_KIND", "custom plugins cannot collide with built-in mark semantics");

let pluginBypassError;
try {
  compileChart(defineChart({
    marks: [{
      kind: "line",
      data: rows,
      x: "month",
      y: "value",
      plugin: { kind: "line", compile: () => ({ nodes: [] }) },
      pluginOptions: {},
    }],
  }), { width: 320, height: 180 });
} catch (error) {
  pluginBypassError = error;
}
assert(pluginBypassError?.code === "E_MARK_PLUGIN_KIND", "manual marks cannot bypass reserved plugin kinds");

let invalidKindError;
try {
  compileChart(defineChart({ marks: [{ kind: "mystery", data: [] }] }), { width: 320, height: 180 });
} catch (error) {
  invalidKindError = error;
}
assert(invalidKindError?.code === "E_MARK_KIND", "dynamic unknown mark kinds fail with a stable actionable error");

let invalidSizeError;
try {
  compileChart(def, { width: 0, height: 180 });
} catch (error) {
  invalidSizeError = error;
}
assert(invalidSizeError?.code === "E_CHART_SIZE", "invalid runtime dimensions fail with a stable actionable error");

console.log(process.exitCode ? "\nCHART: FAIL" : "\nCHART: PASS");
