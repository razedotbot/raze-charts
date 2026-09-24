// DOM legend foundation (W1B-16): definition-built study labels, the per-frame
// legend model (title row, OHLC, Heikin-Ashi values, every plot value),
// market status, the canvas fallback's clipping, the Heikin-Ashi last price,
// and the DOM legend's rows, "+N" collapse, removal and focus handling.
//
// The legend modules are internal, so this test bundles them from source with
// esbuild: node tests/legend.mjs

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};
const equal = (actual, expected, message) =>
  assert(Object.is(actual, expected), `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
const deepEqual = (actual, expected, message) =>
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message} (got ${JSON.stringify(actual)})`);

// ── DOM environment ─────────────────────────────────────────────────────────
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;

// Layout stubs: jsdom has no layout, so give legend lines a fixed height and
// stack them, which is what the "+N" budget and hover hit-test read.
const LINE = 18;
const lineTop = (el) => {
  let top = 0;
  for (let node = el.previousElementSibling; node; node = node.previousElementSibling) {
    if (!node.hidden) top += LINE + 2;
  }
  return top;
};
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() { return this.classList?.contains("raze-legend-line") ? LINE : 0; },
});
Object.defineProperty(window.HTMLElement.prototype, "offsetTop", {
  configurable: true,
  get() {
    if (this.classList?.contains("raze-legend-row")) return this.parentElement.offsetTop + lineTop(this);
    if (this.classList?.contains("raze-legend-studies")) return lineTop(this);
    return 0;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() { return this.classList?.contains("raze-legend-row") ? 160 : 0; },
});

// ── Bundle the modules under test from source ───────────────────────────────
const entry = `
export * from "./src/studies/label";
export { BUILTIN_STUDIES } from "./src/studies/registry";
export { StudyStore } from "./src/studies/StudyStore";
export * from "./src/engine/paint/legend";
export { drawLastPrice } from "./src/engine/paint/lastPrice";
export { xForIndex } from "./src/engine/plotScale";
export { Legend } from "./src/ui/Legend";
export { resolveIndicatorPresets } from "./src/ui/IndicatorsMenu";
export { StudyRegistry } from "./src/studies/registry";
export { createWidgetContext } from "./src/core/widget/runtime";
export { heikinAshi } from "./src/util/heikinAshi";
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts", sourcefile: "legend-entry.ts" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  write: false,
  logLevel: "silent",
  define: { __RAZE_CHARTS_VERSION__: JSON.stringify("test") },
});
const scratch = mkdtempSync(join(tmpdir(), "raze-legend-"));
const bundlePath = join(scratch, "legend.mjs");
writeFileSync(bundlePath, bundled.outputFiles[0].text);
const L = await import(pathToFileURL(bundlePath).href);
rmSync(scratch, { recursive: true, force: true });

const byName = (name) => L.BUILTIN_STUDIES.find((def) => def.name === name);

// ── Labels ──────────────────────────────────────────────────────────────────
equal(L.formatStudyLabel(byName("EMA"), { length: 9 }), "EMA 9", "EMA label separates name and length");
equal(L.formatStudyLabel(byName("EMA")), "EMA 9", "EMA label falls back to its default length");
equal(L.formatStudyLabel(byName("RSI"), { length: 14 }), "RSI 14", "RSI label");
equal(L.formatStudyLabel(byName("VWAP"), { length: 14 }), "VWAP", "VWAP has no length input, so none is shown");
equal(L.formatStudyLabel(byName("Bollinger Bands"), { length: 20 }), "BB 20 2", "Bollinger uses its short title, length and multiplier");
equal(L.formatStudyLabel(byName("Bollinger Bands"), { length: 30, mult: 2.5 }), "BB 30 2.5", "Bollinger label follows a multiplier input");
equal(L.formatStudyLabel(byName("MACD"), { length: 26 }), "MACD 12 26 9", "MACD shows fast, slow and signal, not the unused length");
equal(L.formatStudyLabel(byName("MACD"), { fast: 5, slow: 35, signal: 5 }), "MACD 5 35 5", "MACD label follows named inputs");
equal(L.formatStudyLabel(byName("MACD"), { in_0: 14, in_1: 30, in_2: 9 }), "MACD 14 30 9", "MACD label accepts TradingView in_N ids");
equal(L.formatStudyLabel(byName("Bollinger Bands"), { length: 20 }, { showInputs: false }), "BB", "showInputs: false keeps the short title");

const hl2 = { name: "HL2", pane: "overlay", defaults: { length: 1, color: "#8ecae6" }, compute: (bars) => bars.map((b) => (b.high + b.low) / 2) };
equal(L.formatStudyLabel(hl2, { length: 1 }), "HL2", "a v1 study whose compute ignores inputs shows no input tokens");
const mom = { name: "MOM", pane: "pane", defaults: { length: 10, color: "#fff", smooth: 3 }, compute: (bars, { length }) => bars.map(() => length) };
equal(L.formatStudyLabel(mom), "MOM 10 3", "a v1 study lists its numeric defaults in declaration order");
equal(L.formatStudyLabel(mom, { length: 14 }), "MOM 14 3", "instance values override v1 defaults");
equal(L.formatStudyLabel({ ...mom, shortTitle: "Mo" }, { length: 5 }), "Mo 5 3", "shortTitle replaces the name");
equal(
  L.formatStudyLabel({ ...mom, formatLabel: ({ length, smooth }) => `Momentum(${length}/${smooth})` }, { length: 7 }),
  "Momentum(7/3)",
  "formatLabel receives defaults merged with the instance inputs",
);
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
const broken = { ...mom, formatLabel: () => { throw new Error("boom"); } };
equal(L.formatStudyLabel(broken), "MOM 10 3", "a throwing formatLabel falls back to the default label");
L.formatStudyLabel(broken);
console.warn = originalWarn;
equal(warnings.length, 1, "a failing formatLabel warns once per definition");
assert(warnings[0].includes("formatLabel"), "the warning names formatLabel");

const v2 = {
  name: "Channel",
  shortTitle: "CH",
  pane: "overlay",
  inputs: {
    length: { type: "int", title: "Length", default: 20 },
    source: { type: "source", title: "Source", default: "close" },
    mult: { type: "float", title: "Multiplier", default: 1.5 },
    extend: { type: "bool", title: "Extend", default: true },
    mode: { type: "select", title: "Mode", default: "ema", options: [{ value: "ema", title: "Exponential" }], inLabel: true },
    color: { type: "color", title: "Colour", default: "#fff" },
  },
  plots: [],
  compute: () => ({}),
};
equal(L.formatStudyLabel(v2), "CH 20 1.5 Exponential", "v2 schema: numeric inputs by default, a default source hidden, select titles with inLabel");
equal(L.formatStudyLabel(v2, { source: "hl2", length: 50 }), "CH 50 hl2 1.5 Exponential", "v2 schema: a non-default source appears in order");
equal(
  L.formatStudyLabel({ ...v2, inputs: { ...v2.inputs, mult: { ...v2.inputs.mult, inLabel: false } } }),
  "CH 20 Exponential",
  "v2 schema: inLabel: false hides an input",
);
equal(L.formatLabelToken(0.1 + 0.2), "0.3", "float tokens are trimmed to six significant digits");

equal(L.studyInstanceLabel({ def: byName("VWAP"), length: 14, inputs: {} }), "VWAP", "the store's length fallback never leaks into a label");
equal(L.studyInstanceLabel({ def: byName("EMA"), length: 21, inputs: {} }), "EMA 21", "instance label uses the stored length");

const presets = L.resolveIndicatorPresets({ custom_studies: [hl2], indicator_presets: [{ name: "HL2" }, { name: "VWAP" }, { name: "MACD", length: 26 }] }, new L.StudyRegistry([...L.BUILTIN_STUDIES, hl2]));
deepEqual(presets.map((p) => p.label), ["HL2", "VWAP", "MACD 12 26 9"], "indicator menu presets use definition labels");

// ── Market status ───────────────────────────────────────────────────────────
const ny = (iso) => Date.parse(iso);
equal(L.marketStatus({ session: "24x7", timezone: "Etc/UTC" }, 0), "open", "24x7 is always open");
const equities = { session: "0930-1600", timezone: "America/New_York" };
equal(L.marketStatus(equities, ny("2024-01-16T15:00:00Z")), "open", "a weekday at 10:00 New York is inside 0930-1600");
equal(L.marketStatus(equities, ny("2024-01-16T21:30:00Z")), "closed", "16:30 New York is after the close");
equal(L.marketStatus(equities, ny("2024-01-20T15:00:00Z")), "closed", "the default session days exclude Saturday");
const futures = { session: "1700-1600:23456", timezone: "America/Chicago" };
equal(L.marketStatus(futures, ny("2024-01-15T00:00:00Z")), "open", "an overnight session opens the evening before its trading day");
equal(L.marketStatus(futures, ny("2024-01-19T22:30:00Z")), "closed", "the overnight session is closed between 16:00 and 17:00");
equal(L.marketStatus({ session: "0930-1200,1300-1600:23456", timezone: "America/New_York" }, ny("2024-01-16T17:30:00Z")), "closed", "a lunch break between sessions is closed");
equal(L.marketStatus({ session: "whenever", timezone: "Etc/UTC" }, 0), null, "an unparsable session has no status");
equal(L.marketStatus({ session: "0930-1600", timezone: "Not/AZone" }, 0), null, "an unknown timezone has no status");
equal(L.marketStatus(null, 0), null, "no symbol info, no status");

equal(L.opaqueColor("#2962ff66"), "#2962ff", "8-digit hex loses its alpha for legible text");
equal(L.opaqueColor("#f00a"), "#f00", "4-digit hex loses its alpha");
equal(L.opaqueColor("rgba(41, 98, 255, 0.4)"), "rgb(41,98,255)", "rgba loses its alpha");
equal(L.opaqueColor("#2962ff"), "#2962ff", "opaque colours are unchanged");

// ── Model ───────────────────────────────────────────────────────────────────
const bars = Array.from({ length: 80 }, (_, i) => {
  const open = 100 + Math.sin(i / 5) * 10;
  const close = open + Math.cos(i / 3) * 3;
  return { time: 1_700_000_000_000 + i * 60_000, open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close, volume: 1000 + i * 10 };
});

function makeChart(options = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const context = L.createWidgetContext({
    symbol: "MOCK",
    interval: "1",
    container: host,
    datafeed: {},
    ...options,
  });
  context.symbolInfo = {
    name: "MOCK", ticker: "MOCK", description: "Mock Industries", session: "24x7", timezone: "Etc/UTC",
    exchange: "Mock", minmov: 1, pricescale: 100,
  };
  context.bars = bars;
  const store = new L.StudyStore(context, new L.StudyRegistry([...L.BUILTIN_STUDIES, hl2]));
  return { context, store, host };
}

function makeView(chart, { plotW = 900, plotH = 400, crosshairIndex = null, seriesBars } = {}) {
  const scale = {
    plotL: 0, plotT: 0, plotW, plotH, priceMin: 80, priceMax: 120, pctBase: 1,
    visibleRange: { from: 0, to: bars.length - 1 }, percentScale: false, logScale: false,
  };
  const crosshair = crosshairIndex === null
    ? { x: 0, y: 0, active: false }
    : { x: L.xForIndex(scale, crosshairIndex), y: 30, active: true };
  return {
    ...scale,
    context: chart.context,
    cssWidth: plotW + 64,
    cssHeight: plotH + 22,
    dpr: 1,
    priceAxisW: 64,
    subPanes: [],
    volumePane: null,
    seriesBars: seriesBars ?? chart.context.bars,
    studies: chart.store,
    crosshair,
    fontFamily: "sans-serif",
    axisTags: [],
  };
}

const chart = makeChart();
for (const spec of [
  { name: "EMA", length: 9 },
  { name: "VWAP" },
  { name: "HL2" },
  { name: "MACD", length: 26 },
  { name: "Bollinger Bands", length: 20 },
]) chart.store.add(spec);

let model = L.buildLegendModel(makeView(chart));
deepEqual(model.studies.map((s) => s.label), ["EMA 9", "VWAP", "HL2", "MACD 12 26 9", "BB 20 2"], "legend rows read EMA 9, VWAP, HL2, MACD 12 26 9 and BB 20 2");
equal(model.title.symbol, "MOCK", "title row shows the symbol");
equal(model.title.interval, "1m", "title row shows the interval");
equal(model.title.exchange, "Mock", "title row shows the exchange");
equal(model.title.description, "Mock Industries", "a wide plot shows the description");
equal(model.title.status, "open", "title row shows the market status");
deepEqual(model.series.values.map((v) => v.title), ["O", "H", "L", "C"], "a wide plot shows O, H, L and C");
const last = bars[bars.length - 1];
equal(model.series.values[3].text, chart.context.formatPrice(last.close, 100), "without a crosshair the legend shows the last bar");
const bb = model.studies.find((s) => s.label === "BB 20 2");
const macd = model.studies.find((s) => s.label === "MACD 12 26 9");
equal(bb.values.length, 3, "the BB row shows basis, upper and lower");
equal(macd.values.length, 3, "the MACD row shows MACD, signal and histogram");
equal(new Set(macd.values.map((v) => v.color)).size, 3, "each MACD value has its own plot colour");
assert(bb.values.every((v) => v.color === "#2962ff"), "translucent band colours are made opaque for text");
assert(model.studies.every((s) => s.removable), "unlocked studies are removable");
assert(model.volume && model.volume.text.length > 0, "the volume value is shown");

model = L.buildLegendModel(makeView(chart, { crosshairIndex: 40 }));
equal(model.series.values[0].text, chart.context.formatPrice(bars[40].open, 100), "the crosshair selects the bar the legend describes");
equal(model.studies.find((s) => s.label === "EMA 9").values[0].text, chart.context.formatPrice(chart.store.list()[0].values[40], 100), "study values follow the crosshair");

model = L.buildLegendModel(makeView(chart, { plotW: 400 }));
equal(model.title.description, null, "below 420px the description is dropped");
equal(model.title.exchange, "Mock", "below 420px the title keeps the exchange");
deepEqual(model.series.values.map((v) => v.title), ["C"], "below 420px only the close is shown");
model = L.buildLegendModel(makeView(chart, { plotW: 280 }));
equal(model.title.exchange, null, "on a tiny plot the exchange is dropped too");
equal(model.title.symbol, "MOCK", "the symbol is never dropped");

const ha = L.heikinAshi(bars);
model = L.buildLegendModel(makeView(chart, { seriesBars: ha, crosshairIndex: 50 }));
equal(model.series.values[0].text, chart.context.formatPrice(ha[50].open, 100), "on a Heikin-Ashi chart the legend shows the HA open");
equal(model.series.values[3].text, chart.context.formatPrice(ha[50].close, 100), "on a Heikin-Ashi chart the legend shows the HA close");
assert(ha[50].open !== bars[50].open, "the fixture's HA open differs from the real open");

// Legend overrides and featuresets.
const quiet = makeChart({
  overrides: {
    "paneProperties.legendProperties.showStudyArguments": false,
    "paneProperties.legendProperties.showVolume": false,
    "paneProperties.legendProperties.showSeriesTitle": false,
    "paneProperties.legendProperties.showBarChange": false,
    "paneProperties.legendProperties.showBackground": false,
  },
  disabled_features: ["delete_button_in_legend"],
});
quiet.store.add({ name: "Bollinger Bands", length: 20 });
model = L.buildLegendModel(makeView(quiet));
equal(model.studies[0].label, "BB", "showStudyArguments: false keeps only the short title");
equal(model.volume, null, "showVolume: false hides volume");
equal(model.title, null, "showSeriesTitle: false hides the title");
equal(model.series.change, null, "showBarChange: false hides the change");
equal(model.theme.background, "", "showBackground: false removes the row backdrop");
equal(model.studies[0].removable, false, "delete_button_in_legend disabled hides remove");
const off = makeChart({ overrides: { "paneProperties.legendProperties.showLegend": false } });
equal(L.buildLegendModel(makeView(off)), null, "showLegend: false hides the legend");
const noWidget = makeChart({ disabled_features: ["legend_widget"] });
equal(L.buildLegendModel(makeView(noWidget)), null, "legend_widget disabled hides the legend");

// ── Canvas fallback: clipped, one line per study, "+N" ─────────────────────
function recorder() {
  const calls = { text: [], rect: [] };
  const target = {
    measureText: (value) => ({ width: String(value).length * 7 }),
    fillText: (text, x, y) => calls.text.push({ text, x, y }),
    rect: (x, y, w, h) => calls.rect.push({ x, y, w, h }),
  };
  const ctx = new Proxy(target, {
    get: (object, key) => (key in object ? object[key] : () => {}),
    set: (object, key, value) => { object[key] = value; return true; },
  });
  return { ctx, calls };
}
const crowded = makeChart();
for (const length of [5, 8, 13, 21, 34, 55]) crowded.store.add({ name: "EMA", length });
crowded.store.add({ name: "MACD" });
crowded.store.add({ name: "Bollinger Bands", length: 20 });
for (const plotW of [390 - 64, 480 - 64, 600 - 64]) {
  const v = makeView(crowded, { plotW, plotH: 200 });
  const { ctx, calls } = recorder();
  L.drawLegend(ctx, v);
  const clip = calls.rect[0];
  assert(clip && clip.x + clip.w <= v.plotL + v.plotW - 4, `canvas legend is clipped left of the price axis at ${plotW}px`);
  assert(calls.text.every((c) => c.x < v.plotL + v.plotW - 4), `no canvas legend glyph starts in the price axis at ${plotW}px`);
  const lines = new Set(calls.text.map((c) => c.y)).size;
  const counter = calls.text.find((c) => /^\+\d+$/.test(c.text));
  const shownRows = lines - 2 - (counter ? 1 : 0);
  equal(shownRows + (counter ? Number(counter.text.slice(1)) : 0), 8, `every study is painted or counted in "+N" at ${plotW}px`);
}

// ── Heikin-Ashi last price ──────────────────────────────────────────────────
function lastPriceTag(chart, seriesBars) {
  const { ctx, calls } = recorder();
  L.drawLastPrice(ctx, makeView(chart, { seriesBars }));
  return calls.text.at(-1)?.text;
}
equal(lastPriceTag(chart, ha), chart.context.formatPrice(ha.at(-1).close, 100), "Heikin-Ashi tags the HA close by default");
equal(lastPriceTag(chart, bars), chart.context.formatPrice(bars.at(-1).close, 100), "other styles tag the real close");
const real = makeChart({ overrides: { "mainSeriesProperties.haStyle.showRealLastPrice": true } });
equal(lastPriceTag(real, ha), real.context.formatPrice(bars.at(-1).close, 100), "haStyle.showRealLastPrice tags the real close");

// ── View routing ────────────────────────────────────────────────────────────
{
  const frames = [];
  const detach = L.attachLegendView(chart.context, { render: (frame) => frames.push(frame) });
  const { ctx, calls } = recorder();
  const v = makeView(chart, { plotW: 500 });
  L.drawLegend(ctx, v);
  equal(calls.text.length, 0, "an attached view replaces canvas painting");
  equal(frames.length, 1, "the view receives one frame per paint");
  equal(frames[0].left + frames[0].width, v.plotL + v.plotW - 8, "the frame keeps the legend clear of the price axis");
  const canvas = document.createElement("canvas");
  const snapshot = recorder();
  window.HTMLCanvasElement.prototype.getContext = () => snapshot.ctx;
  assert(L.composeLegendSnapshot(canvas, v) !== canvas, "screenshots get a copy of the canvas");
  assert(snapshot.calls.text.some((c) => c.text.includes("MOCK")), "the copy has the legend painted in");
  detach();
  L.drawLegend(ctx, v);
  assert(calls.text.length > 0, "after detaching, the canvas legend paints again");
  assert(L.composeLegendSnapshot(canvas, v) === canvas, "without a DOM legend the canvas already carries the legend");
}

// ── DOM legend ──────────────────────────────────────────────────────────────
{
  const dom = makeChart();
  for (const spec of [{ name: "EMA", length: 9 }, { name: "VWAP" }, { name: "MACD" }, { name: "Bollinger Bands", length: 20 }]) dom.store.add(spec);
  const log = [];
  const legend = new L.Legend(dom.host, {
    remove: (id) => { log.push(`remove ${id}`); return dom.store.remove(id); },
    undo: () => log.push("undo"),
    redo: () => log.push("redo"),
    announce: (message) => log.push(`announce ${message}`),
    focusChart: () => log.push("focusChart"),
  });
  const render = (options) => {
    const v = makeView(dom, options);
    legend.render(L.legendFrame(v, L.buildLegendModel(v)));
    return v;
  };
  render();
  const el = dom.host.querySelector(".raze-legend");
  assert(el && !el.hidden, "the DOM legend mounts in the host");
  equal(el.getAttribute("role"), "group", "the legend is a named group");
  equal(el.getAttribute("aria-label"), "Chart legend", "the legend has an accessible name");
  equal(el.querySelector(".raze-legend-symbol").textContent, "MOCK", "the title row shows the symbol");
  equal(el.querySelector(".raze-legend-meta").textContent, " · 1m · Mock  Mock Industries", "the title row shows interval, exchange and description");
  equal(el.querySelector(".raze-legend-status").getAttribute("aria-label"), "Market open", "the status dot has an accessible name");
  const rows = () => [...el.querySelectorAll(".raze-legend-row")];
  deepEqual(rows().map((row) => row.querySelector(".raze-legend-label").textContent), ["EMA 9", "VWAP", "MACD 12 26 9", "BB 20 2"], "one row per study, in order");
  const macdRow = rows()[2];
  equal(macdRow.querySelectorAll(".raze-legend-values > span").length, 3, "the MACD row shows three values");
  equal(macdRow.querySelector(".raze-legend-values > span > .raze-legend-sr").textContent, "MACD ", "multi-value rows name each value for screen readers");
  equal(macdRow.querySelector("button").getAttribute("aria-label"), "Remove MACD 12 26 9", "the remove button is named after the row");
  const firstValue = rows()[0].querySelector(".raze-legend-values > span");
  const textNode = firstValue.lastChild;
  render();
  assert(firstValue.lastChild === textNode && rows()[0].querySelector(".raze-legend-values > span") === firstValue, "rows update in place between frames");

  // Keyboard removal moves focus to the next row's remove button.
  const vwapButton = rows()[1].querySelector("button");
  vwapButton.focus();
  vwapButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 0 }));
  assert(log.some((entry) => entry.startsWith("remove study_vwap")), "the remove button removes the study through the store");
  assert(log.includes("announce VWAP removed. Press Ctrl+Z to undo."), "removal is announced with the undo shortcut");
  render();
  deepEqual(rows().map((row) => row.querySelector(".raze-legend-label").textContent), ["EMA 9", "MACD 12 26 9", "BB 20 2"], "the removed row leaves the legend");
  equal(document.activeElement, rows()[1].querySelector("button"), "focus moves to the next row's remove button");

  // Ctrl+Z / Ctrl+Shift+Z inside the legend route to the widget history.
  document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
  document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Z", ctrlKey: true, shiftKey: true, bubbles: true }));
  deepEqual(log.slice(-2), ["undo", "redo"], "Ctrl+Z and Ctrl+Shift+Z undo and redo from the legend");
  document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  equal(log.at(-1), "focusChart", "Escape returns focus to the chart");

  // Pointer removal keeps focus in the legend so Ctrl+Z works immediately.
  const emaButton = rows()[0].querySelector("button");
  emaButton.focus();
  emaButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
  render();
  equal(document.activeElement, el, "after a pointer removal focus rests on the legend");

  // Hover: the crosshair over a row reveals its actions.
  const hoverRow = rows()[0];
  render({ crosshairIndex: 10 });
  const frameTop = 6;
  const v = makeView(dom);
  const y = frameTop + hoverRow.offsetTop + 4;
  legend.render({ ...L.legendFrame(v, L.buildLegendModel(v)), pointer: { x: 20, y } });
  assert(hoverRow.hasAttribute("data-hover"), "the crosshair over a row reveals its actions");
  legend.render({ ...L.legendFrame(v, L.buildLegendModel(v)), pointer: { x: 400, y } });
  assert(!hoverRow.hasAttribute("data-hover"), "moving past the row hides its actions");

  // "+N": rows beyond the height budget collapse into a counted toggle.
  for (const length of [5, 8, 13, 21, 34, 55]) dom.store.add({ name: "SMA", length });
  render({ plotH: 200 });
  const toggle = el.querySelector(".raze-legend-toggle");
  const visible = rows().filter((row) => !row.hidden).length;
  const total = rows().length;
  assert(visible < total, "rows beyond the budget are hidden");
  equal(toggle.textContent, `+${total - visible}`, "the toggle counts the hidden rows");
  equal(toggle.getAttribute("aria-expanded"), "false", "a collapsed toggle reports aria-expanded=false");
  equal(toggle.getAttribute("aria-label"), `Show all indicators (${total - visible} hidden)`, "the toggle names what it reveals");
  toggle.click();
  equal(rows().filter((row) => !row.hidden).length, total, "expanding shows every row");
  equal(toggle.getAttribute("aria-expanded"), "true", "an expanded toggle reports aria-expanded=true");
  assert(el.querySelector(".raze-legend-studies").hasAttribute("data-scroll"), "an expanded legend that overflows scrolls");
  toggle.click();
  equal(rows().filter((row) => !row.hidden).length, 0, "collapsing hides every study row");
  equal(toggle.textContent, `+${total}`, "a collapsed legend counts every study");

  // Locked studies have no remove button; a null model hides the legend.
  const locked = dom.store.add({ name: "RSI", length: 14, lock: true });
  render({ plotH: 2000 });
  const lockedRow = el.querySelector(`[data-study-id="${locked}"]`);
  assert(lockedRow.querySelector("button").hidden, "a locked study has no remove button");
  legend.render({ ...L.legendFrame(v, null) });
  assert(el.hidden, "a null model hides the legend");
  legend.destroy();
  assert(!dom.host.querySelector(".raze-legend"), "destroy removes the legend");
}

console.log(`\n${passed} legend assertions passed`);
