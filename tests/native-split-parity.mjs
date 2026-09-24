#!/usr/bin/env node
// Native compiler/renderer parity harness.
//
// src/chart/defineChart.ts and src/chart/render.ts were split into
// src/chart/compile/* and src/chart/render/* without changing behaviour. This
// suite pins that contract: every fixture below is compiled and rendered
// through the public /chart bundle, and each facet (scene, SVG markup, Canvas
// command stream, hit tests, tooltips, mounted DOM and interaction callbacks,
// validation errors, and the runtime export surface) is compared with the
// checked-in snapshot in tests/fixtures/native-split-parity.json.
//
// The snapshot is byte-exact on purpose. A package that changes native output
// intentionally regenerates it and explains the change in review:
//
//   node build.mjs && node tests/native-split-parity.mjs --update
//
// Set RAZE_PARITY_DUMP=<dir> to write every facet's full text for diffing.
// The suite also enforces the module-size ceiling for the split directories.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = resolve(root, "tests/fixtures/native-split-parity.json");
const update = process.argv.includes("--update");
const dumpDir = process.env.RAZE_PARITY_DUMP ? resolve(process.env.RAZE_PARITY_DUMP) : null;
const MAX_MODULE_LINES = 700;

const chart = await import(pathToFileURL(resolve(root, "dist/chart.esm.js")).href);
const {
  area, bar, compileChart, customMark, defineChart, defineMarkPlugin, heatmap, hitTestCompiled, line,
  mountChart, paintChartCanvas, pie, point, radar, ruleX, ruleY, svgFromCompiled, tooltipText,
} = chart;

// ---------------------------------------------------------------------------
// Canonical, lossless serialization (insertion order, -0, NaN, undefined keys).

function isScale(value) {
  return value && typeof value === "object" && (value.kind === "linear" || value.kind === "band")
    && typeof value.map === "function";
}

function canon(value, stack = []) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    return Number.isFinite(value) ? String(value) : `#${String(value)}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "function") return "fn";
  if (typeof value === "bigint" || typeof value === "symbol") return String(value);
  if (value instanceof Date) return `Date(${Number.isNaN(value.getTime()) ? "invalid" : value.toISOString()})`;
  if (stack.includes(value)) throw new Error("parity fixtures must not contain cycles");
  const next = [...stack, value];
  if (isScale(value)) {
    const descriptor = { kind: value.kind, domain: [...value.domain], range: [...value.range] };
    if (value.kind === "band") {
      descriptor.padding = value.padding;
      descriptor.bandwidth = value.bandwidth();
      descriptor.starts = value.domain.map((entry) => value.start(entry));
    } else {
      descriptor.ticks = value.ticks();
    }
    return `Scale${canon(descriptor, next)}`;
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canon(entry, next)).join(",")}]`;
  if (value instanceof Map) return `Map${canon([...value.entries()], next)}`;
  if (value instanceof Set) return `Set${canon([...value.values()], next)}`;
  return `{${Object.keys(value).map((key) => `${JSON.stringify(key)}:${canon(value[key], next)}`).join(",")}}`;
}

const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 24);

// ---------------------------------------------------------------------------
// Canvas recording: every property write and method call, in order.

function recordingContext(log) {
  const state = {
    globalAlpha: 1,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineJoin: "miter",
    lineCap: "butt",
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
  };
  let gradients = 0;
  const describe = (value) => (value && typeof value === "object" && "gradientId" in value ? `gradient#${value.gradientId}` : value);
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop in state) return state[prop];
      if (prop === "createLinearGradient") {
        return (...args) => {
          const gradientId = gradients++;
          log.push(["createLinearGradient", gradientId, ...args]);
          return { gradientId, addColorStop: (...stop) => log.push(["addColorStop", gradientId, ...stop]) };
        };
      }
      return (...args) => { log.push([prop, ...args]); };
    },
    set(_, prop, value) {
      state[prop] = value;
      log.push(["set", prop, describe(value)]);
      return true;
    },
  });
}

// ---------------------------------------------------------------------------
// Fixtures. Each covers a compiler or renderer branch; many mirror existing
// suites (chart.mjs, chart-edge-cases.mjs, color-theme.mjs, renderer-parity.mjs)
// and the examples/dashboard.html goldens.

let seed = 1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const DAY = 86_400_000;
const rows = [
  { month: "Jan", value: 10, other: 4 },
  { month: "Feb", value: 20, other: 8 },
  { month: "Mar", value: 15, other: 6 },
];
const denseRows = Array.from({ length: 10_000 }, (_, index) => ({ x: index, y: index === 4_321 ? 10_000 : Math.sin(index / 20) }));
const t0 = Date.UTC(2025, 8, 9);
const rev = Array.from({ length: 365 }, (_, i) => {
  const sales = Math.round((52 + i * 0.08 + Math.sin(i / 18) * 3.6 + (rnd() - 0.5) * 2.1) * 10) / 10;
  return { t: t0 + i * DAY, sales, cost: Math.round(sales * 0.54 * 10) / 10 };
});
const months = [
  { month: "Jan", sales: 42, cost: 28 }, { month: "Feb", sales: 55, cost: 31 },
  { month: "Mar", sales: 49, cost: 30 }, { month: "Apr", sales: 71, cost: 39 },
  { month: "May", sales: 84, cost: 43 }, { month: "Jun", sales: 78, cost: 41 },
  { month: "Jul", sales: 96, cost: 49 }, { month: "Aug", sales: 88, cost: 46 },
];
const vol = Array.from({ length: 24 }, (_, i) => {
  const d = new Date(t0 + i * 2 * DAY);
  return { t: `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`, volume: Math.round(38 + i * 4.1 + Math.sin(i / 3.4) * 9 + rnd() * 8) };
});
const flow = [{ name: "Organic", value: 44 }, { name: "Paid", value: 31 }, { name: "Referral", value: 16 }, { name: "Direct", value: 9 }];
const dots = Array.from({ length: 64 }, () => {
  const x = Math.round(12 + rnd() * 108);
  return { x, y: Math.round(16 + 0.46 * x + (rnd() - 0.5) * 18) };
});
const axes = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
const heat = [];
for (const token of ["BTC", "ETH", "SOL", "BONK", "WIF", "JUP"]) {
  for (const h of ["5m", "15m", "1h", "4h", "1D", "1W"]) heat.push({ token, h, value: Math.round((rnd() - 0.5) * 60) / 10 });
}
const heatRows = [
  { x: "5m", y: "SOL", value: 2.4 }, { x: "1h", y: "SOL", value: -1.1 },
  { x: "5m", y: "ETH", value: 0.6 }, { x: "1h", y: "ETH", value: 3.2 },
];

function segmented(count, perSegment, fn) {
  const out = [];
  for (let segment = 0; segment < count; segment++) {
    for (let p = 0; p < perSegment; p++) out.push({ x: out.length, y: fn(segment, p) });
    out.push({ x: out.length, y: Number.NaN });
  }
  return out;
}

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
const bandProbe = defineMarkPlugin({
  kind: "band-probe",
  domain: () => ({ y: [0, 40] }),
  compile: ({ xScale, yScale, plot, theme, name, color, width, height }) => ({
    nodes: xScale.kind === "band"
      ? xScale.domain.map((category, idx) => ({
        type: "rect", x: xScale.start(category), y: yScale.map(10 + idx), w: xScale.bandwidth(), h: 6,
        fill: color, series: name, role: "probe", idx, tip: `${category} ${plot.w}x${plot.h} ${width}x${height} ${theme.background}`,
      }))
      : [],
    legend: [{ name: "Probe", color, detail: xScale.copy().kind }],
    samples: [{ x: plot.x + 4, y: plot.y + 4, series: "Probe", color, tip: "probe\n1", kind: "point" }],
    lastValues: [{ y: yScale.map(20), label: "20", color, dash: false }],
  }),
});
const annotations = defineMarkPlugin({
  kind: "annotations",
  compile: ({ plot }) => ({
    nodes: [
      { type: "text", x: plot.x + 4, y: plot.y + 8, label: "Outside", clip: false, fill: "#ffffff", anchor: "start", fontSize: 18 },
      { type: "polygon", points: [{ x: plot.x, y: plot.y }, { x: plot.x + 30, y: plot.y + 20 }, { x: plot.x + 5, y: plot.y + 40 }], fill: "#8866cc", fillOpacity: 0.4, stroke: "#aa88ee", series: "Poly" },
      { type: "arc", x: plot.x + 60, y: plot.y + 40, r: 30, innerR: 0, startAngle: 0, endAngle: Math.PI * 2, fill: "#cc6688", series: "Full" },
      { type: "arc", x: plot.x + 120, y: plot.y + 40, r: 30, innerR: 12, startAngle: 0.3, endAngle: 4, fill: "#6688cc", stroke: "#ffffff", strokeWidth: 1, series: "Donut" },
      { type: "rect", x: plot.x + 160, y: plot.y + 10, w: 20, h: 30, fill: "#55aaff", stroke: "#ffffff", corner: "all", series: "Box" },
      { type: "line", points: [{ x: plot.x, y: plot.y + 60 }, { x: plot.x + 40, y: plot.y + 60 }], dashed: true, stroke: "#999999", series: "Dash" },
    ],
  }),
});

const fixtures = [
  ["basic-mixed", { marks: [bar(rows, { x: "month", y: "value", fill: "#2563eb", name: "Sales" }), line(rows, { x: "month", y: "other", stroke: "#16a34a", name: "Other" }), ruleY([12], { stroke: "#dc2626" })], ariaLabel: "Sales" }, [640, 320]],
  ["stacked", { marks: [bar(rows, { x: "month", y: "value", stackId: "s", name: "A" }), bar(rows, { x: "month", y: "other", stackId: "s", name: "B" })] }, [400, 200]],
  ["area-points", { marks: [area(rows, { x: "month", y: "value" }), point(rows, { x: "month", y: "value" })] }, [400, 200]],
  ["fit-dashed", { marks: [line([{ x: 0, y: 1 }, { x: 2, y: 3 }], { x: "x", y: "y", dashed: true, lastValue: false, name: "Fit" })] }, [200, 120]],
  ["plugin-lollipop", { marks: [customMark(lollipop, rows, {})], ariaLabel: "Plugin chart", ariaDescription: "A custom lollipop series." }, [400, 220]],
  ["plugin-band-probe", { marks: [bar(rows, { x: "month", y: "value" }), customMark(bandProbe, rows, {})], theme: "light" }, [420, 240]],
  ["plugin-annotations", { marks: [line(rows, { x: "month", y: "value", name: "Base" }), customMark(annotations, [], {})] }, [480, 280]],
  ["dense-128", { marks: [line(denseRows, { x: "x", y: "y" })], performance: { maxRenderedPoints: 128 } }, [320, 180]],
  ["dense-exact", { marks: [line(denseRows.slice(0, 2_000), { x: "x", y: "y" })], performance: { decimation: "none" } }, [320, 180]],
  ["dense-narrow", { marks: [line(denseRows, { x: "x", y: "y" })] }, [80, 180]],
  ...[1, 2, 3, 4, 5, 15, 16].map((cap) => [`dense-cap-${cap}`, { marks: [line(denseRows, { x: "x", y: "y" })], performance: { maxRenderedPoints: cap } }, [320, 180]]),
  ["gap", { marks: [line([{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: Number.NaN }, { x: 3, y: 4 }, { x: 4, y: 5 }], { x: "x", y: "y" })] }, [320, 180]],
  ["fragmented", { marks: [line(segmented(100, 100, (s, p) => Math.sin(p) + s), { x: "x", y: "y" })], performance: { maxRenderedPoints: 128 } }, [320, 180]],
  ["isolated-spike", { marks: [line(Array.from({ length: 200 }, (_, i) => ({ x: i, y: i % 2 ? Number.NaN : (i === 100 ? 10_000 : 1) })), { x: "x", y: "y" })], performance: { maxRenderedPoints: 16 } }, [320, 180]],
  ["internal-spike", { marks: [line(segmented(100, 100, (s, p) => (s === 50 && p === 50 ? 20_000 : s + p / 100)), { x: "x", y: "y" })], performance: { maxRenderedPoints: 16 } }, [320, 180]],
  ["last-value-tail", { marks: [line(segmented(100, 5, (s, p) => (s === 50 ? [2, 2, 20_000, 2, 2] : s === 99 ? [5, 1, 4, 2, 3] : [2, 2, 2, 2, 2])[p]), { x: "x", y: "y" })], performance: { maxRenderedPoints: 16 } }, [320, 180]],
  ["singletons", { marks: [line(segmented(17, 1, (s) => s), { x: "x", y: "y" })], performance: { maxRenderedPoints: 16 } }, [320, 180]],
  ["final-extreme", { marks: [line([{ x: 0, y: -1 }, { x: 1, y: -0.5 }, { x: 2, y: Number.NaN }, { x: 3, y: 0 }, { x: 4, y: 100 }, { x: 5, y: 60 }], { x: "x", y: "y" })], performance: { maxRenderedPoints: 4 } }, [320, 180]],
  ["decimated-area", { marks: [area(denseRows.slice(0, 3_000), { x: "x", y: "y", curve: "linear" }), line(denseRows.slice(0, 3_000), { x: "x", y: (d) => d.y / 2, name: "Half", curve: "step" })] }, [300, 180]],
  ["ranged-area", { marks: [area(rows, { x: "month", y: "value", y0: "other" })] }, [400, 200]],
  ["ranged-area-gaps", { marks: [area([{ x: 0, y: 5, lo: 1 }, { x: 1, y: 7, lo: Number.NaN }, { x: 2, y: 6, lo: 2 }, { x: 3, y: Number.NaN, lo: 1 }, { x: 4, y: 9, lo: 3 }], { x: "x", y: "y", y0: "lo", fill: "#ff8800", fillOpacity: 0.5 })] }, [360, 200]],
  ["viewport-x", { marks: [line(Array.from({ length: 10 }, (_, x) => ({ x, y: x + 1 })), { x: "x", y: "y" })], viewport: { x: [2, 4] } }, [320, 180]],
  ["domain-only", { marks: [line(Array.from({ length: 10 }, (_, x) => ({ x, y: x + 1 })), { x: "x", y: "y" })], scales: { x: { type: "linear", domain: [2, 4] } } }, [320, 180]],
  ["viewport-decimated", { marks: [line(Array.from({ length: 400 }, (_, x) => ({ x, y: Math.sin(x / 8) })), { x: "x", y: "y" })], viewport: { x: [10, 40] }, performance: { maxRenderedPoints: 16 } }, [80, 80]],
  ["viewport-y", { marks: [line(rows, { x: "month", y: "value" }), bar(rows, { x: "month", y: "other" })], viewport: { y: [0, 12] } }, [360, 200]],
  ["viewport-band", { marks: [bar(rows, { x: "month", y: "value" })], viewport: { x: ["Feb", "Mar"] } }, [360, 200]],
  ["viewport-time", { marks: [area(rev, { x: "t", y: "sales" })], viewport: { x: [t0 + 30 * DAY, t0 + 90 * DAY] } }, [480, 220]],
  ["viewport-dates", { marks: [line(rev.slice(0, 60).map((r) => ({ t: new Date(r.t), v: r.sales })), { x: "t", y: "v" })], viewport: { x: [new Date(t0 + 10 * DAY), new Date(t0 + 20 * DAY)] }, scales: { x: { type: "time" } } }, [480, 220]],
  ["viewport-reversed", { marks: [point(dots, { x: "x", y: "y" })], viewport: { x: [90, 30], y: [80, 10] } }, [400, 240]],
  ["hidden-series", { marks: [line(rows, { x: "month", y: "value", name: "Visible" }), line(rows, { x: "month", y: "other", name: "Hidden" })], hiddenSeries: ["Hidden"] }, [360, 200]],
  ["hidden-unmatched", { marks: [line(rows, { x: "month", y: "value", name: "Visible" })], hiddenSeries: ["Nope"] }, [360, 200]],
  ["curves", { marks: [line(rows, { x: "month", y: "value", curve: "step", name: "Step" }), line(rows, { x: "month", y: "other", curve: "linear", name: "Linear" }), area(rows, { x: "month", y: (d) => d.other / 2, curve: "step", name: "StepArea", strokeWidth: 2 })] }, [400, 200]],
  ["rule-x", { marks: [line(rows, { x: "month", y: "value" }), ruleX(["Feb"], { name: "Event" })] }, [400, 200]],
  ["rule-x-time", { marks: [line(rev.slice(0, 40), { x: "t", y: "sales" }), ruleX([new Date(t0 + 12 * DAY), t0 + 30 * DAY], { stroke: "#ff00ff", strokeWidth: 2 })], scales: { x: { type: "time" } } }, [480, 220]],
  ["rule-only", { marks: [ruleY([1, 5, 9], { name: "Levels", strokeWidth: 2 })] }, [300, 160]],
  ["tick-format", { marks: [line(rows, { x: "month", y: "value" })], scales: { x: { type: "band", tickFormat: (v) => `<${v}>` }, y: { type: "linear", tickFormat: (value) => `$${value}` } } }, [400, 200]],
  ["typed-categories", { marks: [point([{ x: 1, y: 1 }, { x: "1", y: 2 }], { x: "x", y: "y" })], scales: { x: { type: "band" } } }, [600, 400]],
  ["band-padding", { marks: [bar(rows, { x: "month", y: "value" })], scales: { x: { type: "band", padding: 0.5, domain: ["Mar", "Jan", "Feb", "Apr"] } } }, [400, 200]],
  ["many-categories", { marks: [bar(Array.from({ length: 60 }, (_, i) => ({ c: `c${i}`, v: (i * 7) % 13 - 3 })), { x: "c", y: "v" })] }, [500, 220]],
  ["heatmap-basic", { marks: [heatmap(heatRows, { x: "x", y: "y", valueKey: "value" })] }, [400, 200]],
  ["heatmap-sparse", { marks: [heatmap([{ x: "x0", y: "y0", z: 1 }], { x: "x", y: "y", valueKey: "z" })], scales: { x: { type: "band", domain: Array.from({ length: 10 }, (_, i) => `x${i}`) }, y: { type: "band", domain: Array.from({ length: 5 }, (_, i) => `y${i}`) } } }, [600, 400]],
  ["heatmap-dashboard", { marks: [heatmap(heat, { x: "h", y: "token", valueKey: "value", name: "return %" })], ariaLabel: "Token returns" }, [520, 300]],
  ["heatmap-positive", { marks: [heatmap([{ a: "p", b: "q", v: 3 }, { a: "r", b: "q", v: 12 }, { a: "p", b: "s", v: Number.NaN }], { x: "a", y: "b", valueKey: "v" })], grid: true, scales: { x: { type: "band", padding: 0.1 }, y: { type: "band", padding: 0.3 } } }, [300, 200]],
  ["bar-single-pos", { marks: [bar([{ x: 5, y: 2 }], { x: "x", y: "y" })] }, [600, 400]],
  ["bar-single-neg", { marks: [bar([{ x: -5, y: 2 }], { x: "x", y: "y" })] }, [600, 400]],
  ["stack-normalized", { marks: [bar([{ x: 1, y: 10 }], { x: "x", y: "y", stackId: "s", name: "number" }), bar([{ x: "1", y: 5 }], { x: "x", y: "y", stackId: "s", name: "numeric string" })] }, [600, 400]],
  ["stack-time", { marks: [bar([{ x: new Date(1_700_000_000_000), y: 4 }], { x: "x", y: "y", stackId: "s" }), bar([{ x: 1_700_000_000_000, y: 6 }], { x: "x", y: "y", stackId: "s" })], scales: { x: { type: "time" } } }, [600, 400]],
  ["stack-diverging", { marks: [bar([{ x: "A", y: 7 }, { x: "B", y: -5 }], { x: "x", y: "y", stackId: "s" }), bar([{ x: "A", y: 3 }, { x: "B", y: -4 }], { x: "x", y: "y", stackId: "s" })] }, [600, 400]],
  ["stack-grouped", { marks: [bar([{ x: "A", y: 4 }], { x: "x", y: "y", stackId: "left" }), bar([{ x: "A", y: 3 }], { x: "x", y: "y", stackId: "right" }), bar([{ x: "A", y: 2 }], { x: "x", y: "y", stackId: "left" })] }, [600, 400]],
  ["bars-negative", { marks: [bar([{ x: "negative", y: -5 }, { x: "positive", y: 3 }, { x: "zero", y: 0 }], { x: "x", y: "y" })] }, [600, 400]],
  ["bars-numeric", { marks: [bar([{ x: 1, y: 3 }, { x: 2, y: 5 }, { x: 4, y: 2 }], { x: "x", y: "y", name: "A" }), bar([{ x: 1, y: 1 }, { x: 2, y: 4 }], { x: "x", y: "y", name: "B" })] }, [480, 240]],
  ["bars-log-x", { marks: [bar([{ x: 1, y: 3 }, { x: 10, y: 5 }, { x: 100, y: 2 }], { x: "x", y: "y" })], scales: { x: { type: "log" } } }, [480, 240]],
  ["bars-time", { marks: [bar(rev.slice(0, 12), { x: "t", y: "cost", lastValue: true })], scales: { x: { type: "time" } } }, [480, 240]],
  ["bars-time-single", { marks: [bar([{ t: t0, v: 3 }], { x: "t", y: "v" })], scales: { x: { type: "time" } } }, [480, 240]],
  ["bars-grouped-dashboard", { marks: [bar(months, { x: "month", y: "sales", fill: "#66d89e", name: "Sales" }), bar(months, { x: "month", y: "cost", fill: "#e57359", name: "Cost" })], legend: false, ariaLabel: "Sales vs cost" }, [520, 260]],
  ["histogram-fade", { marks: [bar(vol, { x: "t", y: "volume", fill: "#8ecae6", name: "Volume", lastValue: true, fade: true })], legend: false, ariaLabel: "Volume" }, [520, 260]],
  ["pie-empty", { marks: [pie([], { valueKey: "value", labelKey: "name" })], legend: false }, [320, 240]],
  ["pie-zero-total", { marks: [pie([{ name: "a", value: 0 }, { name: "b", value: 0 }], { valueKey: "value", labelKey: "name" })] }, [320, 240]],
  ["pie-partial", { marks: [pie([{ name: "A", value: 10 }, { name: "bad", value: Number.NaN }, { name: "B", value: 20 }], { valueKey: "value", labelKey: "name" })] }, [420, 280]],
  ["pie-dashboard", { marks: [pie(flow, { valueKey: "value", labelKey: "name" })], ariaLabel: "Traffic source" }, [420, 260]],
  ["pie-radii", { marks: [pie([{ v: 1 }, { v: 3 }, { v: 0 }], { valueKey: "v", innerRadius: 10, outerRadius: 60 })] }, [360, 240]],
  ["pie-solid", { marks: [pie([{ v: 5 }], { valueKey: "v", innerRadius: 0, name: "One" })], legend: false }, [240, 240]],
  ["radar-basic", { marks: [radar([{ name: "A", value: 3 }, { name: "B", value: 5 }, { name: "C", value: 4 }], { x: "name", y: "value" })] }, [240, 240]],
  ["radar-multi", { marks: [radar([{ axis: "A", value: 1 }, { axis: "B", value: 2 }, { axis: "C", value: 3 }], { x: "axis", y: "value", name: "one" }), radar([{ axis: "A", value: 2 }, { axis: "B", value: 1 }, { axis: "C", value: 2 }], { x: "axis", y: "value", name: "two" })] }, [600, 400]],
  ["radar-dashboard", { marks: [radar(axes.map((name, i) => ({ name, value: [6.2, 6.0, 6.8, 5.4, 5.9][i] })), { x: "name", y: "value", fill: "#d8aa5b", stroke: "#d8aa5b", name: "Base", fillOpacity: 0.07 }), radar(axes.map((name, i) => ({ name, value: [8.6, 4.1, 9.2, 3.6, 7.5][i] })), { x: "name", y: "value", fill: "#66d89e", stroke: "#66d89e", name: "Live", fillOpacity: 0.13, strokeWidth: 2 })], legend: false, ariaLabel: "Profile" }, [360, 280]],
  ["radar-empty", { marks: [radar([], { x: "name", y: "value" })] }, [240, 240]],
  ["null-gap", { marks: [line([null, { x: 1, y: 2 }], { x: "x", y: "y" })] }, [600, 400]],
  ["large-metrics", { marks: [line([{ x: 0, y: 1_000_000_000_000 }, { x: 1, y: 1_200_000_000_000 }], { x: "x", y: "y" })] }, [600, 400]],
  ["small-metrics", { marks: [line([{ x: 0, y: 0.0012 }, { x: 1, y: 0.0031 }, { x: 2, y: -0.0004 }], { x: "x", y: "y" }), ruleY([0.5, -1234.5678, 12.3456])] }, [600, 400]],
  ["epoch-time", { marks: [line([{ x: 0, y: 1 }, { x: 2 * DAY, y: 2 }], { x: "x", y: "y" })], scales: { x: { type: "time" } } }, [600, 400]],
  ["inferred-dates", { marks: [line([{ x: new Date(0), y: 1 }, { x: new Date(2 * DAY), y: 2 }], { x: "x", y: "y" })] }, [600, 400]],
  ["long-time", { marks: [line(rev, { x: "t", y: "sales", name: "Sales" }), line(rev, { x: "t", y: "cost", name: "Cost" })], scales: { x: { type: "time" } } }, [900, 300]],
  ["singleton-log", { marks: [line([{ x: 1, y: 100 }], { x: "x", y: "y" })], scales: { y: { type: "log" } } }, [600, 400]],
  ["log-y", { marks: [line([{ x: 1, y: 3 }, { x: 2, y: 30 }, { x: 3, y: 3000 }], { x: "x", y: "y" }), point([{ x: 2, y: 300 }], { x: "x", y: "y" })], scales: { y: { type: "log", domain: [1, 10_000] } } }, [480, 260]],
  ["log-x-points", { marks: [point([{ x: 1, y: 3 }, { x: 20, y: 5 }, { x: 900, y: 1 }], { x: "x", y: "y", r: 5, fill: "#ff0000", fillOpacity: 0.5 })], scales: { x: { type: "log" } } }, [480, 260]],
  ["log-x-flat", { marks: [line([{ x: 7, y: 3 }, { x: 7, y: 5 }], { x: "x", y: "y" })], scales: { x: { type: "log" } } }, [480, 260]],
  ["theme-light", { marks: [bar(rows, { x: "month", y: "value", fade: true }), line(rows, { x: "month", y: "other" }), ruleY([7])], theme: "light" }, [400, 220]],
  ["theme-custom", { marks: [area(rows, { x: "month", y: "value" }), point(rows, { x: "month", y: "other" })], theme: { background: "#102030", text: "#eeeeee", accent: "#ff00aa", chipBg: "#ffffff" } }, [400, 220]],
  ["theme-area-hsla", { grid: false, marks: [area([{ x: 0, y: 2 }, { x: 1, y: 5 }, { x: 2, y: 3 }], { x: "x", y: "y", fill: "hsla(210 100% 50% / 50%)", fillOpacity: 0.4 })] }, [360, 220]],
  ["theme-orange-bar", { marks: [bar([{ x: "A", y: 2 }], { x: "x", y: "y", fill: "orange" })] }, [300, 180]],
  ["dashboard-revenue", { marks: [area(rev, { x: "t", y: "sales", fill: "#66d89e", stroke: "#66d89e", name: "Sales" }), ruleY([70], { stroke: "#d8aa5b", name: "goal" })], scales: { x: { type: "time" } }, legend: false, ariaLabel: "Revenue" }, [760, 300]],
  ["dashboard-scatter", { marks: [point(dots, { x: "x", y: "y", name: "fill" }), line([{ x: 12, y: 20 }, { x: 120, y: 70 }], { x: "x", y: "y", stroke: "rgba(216,170,91,0.7)", name: "Fit", dashed: true, lastValue: false, strokeWidth: 1.2 })], scales: { x: { type: "linear" }, y: { type: "linear" } }, legend: false, ariaLabel: "Scatter" }, [420, 280]],
  ["toggles-off", { marks: [line(rows, { x: "month", y: "value" })], legend: false, grid: false, tooltip: false, ariaLabel: "  Trimmed  ", ariaDescription: "  described  " }, [300, 160]],
  ["margins", { marks: [bar(rows, { x: "month", y: "value" })], margin: { left: 40, right: 20, top: 0 } }, [300, 160]],
  ["empty", { marks: [] }, [300, 160]],
  ["spec-size", { width: 500, height: 250, marks: [line(rows, { x: "month", y: "value" })] }, [300, 160]],
  ["y-nice-flags", { marks: [bar(rows, { x: "month", y: "value" }), line(rows, { x: "month", y: "other" })], scales: { y: { nice: false } } }, [300, 160]],
  ["x-nice", { marks: [line([{ x: 0.3, y: 1 }, { x: 9.7, y: 4 }], { x: "x", y: "y" })], scales: { x: { type: "linear", nice: true }, y: { type: "linear", nice: true, domain: [0.5, 4.2] } } }, [300, 160]],
  ["single-point-line", { marks: [line([{ x: "only", y: 3 }], { x: "x", y: "y", strokeWidth: 3 })] }, [300, 160]],
  ["flat-series", { marks: [line([{ x: 1, y: 5 }, { x: 1, y: 5 }], { x: "x", y: "y" })] }, [300, 160]],
  ["numeric-strings", { marks: [line([{ x: "1", y: "2.5" }, { x: "2", y: "3" }, { x: "3", y: "" }, { x: "4", y: "4" }], { x: "x", y: "y" })] }, [300, 160]],
  ["accessor-fns", { marks: [line(rows, { x: (d) => d.month, y: (d) => d.value * 2, name: "Doubled" }), point(rows, { x: (d) => d.month, y: (d) => d.other })] }, [300, 160]],
  // Chips are spaced apart: overlapping chips pinned at the plot floor hang the
  // pre-split stacking loop (tracked as native-lastvalue-chip-hang).
  ["palette-cycle", { marks: Array.from({ length: 9 }, (_, i) => line(rows, { x: "month", y: (d) => d.value + i * 6, name: `S${i}`, lastValue: i % 3 === 0 })) }, [700, 260]],
  ["mixed-legend-dupes", { marks: [line(rows, { x: "month", y: "value", name: "Same" }), bar(rows, { x: "month", y: "other", name: "Same", lastValue: true })] }, [300, 160]],
];

const functionFixtures = [
  ["function-spec", defineChart(({ width, height }) => ({ marks: [bar(rows, { x: "month", y: (d) => (d.value * width) / height })], ariaLabel: `${width}x${height}` })), [333, 177]],
];

// Validation failures. Messages are part of the public contract.
const failing = [
  ["budget-0", () => compileChart(defineChart({ marks: [line(rows, { x: "month", y: "value" })], performance: { maxRenderedPoints: 0 } }), { width: 320, height: 180 })],
  ["budget-nan", () => compileChart(defineChart({ marks: [line(rows, { x: "month", y: "value" })], performance: { maxRenderedPoints: Number.NaN } }), { width: 320, height: 180 })],
  ["decimation-bad", () => compileChart(defineChart({ marks: [], performance: { decimation: "fast" } }), { width: 320, height: 180 })],
  ["performance-key", () => compileChart(defineChart({ marks: [], performance: { turbo: true } }), { width: 320, height: 180 })],
  ["y0-on-line", () => compileChart(defineChart({ marks: [{ kind: "line", data: rows, x: "month", y: "value", y0: "other" }] }), { width: 320, height: 180 })],
  ["reserved-plugin", () => defineMarkPlugin({ kind: "line", compile: () => ({ nodes: [] }) })],
  ["empty-plugin", () => defineMarkPlugin({ kind: " ", compile: () => ({ nodes: [] }) })],
  ["custom-reserved", () => customMark({ kind: "bar", compile: () => ({ nodes: [] }) }, [], {})],
  ["plugin-bypass", () => compileChart(defineChart({ marks: [{ kind: "line", data: rows, x: "month", y: "value", plugin: { kind: "line", compile: () => ({ nodes: [] }) }, pluginOptions: {} }] }), { width: 320, height: 180 })],
  ["plugin-mismatch", () => compileChart(defineChart({ marks: [{ kind: "one", data: [], plugin: { kind: "two", compile: () => ({ nodes: [] }) }, pluginOptions: {} }] }), { width: 320, height: 180 })],
  ["plugin-top-level", () => compileChart(defineChart({ marks: [{ ...customMark(lollipop, rows, {}), color: "red" }] }), { width: 320, height: 180 })],
  ["unknown-kind", () => compileChart(defineChart({ marks: [{ kind: "mystery", data: [] }] }), { width: 320, height: 180 })],
  ["size-zero", () => compileChart(defineChart({ marks: [] }), { width: 0, height: 180 })],
  ["size-null", () => compileChart(defineChart({ marks: [] }), null)],
  ["definition-bad", () => compileChart({}, { width: 10, height: 10 })],
  ["marks-missing", () => compileChart(defineChart(() => ({})), { width: 10, height: 10 })],
  ["band-domain-missing", () => compileChart(defineChart({ marks: [bar([{ x: "A", y: 1 }, { x: "C", y: 2 }], { x: "x", y: "y" })], scales: { x: { type: "band", domain: ["A", "B"] } } }), { width: 600, height: 400 })],
  ["heatmap-domain-missing", () => compileChart(defineChart({ marks: [heatmap([{ x: "C", y: "row", z: 1 }], { x: "x", y: "y", valueKey: "z" })], scales: { x: { type: "band", domain: ["A", "B"] }, y: { type: "band", domain: ["row"] } } }), { width: 600, height: 400 })],
  ["heatmap-y-domain-missing", () => compileChart(defineChart({ marks: [heatmap([{ x: "A", y: "zzz", z: 1 }], { x: "x", y: "y", valueKey: "z" })], scales: { x: { type: "band", domain: ["A"] }, y: { type: "band", domain: ["row"] } } }), { width: 600, height: 400 })],
  ["pie-radius-nan", () => compileChart(defineChart({ marks: [pie([{ value: 1 }], { valueKey: "value", innerRadius: Number.NaN })] }), { width: 600, height: 400 })],
  ["pie-radius-inverted", () => compileChart(defineChart({ marks: [pie([{ value: 1 }], { valueKey: "value", innerRadius: 20, outerRadius: 10 })] }), { width: 600, height: 400 })],
  ["pie-negative", () => compileChart(defineChart({ marks: [pie([{ value: -1 }], { valueKey: "value" })] }), { width: 600, height: 400 })],
  ["pie-no-value", () => compileChart(defineChart({ marks: [{ kind: "pie", data: [] }] }), { width: 600, height: 400 })],
  ["pie-composed", () => compileChart(defineChart({ marks: [pie([], { valueKey: "v" }), pie([], { valueKey: "v" })] }), { width: 600, height: 400 })],
  ["radar-negative", () => compileChart(defineChart({ marks: [radar([{ axis: "A", value: -1 }, { axis: "B", value: 1 }, { axis: "C", value: 1 }], { x: "axis", y: "value" })] }), { width: 600, height: 400 })],
  ["radar-two-axes", () => compileChart(defineChart({ marks: [radar([{ axis: "A", value: 1 }, { axis: "B", value: 1 }], { x: "axis", y: "value" })] }), { width: 600, height: 400 })],
  ["radar-dup-axis", () => compileChart(defineChart({ marks: [radar([{ axis: "A", value: 1 }, { axis: "A", value: 1 }, { axis: "C", value: 1 }], { x: "axis", y: "value" })] }), { width: 600, height: 400 })],
  ["radar-bad-axis", () => compileChart(defineChart({ marks: [radar([{ axis: null, value: 1 }, { axis: "B", value: 1 }, { axis: "C", value: 1 }], { x: "axis", y: "value" })] }), { width: 600, height: 400 })],
  ["radar-order", () => compileChart(defineChart({ marks: [radar([{ a: "A", v: 1 }, { a: "B", v: 1 }, { a: "C", v: 1 }], { x: "a", y: "v" }), radar([{ a: "B", v: 1 }, { a: "A", v: 1 }, { a: "C", v: 1 }], { x: "a", y: "v" })] }), { width: 600, height: 400 })],
  ["radar-mixed", () => compileChart(defineChart({ marks: [radar([{ a: "A", v: 1 }, { a: "B", v: 1 }, { a: "C", v: 1 }], { x: "a", y: "v" }), line(rows, { x: "month", y: "value" })] }), { width: 600, height: 400 })],
  ["radar-scales", () => compileChart(defineChart({ marks: [radar([{ axis: "A", value: 1 }, { axis: "B", value: 1 }, { axis: "C", value: 1 }], { x: "axis", y: "value" })], scales: { y: { type: "linear" } } }), { width: 600, height: 400 })],
  ["heatmap-composed", () => compileChart(defineChart({ marks: [heatmap(heatRows, { x: "x", y: "y", valueKey: "value" }), line(rows, { x: "month", y: "value" })] }), { width: 600, height: 400 })],
  ["heatmap-no-value", () => compileChart(defineChart({ marks: [{ kind: "heatmap", data: [], x: "x", y: "y" }] }), { width: 600, height: 400 })],
  ["heatmap-linear", () => compileChart(defineChart({ marks: [heatmap(heatRows, { x: "x", y: "y", valueKey: "value" })], scales: { x: { type: "linear" } } }), { width: 600, height: 400 })],
  ["viewport-polar", () => compileChart(defineChart({ marks: [pie(flow, { valueKey: "value" })], viewport: { x: [0, 1] } }), { width: 600, height: 400 })],
  ["viewport-key", () => compileChart(defineChart({ marks: [], viewport: { z: [0, 1] } }), { width: 600, height: 400 })],
  ["viewport-x-empty", () => compileChart(defineChart({ marks: [], viewport: { x: [] } }), { width: 600, height: 400 })],
  ["viewport-y-bad", () => compileChart(defineChart({ marks: [], viewport: { y: [0] } }), { width: 600, height: 400 })],
  ["margin-nan", () => compileChart(defineChart({ marks: [], margin: { left: Number.NaN } }), { width: 600, height: 400 })],
  ["margin-key", () => compileChart(defineChart({ marks: [], margin: { middle: 3 } }), { width: 600, height: 400 })],
  ["margin-type", () => compileChart(defineChart({ marks: [], margin: 4 }), { width: 600, height: 400 })],
  ["scales-string", () => compileChart(defineChart({ marks: [], scales: "oops" }), { width: 600, height: 400 })],
  ["scales-axis", () => compileChart(defineChart({ marks: [], scales: { z: {} } }), { width: 600, height: 400 })],
  ["scale-null", () => compileChart(defineChart({ marks: [], scales: { x: null } }), { width: 600, height: 400 })],
  ["scale-option", () => compileChart(defineChart({ marks: [], scales: { x: { type: "linear", ticks: 3 } } }), { width: 600, height: 400 })],
  ["scale-y-band", () => compileChart(defineChart({ marks: [], scales: { y: { type: "band" } } }), { width: 600, height: 400 })],
  ["scale-x-weird", () => compileChart(defineChart({ marks: [], scales: { x: { type: "ordinal" } } }), { width: 600, height: 400 })],
  ["band-nice", () => compileChart(defineChart({ marks: [], scales: { x: { type: "band", nice: true } } }), { width: 600, height: 400 })],
  ["band-padding-bad", () => compileChart(defineChart({ marks: [], scales: { x: { type: "band", padding: 1 } } }), { width: 600, height: 400 })],
  ["band-domain-object", () => compileChart(defineChart({ marks: [], scales: { x: { type: "band", domain: "abc" } } }), { width: 600, height: 400 })],
  ["band-domain-nan", () => compileChart(defineChart({ marks: [], scales: { x: { type: "band", domain: ["a", Number.NaN] } } }), { width: 600, height: 400 })],
  ["band-domain-dupe", () => compileChart(defineChart({ marks: [], scales: { x: { type: "band", domain: ["a", "a"] } } }), { width: 600, height: 400 })],
  ["linear-padding", () => compileChart(defineChart({ marks: [], scales: { x: { type: "linear", padding: 0.1 } } }), { width: 600, height: 400 })],
  ["log-nice", () => compileChart(defineChart({ marks: [], scales: { y: { type: "log", nice: true } } }), { width: 600, height: 400 })],
  ["nice-type", () => compileChart(defineChart({ marks: [], scales: { y: { nice: "yes" } } }), { width: 600, height: 400 })],
  ["domain-three", () => compileChart(defineChart({ marks: [], scales: { y: { domain: [0, 1, 2] } } }), { width: 600, height: 400 })],
  ["domain-nan", () => compileChart(defineChart({ marks: [], scales: { y: { domain: [0, Number.NaN] } } }), { width: 600, height: 400 })],
  ["domain-same", () => compileChart(defineChart({ marks: [], scales: { y: { domain: [2, 2] } } }), { width: 600, height: 400 })],
  ["domain-log-zero", () => compileChart(defineChart({ marks: [], scales: { y: { type: "log", domain: [0, 10] } } }), { width: 600, height: 400 })],
  ["tickformat-type", () => compileChart(defineChart({ marks: [], scales: { y: { tickFormat: "x" } } }), { width: 600, height: 400 })],
  ["x-type-categories", () => compileChart(defineChart({ marks: [line(rows, { x: "month", y: "value" })], scales: { x: { type: "linear" } } }), { width: 600, height: 400 })],
  ["x-band-inferred-nice", () => compileChart(defineChart({ marks: [line(rows, { x: "month", y: "value" })], scales: { x: { nice: true, type: undefined } } }), { width: 600, height: 400 })],
  ["x-log-nonpositive", () => compileChart(defineChart({ marks: [line([{ x: 0, y: 1 }, { x: 1, y: 2 }], { x: "x", y: "y" })], scales: { x: { type: "log" } } }), { width: 600, height: 400 })],
  ["y-log-bar", () => compileChart(defineChart({ marks: [bar(rows, { x: "month", y: "value" })], scales: { y: { type: "log" } } }), { width: 600, height: 400 })],
  ["y-log-nonpositive", () => compileChart(defineChart({ marks: [line([{ x: 0, y: 0 }, { x: 1, y: 2 }], { x: "x", y: "y" })], scales: { y: { type: "log" } } }), { width: 600, height: 400 })],
  ["plugin-band-miss", () => compileChart(defineChart({ marks: [customMark(lollipop, [{ month: "Zed", value: 1 }], {})], scales: { x: { type: "band", domain: ["Jan"] } } }), { width: 600, height: 400 })],
  ["grid-type", () => compileChart(defineChart({ marks: [], grid: "yes" }), { width: 600, height: 400 })],
  ["theme-token", () => compileChart(defineChart({ marks: [], theme: { background: 42 } }), { width: 600, height: 400 })],
  ["theme-unknown", () => compileChart(defineChart({ marks: [], theme: { sparkle: "#fff" } }), { width: 600, height: 400 })],
  ["theme-type", () => compileChart(defineChart({ marks: [], theme: "sepia" }), { width: 600, height: 400 })],
  ["aria-label", () => compileChart(defineChart({ marks: [], ariaLabel: 4 }), { width: 600, height: 400 })],
  ["aria-description", () => compileChart(defineChart({ marks: [], ariaDescription: 4 }), { width: 600, height: 400 })],
  ["hidden-bad", () => compileChart(defineChart({ marks: [], hiddenSeries: [1] }), { width: 600, height: 400 })],
  ["performance-type", () => compileChart(defineChart({ marks: [], performance: "fast" }), { width: 600, height: 400 })],
  ["unknown-option", () => compileChart(defineChart({ marks: [], mystery: true }), { width: 600, height: 400 })],
  ["spec-width", () => compileChart(defineChart({ marks: [], width: -1 }), { width: 600, height: 400 })],
  ["mark-data", () => compileChart(defineChart({ marks: [{ kind: "line", data: "nope", x: "x", y: "y" }] }), { width: 600, height: 400 })],
  ["mark-option", () => compileChart(defineChart({ marks: [{ kind: "line", data: [{ x: 0, y: 1 }], x: "x", y: "y", innerRadius: 10 }] }), { width: 600, height: 400 })],
  ["mark-channel-type", () => compileChart(defineChart({ marks: [{ kind: "line", data: [], x: 4, y: "y" }] }), { width: 600, height: 400 })],
  ["mark-name", () => compileChart(defineChart({ marks: [{ kind: "line", data: [], x: "x", y: "y", name: 3 }] }), { width: 600, height: 400 })],
  ["mark-fill", () => compileChart(defineChart({ marks: [{ kind: "bar", data: [], x: "x", y: "y", fill: " " }] }), { width: 600, height: 400 })],
  ["mark-stack", () => compileChart(defineChart({ marks: [{ kind: "bar", data: [], x: "x", y: "y", stackId: "" }] }), { width: 600, height: 400 })],
  ["mark-width", () => compileChart(defineChart({ marks: [{ kind: "line", data: [], x: "x", y: "y", strokeWidth: -1 }] }), { width: 600, height: 400 })],
  ["mark-opacity", () => compileChart(defineChart({ marks: [{ kind: "point", data: [], x: "x", y: "y", fillOpacity: 2 }] }), { width: 600, height: 400 })],
  ["mark-bool", () => compileChart(defineChart({ marks: [{ kind: "line", data: [], x: "x", y: "y", dashed: "yes" }] }), { width: 600, height: 400 })],
  ["mark-curve", () => compileChart(defineChart({ marks: [{ kind: "line", data: [], x: "x", y: "y", curve: "basis" }] }), { width: 600, height: 400 })],
  ["mark-y0", () => compileChart(defineChart({ marks: [{ kind: "area", data: [], x: "x", y: "y", y0: 4 }] }), { width: 600, height: 400 })],
  ["mark-xy", () => compileChart(defineChart({ marks: [{ kind: "line", data: [], x: "x" }] }), { width: 600, height: 400 })],
  ["rule-y-missing", () => compileChart(defineChart({ marks: [{ kind: "ruleY", data: [] }] }), { width: 600, height: 400 })],
  ["rule-x-missing", () => compileChart(defineChart({ marks: [{ kind: "ruleX", data: [] }] }), { width: 600, height: 400 })],
  ["plugin-domain-throw", () => compileChart(defineChart({ marks: [customMark(defineMarkPlugin({ kind: "boom", domain: () => { throw new Error("domain boom"); }, compile: () => ({ nodes: [] }) }), [], {})] }), { width: 600, height: 400 })],
  ["plugin-domain-shape", () => compileChart(defineChart({ marks: [customMark(defineMarkPlugin({ kind: "bad-domain", domain: () => ({ x: 42 }), compile: () => ({ nodes: [] }) }), [], {})] }), { width: 600, height: 400 })],
  ["plugin-domain-key", () => compileChart(defineChart({ marks: [customMark(defineMarkPlugin({ kind: "bad-domain-key", domain: () => ({ z: [] }), compile: () => ({ nodes: [] }) }), [], {})] }), { width: 600, height: 400 })],
  ["plugin-domain-y", () => compileChart(defineChart({ marks: [customMark(defineMarkPlugin({ kind: "bad-domain-y", domain: () => ({ y: [Number.NaN] }), compile: () => ({ nodes: [] }) }), [], {})] }), { width: 600, height: 400 })],
  ["plugin-compile-throw", () => compileChart(defineChart({ marks: [customMark(defineMarkPlugin({ kind: "kaboom", compile: () => { throw new Error("compile boom"); } }), [], {})] }), { width: 600, height: 400 })],
  ...[
    ["bad-legend", { nodes: [], legend: {} }],
    ["null-node", { nodes: [null] }],
    ["bad-rect", { nodes: [{ type: "rect" }] }],
    ["bad-fill", { nodes: [{ type: "circle", x: 1, y: 1, r: 2, fill: 42 }] }],
    ["bad-opacity", { nodes: [{ type: "circle", x: 1, y: 1, r: 2, fillOpacity: 2 }] }],
    ["bad-size", { nodes: [{ type: "rect", x: 1, y: 1, w: -2, h: 3 }] }],
    ["bad-corner", { nodes: [{ type: "rect", x: 1, y: 1, w: 2, h: 3, corner: "sideways" }] }],
    ["bad-anchor", { nodes: [{ type: "text", x: 1, y: 1, label: "a", anchor: "left" }] }],
    ["bad-boolean", { nodes: [{ type: "circle", x: 1, y: 1, r: 2, dashed: "yes" }] }],
    ["bad-detail", { nodes: [], legend: [{ name: "x", color: "red", detail: 42 }] }],
    ["bad-sample", { nodes: [], samples: [{ x: 1, y: 1, series: "a", color: "red", tip: "t", kind: "bar" }] }],
    ["bad-last", { nodes: [], lastValues: [{ y: 1, label: "a", color: "red", dash: 1 }] }],
    ["bad-points", { nodes: [{ type: "line", points: [{ x: 1 }] }] }],
    ["bad-node-key", { nodes: [{ type: "circle", x: 1, y: 1, r: 2, glow: true }] }],
    ["bad-node-type", { nodes: [{ type: "hexagon" }] }],
    ["bad-idx", { nodes: [{ type: "circle", x: 1, y: 1, r: 2, idx: 1.5 }] }],
    ["bad-inner", { nodes: [{ type: "arc", x: 1, y: 1, r: 2, innerR: 3, startAngle: 0, endAngle: 1 }] }],
    ["bad-points-kind", { nodes: [{ type: "circle", x: 1, y: 1, r: 2, points: [] }] }],
    ["bad-label", { nodes: [{ type: "text", x: 1, y: 1 }] }],
    ["bad-result", 42],
    ["bad-result-key", { nodes: [], extra: 1 }],
    ["bad-samples-type", { nodes: [], samples: {} }],
  ].map(([kind, result]) => [`plugin-${kind}`, () => compileChart(defineChart({ marks: [customMark(defineMarkPlugin({ kind, compile: () => result }), [], {})] }), { width: 600, height: 400 })]),
];

// ---------------------------------------------------------------------------
// Facet capture

const facets = {};
const verbose = process.env.RAZE_PARITY_VERBOSE === "1";
let lastMark = Date.now();
function record(group, name, facet, text) {
  if (verbose) {
    console.log(`${group}/${name}.${facet} ${text.length}B +${Date.now() - lastMark}ms`);
    lastMark = Date.now();
  }
  const key = `${group}/${name}`;
  facets[key] ??= {};
  facets[key][facet] = text;
}

function probes(scene) {
  const points = [];
  for (let gy = 0; gy <= 10; gy++) {
    for (let gx = 0; gx <= 16; gx++) points.push([(scene.width * gx) / 16, (scene.height * gy) / 10]);
  }
  for (const node of scene.nodes.slice(0, 60)) {
    if (node.type === "rect") points.push([node.x + node.w / 2, node.y + node.h / 2]);
    else if (node.type === "line" || node.type === "area" || node.type === "polygon") {
      const p = node.points[Math.floor(node.points.length / 2)];
      if (p) points.push([p.x, p.y + 1]);
    } else if (node.x != null && node.y != null) points.push([node.x + 0.5, node.y - 0.5]);
  }
  for (const sample of scene.samples.slice(0, 30)) points.push([sample.x + 1, sample.y + 1]);
  return points;
}

function captureScene(name, scene) {
  record("scene", name, "scene", canon(scene));
  record("scene", name, "svg", svgFromCompiled(scene, { idPrefix: `parity-${name}` }));
  const log = [];
  paintChartCanvas(recordingContext(log), scene);
  record("scene", name, "canvas", canon(log));
  const hits = probes(scene).map(([x, y]) => {
    const hit = hitTestCompiled(scene, x, y);
    return hit ? [x, y, scene.nodes.indexOf(hit), tooltipText(hit)] : [x, y, -1];
  });
  record("scene", name, "hits", canon(hits));
  record("scene", name, "tooltips", canon(scene.nodes.slice(0, 200).map((node) => tooltipText(node))));
}

function compileFixture(name, definition, width, height) {
  let scene;
  try {
    scene = compileChart(definition, { width, height });
  } catch (error) {
    // Some edge fixtures deliberately pin a thrown (non-compile) error.
    record("scene", name, "thrown", `${error?.name}: ${error?.message}`);
    return;
  }
  captureScene(name, scene);
}
for (const [name, spec, [width, height]] of fixtures) compileFixture(name, defineChart(spec), width, height);
for (const [name, definition, [width, height]] of functionFixtures) compileFixture(name, definition, width, height);
// Hand-built scenes exercise renderer branches the compiler never emits.
{
  const base = compileChart(defineChart({ marks: [], ariaLabel: "Renderer parity" }), { width: 480, height: 280 });
  captureScene("hand-all-nodes", {
    ...base,
    nodes: [
      { type: "line", points: [{ x: 20, y: 90 }, { x: 80, y: 30 }, { x: 140, y: 70 }], stroke: "#55aaff", strokeWidth: 2, series: "Line" },
      { type: "line", points: [{ x: 20, y: 90 }], stroke: "none", series: "Invisible" },
      { type: "line", points: [{ x: 20, y: 95 }, { x: 60, y: 95 }], stroke: "#ffffff", dashed: true },
      { type: "area", points: [{ x: 20, y: 160 }, { x: 20, y: 100 }, { x: 80, y: 70 }, { x: 140, y: 110 }, { x: 140, y: 160 }], fill: "#55aaff", fillOpacity: 0.35, stroke: "#224466", series: "Area" },
      { type: "area", points: [{ x: 20, y: 160 }, { x: 80, y: 70 }], fill: "#55aaff" },
      { type: "rect", x: 160, y: 70, w: 24, h: 90, fill: "#66d89e", corner: "top", series: "Bar" },
      { type: "rect", x: 190, y: 70, w: 3, h: 4, fill: "#66d89e", corner: "bottom", stroke: "#000000", strokeWidth: 2, series: "Tiny" },
      { type: "rect", x: 200, y: 70, w: 10, h: 10, fill: "none", stroke: "#ff0000", series: "Outline" },
      { type: "circle", x: 210, y: 90, r: 6, fill: "#d7a856", stroke: "#ffffff", fillOpacity: 0.8, series: "Point" },
      { type: "circle", x: 230, y: 90, fill: "none", stroke: "#ffffff" },
      { type: "rule", x: 15, y: 170, x2: 240, y2: 170, stroke: "#999999", dashed: true, series: "Rule" },
      { type: "rule", x: 15, y: 175, x2: 240, y2: 175, stroke: "none" },
      { type: "arc", x: 300, y: 100, r: 42, innerR: 20, startAngle: 0, endAngle: Math.PI * 1.5, fill: "#cc6688", stroke: "#ffffff", series: "Arc" },
      { type: "arc", x: 300, y: 100, r: 0, innerR: 0, startAngle: 0, endAngle: 1, fill: "#cc6688" },
      { type: "arc", x: 360, y: 60, r: 30, innerR: 10, startAngle: -Math.PI / 2, endAngle: Math.PI * 1.5, fill: "#44aa88", fillOpacity: 0.6, series: "Ring", role: "slice", idx: 2 },
      { type: "polygon", points: [{ x: 260, y: 190 }, { x: 310, y: 150 }, { x: 360, y: 195 }], fill: "#8866cc", fillOpacity: 0.4, stroke: "#aa88ee", series: "Polygon" },
      { type: "polygon", points: [{ x: 260, y: 200 }, { x: 310, y: 210 }, { x: 360, y: 205 }], fill: "none", stroke: "#aa88ee" },
      { type: "text", x: 300, y: 220, label: "Outside annotation", fill: "#ffffff", anchor: "middle", fontSize: 12, clip: false },
      { type: "text", x: 300, y: 240, label: "Big <&\"> label", anchor: "end", fontSize: 22 },
      { type: "text", x: 300, y: 250, label: "" },
      { type: "rect", x: 10, y: 10, w: 20, h: 20, fill: "#123456", role: "heat", datum: { a: "x", b: "y", v: 1.25 } },
      { type: "circle", x: 40, y: 40, r: 3, fill: "#ffffff", datum: { name: "n", value: -0.5, when: new Date(0), extra: 2, more: 3, most: 4 } },
      { type: "circle", x: 44, y: 44, r: 3, fill: "#ffffff", datum: { k: 3 } },
      { type: "arc", x: 100, y: 200, r: 10, innerR: 0, startAngle: 0, endAngle: 1, label: "Arc label" },
    ],
    grid: true,
    legend: [{ name: "Line", color: "#55aaff", detail: "42" }, { name: "Other <b>", color: "#ffaa00" }],
    legendPlacement: "top",
    lastValues: [
      { y: 90, label: "42.0", color: "#55aaff", dash: true },
      { y: 92, label: "43.0", color: "#ffffff", dash: false },
      { y: 91, label: "44.0", color: "rgba(0,0,0,0.5)" },
    ],
  });
  captureScene("hand-right-legend", {
    ...base,
    legendPlacement: "right",
    legend: [{ name: "One", color: "#ff0000", detail: "10%" }, { name: "Two", color: "#00ff00" }],
    colorBar: { min: -4, max: 12 },
    heatmap: true,
    yTicks: [{ value: "a", px: 40, label: "a" }, { value: "b", px: 80, label: "b" }],
  });
  captureScene("hand-colorbar-positive", { ...base, colorBar: { min: 2, max: 30 }, legendPlacement: "hidden", legend: [{ name: "x", color: "#fff" }] });
  captureScene("hand-polar-chrome", { ...base, polar: true, colorBar: { min: -1, max: 1 }, lastValues: [{ y: 20, label: "1", color: "#fff" }] });
}

// Errors: name, stable code, message, and wrapped cause.
const errors = {};
for (const [name, run] of failing) {
  try {
    run();
    errors[name] = "NO ERROR";
  } catch (error) {
    const cause = error?.cause instanceof Error ? ` | cause: ${error.cause.message}` : "";
    errors[name] = `${error?.name}:${error?.code ?? "-"}: ${error?.message}${cause}`;
  }
}

// ---------------------------------------------------------------------------
// Mounted runtime (jsdom): DOM output, overlay state, and callback payloads.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe(target) { this.target = target; }
  disconnect() { this.target = null; }
};
const canvasLogs = new WeakMap();
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  let log = canvasLogs.get(this);
  if (!log) { log = []; canvasLogs.set(this, log); }
  log.push(["getContext"]);
  return recordingContext(log);
};

function mountScenario(name, definition, options, script) {
  const events = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = mountChart(host, definition, {
    ...options,
    onSelect: (event) => events.push(["select", event]),
    onTooltip: (event) => events.push(["tooltip", event]),
    onViewportChange: (viewport) => events.push(["viewport", viewport]),
  });
  const wrap = host.firstElementChild;
  const box = { x: 0, y: 0, left: 0, top: 0, right: options.boxWidth ?? 480, bottom: options.boxHeight ?? 280, width: options.boxWidth ?? 480, height: options.boxHeight ?? 280, toJSON() {} };
  wrap.getBoundingClientRect = () => box;
  const snapshots = [];
  const snap = (label) => {
    const canvases = [...wrap.querySelectorAll("canvas")].map((canvas) => {
      const log = canvasLogs.get(canvas) ?? [];
      const copy = log.slice();
      log.length = 0;
      return copy;
    });
    snapshots.push([label, wrap.outerHTML, canvases, handle.getViewport(), handle.getScene()?.diagnostics ?? null]);
  };
  const fire = (type, init = {}, target = wrap) => {
    const Ctor = type === "wheel" ? dom.window.WheelEvent : dom.window.MouseEvent;
    target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
  };
  snap("mounted");
  script({ handle, wrap, fire, snap, box, scene: () => handle.getScene() });
  handle.destroy();
  snap("destroyed");
  host.remove();
  record("mount", name, "dom", canon(snapshots));
  record("mount", name, "events", canon(events));
}

function hoverAll(ctx, limit = 24) {
  const scene = ctx.scene();
  const points = probes(scene).slice(0, 40);
  for (const sample of scene.samples.slice(0, limit)) points.push([sample.x, sample.y]);
  // Plot-edge probes exercise crosshair and chip clamping.
  const { plot } = scene;
  for (const fx of [0.01, 0.5, 0.99]) {
    for (const fy of [0.005, 0.5, 0.995]) points.push([plot.x + plot.w * fx, plot.y + plot.h * fy]);
  }
  // Probes are scene coordinates; the mounted box may be CSS-scaled.
  const sx = ctx.box.width / scene.width;
  const sy = ctx.box.height / scene.height;
  for (const [x, y] of points) {
    ctx.fire("pointermove", { clientX: x * sx, clientY: y * sy });
    ctx.snap(`move ${x},${y}`);
  }
  ctx.fire("pointerleave");
  ctx.snap("leave");
}

const timeDefinition = defineChart({
  marks: [area(rev.slice(0, 90), { x: "t", y: "sales", name: "Sales" }), line(rev.slice(0, 90), { x: "t", y: "cost", name: "Cost" }), ruleY([55], { name: "goal" })],
  scales: { x: { type: "time" } },
  ariaLabel: "Revenue",
  ariaDescription: "Ninety days of revenue.",
});
const pointerScript = (ctx) => {
  hoverAll(ctx);
  ctx.fire("wheel", { clientX: 200, clientY: 120, deltaY: 100 });
  ctx.snap("wheel out");
  ctx.fire("wheel", { clientX: 260, clientY: 120, deltaY: -100 });
  ctx.snap("wheel in");
  ctx.fire("pointerdown", { clientX: 220, clientY: 80 });
  ctx.fire("pointermove", { clientX: 222, clientY: 81 });
  ctx.fire("pointerup", { clientX: 222, clientY: 81 });
  ctx.snap("click");
  ctx.fire("pointerdown", { clientX: 220, clientY: 80 });
  ctx.fire("pointermove", { clientX: 160, clientY: 80 });
  ctx.snap("pan preview");
  ctx.fire("pointermove", { clientX: 120, clientY: 90 });
  ctx.fire("pointerup", { clientX: 120, clientY: 90 });
  ctx.snap("pan commit");
  ctx.fire("pointerdown", { clientX: 220, clientY: 80 });
  ctx.fire("pointermove", { clientX: 300, clientY: 80 });
  ctx.fire("pointercancel", { clientX: 300, clientY: 80 });
  ctx.snap("pan cancel");
  ctx.fire("pointerdown", { clientX: 100, clientY: 80, shiftKey: true });
  ctx.fire("pointermove", { clientX: 260, clientY: 80, shiftKey: true });
  ctx.snap("brush preview");
  ctx.fire("pointerup", { clientX: 260, clientY: 80, shiftKey: true });
  ctx.snap("brush commit");
  const legendEntry = ctx.wrap.querySelector("[data-series]");
  if (legendEntry) {
    // A legend entry toggles on the release of a press on it.
    ctx.fire("pointerdown", { clientX: 20, clientY: 10 }, legendEntry);
    ctx.fire("pointerup", { clientX: 20, clientY: 10 }, legendEntry);
    ctx.snap("legend toggle");
    const again = ctx.wrap.querySelector("[data-series]");
    if (again) {
      ctx.fire("pointerdown", { clientX: 20, clientY: 10 }, again);
      ctx.fire("pointerup", { clientX: 20, clientY: 10 }, again);
    }
    ctx.snap("legend restore");
  }
  ctx.fire("selectstart");
  for (const button of ctx.wrap.querySelectorAll("button")) {
    ctx.fire("pointerdown", { clientX: 10, clientY: 270 }, button);
    ctx.fire("click", {}, button);
    ctx.snap(`preset ${button.textContent}`);
  }
  const nav = [...ctx.wrap.children].find((child) => child.querySelector?.("canvas[aria-hidden='true']"));
  if (nav) {
    ctx.fire("pointerdown", { clientX: 40, clientY: 260 }, nav);
    ctx.fire("wheel", { clientX: 40, clientY: 260, deltaY: 50 }, nav);
    ctx.snap("navigator");
  }
  ctx.handle.setViewport(null);
  ctx.snap("reset viewport");
  ctx.handle.update(timeDefinition, { hiddenSeries: ["Cost"], viewport: { x: [t0 + 5 * DAY, t0 + 40 * DAY] } });
  ctx.snap("update options");
  try {
    ctx.handle.update(defineChart(() => { throw new Error("parity rejected update"); }));
  } catch (error) {
    ctx.snap(`rejected ${error.message}`);
  }
};

for (const renderer of ["svg", "canvas"]) {
  mountScenario(`time-${renderer}`, timeDefinition, { width: 480, height: 280, renderer, idPrefix: `time-${renderer}` }, pointerScript);
  mountScenario(`time-chrome-${renderer}`, timeDefinition, { renderer, interaction: { brush: true, zoom: true, pan: true, rangePresets: true, navigator: true } }, pointerScript);
  mountScenario(`time-static-${renderer}`, timeDefinition, { width: 480, height: 280, renderer, interaction: false }, (ctx) => {
    hoverAll(ctx, 6);
    ctx.fire("wheel", { clientX: 200, clientY: 120, deltaY: 100 });
    ctx.fire("pointerdown", { clientX: 220, clientY: 80 });
    ctx.fire("pointermove", { clientX: 120, clientY: 80 });
    ctx.fire("pointerup", { clientX: 120, clientY: 80 });
    ctx.snap("inert gestures");
    ctx.handle.update(timeDefinition, { interaction: true });
    ctx.snap("interaction enabled");
  });
  for (const [name, spec, [width, height]] of fixtures.filter(([fixture]) => [
    "basic-mixed", "stacked", "area-points", "plugin-lollipop", "plugin-band-probe", "plugin-annotations", "curves", "rule-x",
    "heatmap-basic", "heatmap-dashboard", "bars-negative", "bars-numeric", "histogram-fade", "pie-dashboard", "pie-empty",
    "radar-dashboard", "radar-multi", "dashboard-scatter", "log-y", "theme-light", "theme-custom", "toggles-off", "hidden-series",
    "typed-categories", "single-point-line", "dense-128",
  ].includes(fixture))) {
    mountScenario(`${name}-${renderer}`, defineChart(spec), { width, height, renderer, boxWidth: width * 1.5, boxHeight: height * 1.5 }, (ctx) => {
      hoverAll(ctx);
      const target = ctx.wrap.querySelector("[data-series]");
      if (target) {
        ctx.fire("pointerdown", { clientX: 10, clientY: 10 }, target);
        ctx.fire("pointerup", { clientX: 10, clientY: 10 }, target);
        ctx.snap("legend toggle");
      }
      ctx.fire("pointerdown", { clientX: width / 2, clientY: height / 2 });
      ctx.fire("pointerup", { clientX: width / 2, clientY: height / 2 });
      ctx.snap("select");
    });
  }
}
mountScenario("auto-ids", defineChart({ marks: [area(rows, { x: "month", y: "value" })], ariaDescription: "auto" }), {}, (ctx) => {
  ctx.handle.update(defineChart({ marks: [bar(rows, { x: "month", y: "value" })] }), { renderer: "canvas" });
  ctx.snap("to canvas");
  ctx.handle.update(defineChart({ marks: [bar(rows, { x: "month", y: "value" })] }), { renderer: "svg", width: 300, height: 150 });
  ctx.snap("to svg");
});
dom.window.close();

// ---------------------------------------------------------------------------
// Runtime export surface.

const exportsSurface = Object.keys(chart).sort().map((key) => `${key}:${typeof chart[key]}`);

// ---------------------------------------------------------------------------
// Compare / update

const current = {
  version: 1,
  exports: exportsSurface,
  errors,
  facets: Object.fromEntries(Object.entries(facets).map(([key, value]) => [
    key,
    Object.fromEntries(Object.entries(value).map(([facet, text]) => [facet, hash(text)])),
  ])),
};

if (dumpDir) {
  for (const [key, value] of Object.entries(facets)) {
    for (const [facet, text] of Object.entries(value)) {
      const path = join(dumpDir, `${key.replace(/[^a-z0-9_-]+/gi, "_")}.${facet}.txt`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }
  writeFileSync(join(dumpDir, "errors.json"), JSON.stringify(errors, null, 2));
}

const failures = [];

// Module-size ceiling for the split native compiler and renderer.
for (const dir of ["src/chart/compile", "src/chart/render"]) {
  const abs = resolve(root, dir);
  if (!existsSync(abs)) {
    failures.push(`${dir} is missing; the native compiler/renderer split must stay in place`);
    continue;
  }
  for (const file of readdirSync(abs).filter((entry) => entry.endsWith(".ts"))) {
    const lines = readFileSync(join(abs, file), "utf8").split(/\r?\n/).length;
    if (lines > MAX_MODULE_LINES) failures.push(`${dir}/${file} has ${lines} lines (limit ${MAX_MODULE_LINES}); split it further`);
  }
}

if (update) {
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`[raze-charts] native split parity snapshot written (${Object.keys(current.facets).length} fixtures, ${Object.keys(errors).length} errors)`);
} else {
  if (!existsSync(snapshotPath)) {
    failures.push("tests/fixtures/native-split-parity.json is missing; run with --update on a trusted build");
  } else {
    const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const compare = (label, a, b) => {
      for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
        if (JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key])) failures.push(`${label} ${key} differs`);
      }
    };
    if (JSON.stringify(expected.exports) !== JSON.stringify(current.exports)) {
      failures.push(`runtime export surface differs:\n  expected ${expected.exports.join(", ")}\n  actual   ${current.exports.join(", ")}`);
    }
    compare("error", expected.errors, current.errors);
    for (const key of new Set([...Object.keys(expected.facets), ...Object.keys(current.facets)])) {
      compare(`facet ${key}`, expected.facets[key], current.facets[key]);
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`\nNATIVE SPLIT PARITY: FAIL (${failures.length})`);
  process.exit(1);
}
console.log(`NATIVE SPLIT PARITY: PASS (${Object.keys(current.facets).length} fixtures byte-identical, ${Object.keys(errors).length} validation messages, ${exportsSurface.length} exports)`);
