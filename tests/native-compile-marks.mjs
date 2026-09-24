#!/usr/bin/env node
// W1B-02 regressions: native marks and legend.
//
//   - one formatter per axis: tickFormat reaches tooltips, chips, rule labels
//   - structured hover samples (series id, source row, datum, raw values)
//   - stable series ids, disambiguated default names, reversible legend toggles
//   - wrapping top legend and compacting side legend with `+N more`
//   - theme-aware bar fade, value-only rule labels, palette-coloured points,
//     curve-following ranged areas with an optional lower stroke, zero bars
//
// Runs against the built bundle: `node build.mjs && node tests/native-compile-marks.mjs`.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
  area, bar, compileChart, customMark, defineChart, defineMarkPlugin, hitTestCompiled, line, mountChart,
  paintChartCanvas, parseChartColor, pie, point, radar, ruleX, ruleY, svgFromCompiled,
  LIGHT_CHART_THEME, DARK_CHART_THEME,
} = await import(pathToFileURL(resolve(root, "dist/chart.esm.js")).href);

let checks = 0;
function check(name, fn) {
  if (process.env.RAZE_DEBUG_CHECKS) console.error(`… ${name}`);
  fn();
  checks += 1;
}
const compile = (spec, size = { width: 480, height: 300 }) => compileChart(defineChart(spec), size);

// ---------------------------------------------------------------------------
// One formatter per axis

check("tickFormat reaches the tooltip, last-value chip, bar chip and rule label", () => {
  const money = (value) => `$${Number(value).toFixed(3)}`;
  const rows = [{ x: 1, y: 1.1 }, { x: 2, y: 1.15 }, { x: 3, y: 1.2 }];
  const scene = compile({
    marks: [line(rows, { x: "x", y: "y", name: "Rev" }), ruleY([1.1])],
    scales: { y: { tickFormat: money } },
  });
  assert.ok(scene.yTicks.every((tick) => tick.label.startsWith("$")), "ticks use the formatter");
  const last = scene.samples[scene.samples.length - 1];
  assert.equal(last.tip, "Rev\n3   $1.200", "tooltip formats the value with the axis formatter");
  assert.equal(scene.lastValues[0].label, "$1.200", "last-value chip uses the axis formatter");
  assert.equal(scene.nodes.find((node) => node.role === "rule-label")?.label, "$1.100", "rule label uses the axis formatter");
  assert.equal(scene.lastValues[1].label, "$1.100", "rule chip uses the axis formatter");
  // Hover chips format the raw datum value, never an inverted pixel.
  assert.equal(last.yValue, 1.2);
  assert.equal(scene.formatters.y(last.yValue), "$1.200", "the scene exposes the axis formatter for chips");

  const bars = compile({ marks: [bar([{ c: "A", v: 1.2 }], { x: "c", y: "v", name: "Rev", lastValue: true })], scales: { y: { tickFormat: money } } });
  assert.equal(bars.nodes.find((node) => node.role === "bar").tip, "Rev\nA   $1.200");
  assert.equal(bars.lastValues[0].label, "$1.200");

  const scatter = compile({ marks: [point([{ x: 1, y: 1.2 }], { x: "x", y: "y", name: "P" })], scales: { y: { type: "linear", tickFormat: money } } });
  assert.equal(scatter.samples[0].tip, "P\n1   ·   $1.200");
});

check("hover samples carry series id, source row, datum and raw values", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ x: i, y: i * 2 }));
  const scene = compile({ marks: [line(rows, { x: "x", y: "y", id: "revenue", name: "Revenue" })], viewport: { x: [10, 15] } });
  assert.equal(scene.hoverSamples, scene.samples, "hoverSamples is the structured sample list");
  for (const sample of scene.hoverSamples) {
    assert.equal(sample.seriesId, "revenue");
    assert.equal(sample.markIndex, 0);
    assert.equal(sample.datum, rows[sample.index], "index addresses the source row, even when windowed");
    assert.equal(sample.xValue, sample.datum.x);
    assert.equal(sample.yValue, sample.datum.y);
  }
  assert.ok(scene.hoverSamples.some((sample) => sample.index === 10), "windowed rows keep their source index");

  const radarScene = compile({ marks: [radar([{ a: "x", v: 1 }, { a: "y", v: 2 }, { a: "z", v: 3 }], { x: "a", y: "v" })] });
  assert.deepEqual(radarScene.hoverSamples.map((sample) => [sample.xValue, sample.yValue, sample.index]), [["x", 1, 0], ["y", 2, 1], ["z", 3, 2]]);

  const probe = defineMarkPlugin({
    kind: "probe",
    compile: ({ mapX, mapY }) => ({ nodes: [], samples: [{ x: mapX(2), y: mapY(4), series: "Probe", color: "red", tip: "p", kind: "point" }] }),
  });
  const withPlugin = compile({ marks: [line(rows, { x: "x", y: "y" }), customMark(probe, [], {})], scales: { x: { type: "linear" } } });
  const pluginSample = withPlugin.hoverSamples.find((sample) => sample.series === "Probe");
  assert.equal(pluginSample.seriesId, "mark-1");
  assert.ok(Math.abs(pluginSample.xValue - 2) < 1e-9 && Math.abs(pluginSample.yValue - 4) < 1e-9, "plugin samples recover data values");
});

// ---------------------------------------------------------------------------
// Series identity and legend toggles

check("series with the same default name get two legend entries and separate ids", () => {
  const rows = [{ x: 1, y: 1 }, { x: 2, y: 3 }];
  const scene = compile({ marks: [line(rows, { x: "x", y: "y" }), line(rows, { x: "x", y: "y" })] });
  assert.deepEqual(scene.legend.map((row) => [row.id, row.name, row.hidden]), [["mark-0", "y", false], ["mark-1", "y (2)", false]]);
  assert.notEqual(scene.legend[0].color, scene.legend[1].color);
  const hidden = compile({ marks: [line(rows, { x: "x", y: "y" }), line(rows, { x: "x", y: "y" })], hiddenSeries: ["mark-1"] });
  assert.equal(hidden.nodes.filter((node) => node.role === "line").length, 1, "hiding one id hides only that series");

  const grouped = compile({
    marks: [area(rows, { x: "x", y: "y", name: "Revenue", id: "rev-fill" }), line(rows, { x: "x", y: "y", name: "Revenue" })],
  });
  assert.deepEqual(grouped.legend.map((row) => row.id), ["rev-fill"], "marks sharing an explicit name share one row");
  const groupHidden = compile({
    marks: [area(rows, { x: "x", y: "y", name: "Revenue", id: "rev-fill" }), line(rows, { x: "x", y: "y", name: "Revenue" })],
    hiddenSeries: ["rev-fill"],
  });
  assert.equal(groupHidden.nodes.filter((node) => node.series === "Revenue").length, 0, "toggling the row hides the whole group");

  assert.throws(
    () => compile({ marks: [line(rows, { x: "x", y: "y", id: "a" }), line(rows, { x: "x", y: "y", id: "a" })] }),
    (error) => error.code === "E_MARK_OPTION" && /duplicates/.test(error.message),
  );
  assert.throws(
    () => compile({ marks: [line(rows, { x: "x", y: "y" }), line(rows, { x: "x", y: "y", id: "mark-0" })] }),
    (error) => error.code === "E_MARK_OPTION" && /default id/.test(error.message),
  );
  assert.throws(() => compile({ marks: [line(rows, { x: "x", y: "y", id: "" })] }), (error) => error.code === "E_MARK_OPTION");
});

const salesRows = [
  { m: "Jan", a: 10, b: 4 }, { m: "Feb", a: 20, b: 8 }, { m: "Mar", a: 15, b: 6 }, { m: "Apr", a: 18, b: 12 },
];
const toggleSpec = (hiddenSeries) => ({
  marks: [line(salesRows, { x: "m", y: "a", name: "A" }), bar(salesRows, { x: "m", y: "b", name: "B" })],
  ...(hiddenSeries ? { hiddenSeries } : {}),
});
const sceneKey = (scene) => JSON.stringify({
  svg: svgFromCompiled(scene, { idPrefix: "k" }),
  nodes: scene.nodes,
  legend: scene.legend,
  samples: scene.samples.map(({ datum, ...rest }) => rest),
  lastValues: scene.lastValues,
});

check("toggling A off keeps its row and B's colour; toggling back restores the original scene", () => {
  const original = compile(toggleSpec());
  const hidden = compile(toggleSpec(["mark-0"]));
  assert.deepEqual(hidden.legend.map((row) => [row.name, row.hidden]), [["A", true], ["B", false]]);
  assert.equal(hidden.legend[1].color, original.legend[1].color, "hiding A never recolours B");
  assert.ok(!hidden.nodes.some((node) => node.series === "A"));
  assert.equal(hidden.legendLayout.rows[0].hidden, true, "the layout keeps the hidden row");
  assert.equal(hidden.margin.top, original.margin.top, "the legend band does not move while toggling");
  const restored = compile(toggleSpec([]));
  assert.equal(sceneKey(restored), sceneKey(original));
  // Legacy name keys still work.
  assert.equal(compile(toggleSpec(["A"])).legend[0].hidden, true);

  const svg = svgFromCompiled(hidden, { idPrefix: "t" });
  assert.match(svg, /<g data-series="mark-0" data-hidden="true" opacity="0\.42"/, "hidden rows render dimmed and keyed by id");
  assert.match(svg, /<g data-series="mark-1" style="cursor:pointer"/);
});

check("a mounted legend toggles a series off and back on through its row id", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  try {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = mountChart(host, defineChart(toggleSpec()), { width: 480, height: 300 });
    const original = sceneKey(handle.getScene());
    const click = () => {
      const entry = host.querySelector('[data-series="mark-0"]');
      assert.ok(entry, "the A row is always present");
      entry.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    };
    click();
    assert.equal(handle.getScene().legend[0].hidden, true, "first click hides A");
    assert.ok(!handle.getScene().nodes.some((node) => node.series === "A"));
    click();
    assert.equal(sceneKey(handle.getScene()), original, "second click restores the original scene");
    handle.destroy();
  } finally {
    dom.window.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
  }
});

check("pie slices hide individually, keep their rows and colours", () => {
  const flow = [{ n: "Organic", v: 44 }, { n: "Paid", v: 31 }, { n: "Referral", v: 16 }, { n: "Direct", v: 9 }];
  const full = compile({ marks: [pie(flow, { valueKey: "v", labelKey: "n" })] });
  assert.deepEqual(full.legend.map((row) => row.id), ["mark-0/Organic", "mark-0/Paid", "mark-0/Referral", "mark-0/Direct"]);
  const hidden = compile({ marks: [pie(flow, { valueKey: "v", labelKey: "n" })], hiddenSeries: ["mark-0/Paid"] });
  assert.equal(hidden.legend[1].hidden, true);
  assert.equal(hidden.nodes.filter((node) => node.role === "slice").length, 3);
  assert.deepEqual(hidden.legend.map((row) => row.color), full.legend.map((row) => row.color));
  assert.equal(hidden.legend[0].detail, "64%  ·  44", "percentages are of the visible total");
  const none = compile({ marks: [pie(flow, { valueKey: "v", labelKey: "n" })], hiddenSeries: flow.map((row) => row.n) });
  assert.equal(none.nodes.find((node) => node.role === "hole")?.label, "All slices hidden");
  assert.equal(none.legendPlacement, "right");
});

// ---------------------------------------------------------------------------
// Legend layout

function assertNoOverlap(boxes, label) {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
      assert.ok(!overlap, `${label}: boxes ${i} and ${j} overlap`);
    }
  }
}

const twelve = Array.from({ length: 12 }, (_, i) => line(
  salesRows.map((row) => ({ ...row, a: row.a + i })),
  // lastValue: false keeps twelve stacked chips out of the chip layout (W1B-03 owns its collision fix).
  { x: "m", y: "a", name: `Portfolio ${i + 1}`, lastValue: false },
));

check("12 series at 480x300 wrap the top legend and grow the top margin", () => {
  const scene = compile({ marks: twelve });
  const { legendLayout: layout } = scene;
  assert.equal(layout.rows.length, 12, "every series is listed");
  assert.equal(layout.overflow, 0);
  const lines = new Set(layout.rows.map((row) => row.box.y)).size;
  assert.ok(lines >= 2, "the legend wraps");
  assert.equal(scene.margin.top, 28 + (lines - 1) * 16, "the top margin grows one row per extra line");
  assert.ok(layout.rows.every((row) => row.box.x + row.box.w <= scene.width - 8), "no row runs off the right edge");
  assert.ok(Math.max(...layout.rows.map((row) => row.box.y + row.box.h)) <= scene.plot.y, "rows sit above the plot");
  assertNoOverlap(layout.rows.map((row) => row.box), "top legend");
  const svg = svgFromCompiled(scene, { idPrefix: "w" });
  for (const row of layout.rows) assert.ok(svg.includes(`data-series="${row.id}"`));
});

check("an overflowing top legend summarises the rest as +N more", () => {
  const many = Array.from({ length: 60 }, (_, i) => line(salesRows, { x: "m", y: "a", name: `Long series name ${i + 1}`, lastValue: false }));
  const scene = compile({ marks: many });
  const { legendLayout: layout } = scene;
  assert.ok(layout.overflow > 0);
  assert.equal(layout.rows.length + layout.overflow, 60);
  assert.equal(layout.more.label, `+${layout.overflow} more`);
  assert.equal(layout.more.names.length, layout.overflow);
  assert.ok(layout.more.box.x + layout.more.box.w <= scene.width - 8, "the summary fits on the last row");
  assert.ok(scene.margin.top <= scene.height * 0.3 + 28, "the legend never takes over the chart");
  assertNoOverlap([...layout.rows.map((row) => row.box), layout.more.box], "overflowing legend");
  assert.match(svgFromCompiled(scene, { idPrefix: "m" }), /<g data-role="legend-more"><title>Long series name/);
  const explicit = compile({ marks: many, margin: { top: 28 } });
  assert.equal(explicit.margin.top, 28, "an explicit top margin is respected");
  assert.equal(new Set(explicit.legendLayout.rows.map((row) => row.box.y)).size, 1, "and caps the legend to the rows that fit");
  const long = compile({ marks: [line(salesRows, { x: "m", y: "a", name: "An extremely long series name that cannot possibly fit on one legend line at all" })] }, { width: 240, height: 200 });
  assert.ok(long.legendLayout.rows[0].label.endsWith("…"), "an over-long name is truncated");
  assert.ok(long.legendLayout.rows[0].box.x + long.legendLayout.rows[0].box.w <= 240 - 8);
});

check("12 pie slices at 480x300 compact the side legend; more slices show +N more", () => {
  const slices = (n) => Array.from({ length: n }, (_, i) => ({ name: `Segment ${i + 1}`, value: n + 1 - i }));
  const four = compile({ marks: [pie(slices(4), { valueKey: "value", labelKey: "name" })] });
  assert.equal(four.legendLayout.rowStyle, "stacked", "few slices keep the two-line rows");
  const twelveSlices = compile({ marks: [pie(slices(12), { valueKey: "value", labelKey: "name" })] });
  const layout = twelveSlices.legendLayout;
  assert.equal(layout.rowStyle, "compact");
  assert.equal(layout.rows.length, 12, "all 12 slices fit once rows compact to 20px");
  assert.ok(layout.rows.every((row) => row.box.h === 20));
  assert.ok(layout.rows.every((row) => row.box.y >= twelveSlices.plot.y && row.box.y + row.box.h <= twelveSlices.plot.y + twelveSlices.plot.h));
  assertNoOverlap(layout.rows.map((row) => row.box), "side legend");
  const thirty = compile({ marks: [pie(slices(30), { valueKey: "value", labelKey: "name" })] });
  assert.ok(thirty.legendLayout.overflow > 0);
  assert.equal(thirty.legendLayout.more.label, `+${thirty.legendLayout.overflow} more`);
  assert.ok(thirty.legendLayout.more.box.y + thirty.legendLayout.more.box.h <= thirty.plot.y + thirty.plot.h);
  const shortPie = compile({ marks: [pie(slices(12), { valueKey: "value", labelKey: "name" })] }, { width: 480, height: 200 });
  assert.ok(shortPie.legendLayout.more, "12 slices in a 200px pie summarise the rest");
  assert.equal(shortPie.legendLayout.rows.length + shortPie.legendLayout.overflow, 12);
});

check("Canvas paints the legend in the compiled boxes, dimming hidden rows", () => {
  const calls = [];
  const state = { globalAlpha: 1 };
  const ctx = new Proxy({}, {
    get(_, prop) {
      if (prop in state) return state[prop];
      if (prop === "createLinearGradient") return () => ({ addColorStop() {} });
      if (prop === "measureText") return (text) => ({ width: text.length * 5 });
      return (...args) => calls.push([prop, ...args, state.globalAlpha]);
    },
    set(_, prop, value) { state[prop] = value; return true; },
  });
  const scene = compile(toggleSpec(["mark-1"]));
  paintChartCanvas(ctx, scene);
  const [a, b] = scene.legendLayout.rows;
  const text = (label) => calls.find(([name, value]) => name === "fillText" && value === label);
  assert.equal(text("A")[2], a.box.x + 12 + 5);
  assert.equal(text("B")[2], b.box.x + 8 + 5);
  assert.equal(text("B")[4], 0.42, "the hidden row paints at reduced opacity");
  assert.equal(text("A")[4], 1);
});

// ---------------------------------------------------------------------------
// Marks

function contrast(a, b) {
  const lum = (hex) => {
    const { r, g, b: blue } = parseChartColor(hex);
    const channel = (value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(blue);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

check("bar fade mixes toward the theme background", () => {
  const vol = Array.from({ length: 12 }, (_, i) => ({ t: `D${i}`, v: 10 + i }));
  const light = compile({ marks: [bar(vol, { x: "t", y: "v", fade: true, fill: "#0f766e" })], theme: "light" });
  const lightBars = light.nodes.filter((node) => node.role === "bar");
  assert.ok(contrast(lightBars[0].fill, LIGHT_CHART_THEME.background) <= 1.5, "the first bar fades into the light pane");
  assert.equal(lightBars[lightBars.length - 1].fill, "rgb(15,118,110)", "the last bar keeps the full colour");
  const dark = compile({ marks: [bar(vol, { x: "t", y: "v", fade: true, fill: "#8ecae6" })] });
  const first = parseChartColor(dark.nodes.find((node) => node.role === "bar").fill);
  const background = parseChartColor(DARK_CHART_THEME.background);
  const fill = parseChartColor("#8ecae6");
  for (const key of ["r", "g", "b"]) {
    assert.ok(Math.abs(first[key] - (background[key] + (fill[key] - background[key]) * 0.22)) <= 1, "dark fades toward the dark pane");
  }
  // The dark look is kept: the old fade target (#1b1e20) sits within 11 levels of the dark pane (#181615),
  // so the earliest bar moves by at most 0.78 * 11 levels per channel.
  const legacy = parseChartColor("#1b1e20");
  for (const key of ["r", "g", "b"]) {
    assert.ok(Math.abs(first[key] - (legacy[key] + (fill[key] - legacy[key]) * 0.22)) <= 9, "dark fades look as before");
  }
});

check("unnamed rules label only the value; rules take label, position and dash options", () => {
  const rows = [{ x: 0, y: 0 }, { x: 10, y: 20 }];
  const labels = (scene) => scene.nodes.filter((node) => node.role === "rule-label");
  const plain = compile({ marks: [line(rows, { x: "x", y: "y" }), ruleY([5]), ruleX([4])] });
  assert.deepEqual(labels(plain).map((node) => node.label), ["5", "4"], "no internal 'y' or 'ruleX' leaks into labels");
  const named = compile({ marks: [line(rows, { x: "x", y: "y" }), ruleY([5], { name: "Goal" })] });
  assert.equal(labels(named)[0].label, "Goal  5");
  const off = compile({ marks: [line(rows, { x: "x", y: "y" }), ruleY([5], { name: "Goal", label: false })] });
  assert.equal(labels(off).length, 0);
  assert.equal(off.lastValues.length, 2, "label: false keeps the axis chip");
  const custom = compile({
    marks: [line(rows, { x: "x", y: "y" }), ruleY([5], { label: "Target", labelPosition: "end", dashed: false, stroke: "#dc2626" })],
  });
  const [text] = labels(custom);
  assert.equal(text.label, "Target");
  assert.equal(text.anchor, "end");
  assert.equal(text.x, custom.plot.x + custom.plot.w - 6);
  assert.equal(text.fill, "#dc2626", "labels match their rule's colour");
  const rule = custom.nodes.find((node) => node.role === "rule");
  assert.equal(rule.dashed, false);
  assert.ok(!svgFromCompiled(custom).includes('stroke="#dc2626" stroke-dasharray'), "solid rules render without a dash");
  const middle = compile({ marks: [line(rows, { x: "x", y: "y" }), ruleX([5], { labelPosition: "middle" })] });
  assert.equal(labels(middle)[0].y, middle.plot.y + middle.plot.h / 2);
  const edge = compile({ marks: [line(rows, { x: "x", y: "y" }), ruleX([10], { label: "Release" })] });
  assert.equal(labels(edge)[0].anchor, "end", "labels at the right edge flip inside the plot");
  for (const [option, value] of [["label", 3], ["labelPosition", "top"], ["dashed", "no"]]) {
    assert.throws(() => compile({ marks: [ruleY([1], { [option]: value })] }), (error) => error.code === "E_MARK_OPTION", option);
  }
});

check("default points use the series colour and one radius, matching the legend", () => {
  const dots = Array.from({ length: 30 }, (_, i) => ({ x: i, y: (i * 7) % 23 }));
  const scene = compile({ marks: [point(dots, { x: "x", y: "y", name: "Samples" })], scales: { x: { type: "linear" } } });
  const circles = scene.nodes.filter((node) => node.role === "point");
  assert.equal(new Set(circles.map((node) => node.fill)).size, 1, "no value-driven colour ramp");
  assert.equal(new Set(circles.map((node) => node.r)).size, 1, "no invented size encoding");
  assert.equal(circles[0].fill, scene.legend[0].color, "the legend swatch matches the painted fill");
  assert.equal(scene.legend[0].color, scene.samples[0].color);
  assert.equal(scene.legendLayout.rows[0].symbol, "circle");
  const explicit = compile({ marks: [point(dots, { x: "x", y: "y", fill: "#123456", r: 6 })], scales: { x: { type: "linear" } } });
  assert.ok(explicit.nodes.filter((node) => node.role === "point").every((node) => node.fill === "#123456" && node.r === 6));
});

function cubicAt(p0, c1, c2, p3, u) {
  const v = 1 - u;
  return {
    x: v ** 3 * p0.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u ** 3 * p3.x,
    y: v ** 3 * p0.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u ** 3 * p3.y,
  };
}

/** Points on the renderer's monotone path, read back from the SVG `d` of a line. */
function samplePath(d) {
  const numbers = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  let p0 = { x: numbers[0], y: numbers[1] };
  const out = [p0];
  for (let i = 2; i + 5 < numbers.length + 1; i += 6) {
    const c1 = { x: numbers[i], y: numbers[i + 1] };
    const c2 = { x: numbers[i + 2], y: numbers[i + 3] };
    const p3 = { x: numbers[i + 4], y: numbers[i + 5] };
    for (let k = 1; k <= 20; k++) out.push(cubicAt(p0, c1, c2, p3, k / 20));
    p0 = p3;
  }
  return out;
}

function distanceToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

check("a ranged area's fill follows the stroke's monotone curve on both edges", () => {
  const band = [
    { x: 0, hi: 12, lo: 8 }, { x: 1, hi: 20, lo: 11 }, { x: 2, hi: 9, lo: 4 }, { x: 3, hi: 16, lo: 12 }, { x: 4, hi: 25, lo: 15 },
  ];
  const scene = compile({
    marks: [area(band, { x: "x", y: "hi", y0: "lo", name: "Band", stroke0: true, lastValue: false })],
    scales: { x: { type: "linear" } },
  }, { width: 400, height: 240 });
  const fill = scene.nodes.find((node) => node.role === "ranged-area");
  const upper = scene.nodes.find((node) => node.role === "line");
  const lower = scene.nodes.find((node) => node.role === "ranged-lower");
  assert.ok(lower, "stroke0 draws the lower edge");
  assert.equal(lower.curve, "monotone");
  assert.equal(lower.stroke, upper.stroke, "stroke0: true uses the series colour");
  assert.ok(fill.points.length > upper.points.length + lower.points.length, "the fill is flattened from the curve");
  const svg = svgFromCompiled(scene, { idPrefix: "band" });
  const paths = [...svg.matchAll(/<path fill="none"[^>]* d="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(paths.length, 2, "upper and lower strokes");
  // Every point of both stroked curves lies on the fill outline (within 0.6px).
  for (const d of paths) {
    for (const point of samplePath(d)) {
      assert.ok(distanceToPolyline(point, fill.points) < 0.6, `stroke point ${point.x},${point.y} leaves the fill edge`);
    }
  }
  const stepped = compile({ marks: [area(band, { x: "x", y: "hi", y0: "lo", curve: "step" })], scales: { x: { type: "linear" } } });
  const stepFill = stepped.nodes.find((node) => node.role === "ranged-area");
  assert.equal(stepFill.points.length, (band.length * 2 - 1) * 2, "step bands trace both edges as steps");
  assert.throws(() => compile({ marks: [area(band, { x: "x", y: "hi", stroke0: true })] }), (error) => error.code === "E_MARK_OPTION");
});

check("zero bars paint nothing but stay hoverable; minBarHeight adds a stub", () => {
  const rows = [{ c: "A", v: 0 }, { c: "B", v: 5 }, { c: "C", v: 0.001 }];
  const scene = compile({ marks: [bar(rows, { x: "c", y: "v", name: "Volume" })] });
  const visible = scene.nodes.filter((node) => node.role === "bar" && node.fillOpacity !== 0);
  assert.equal(visible[0].h, 0, "a zero value has no height");
  assert.equal(visible[2].h, 0, "a sub-pixel value rounds to nothing");
  assert.ok(visible[1].h > 50);
  const proxies = scene.nodes.filter((node) => node.role === "bar" && node.fillOpacity === 0);
  assert.equal(proxies.length, 2, "invisible hit targets for the empty bars");
  const zero = visible[0];
  const hit = hitTestCompiled(scene, zero.x + zero.w / 2, zero.y + 1);
  assert.equal(hit?.tip, "Volume\nA   0", "the zero bar is hoverable at its baseline");
  assert.ok(!svgFromCompiled(scene).includes('height="0" rx'), "no degenerate rounded rect");
  const stub = compile({ marks: [bar(rows, { x: "c", y: "v", minBarHeight: 3 })] });
  const stubBars = stub.nodes.filter((node) => node.role === "bar" && node.fillOpacity !== 0);
  assert.equal(stubBars[0].h, 0, "minBarHeight never invents a value for zero");
  assert.equal(stubBars[2].h, 3, "tiny values get the stub");
  assert.equal(stubBars[2].y + stubBars[2].h, Math.round(stub.yScale.map(0)), "the stub grows up from the baseline");
  const negative = compile({ marks: [bar([{ c: "A", v: -0.001 }, { c: "B", v: 5 }], { x: "c", y: "v", minBarHeight: 4 })] });
  const down = negative.nodes.find((node) => node.role === "bar");
  assert.equal(down.y, Math.round(negative.yScale.map(0)), "negative stubs grow down from the baseline");
  assert.equal(down.h, 4);
  assert.throws(() => compile({ marks: [bar(rows, { x: "c", y: "v", minBarHeight: -1 })] }), (error) => error.code === "E_MARK_OPTION");
});

console.log(`NATIVE COMPILE MARKS: PASS (${checks} checks)`);
