// Axis chrome (W1B-09): the bar-close countdown formatter and clock rules,
// the timezone caption in the reserved corner cell, timescale-mark badges and
// their hit targets, and compare series normalised to their own base and
// included in autoscale.
//
// The painters are internal modules, so this test bundles them from source
// with esbuild (no build step needed): node tests/axis-chrome.mjs

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
  assert(Object.is(actual, expected), `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
const near = (actual, expected, message, eps = 1e-6) =>
  assert(Math.abs(actual - expected) <= eps, `${message} (expected ${expected}, got ${actual})`);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

const entry = `
export * from "./src/engine/paint/chrome";
export { createChartContext, buildFeatureSet } from "./src/core/context";
export { buildTheme } from "./src/core/theme";
export { createPriceFormatter } from "./src/util/format";
export { Delegate } from "./src/util/delegate";
export { ChartRenderer } from "./src/engine/ChartRenderer";
export { yForPrice, toDisplay } from "./src/engine/plotScale";
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts", sourcefile: "axis-chrome-entry.ts" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  write: false,
  logLevel: "silent",
  define: { __RAZE_CHARTS_VERSION__: JSON.stringify("test") },
});
const scratch = mkdtempSync(join(tmpdir(), "raze-axis-chrome-"));
const bundlePath = join(scratch, "axis-chrome.mjs");
writeFileSync(bundlePath, bundled.outputFiles[0].text);
const m = await import(pathToFileURL(bundlePath).href);
rmSync(scratch, { recursive: true, force: true });

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ── Countdown format ─────────────────────────────────────────────────────────
{
  const f = m.formatBarCountdown;
  equal(f(82_525_000), "22:55:25", "1D countdown with 82,525 s left reads h:mm:ss");
  equal(f(59_000), "0:59", "under a minute reads m:ss");
  equal(f(3_599_000), "59:59", "just under an hour stays m:ss");
  equal(f(HOUR), "1:00:00", "one hour switches to h:mm:ss");
  equal(f(DAY - 1_000), "23:59:59", "just under a day stays h:mm:ss");
  equal(f(4 * DAY + 3 * HOUR + 12 * MIN), "4d 03:12", "a weekly countdown reads Nd hh:mm");
  equal(f(10 * DAY), "10d 00:00", "whole days keep the hh:mm part");
  equal(f(-5_000), "0:00", "negative input clamps to zero");
  equal(f(1_999), "0:01", "partial seconds floor");
}

// ── Countdown per resolution (1S, 1, 60, 1D, 1W, 1M) ─────────────────────────
{
  const c = m.barCountdownMs;
  const t = Date.UTC(2024, 0, 15, 12, 0, 0);
  equal(m.formatBarCountdown(c(t, "1S", t)), "0:01", "1S: a fresh second bar counts one second");
  equal(m.formatBarCountdown(c(t, "1", t + 55_000)), "0:05", "1: five seconds left in the minute");
  equal(m.formatBarCountdown(c(t, "60", t + 20 * MIN)), "40:00", "60: forty minutes left in the hour");
  const day = Date.UTC(2024, 0, 15);
  equal(m.formatBarCountdown(c(day, "1D", day + HOUR + 4 * MIN + 35_000)), "22:55:25", "1D: reads 22:55:25, not 1375:25");
  equal(m.formatBarCountdown(c(day, "1W", day + 2 * DAY + 20 * HOUR + 48 * MIN)), "4d 03:12", "1W: reads Nd hh:mm");
  const feb = Date.UTC(2024, 1, 1);
  equal(m.barCloseTime(feb, "1M"), Date.UTC(2024, 2, 1), "1M closes at the next calendar month, not after 30 days");
  equal(m.formatBarCountdown(c(feb, "1M", Date.UTC(2024, 1, 20))), "10d 00:00", "1M: 29-day February counts to 1 March");
  equal(m.barCloseTime(Date.UTC(2024, 0, 31), "1M"), Date.UTC(2024, 1, 29), "month ends clamp to the shorter month");
  equal(m.barCloseTime(Date.UTC(2024, 0, 1), "3M"), Date.UTC(2024, 3, 1), "multi-month bars step by calendar months");
  equal(c(t, "1", t + 150_000), null, "a bar older than one period after its close is stale: hidden");
  equal(c(t, "1", t + 90_000), 30_000, "a quiet market with no tick yet counts down the running period");
  equal(c(t, "1", t - 30_000), 60_000, "a clock behind the feed never shows more than one bar");
  equal(c(day, "1D", day + 3 * DAY), null, "a historical daily series shows no countdown");
  equal(c(Number.NaN, "1", t), null, "a non-finite bar time hides the countdown");
}

// ── Timezone caption ─────────────────────────────────────────────────────────
{
  const jan = Date.UTC(2024, 0, 15);
  const jul = Date.UTC(2024, 6, 15);
  equal(m.utcOffsetLabel("America/New_York", jan), "UTC-5", "New York in winter is UTC-5");
  equal(m.utcOffsetLabel("America/New_York", jul), "UTC-4", "New York in summer follows DST: UTC-4");
  equal(m.utcOffsetLabel("Asia/Kolkata", jan), "UTC+5:30", "half-hour offsets keep their minutes");
  equal(m.utcOffsetLabel("Etc/UTC", jan), "UTC", "UTC has no offset suffix");
  equal(m.utcOffsetLabel("Not/AZone", jan), "Not/AZone", "an unknown zone is shown unchanged");
  const measure = (s) => s.length * 6;
  equal(m.timezoneCaption("Etc/UTC", jan, 50, measure), "Etc/UTC", "a name that fits the corner cell is shown in full");
  equal(m.timezoneCaption("America/New_York", jan, 50, measure), "UTC-5", "a long name abbreviates to its UTC offset");
  equal(m.displayTimezone({ timezone: "exchange", symbolInfo: { timezone: "Asia/Tokyo" }, options: {} }), "Asia/Tokyo", "exchange follows the symbol zone");
  equal(m.displayTimezone({ timezone: null, symbolInfo: null, options: {} }), "Etc/UTC", "no setting and no symbol falls back to Etc/UTC");
}

// ── Recording canvas context ─────────────────────────────────────────────────
function recordingContext() {
  const calls = [];
  const state = { font: "10px sans-serif", fillStyle: "#000", strokeStyle: "#000", textAlign: "start", textBaseline: "alphabetic", lineWidth: 1, globalAlpha: 1, lineJoin: "miter" };
  const stack = [];
  let path = [];
  const ctx = {
    get canvas() { return {}; },
    save() { stack.push({ ...state }); },
    restore() { Object.assign(state, stack.pop() ?? {}); },
    measureText(text) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1] ?? 10);
      return { width: String(text).length * px * 0.6 };
    },
    fillText(text, x, y) { calls.push({ op: "fillText", text: String(text), x, y, ...state }); },
    beginPath() { path = []; },
    moveTo(x, y) { path.push({ x, y, move: true }); },
    lineTo(x, y) { path.push({ x, y }); },
    arc(x, y, r) { path.push({ arc: true, x, y, r }); },
    stroke() { calls.push({ op: "stroke", path: path.slice(), ...state }); },
    fill() { calls.push({ op: "fill", path: path.slice(), ...state }); },
    setLineDash() {},
  };
  const proxy = new Proxy(ctx, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in state) return state[prop];
      return () => {};
    },
    set(target, prop, value) {
      state[prop] = value;
      return true;
    },
  });
  return { ctx: proxy, calls };
}

function makeContext({ bars, resolution = "1", now, features = [], disabled = [], overrides = {}, timezone = "Etc/UTC", compare = [], percent = false, log = false }) {
  const options = { timezone, overrides, enabled_features: features, disabled_features: disabled };
  return m.createChartContext({
    options,
    datafeed: {},
    locale: "en",
    fontFamily: "sans-serif",
    symbol: "BTC",
    resolution,
    symbolInfo: { timezone: "Etc/UTC", pricescale: 100 },
    theme: m.buildTheme(options),
    features: m.buildFeatureSet(options),
    formatPrice: m.createPriceFormatter(options, null),
    bars,
    marks: [],
    timescaleMarks: [],
    visibleRange: { from: 0, to: Math.max(1, bars.length - 1) },
    autoScalePrice: true,
    priceRange: null,
    chartStyle: "candles",
    logScale: log,
    percentScale: percent,
    volumeMode: "overlay",
    magnet: false,
    stayInDrawingMode: false,
    compare,
    syncedCrosshair: null,
    drawingTool: "cursor",
    selectedShapeId: null,
    selectedTradingLineId: null,
    intervalChanged: new m.Delegate(),
    dataChanged: new m.Delegate(),
    drawingEvent: new m.Delegate(),
    tradingEvent: new m.Delegate(),
    viewportChanged: new m.Delegate(),
    crosshairMoved: new m.Delegate(),
    requestPaint() {},
  }, { clock: () => now ?? Date.now() });
}

function makeView(context, extra = {}) {
  const plotW = 700;
  const plotH = 400;
  const priceAxisW = 64;
  return {
    plotL: 0,
    plotT: 0,
    plotW,
    plotH,
    priceMin: 90,
    priceMax: 130,
    pctBase: context.bars[0]?.close ?? 1,
    visibleRange: context.visibleRange,
    percentScale: context.percentScale,
    logScale: context.logScale,
    context,
    cssWidth: plotW + priceAxisW,
    cssHeight: plotH + 22,
    dpr: 1,
    priceAxisW,
    subPanes: [],
    volumePane: null,
    seriesBars: context.bars,
    markScreen: [],
    shapeScreen: [],
    tradingScreen: [],
    timescaleMarkScreen: [],
    crosshair: { x: 0, y: 0, active: false },
    hoverMark: null,
    hoverTimescaleMark: null,
    hoverShapeId: null,
    draft: null,
    selectedShapeId: null,
    selectedTradingLineId: null,
    fontFamily: "sans-serif",
    axisTags: [],
    axisChromeRect: { x: plotW, y: plotH, w: priceAxisW, h: 22 },
    ...extra,
  };
}

function series(count, { start, step, base, drift = 0.002 }) {
  const out = [];
  let price = base;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 + Math.sin(i / 5) * drift + drift / 4);
    out.push({ time: start + i * step, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1 });
    price = close;
  }
  return out;
}

// ── Corner caption and countdown painting ────────────────────────────────────
{
  const day = Date.UTC(2024, 0, 15);
  const bars = series(30, { start: day - 29 * DAY, step: DAY, base: 100 });
  const now = day + HOUR + 4 * MIN + 35_000;
  const context = makeContext({ bars, resolution: "1D", now });
  const view = makeView(context);
  const { ctx, calls } = recordingContext();
  m.drawAxisChrome(ctx, view);
  const texts = calls.filter((c) => c.op === "fillText");
  const caption = texts.find((c) => c.text === "Etc/UTC");
  assert(caption, "the timezone caption is painted");
  const cell = view.axisChromeRect;
  const captionWidth = caption.text.length * 10 * 0.6;
  assert(caption.textAlign === "right" && caption.x <= cell.x + cell.w && caption.x - captionWidth >= cell.x, "the caption stays inside the reserved corner cell");
  assert(caption.y > cell.y && caption.y < cell.y + cell.h, "the caption is vertically centred in the time-axis row");
  const countdown = texts.find((c) => c.text === "22:55:25");
  assert(countdown, "the 1D countdown reads 22:55:25 through the context clock");
  assert(countdown.x > view.plotW && countdown.x <= view.plotW + view.priceAxisW, "the countdown sits on the price axis, not in the time axis");
  const lastY = m.yForPrice(view, bars[bars.length - 1].close);
  assert(countdown.y > lastY && countdown.y - lastY < 30, "the countdown is a second line directly under the last-price tag");
  assert(!texts.some((c) => /\d{3,}:\d\d/.test(c.text)), "no unbounded minute count is painted");

  // Long zone names abbreviate inside the cell.
  const ny = makeContext({ bars, resolution: "1D", now, timezone: "America/New_York" });
  const nyCalls = recordingContext();
  m.drawAxisChrome(nyCalls.ctx, makeView(ny));
  assert(nyCalls.calls.some((c) => c.op === "fillText" && c.text === "UTC-5"), "America/New_York abbreviates to UTC-5 in a 64px cell");

  // Tag near the bottom edge: the countdown flips above it.
  const low = makeView(context, { priceMin: 200, priceMax: 300 });
  const lowBox = m.countdownBox(low);
  assert(lowBox && !lowBox.below && lowBox.rect.y + lowBox.rect.h <= low.plotT + low.plotH, "a tag clamped to the bottom edge puts the countdown above it");

  // Stale bars hide the countdown; the caption stays.
  const stale = makeContext({ bars, resolution: "1D", now: day + 5 * DAY });
  const staleCalls = recordingContext();
  m.drawAxisChrome(staleCalls.ctx, makeView(stale));
  const staleTexts = staleCalls.calls.filter((c) => c.op === "fillText").map((c) => c.text);
  assert(staleTexts.includes("Etc/UTC") && staleTexts.length === 1, "a stale series shows the caption but no frozen 0:00 countdown");

  // Feature and override gating.
  const off = makeContext({ bars, resolution: "1D", now, overrides: { "mainSeriesProperties.showCountdown": false } });
  equal(m.countdownBox(makeView(off)), null, "mainSeriesProperties.showCountdown=false hides the countdown");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const disabled = makeContext({ bars, resolution: "1D", now, disabled: ["countdown"], overrides: { "mainSeriesProperties.showCountdown": true } });
    equal(m.countdownBox(makeView(disabled)), null, "the countdown feature stays authoritative");
    m.countdownBox(makeView(disabled));
    assert(warnings.length === 1 && /showCountdown/.test(warnings[0]) && /disabled_features/.test(warnings[0]), "an override the feature set blocks warns once with guidance");
  } finally {
    console.warn = originalWarn;
  }
  const noTz = makeContext({ bars, resolution: "1D", now, disabled: ["timezone_display", "countdown"] });
  const noTzCalls = recordingContext();
  m.drawAxisChrome(noTzCalls.ctx, makeView(noTz));
  equal(noTzCalls.calls.length, 0, "both features disabled paints nothing");

  // Server clock: now() includes the datafeed offset.
  context.setServerTimeOffset(10_000);
  equal(m.countdownBox(makeView(context)).text, "22:55:15", "the countdown follows the server clock offset");
}

// ── Timescale marks ──────────────────────────────────────────────────────────
{
  const t0 = Date.UTC(2024, 0, 15, 10);
  const bars = series(100, { start: t0, step: MIN, base: 100 });
  const context = makeContext({ bars, resolution: "1", now: t0 + 99 * MIN + 5_000 });
  context.visibleRange = { from: 0, to: 99 };
  const sec = (i) => (t0 + i * MIN) / 1000;
  context.timescaleMarks = [
    { id: 1, time: sec(20), color: "red", label: "Earnings", tooltip: ["Earnings", "EPS 1.23"] },
    { id: 2, time: sec(50), color: "#ff9800", label: "D", tooltip: ["Dividend"] },
    { id: 3, time: sec(50), color: "blue", label: "S", tooltip: ["Split"] },
    { id: 4, time: sec(80), color: "green", label: "A", tooltip: [], shape: "earningUp" },
    { id: 5, time: sec(80), color: "green", label: "B", tooltip: [] },
    { id: 6, time: sec(80), color: "green", label: "C", tooltip: [] },
    { id: 7, time: sec(80), color: "green", label: "D", tooltip: [] },
    { id: 8, time: sec(500), color: "green", label: "X", tooltip: [] },
  ];
  const view = makeView(context);
  const axisTop = view.plotT + view.plotH;
  const { ctx, calls } = recordingContext();
  m.drawTimescaleMarks(ctx, view);
  const hits = view.timescaleMarkScreen;
  equal(hits.length, 6, "every visible mark gets a hit target (the fourth in a stack collapses into +N)");
  assert(hits.every((h) => h.y + h.r <= axisTop && h.y - h.r >= view.plotT), "badges sit above the time axis, never on its tick labels");
  const glyphs = calls.filter((c) => c.op === "fillText").map((c) => c.text);
  assert(glyphs.includes("E") && !glyphs.some((g) => g.length > 2 && g !== "+2"), "long labels collapse to one glyph instead of overprinting text");
  assert(glyphs.includes("+2"), "a cluster over three marks shows an overflow badge");
  const first = hits.find((h) => h.mark.id === 1);
  near(first.x, 20 * (view.plotW / 99) + 0.5 * (view.plotW / 99), "the badge is centred on its bar", 1e-6);
  const fills = calls.filter((c) => c.op === "fill" && c.path.some((p) => p.arc));
  assert(fills.some((c) => c.fillStyle === "#f23645"), "named colours map to TradingView's palette");
  equal(m.timescaleMarkAt(hits, first.x + 3, first.y - 3)?.mark.id, 1, "hit-testing finds the badge under the pointer");
  equal(m.timescaleMarkAt(hits, first.x + 30, first.y), null, "hit-testing misses empty space");
  const stack = hits.filter((h) => h.mark.id === 2 || h.mark.id === 3);
  assert(stack.length === 2 && stack[0].x === stack[1].x && stack[0].y !== stack[1].y, "marks on the same bar stack vertically");

  // Hover: a ring and a guide line in the mark colour.
  const hoverView = makeView(context, { hoverTimescaleMark: context.timescaleMarks[0] });
  const hover = recordingContext();
  m.drawTimescaleMarks(hover.ctx, hoverView);
  const strokes = hover.calls.filter((c) => c.op === "stroke" && c.strokeStyle === "#f23645");
  assert(strokes.length >= 2, "the hovered badge gets a ring and a guide line");

  // Unknown shapes draw a circle and warn once.
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    context.timescaleMarks = [
      { id: 9, time: sec(10), color: "red", label: "Q", tooltip: [], shape: "hexagon" },
      { id: 10, time: sec(30), color: "red", label: "I", tooltip: [], imageUrl: "https://example.test/logo.png" },
    ];
    m.drawTimescaleMarks(recordingContext().ctx, makeView(context));
    m.drawTimescaleMarks(recordingContext().ctx, makeView(context));
  } finally {
    console.warn = originalWarn;
  }
  assert(warnings.filter((w) => /hexagon/.test(w) && /circle/.test(w)).length === 1, "an unsupported mark shape warns once with the supported list");
  assert(warnings.filter((w) => /imageUrl/.test(w)).length === 1, "an unsupported mark image warns once instead of being ignored silently");
  context.timescaleMarks = [];
  const emptyView = makeView(context);
  emptyView.timescaleMarkScreen.push(hits[0]);
  m.drawTimescaleMarks(recordingContext().ctx, emptyView);
  equal(emptyView.timescaleMarkScreen.length, 0, "the painter resets stale hit targets every frame");
  equal(m.timescaleMarkGlyph("Earnings"), "E", "glyph: first character of a long label");
  equal(m.timescaleMarkGlyph("Q1"), "Q1", "glyph: two-character labels are kept");
}

// ── Compare normalisation ────────────────────────────────────────────────────
{
  const t0 = Date.UTC(2024, 0, 15, 10);
  const btc = series(200, { start: t0, step: MIN, base: 74_000, drift: 0.001 });
  const eth = series(200, { start: t0, step: MIN, base: 2_978, drift: 0.004 });
  for (const mode of ["percent", "price", "log"]) {
    const context = makeContext({
      bars: btc,
      resolution: "1",
      percent: mode === "percent",
      log: mode === "log",
      compare: [{ id: "compare_ETH_1", symbol: "ETH", bars: eth, color: "#f5a623" }],
    });
    context.visibleRange = { from: 60, to: 180 };
    const first = 60;
    const scaleBase = { plotL: 0, plotT: 0, plotW: 700, plotH: 400, priceMin: 0, priceMax: 1, pctBase: btc[first].close, visibleRange: context.visibleRange, percentScale: mode === "percent", logScale: mode === "log" };
    const levels = m.compareAutoScaleLevels(scaleBase, context);
    const mainLo = Math.min(...btc.slice(60, 181).map((b) => m.toDisplay(scaleBase, b.low)));
    const mainHi = Math.max(...btc.slice(60, 181).map((b) => m.toDisplay(scaleBase, b.high)));
    const lo = Math.min(mainLo, ...levels);
    const hi = Math.max(mainHi, ...levels);
    const scale = { ...scaleBase, priceMin: lo, priceMax: hi };
    const [projection] = m.projectCompares(scale, context);
    equal(projection.base, eth[first].close, `${mode}: the compare is normalised to its own close at the first visible bar`);
    const start = projection.points.find((p) => p.logical === first);
    near(m.yForPrice(scale, start.price), m.yForPrice(scale, btc[first].close), `${mode}: compare y at the first visible bar equals the main series y`, 1e-6);
    const ys = projection.points.filter((p) => p.logical >= first && p.logical <= 180).map((p) => m.yForPrice(scale, p.price));
    assert(ys.every((y) => y >= -1e-6 && y <= 400 + 1e-6), `${mode}: with compares in autoscale ETH (≈3,000) stays inside a BTC (≈74,000) plot`);
    assert(projection.points.length <= 125, `${mode}: only the visible window (±1 bar) is projected`);
    if (mode === "percent") {
      const label = m.compareAxisLabel(scale, projection);
      assert(/^[+-]\d+\.\d\d%$/.test(label), "percent mode labels the compare with its own percent change");
    } else {
      equal(m.compareAxisLabel(scale, projection), eth[eth.length - 1].close.toFixed(2), `${mode}: price modes label the compare with its own price`);
    }
  }

  // Painter: the line is drawn from the projection and queues a compare axis tag.
  const context = makeContext({
    bars: btc,
    resolution: "1",
    percent: true,
    compare: [{ id: "compare_ETH_1", symbol: "ETH", bars: eth, color: "#f5a623" }],
  });
  context.visibleRange = { from: 60, to: 180 };
  const view = makeView(context, { pctBase: btc[60].close, priceMin: -20, priceMax: 20, percentScale: true });
  const { ctx, calls } = recordingContext();
  m.drawCompare(ctx, view);
  const line = calls.find((c) => c.op === "stroke" && c.strokeStyle === "#f5a623");
  assert(line && line.path.length > 100, "the compare line is stroked");
  assert(view.axisTags.length === 1 && view.axisTags[0].source.kind === "compare" && view.axisTags[0].source.id === "compare_ETH_1", "the compare queues its last-value axis tag");

  // A compare still loaded at another resolution is skipped until reloaded.
  context.compare[0].resolution = "5";
  equal(m.projectCompares(view, context).length, 0, "a compare at a stale resolution is not painted against the new axis");
  context.compare[0].resolution = "1";
  equal(m.projectCompares(view, context).length, 1, "a compare at the chart resolution is painted");
  context.compare[0].bars = eth.map((b) => ({ ...b, time: b.time + 10 * DAY }));
  equal(m.projectCompares(view, context).length, 0, "a compare with no data in the visible window is skipped");
}

// ── Renderer: compares take part in autoscale ────────────────────────────────
{
  const t0 = Date.UTC(2024, 0, 15, 10);
  const btc = series(200, { start: t0, step: MIN, base: 74_000, drift: 0.001 });
  const eth = series(200, { start: t0, step: MIN, base: 2_978, drift: 0.01 });
  for (const percent of [true, false]) {
    const context = makeContext({
      bars: btc,
      resolution: "1",
      percent,
      compare: [{ id: "compare_ETH_1", symbol: "ETH", bars: eth, color: "#f5a623" }],
    });
    context.visibleRange = { from: 60, to: 180 };
    const { ctx } = recordingContext();
    const engine = { canvas: document.createElement("canvas"), cssWidth: 764, cssHeight: 422, dpr: 1, paintHook: null, markDirty() {} };
    const stub = new Proxy({}, { get: () => () => [] });
    const renderer = new m.ChartRenderer(context, engine, stub, stub, {}, stub);
    renderer.render(ctx);
    const view = renderer.financeView();
    const [projection] = m.projectCompares(view, context);
    const ys = projection.points.filter((p) => p.logical >= 60 && p.logical <= 180).map((p) => m.yForPrice(view, p.price));
    assert(
      ys.every((y) => y >= view.plotT && y <= view.plotT + view.plotH),
      `renderer (${percent ? "percent" : "price"} mode): the fitted range includes every visible compare point`,
    );
  }
}

console.log(`\nAXIS CHROME: PASS (${passed} assertions)`);
