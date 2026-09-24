#!/usr/bin/env node
// Native compile: tick precision, Intl-cached formatting, measured axis
// margins with compact notation, measured x-label thinning/rotation, the
// date-aware viewport, calendar time ticks and heatmap value formats.
//
// Formatting and measurement helpers are internal, so they are bundled from
// source with esbuild; everything else runs through the public /chart bundle.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = await import(pathToFileURL(resolve(root, "dist/chart.esm.js")).href);
const { ChartCompileError, area, bar, compileChart, defineChart, heatmap, line, svgFromCompiled } = chart;

const workdir = mkdtempSync(join(tmpdir(), "raze-native-axes-"));
let internals;
try {
  const outfile = join(workdir, "internals.mjs");
  await build({
    stdin: {
      contents: [
        'export * from "./src/chart/compile/format.ts";',
        'export { measureText, ellipsize, TIME_TICK_SPACING } from "./src/chart/compile/axes.ts";',
        'export { crosshairCategoryLabel, crosshairValueLabel } from "./src/chart/render/chips.ts";',
        'export { calendarTicks, TickWeight, tickLevel } from "./src/util/time/calendarTicks.ts";',
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  internals = await import(pathToFileURL(outfile).href);
} finally {
  // The module is loaded; the directory can go.
  process.on("exit", () => rmSync(workdir, { recursive: true, force: true }));
}
const {
  decimalsOf, formatFixed, formatNum, heatmapValueFormatter, numericTickLabels, timeValueFormatter, valueFormatter,
  measureText, ellipsize, TIME_TICK_SPACING, crosshairCategoryLabel, crosshairValueLabel,
  calendarTicks, TickWeight, tickLevel,
} = internals;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const compile = (marks, extra = {}, size = { width: 600, height: 300 }) => compileChart(defineChart({ marks, ...extra }), size);
const decimals = (label) => (label.split(".")[1] ?? "").replace(/[^0-9]/g, "").length;
const DAY = 86_400_000;

// Seeded RNG so the property tests are reproducible.
let seed = 0x2f6b1a;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// ---------------------------------------------------------------------------
// Precision helpers

check("decimalsOf ignores binary noise and caps", () => {
  assert.equal(decimalsOf(1.085), 3);
  assert.equal(decimalsOf(1.08523), 5);
  assert.equal(decimalsOf(0.1 + 0.2), 1);
  assert.equal(decimalsOf(100), 0);
  assert.equal(decimalsOf(-0.0005), 4);
  assert.equal(decimalsOf(Math.PI), 8, "irrational values hit the cap");
  assert.equal(decimalsOf(Math.PI, 3), 3);
});

check("tick decimals come from the tick step", () => {
  assert.deepEqual(numericTickLabels([1.085, 1.0855, 1.086, 1.0865, 1.087]), ["1.0850", "1.0855", "1.0860", "1.0865", "1.0870"]);
  assert.deepEqual(numericTickLabels([0.1, 0.105, 0.11, 0.115, 0.12]), ["0.100", "0.105", "0.110", "0.115", "0.120"]);
  assert.deepEqual(numericTickLabels([1, 1.05, 1.1, 1.15, 1.2]), ["1.00", "1.05", "1.10", "1.15", "1.20"]);
  assert.deepEqual(numericTickLabels([0, 500, 1000, 1500]), ["0", "500", "1,000", "1,500"]);
  assert.deepEqual(numericTickLabels([-1, -0.5, 0, 0.5]), ["-1.0", "-0.5", "0.0", "0.5"], "no -0.0");
});

check("ticks of a million and more share one compact unit", () => {
  assert.deepEqual(
    numericTickLabels([0, 2e11, 4e11, 6e11, 8e11, 1e12, 1.2e12]),
    ["0", "0.2T", "0.4T", "0.6T", "0.8T", "1.0T", "1.2T"],
  );
  assert.deepEqual(numericTickLabels([1e6, 1.5e6, 2e6]), ["1.0M", "1.5M", "2.0M"]);
  assert.deepEqual(numericTickLabels([999_000_000, 999_500_000, 1_000_000_000]), ["0.9990B", "0.9995B", "1.0000B"]);
});

check("log ticks keep three significant digits and stay distinct", () => {
  const labels = numericTickLabels([1, 10 ** 0.2, 10 ** 0.4, 10 ** 0.6, 10 ** 0.8, 10], true);
  assert.deepEqual(labels, ["1", "1.58", "2.51", "3.98", "6.31", "10"]);
});

check("single values keep their own precision, grouping and compact notation", () => {
  assert.equal(formatNum(1.08523), "1.08523");
  assert.equal(formatNum(12345.5), "12,345.5");
  assert.equal(formatNum(1_200_000_000_000), "1.2T");
  assert.equal(formatNum(1_234_567), "1.23457M", "compact values keep six significant digits");
  assert.equal(formatNum(25_000_400), "25.0004M", "compact notation never hides the data (not 25.00M)");
  assert.equal(formatNum(1_000_050), "1.00005M");
  assert.equal(formatNum(-2_500_000), "-2.5M");
  assert.equal(formatNum(0.00123), "0.00123");
  assert.equal(formatNum(1.2e-8), "1.2e-8");
  assert.equal(formatNum(100.60553987364), "100.606", "computed floats show six significant digits");
  assert.equal(formatNum(Number.NaN), "");
});

check("value formatters use the series' data precision", () => {
  const fx = valueFormatter([1.085, 1.08523, 1.0851]);
  assert.equal(fx(1.085), "1.08500");
  assert.equal(fx(1.08523), "1.08523");
  const counts = valueFormatter([1, 2, 3000]);
  assert.equal(counts(3000), "3,000");
  const capped = valueFormatter([0.123456789, 0.5]);
  assert.equal(capped(0.5), "0.500", "unquantised data prints at 1/100 of its span (span 0.38)");
  const sine = valueFormatter(Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i)));
  assert.equal(sine(100.60553987), "100.61");
  const quoted8 = valueFormatter([0.00001234, 0.00002]);
  assert.equal(quoted8(0.00001234), "0.00001234", "eight quoted decimals are kept");
  assert.equal(valueFormatter([1, 2])(2_500_000), "2.5M");
});

check("time values print the data's calendar resolution", () => {
  const days = timeValueFormatter([Date.UTC(2025, 8, 9), Date.UTC(2025, 8, 10)]);
  assert.equal(days(Date.UTC(2025, 8, 9)), "9 Sep");
  const years = timeValueFormatter([Date.UTC(2024, 0, 1), Date.UTC(2025, 5, 1)]);
  assert.equal(years(new Date(Date.UTC(2024, 11, 31))), "31 Dec 2024");
  const minutes = timeValueFormatter([Date.UTC(2025, 8, 9, 13, 30), Date.UTC(2025, 8, 9, 13, 31)]);
  assert.equal(minutes(Date.UTC(2025, 8, 9, 13, 30)), "9 Sep 13:30");
  const seconds = timeValueFormatter([Date.UTC(2025, 8, 9, 13, 30, 5)]);
  assert.equal(seconds(Date.UTC(2025, 8, 9, 13, 30, 5)), "9 Sep 13:30:05");
});

check("heatmap value presets", () => {
  const values = [1234.5, -3, 0, 2.25];
  assert.equal(heatmapValueFormatter(undefined, values)(1234.5), "1,234.50");
  assert.equal(heatmapValueFormatter("number", [1234.5, -3])(1234.5), "1,234.5");
  assert.equal(heatmapValueFormatter("percent", [12.5])(12.5), "12.5%");
  assert.equal(heatmapValueFormatter("signed", [2.4, -1])(2.4), "+2.4");
  assert.equal(heatmapValueFormatter("signed", [2.4, -1])(-1), "-1.0");
  assert.equal(heatmapValueFormatter("signed-percent", [2.4, 0])(0), "0.0%", "zero is never signed");
  assert.equal(heatmapValueFormatter((value) => `${value} ms`, [])(12), "12 ms");
  assert.throws(() => heatmapValueFormatter(() => 12, [])(1), /must return a string/);
});

check("label measurement and ellipsis", () => {
  assert.equal(measureText("1234", 9, "ui-monospace, monospace"), 4 * 0.6 * 9);
  assert.equal(measureText("東京", 10, "monospace"), 2 * 1.2 * 10, "wide characters take two cells");
  assert.ok(measureText("WWW", 10, "Inter, sans-serif") > measureText("iii", 10, "Inter, sans-serif"));
  const measure = (text) => measureText(text, 9, "monospace");
  assert.equal(ellipsize("North America", 40, measure), "North…");
  assert.equal(ellipsize("Europe", 100, measure), "Europe");
  assert.ok(measure(ellipsize("x".repeat(200), 50, measure)) <= 50);
});

// ---------------------------------------------------------------------------
// Compiled scenes: tick precision

function assertUniformTicks(scene, name) {
  const labels = scene.yTicks.map((tick) => tick.label);
  assert.equal(new Set(labels).size, labels.length, `${name}: unique y labels (${labels.join(", ")})`);
  const counts = new Set(labels.map(decimals));
  assert.equal(counts.size, 1, `${name}: uniform decimals (${labels.join(", ")})`);
}

check("FX, 0.10-0.12 and 1.0-1.2 axes get unique, uniformly formatted labels", () => {
  const fxRows = Array.from({ length: 40 }, (_, i) => ({ t: new Date(Date.UTC(2025, 0, 1) + i * DAY), v: 1.085 + (i % 5) * 0.0005 }));
  const fx = compile([line(fxRows, { x: "t", y: "v", name: "EURUSD" })]);
  assertUniformTicks(fx, "FX");
  assert.ok(fx.yTicks.every((tick) => decimals(tick.label) >= 4), `FX ticks read 1.0850…: ${fx.yTicks.map((t) => t.label)}`);
  // Chips and tooltips format through scene.formatters.y (W1B-02 routes the
  // mark compilers through it); until then a chip keeps its own value's precision.
  assert.equal(fx.formatters.y(1.087), "1.0870", "value formatter uses the series' data precision");
  assert.equal(Number(fx.lastValues[0].label), 1.087);
  const sample = fx.samples[fx.samples.length - 1];
  const hover = { hit: null, sample, isBar: false, isLine: true, isPoint: false, scanX: sample.x, scanY: sample.y, y: sample.y };
  assert.equal(crosshairValueLabel(fx, hover), "1.0870", "the hover chip uses data precision, not toFixed(1)");
  for (const [lo, hi] of [[0.1, 0.12], [1.0, 1.2], [1.0834, 1.0871], [98_000, 104_000]]) {
    const rows = Array.from({ length: 12 }, (_, i) => ({ x: i, y: lo + ((hi - lo) * i) / 11 }));
    assertUniformTicks(compile([line(rows, { x: "x", y: "y" })]), `${lo}-${hi}`);
  }
});

// ---------------------------------------------------------------------------
// Measured value axis

function yLabelLeft(scene, tick) {
  return scene.width - 7 - measureText(tick.label, 9, scene.theme.font);
}

check("1.2e12 labels are compact and never overlap the plot", () => {
  const rows = [1.2e12, 1.4e12, 1.5e12, 1.1e12].map((y, x) => ({ x, y }));
  const scene = compile([area(rows, { x: "x", y: "y", name: "Large" })]);
  assert.ok(scene.yTicks.every((tick) => /^(0|\d+(\.\d+)?T)$/.test(tick.label)), scene.yTicks.map((t) => t.label).join(" "));
  const plotRight = scene.plot.x + scene.plot.w;
  for (const tick of scene.yTicks) assert.ok(yLabelLeft(scene, tick) >= plotRight + 4, `"${tick.label}" clears the plot`);
  assert.equal(scene.lastValues[0].label, "1.1T");
  assert.ok(measureText(scene.lastValues[0].label, 10, scene.theme.font) + 18 <= scene.margin.right, "the chip text fits its gutter");
  assert.equal(scene.axes.y.size, scene.width - plotRight);
});

function assertChipsFit(scene, name) {
  assert.ok(scene.lastValues.length > 0, `${name}: has a chip`);
  for (const chip of scene.lastValues) {
    const text = measureText(chip.label, 10, scene.theme.font);
    assert.ok(text + 18 <= scene.width - scene.plot.x - scene.plot.w + 1e-9, `${name}: chip "${chip.label}" (${text}px) fits its ${scene.margin.right}px gutter`);
  }
}

check("last-value chips of computed series fit their gutter", () => {
  let level = 100;
  const walk = Array.from({ length: 200 }, (_, x) => ({ x, y: (level += rnd() - 0.5) }));
  const sine = Array.from({ length: 50 }, (_, x) => ({ x, y: Math.sin(x / 5) }));
  const average = walk.map((row, x) => ({ x, y: walk.slice(Math.max(0, x - 9), x + 1).reduce((sum, r) => sum + r.y, 0) / Math.min(10, x + 1) }));
  for (const [name, rows] of [["random walk", walk], ["sine", sine], ["moving average", average]]) {
    for (const width of [320, 600]) assertChipsFit(compile([line(rows, { x: "x", y: "y" })], {}, { width, height: 260 }), `${name} @ ${width}px`);
  }
  assertChipsFit(compile([
    line(sine, { x: "x", y: "y", name: "a" }),
    line(Array.from({ length: 10 }, (_, x) => ({ x, y: x * 0.123456 })), { x: "x", y: "y", name: "b" }),
  ]), "two series");
  assertChipsFit(compile([bar(sine.slice(0, 12), { x: "x", y: "y", lastValue: true })]), "bar chip");
  // A disabled chip does not widen the gutter.
  const quiet = compile([line(sine, { x: "x", y: "y", lastValue: false })]);
  assert.equal(quiet.lastValues.length, 0);
  assert.equal(quiet.margin.right, 56);
});

check("compact chips and tooltips keep the data (25,000,400 is not 25.00M)", () => {
  const rows = Array.from({ length: 10 }, (_, x) => ({ x, y: 25_000_000 + (400 * x) / 9 }));
  rows[9].y = 25_000_400;
  const scene = compile([line(rows, { x: "x", y: "y", name: "Volume" })]);
  assert.equal(scene.lastValues[0].label, "25.0004M");
  assert.match(scene.samples[scene.samples.length - 1].tip, /25\.0004M$/);
  assert.ok(scene.yTicks.every((tick) => /^25\.000\dM$/.test(tick.label)), scene.yTicks.map((t) => t.label).join(" "));
  assert.equal(valueFormatter([1_000_000, 1_000_050])(1_000_050), "1.00005M");
  assertChipsFit(scene, "compact");
});

check("long custom labels widen the value axis up to a cap, then ellipsize", () => {
  const rows = Array.from({ length: 5 }, (_, x) => ({ x, y: 1000 + x * 250 }));
  const money = compile([line(rows, { x: "x", y: "y" })], { scales: { y: { tickFormat: (v) => `$${Number(v).toFixed(2)} USD` } } });
  const plotRight = money.plot.x + money.plot.w;
  assert.ok(money.margin.right > 56, "the gutter grew");
  for (const tick of money.yTicks) assert.ok(yLabelLeft(money, tick) >= plotRight + 4);
  const huge = compile([line(rows, { x: "x", y: "y" })], { scales: { y: { tickFormat: (v) => `${"label ".repeat(20)}${v}` } } }, { width: 400, height: 300 });
  assert.ok(huge.margin.right <= 400 * 0.35 + 1, "the gutter is capped");
  assert.ok(huge.yTicks.every((tick) => tick.label.endsWith("…")), "overlong labels are cut");
  for (const tick of huge.yTicks) assert.ok(yLabelLeft(huge, tick) >= huge.plot.x + huge.plot.w + 4);
  const pinned = compile([line(rows, { x: "x", y: "y" })], { margin: { right: 40 }, scales: { y: { tickFormat: (v) => `${v} units` } } });
  assert.equal(pinned.margin.right, 40, "explicit margins are never changed");
  assert.ok(pinned.yTicks.every((tick) => measureText(tick.label, 9, pinned.theme.font) <= 40 - 13));
  const short = compile([line(rows, { x: "x", y: "y" })]);
  assert.equal(short.margin.right, 56, "short labels keep the default gutter");
});

// ---------------------------------------------------------------------------
// Time axis

function horizontalExtents(scene) {
  return scene.xTicks.map((tick) => {
    const width = measureText(tick.label, 9, scene.theme.font);
    const left = tick.anchor === "start" ? tick.px : tick.anchor === "end" ? tick.px - width : tick.px - width / 2;
    return [left, left + width];
  });
}

function assertNoHorizontalOverlap(scene, name) {
  const extents = horizontalExtents(scene);
  for (let i = 0; i < extents.length; i++) {
    const [left, right] = extents[i];
    assert.ok(left >= 0 && right <= scene.width, `${name}: "${scene.xTicks[i].label}" stays inside the chart`);
    if (i) assert.ok(left - extents[i - 1][1] >= 4, `${name}: "${scene.xTicks[i - 1].label}" and "${scene.xTicks[i].label}" do not overlap`);
  }
}

check("6.5 hours of minutes gives at least four distinct HH:mm labels", () => {
  const rows = Array.from({ length: 391 }, (_, i) => ({ t: new Date(Date.UTC(2025, 8, 9, 13, 30) + i * 60_000), v: 100 + Math.sin(i / 20) }));
  for (const width of [400, 600, 1000]) {
    const scene = compile([line(rows, { x: "t", y: "v" })], {}, { width, height: 300 });
    const clock = scene.xTicks.map((tick) => tick.label).filter((label) => /^\d\d:\d\d$/.test(label));
    assert.ok(new Set(clock).size >= 4, `${width}px: ${scene.xTicks.map((t) => t.label).join(" | ")}`);
    assertNoHorizontalOverlap(scene, `6.5h @ ${width}px`);
  }
});

check("ten years of days labels years within the tick budget", () => {
  const rows = Array.from({ length: 3650 }, (_, i) => ({ t: new Date(Date.UTC(2015, 4, 27) + i * DAY), v: i }));
  for (const width of [400, 600, 1200]) {
    const scene = compile([line(rows, { x: "t", y: "v" })], {}, { width, height: 300 });
    const budget = Math.max(2, Math.floor(scene.plot.w / TIME_TICK_SPACING));
    assert.ok(scene.xTicks.length >= 2 && scene.xTicks.length <= budget + 1, `${width}px: ${scene.xTicks.length} ticks`);
    assert.ok(scene.xTicks.every((tick) => /^\d{4}$/.test(tick.label)), scene.xTicks.map((t) => t.label).join(" "));
    assertNoHorizontalOverlap(scene, `10y @ ${width}px`);
  }
});

check("calendar ticks align to boundaries and name the higher unit", () => {
  const twoYears = Array.from({ length: 730 }, (_, i) => ({ t: new Date(Date.UTC(2023, 10, 18) + i * DAY), v: i }));
  const two = compile([line(twoYears, { x: "t", y: "v" })]);
  assert.ok(two.xTicks.some((tick) => /^\d{4}$/.test(tick.label)), "a year boundary shows the year");
  for (const tick of two.xTicks) {
    const date = new Date(tick.value);
    assert.equal(date.getUTCDate(), 1, `"${tick.label}" sits on a month start`);
    assert.equal(date.getUTCHours(), 0);
    if (/^\d{4}$/.test(tick.label)) assert.equal(date.getUTCMonth(), 0, "year ticks sit on January 1");
  }
  const sixMonths = Array.from({ length: 180 }, (_, i) => ({ t: new Date(Date.UTC(2025, 2, 3) + i * DAY), v: i }));
  const six = compile([line(sixMonths, { x: "t", y: "v" })]);
  assert.match(six.xTicks[0].label, /^[A-Z][a-z]{2} 2025$/, "a month axis without a year tick names the year once");
  assert.ok(six.xTicks.slice(1).every((tick) => /^[A-Z][a-z]{2}$/.test(tick.label)));
  const weeks = Array.from({ length: 30 }, (_, i) => ({ t: new Date(Date.UTC(2025, 8, 1) + i * DAY), v: i }));
  const month = compile([line(weeks, { x: "t", y: "v" })]);
  assert.ok(month.xTicks.every((tick) => /^(\d{1,2} [A-Z][a-z]{2}|[A-Z][a-z]{2})$/.test(tick.label)), month.xTicks.map((t) => t.label).join(" | "));
  assert.ok(month.xTicks.every((tick) => typeof tick.weight === "number"), "time ticks carry calendar weights");
  const intraday = Array.from({ length: 49 }, (_, i) => ({ t: Date.UTC(2025, 8, 9, 20) + i * 15 * 60_000, v: i }));
  const overnight = compile([line(intraday, { x: "t", y: "v" })], { scales: { x: { type: "time" } } });
  assert.ok(overnight.xTicks.some((tick) => tick.label === "10 Sep"), "a midnight between hours shows the date");
  const seconds = Array.from({ length: 120 }, (_, i) => ({ t: Date.UTC(2025, 8, 9, 9, 30) + i * 1000, v: i }));
  const secondScene = compile([line(seconds, { x: "t", y: "v" })], { scales: { x: { type: "time" } } });
  assert.ok(secondScene.xTicks.some((tick) => /^\d\d:\d\d:\d\d$/.test(tick.label)), "second ticks print seconds");
});

check("calendar ticks before 1970 and across the millennia", () => {
  const evening = Array.from({ length: 60 }, (_, i) => ({ t: new Date(Date.UTC(1969, 11, 31, 18) + i * 10 * 60_000), v: i }));
  const scene = compile([line(evening, { x: "t", y: "v" })]);
  const labels = scene.xTicks.map((tick) => tick.label);
  assert.ok(labels.includes("1970"), `the new year shows the year: ${labels.join(" | ")}`);
  assert.ok(labels.filter((label) => /^\d\d:\d\d$/.test(label)).length >= 3, labels.join(" | "));
  for (const tick of scene.xTicks) assert.ok(tick.value % 3_600_000 === 0, `"${tick.label}" sits on an hour`);
  const ancient = compile([line([{ t: Date.UTC(-500, 0, 1), v: 1 }, { t: Date.UTC(1500, 0, 1), v: 2 }], { x: "t", y: "v" })], { scales: { x: { type: "time" } } });
  assert.ok(ancient.xTicks.length >= 2 && ancient.xTicks.every((tick) => /^-?\d+$/.test(tick.label)), ancient.xTicks.map((t) => t.label).join(" | "));
  const beyond = compile([line([{ t: -9e15, v: 1 }, { t: 9e15, v: 2 }], { x: "t", y: "v" })], { scales: { x: { type: "time" } } });
  assert.ok(beyond.xTicks.length >= 2, "instants outside the Date range fall back to numeric ticks");
});

check("a zoomed Date axis stays a time axis when every series is hidden", () => {
  const rows = Array.from({ length: 36 }, (_, i) => ({ t: new Date(Date.UTC(1960, i, 1)), v: i }));
  const hidden = compile([line(rows, { x: "t", y: "v", name: "a" })], {
    hiddenSeries: ["a"],
    viewport: { x: [Date.UTC(1960, 3, 1), Date.UTC(1961, 3, 1)] },
  });
  assert.ok(hidden.xTicks.some((tick) => tick.label === "1961"), hidden.xTicks.map((t) => t.label).join(" | "));
});

check("time axes never overlap labels at 400px", () => {
  for (const span of [60_000 * 90, 3_600_000 * 30, DAY * 20, DAY * 400, DAY * 365 * 40]) {
    const rows = Array.from({ length: 200 }, (_, i) => ({ t: Date.UTC(2020, 0, 1) + (span * i) / 199, v: i }));
    const scene = compile([line(rows, { x: "t", y: "v" })], { scales: { x: { type: "time" } } }, { width: 400, height: 240 });
    assert.ok(scene.xTicks.length >= 2, `span ${span}: ${scene.xTicks.map((t) => t.label)}`);
    assertNoHorizontalOverlap(scene, `span ${span}`);
  }
});

// ---------------------------------------------------------------------------
// Category axis: thinning, rotation, ellipsis

function rotatedFootprint(scene, tick) {
  const angle = (Math.abs(tick.rotation) * Math.PI) / 180;
  const width = measureText(tick.label, 9, scene.theme.font);
  const top = scene.plot.y + scene.plot.h + 8;
  return {
    left: tick.px - width * Math.cos(angle) - 5.5 * Math.sin(angle),
    bottom: top + width * Math.sin(angle) + 11 * Math.cos(angle),
  };
}

function assertCategoryLayout(scene, name) {
  const rotated = scene.xTicks.some((tick) => tick.rotation !== 0);
  if (!rotated) {
    assertNoHorizontalOverlap(scene, name);
    return;
  }
  assert.ok(scene.xTicks.every((tick) => tick.rotation === scene.xTicks[0].rotation && tick.anchor === "end"), `${name}: one rotation`);
  const pitch = 11 / Math.sin((Math.abs(scene.xTicks[0].rotation) * Math.PI) / 180);
  for (let i = 1; i < scene.xTicks.length; i++) {
    assert.ok(scene.xTicks[i].px - scene.xTicks[i - 1].px >= pitch, `${name}: rotated labels ${i - 1}/${i} do not overlap`);
  }
  for (const tick of scene.xTicks) {
    const { left, bottom } = rotatedFootprint(scene, tick);
    assert.ok(left >= -0.5, `${name}: "${tick.label}" stays inside the left edge (${left})`);
    assert.ok(bottom <= scene.height + 0.5, `${name}: "${tick.label}" fits the reserved bottom margin`);
  }
}

check("long categories rotate and reserve bottom margin", () => {
  const regions = ["North America", "South America", "Europe", "Middle East & Africa", "Asia Pacific", "Oceania"];
  const scene = compile([bar(regions.map((k, v) => ({ k, v: v + 1 })), { x: "k", y: "v" })], {}, { width: 360, height: 300 });
  assert.equal(scene.xTicks.length, regions.length, "every category stays labelled");
  assert.ok(scene.xTicks.every((tick) => tick.rotation === -45));
  assert.ok(scene.margin.bottom > 26, "bottom margin grew for rotated labels");
  assert.equal(scene.axes.x.size, scene.margin.bottom);
  assertCategoryLayout(scene, "regions");
  const svg = svgFromCompiled(scene);
  assert.match(svg, /transform="rotate\(-45 /, "SVG paints rotated labels");
});

check("random category sets never overlap at 300-1200px", () => {
  const letters = "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let trial = 0; trial < 120; trial++) {
    const count = 1 + Math.floor(rnd() * 60);
    const width = 300 + Math.floor(rnd() * 900);
    const rows = Array.from({ length: count }, (_, i) => {
      const length = 1 + Math.floor(rnd() * 28);
      let label = `${i}:`;
      for (let c = 0; c < length; c++) label += letters[Math.floor(rnd() * letters.length)];
      return { k: label, v: 1 + rnd() * 10 };
    });
    const scene = compile([bar(rows, { x: "k", y: "v" })], {}, { width, height: 320 });
    assertCategoryLayout(scene, `trial ${trial} (${count} @ ${width}px)`);
  }
});

check("scales.x.labels controls interval, rotation and width", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ k: `Category ${i + 1}`, v: i }));
  const every3 = compile([bar(rows, { x: "k", y: "v" })], { scales: { x: { type: "band", labels: { interval: 3 } } } });
  assert.deepEqual(every3.xTicks.map((tick) => tick.value), rows.filter((_, i) => i % 3 === 0).map((row) => row.k));
  const flat = compile([bar(rows, { x: "k", y: "v" })], { scales: { x: { type: "band", labels: { rotate: false } } } }, { width: 360, height: 300 });
  assert.ok(flat.xTicks.every((tick) => tick.rotation === 0));
  assertNoHorizontalOverlap(flat, "rotate: false");
  const vertical = compile([bar(rows, { x: "k", y: "v" })], { scales: { x: { type: "band", labels: { rotate: -90, maxWidth: 30 } } } });
  assert.ok(vertical.xTicks.every((tick) => tick.rotation === -90 && measureText(tick.label, 9, vertical.theme.font) <= 30));
  const forced = compile([line(rows.map((r, x) => ({ x, v: r.v })), { x: "x", y: "v" })], { scales: { x: { type: "linear", labels: { rotate: true } } } });
  assert.ok(forced.xTicks.every((tick) => tick.rotation === -45), "rotation can be forced on numeric axes");
  const bad = [
    [{ rotate: 45 }, /angle from -90 to 0/],
    [{ rotate: "sideways" }, /rotate must be/],
    [{ maxWidth: 0 }, /positive number of pixels/],
    [{ interval: 1.5 }, /positive integer/],
    [{ spin: true }, /does not support option "spin"/],
    ["tight", /must be an object/],
  ];
  for (const [labels, message] of bad) {
    assert.throws(
      () => compile([bar(rows, { x: "k", y: "v" })], { scales: { x: { type: "band", labels } } }),
      (error) => error instanceof ChartCompileError && error.code === "E_SCALE_TYPE" && message.test(error.message),
      `labels ${JSON.stringify(labels)} fails loudly`,
    );
  }
  assert.throws(
    () => compile([bar(rows, { x: "k", y: "v" })], { scales: { y: { labels: { rotate: -45 } } } }),
    (error) => error instanceof ChartCompileError && /value-axis labels are always horizontal/.test(error.message),
  );
  const yCapped = compile([line(rows.map((r, x) => ({ x, v: r.v * 1000 })), { x: "x", y: "v" })], { scales: { y: { labels: { maxWidth: 12 } } } });
  assert.ok(yCapped.yTicks.every((tick) => measureText(tick.label, 9, yCapped.theme.font) <= 12));
});

// ---------------------------------------------------------------------------
// Heatmap

check("dense heatmaps thin their labels and format values without a hard-coded %", () => {
  const cells = [];
  for (let week = 1; week <= 52; week++) {
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) cells.push({ w: `W${week}`, d: day, v: (week * 7 + day.length) % 13 - 6 });
  }
  const scene = compile([heatmap(cells, { x: "w", y: "d", valueKey: "v" })]);
  assert.ok(scene.xTicks.length < 52, "week labels are thinned");
  assertCategoryLayout(scene, "52x7 heatmap");
  for (let i = 1; i < scene.yTicks.length; i++) assert.ok(Math.abs(scene.yTicks[i].px - scene.yTicks[i - 1].px) >= 12, "row labels keep a line apart");
  for (const tick of scene.yTicks) assert.ok(scene.plot.x - 8 - measureText(tick.label, 9, scene.theme.font) >= 0, "row labels fit left of the grid");

  const plain = compile([heatmap([{ x: "a", y: "b", v: 1234.5 }, { x: "b", y: "b", v: -3 }], { x: "x", y: "y", valueKey: "v" })]);
  const tip = plain.nodes.find((node) => node.tip)?.tip;
  assert.equal(tip, "b  ·  a\n1,234.5");
  assert.equal(plain.formatters.color(-3), "-3.0");
  assert.ok(!plain.nodes.some((node) => node.label?.includes("%") || node.label?.startsWith("+")), "no % and no sign by default");
  const signed = compile([heatmap([{ x: "a", y: "b", v: 2.4 }, { x: "b", y: "b", v: -1 }], { x: "x", y: "y", valueKey: "v", valueFormat: "signed-percent" })]);
  assert.ok(signed.nodes.some((node) => node.type === "text" && node.label === "+2.4%"));
  const latency = compile([heatmap([{ x: "a", y: "b", v: 12 }], { x: "x", y: "y", valueKey: "v", valueFormat: (v) => `${v} ms` })]);
  assert.ok(latency.nodes.some((node) => node.tip?.endsWith("12 ms")));
  assert.throws(
    () => compile([heatmap([{ x: "a", y: "b", v: 1 }], { x: "x", y: "y", valueKey: "v", valueFormat: "percentage" })]),
    (error) => error instanceof ChartCompileError && error.code === "E_MARK_OPTION" && /signed-percent/.test(error.message),
  );
  const wideBar = compile([heatmap([{ x: "a", y: "b", v: 123456.25 }, { x: "b", y: "b", v: -98765.5 }], { x: "x", y: "y", valueKey: "v" })], {}, { width: 360, height: 240 });
  const barRight = wideBar.plot.x + wideBar.plot.w + 22;
  for (const label of [wideBar.formatters.color(wideBar.colorBar.max), wideBar.formatters.color(wideBar.colorBar.min)]) {
    assert.ok(barRight + measureText(label, 9, wideBar.theme.font) <= wideBar.width, `colour-bar label "${label}" fits`);
  }
  for (const node of wideBar.nodes.filter((n) => n.type === "text")) {
    const cell = wideBar.nodes.find((n) => n.type === "rect" && Math.abs(n.x + n.w / 2 - node.x) < 1 && Math.abs(n.y + n.h / 2 - node.y) < 1);
    assert.ok(cell && measureText(node.label, 9, wideBar.theme.font) <= cell.w, "cell labels fit their cell");
  }
});

check("heatmap values are re-read on every compile of the same definition", () => {
  const cells = [{ x: "a", y: "r", v: 1 }, { x: "b", y: "r", v: 2 }];
  const definition = defineChart({ marks: [heatmap(cells, { x: "x", y: "y", valueKey: "v" })] });
  const before = compileChart(definition, { width: 400, height: 200 });
  assert.deepEqual(before.colorBar, { min: 1, max: 2 });
  cells.push({ x: "c", y: "r", v: 500.25 });
  cells[0].v = -40;
  const after = compileChart(definition, { width: 400, height: 200 });
  assert.deepEqual(after.colorBar, { min: -500.25, max: 500.25 });
  const tips = after.nodes.filter((node) => node.tip).map((node) => node.tip);
  assert.deepEqual(tips, ["r  ·  a\n-40.00", "r  ·  b\n2.00", "r  ·  c\n500.25"]);
  assert.equal(after.formatters.color(500.25), "500.25");
});

check("heatmap crosshair chips name the hovered cell on thinned axes", () => {
  const tokens = ["BTC", "ETH", "SOL", "DOGE", "AVAX", "LINK", "DOT", "ADA", "XRP", "LTC", "UNI", "ATOM"];
  const cells = [];
  for (let h = 0; h < 24; h++) for (const token of tokens) cells.push({ h, token, value: ((h * 7 + token.length) % 9) - 4 });
  const scene = compile([heatmap(cells, { x: "h", y: "token", valueKey: "value" })], {}, { width: 420, height: 200 });
  assert.ok(!scene.xTicks.some((tick) => tick.value === 1), "column 1 is unlabelled at 420px");
  const hovered = scene.nodes.filter((n) => n.role === "heat" && (n.datum.h === 1 || n.datum.h === 23));
  assert.equal(hovered.length, 2 * tokens.length);
  for (const node of hovered) {
    const target = { hit: node, sample: null, isBar: false, isLine: false, isPoint: false, scanX: node.x + node.w / 2, scanY: node.y + node.h / 2, y: node.y };
    assert.equal(crosshairCategoryLabel(scene, target), String(node.datum.h));
    assert.equal(crosshairValueLabel(scene, target), node.datum.token);
  }
  const regions = ["North America", "South America", "Europe", "Middle East & Africa"];
  const narrow = compile([bar(regions.map((k, v) => ({ k, v: v + 1 })), { x: "k", y: "v" })], { scales: { x: { type: "band", labels: { rotate: false } } } }, { width: 240, height: 200 });
  const target = narrow.nodes.find((node) => node.role === "bar" && node.datum.k === "Middle East & Africa");
  assert.equal(
    crosshairCategoryLabel(narrow, { hit: target, sample: null, isBar: true, isLine: false, isPoint: false, scanX: target.x + target.w / 2, scanY: target.y, y: target.y }),
    "Middle East & Africa",
    "the chip shows the full category, never a thinned neighbour or an ellipsized label",
  );
  const numericRows = compile([heatmap([{ x: "a", y: 1.5, v: 1 }, { x: "a", y: 2.5, v: 2 }], { x: "x", y: "y", valueKey: "v" })]);
  const row = numericRows.nodes.find((node) => node.role === "heat" && node.datum.y === 1.5);
  assert.equal(crosshairValueLabel(numericRows, { hit: row, sample: null, isBar: false, isLine: false, isPoint: false, scanX: row.x, scanY: row.y + row.h / 2, y: row.y }), "1.5");
});

check("the colour bar paints the heatmap's value format", () => {
  const scene = compile([heatmap([{ x: "a", y: "b", v: 2.4 }, { x: "b", y: "b", v: -1 }], { x: "x", y: "y", valueKey: "v", valueFormat: "signed-percent" })]);
  const barX = scene.plot.x + scene.plot.w + 22;
  const labels = [...svgFromCompiled(scene).matchAll(/<text x="([\d.]+)"[^>]*>([^<]*)<\/text>/g)]
    .filter((match) => Math.abs(Number(match[1]) - barX) < 0.01)
    .map((match) => match[2]);
  assert.deepEqual(labels, ["+2.4%", "0", "-2.4%"], "the colour bar reads +2.4% … -2.4%, like the cells and the measured margin");
});

// ---------------------------------------------------------------------------
// Viewport

check("a Date axis keeps date labels under a pre-1973 viewport", () => {
  const rows = Array.from({ length: 36 }, (_, i) => ({ t: new Date(Date.UTC(1960, i, 1)), v: i }));
  const zoomed = compile([line(rows, { x: "t", y: "v" })], { viewport: { x: [Date.UTC(1960, 3, 1), Date.UTC(1961, 3, 1)] } });
  assert.ok(zoomed.xTicks.length >= 2);
  assert.ok(zoomed.xTicks.every((tick) => /^([A-Z][a-z]{2}( \d{4})?|\d{4}|\d{1,2} [A-Z][a-z]{2})$/.test(tick.label)), zoomed.xTicks.map((t) => t.label).join(" | "));
  assert.ok(zoomed.xTicks.some((tick) => tick.label === "1961"));
  const empty = compile([line(rows, { x: "t", y: "v" })], { viewport: { x: [Date.UTC(1950, 0, 1), Date.UTC(1950, 6, 1)] } });
  assert.deepEqual(empty.xTicks.map((tick) => tick.label).slice(0, 3), ["1950", "Feb", "Mar"], "an empty window keeps the time axis");
  const epochNumbers = Array.from({ length: 20 }, (_, i) => ({ x: 1.7e12 + i * DAY, v: i }));
  const numeric = compile([line(epochNumbers, { x: "x", y: "v" })], { viewport: { x: [1.7e12 + 2 * DAY, 1.7e12 + 9 * DAY] } });
  assert.ok(numeric.xTicks.every((tick) => !/[A-Z][a-z]{2}/.test(tick.label)), "plain numbers are never guessed to be dates");
});

// ---------------------------------------------------------------------------
// Scene contract v2 and performance

check("the scene carries v2 formatters and measured axes", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ x: i, y: i * 1.5 }));
  const scene = compile([line(rows, { x: "x", y: "y" })]);
  assert.equal(scene.contractVersion, 2);
  assert.equal(typeof scene.formatters.x, "function");
  assert.equal(scene.formatters.y(3), "3.0");
  assert.equal(scene.axes.x.position, "bottom");
  assert.equal(scene.axes.y.position, "right");
  assert.deepEqual(scene.axes.x.ticks, scene.xTicks);
  assert.deepEqual(scene.axes.y.ticks, scene.yTicks);
  assert.ok(scene.xTicks.every((tick) => ["start", "middle", "end"].includes(tick.anchor) && tick.rotation === 0));
  const custom = compile([line(rows, { x: "x", y: "y" })], { scales: { y: { tickFormat: (v) => `$${v}` } } });
  assert.equal(custom.formatters.y(3), "$3", "tickFormat drives value labels too");
});

check("a 10k-point line compiles quickly", () => {
  let value = 100;
  const rows = Array.from({ length: 10_000 }, (_, index) => ({ x: index, y: (value += ((index * 17) % 23 - 11) * 0.0025) }));
  const definition = defineChart({ marks: [line(rows, { x: "x", y: "y", lastValue: false })], grid: false, legend: false });
  for (let i = 0; i < 3; i++) compileChart(definition, { width: 1280, height: 720 });
  const times = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    compileChart(definition, { width: 1280, height: 720 });
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  // Loose in Node (shared CI machines); the Chromium budget lives in tests/native-axes.spec.ts.
  assert.ok(times[4] < 40, `median ${times[4].toFixed(2)} ms`);
});

check("formatFixed prints the en-US Intl digits without calling Intl per value", () => {
  const cases = [
    [1234.5, 1, "1,234.5"],
    [-1234567.891, 2, "-1,234,567.89"],
    [999.96, 1, "1,000.0"],
    [-999.5, 0, "-1,000"],
    [12, 3, "12.000"],
    [-0.004, 2, "0.00"],
    [-0, 1, "0.0"],
    [0.1 + 0.2, 2, "0.30"],
    [123456789012.25, 6, "123,456,789,012.250000"],
    [1e21, 0, "1,000,000,000,000,000,000,000"],
    [-1.5e25, 2, "-15,000,000,000,000,000,000,000,000.00"],
  ];
  for (const [value, digits, expected] of cases) assert.equal(formatFixed(value, digits), expected, `${value} with ${digits} decimals`);
  const intl = [];
  const reference = (value, digits) => (intl[digits] ??= new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })).format(value);
  const toFixed = (value, digits) => `${value < 0 && Math.abs(value) >= 0.5 / 10 ** digits ? "-" : ""}${Math.abs(value).toFixed(digits)}`;
  for (let trial = 0; trial < 20_000; trial++) {
    const digits = Math.floor(rnd() * 9);
    let value = rnd() * 10 ** Math.floor(rnd() * 11 - 4);
    const shape = rnd();
    // Decimal ties (1.005), exact binary ties (0.125) and values already at `digits` decimals.
    if (shape < 0.25) value = Math.round(value * 10 ** (digits + 1)) / 10 ** (digits + 1);
    else if (shape < 0.35) value = (Math.floor(value * 10 ** digits) + 0.5) / 10 ** digits;
    else if (shape < 0.45) value = Math.round(value * 10 ** digits) / 10 ** digits;
    if (rnd() < 0.5) value = -value;
    const label = formatFixed(value, digits);
    // The fast paths round exactly like toFixed(), ties included.
    if (!Number.isInteger(value)) assert.equal(label.replace(/,/g, ""), toFixed(value, digits), `${value} with ${digits} decimals rounds like toFixed`);
    // And group like en-US Intl, which rounds decimal ties of the shortest form (those are skipped).
    const fraction = String(Math.abs(value)).split(".")[1] ?? "";
    const tie = fraction.length === digits + 1 && fraction.endsWith("5");
    const safe = value < 0 && Math.abs(value) < 0.5 / 10 ** digits ? 0 : value;
    if (!tie && Math.abs(value) >= 999) assert.equal(label, reference(safe, digits), `${value} with ${digits} decimals groups like Intl`);
  }
});

check("thinning thousands of categories stays near-linear", () => {
  const size = { width: 800, height: 400 };
  const bars = (count, key = (i) => `Item ${i}`) => defineChart({ marks: [bar(Array.from({ length: count }, (_, i) => ({ k: key(i), v: i % 17 })), { x: "k", y: "v" })] });
  const fastest = (definition) => {
    compileChart(definition, size);
    let best = Infinity;
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      compileChart(definition, size);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  const small = bars(1000);
  const large = bars(20_000);
  // 20x the categories take about 20x as long, as they did before measured
  // labels (raze-100x: 22x). Trying every n from 1 over all labels took 56x.
  let ratio = Infinity;
  for (let attempt = 0; attempt < 3 && ratio >= 36; attempt++) ratio = Math.min(ratio, fastest(large) / fastest(small));
  assert.ok(ratio < 36, `20,000 categories took ${ratio.toFixed(1)}x as long as 1,000`);
  assertCategoryLayout(compileChart(large, size), "20,000 categories");
  // String-date categories, as a daily bar chart read from a CSV has them.
  const daily = compileChart(bars(2000, (i) => new Date(Date.UTC(2020, 0, 1) + i * DAY).toISOString().slice(0, 10)), size);
  assert.ok(daily.xTicks.length >= 5, `${daily.xTicks.length} date labels`);
  assertCategoryLayout(daily, "2,000 date categories");
  for (const width of [300, 700, 1200]) {
    assertCategoryLayout(compileChart(bars(3000), { width, height: 320 }), `3,000 categories @ ${width}px`);
    const flat = compileChart(defineChart({
      marks: [bar(Array.from({ length: 3000 }, (_, i) => ({ k: `Long category ${i}`, v: 1 })), { x: "k", y: "v" })],
      scales: { x: { type: "band", labels: { rotate: false } } },
    }), { width, height: 320 });
    assertNoHorizontalOverlap(flat, `3,000 flat categories @ ${width}px`);
  }
});

check("a year-by-hour heatmap fits the chart without runaway margins", () => {
  const cells = [];
  for (let d = 0; d < 365; d++) for (let h = 0; h < 24; h++) cells.push({ d: `D${d + 1}`, h: `${String(h).padStart(2, "0")}:00`, v: ((d * h) % 11) - 5 });
  for (const [width, height] of [[800, 400], [500, 300], [1400, 500]]) {
    const scene = compile([heatmap(cells, { x: "d", y: "h", valueKey: "v" })], {}, { width, height });
    const name = `365x24 @ ${width}x${height}`;
    // The defaults are left 46 and right 54; row labels ("23:00") and the colour bar fit them.
    assert.ok(scene.margin.left <= 46 && scene.margin.right <= 54, `${name}: margins ${JSON.stringify(scene.margin)}`);
    assert.ok(scene.plot.x >= scene.margin.left - 1 && scene.plot.x + scene.plot.w <= width - scene.margin.right + 1, `${name}: the grid sits between the margins`);
    const rects = scene.nodes.filter((node) => node.role === "heat");
    assert.equal(rects.length, 365 * 24);
    assert.ok(rects.every((node) => node.x >= 0 && node.x + node.w <= width && node.y >= 0 && node.y + node.h <= height), `${name}: every cell is inside the chart`);
    assert.ok(new Set(rects.filter((node) => node.datum.h === "00:00").map((node) => node.x)).size > 300, `${name}: columns stay distinct`);
    assertCategoryLayout(scene, name);
  }
  // Grids that fit keep whole-pixel cells and 2px gaps.
  const week = compile([heatmap(cells.filter((cell) => Number(cell.d.slice(1)) <= 7), { x: "d", y: "h", valueKey: "v" })], {}, { width: 600, height: 400 });
  const row = week.nodes.filter((node) => node.role === "heat" && node.datum.h === "00:00").sort((a, b) => a.x - b.x);
  assert.ok(Number.isInteger(row[0].w) && row[1].x - (row[0].x + row[0].w) === 2, "a 7-day grid keeps 2px gaps");
});

check("the local calendar ladder agrees with the shared time core", () => {
  // TODO(W1B-05): /chart keeps a compact UTC ladder (timeDrafts in axes.ts)
  // until it can adopt calendarTicks(). Until then its weights must stay the
  // core's unit weights, and both must name the same unit at a shared tick.
  const unitWeights = new Set([TickWeight.Year, TickWeight.Month, TickWeight.Day, TickWeight.Hour, TickWeight.Minute, TickWeight.Second, TickWeight.Millisecond]);
  const spans = [
    [Date.UTC(2025, 8, 9, 13, 30), 6.5 * 3_600_000],
    [Date.UTC(2025, 0, 30), 3 * DAY],
    [Date.UTC(2025, 0, 20), 60 * DAY],
    [Date.UTC(2023, 10, 18), 730 * DAY],
    [Date.UTC(2015, 4, 27), 3650 * DAY],
    [Date.UTC(2025, 0, 1, 9, 59, 30), 90_000],
    [Date.UTC(2025, 0, 1, 9, 59, 59, 900), 400],
    [Date.UTC(1965, 2, 1), 400 * DAY],
    [Date.UTC(1200, 0, 1), 600 * 365 * DAY],
  ];
  let shared = 0;
  for (const [from, span] of spans) {
    const rows = Array.from({ length: 200 }, (_, i) => ({ t: new Date(from + (i * span) / 199), v: i }));
    const scene = compile([line(rows, { x: "t", y: "v" })]);
    const name = `${new Date(from).toISOString()} + ${span} ms`;
    assert.ok(scene.xTicks.length >= 2, `${name}: ticks`);
    const [lo, hi] = scene.xScale.domain;
    const core = new Map(calendarTicks({ from: lo, to: hi, width: scene.plot.w, minSpacing: TIME_TICK_SPACING }).map((tick) => [tick.time, tick]));
    for (const tick of scene.xTicks) {
      assert.ok(unitWeights.has(tick.weight), `${name}: "${tick.label}" weighs ${tick.weight}, a core unit weight`);
      const match = core.get(tick.value);
      if (!match) continue;
      shared++;
      // The core marks Monday midnights as weeks; the local ladder names them as days.
      const unit = match.unit === "week" ? "day" : match.unit;
      assert.equal(tickLevel(tick.weight).unit, unit, `${name}: "${tick.label}" is a ${unit} boundary in both`);
    }
  }
  assert.ok(shared >= 30, `${shared} ticks shared with the core`);
});

console.log(`[raze-charts] native compile axes: ${passed} checks passed`);
