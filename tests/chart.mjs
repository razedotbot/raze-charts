import { defineChart, line, bar, area, point, ruleY, pie, radar, heatmap, compileChart, renderChartSvg, scaleLinear, scaleBand, scaleLog, scaleTime, hitTestCompiled } from "../dist/chart.esm.js";

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

console.log(process.exitCode ? "\nCHART: FAIL" : "\nCHART: PASS");
