// Contract tests for the trading and shape stores (W1B-20): tick-rounded
// order prices, TradingView's two-argument callbacks, the drawing text
// setter, integer z-order, closed shape-kind validation with TradingView
// aliases, point validation, and per-instance id allocation.
//
// The stores are bundled from source with esbuild (no build step needed):
//   node tests/stores-contract.mjs

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
const throwsLike = (fn, ctor, pattern, message) => {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  const ok = error instanceof ctor && pattern.test(String(error.message));
  assert(ok, ok ? message : `${message}${error ? ` (got ${error.name}: ${error.message})` : " (nothing was thrown)"}`);
  return error;
};
const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
};

// Console capture: warnings and errors are asserted, not printed.
const consoleLog = { warn: [], error: [] };
const realWarn = console.warn;
const realError = console.error;
console.warn = (...args) => { consoleLog.warn.push(args.map(String).join(" ")); };
console.error = (...args) => { consoleLog.error.push(args.map(String).join(" ")); };
const takeWarnings = () => consoleLog.warn.splice(0);
const takeErrors = () => consoleLog.error.splice(0);

// ── DOM environment (mirrors tests/seams.mjs) ───────────────────────────────
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
window.devicePixelRatio = 2;
const context2d = new Proxy(
  { measureText: (value) => ({ width: String(value ?? "").length * 6 }), canvas: {} },
  {
    get: (target, property) => (property in target ? target[property] : () => {}),
    set: (target, property, value) => {
      target[property] = value;
      return true;
    },
  },
);
window.HTMLCanvasElement.prototype.getContext = () => context2d;
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 640 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 360 });
class TestResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([]); }
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver;
window.ResizeObserver = TestResizeObserver;
const frames = new Map();
let nextFrameId = 0;
globalThis.requestAnimationFrame = (callback) => {
  const id = ++nextFrameId;
  frames.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
const flushFrames = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
};

// ── Bundle the stores from source ───────────────────────────────────────────
const entry = `
export { ShapeStore, ShapeError, BUILTIN_SHAPE_TOOLS, SHAPE_NAME_ALIASES, createShapeKindCatalog, builtinShapeCatalog } from "./src/core/ShapeStore";
export { TradingStore, roundToPriceGrid, priceGridFromStep } from "./src/core/TradingStore";
export { CommandStack } from "./src/core/CommandStack";
export { IdAllocator, idSlug } from "./src/core/ids";
export { createChartContext } from "./src/core/context";
export { buildTheme } from "./src/core/theme";
export { buildFeatureSet } from "./src/core/context";
export { createPriceFormatter } from "./src/util/format";
export { Widget } from "./src/core/Widget";
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts", sourcefile: "stores-entry.ts" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  write: false,
  logLevel: "silent",
  define: { __RAZE_CHARTS_VERSION__: JSON.stringify("test") },
});
const scratch = mkdtempSync(join(tmpdir(), "raze-stores-"));
const bundlePath = join(scratch, "stores.mjs");
writeFileSync(bundlePath, bundled.outputFiles[0].text);
const mod = await import(pathToFileURL(bundlePath).href);
rmSync(scratch, { recursive: true, force: true });
const {
  BUILTIN_SHAPE_TOOLS,
  CommandStack,
  IdAllocator,
  SHAPE_NAME_ALIASES,
  ShapeError,
  ShapeStore,
  TradingStore,
  Widget,
  buildFeatureSet,
  buildTheme,
  builtinShapeCatalog,
  createChartContext,
  createPriceFormatter,
  createShapeKindCatalog,
  idSlug,
  priceGridFromStep,
  roundToPriceGrid,
} = mod;

class Emitter {
  constructor() { this.listeners = []; }
  subscribe(_obj, fn) { this.listeners.push(fn); }
  unsubscribe(_obj, fn) { this.listeners = this.listeners.filter((l) => l !== fn); }
  unsubscribeAll() { this.listeners = []; }
  fire(...args) { for (const fn of this.listeners.slice()) fn(...args); }
}

const symbolInfo = (overrides = {}) => ({
  name: "TEST", ticker: "TEST", description: "TEST", type: "crypto", session: "24x7", timezone: "Etc/UTC",
  exchange: "T", listed_exchange: "T", format: "price", minmov: 1, pricescale: 100, has_intraday: true,
  supported_resolutions: ["1"], ...overrides,
});
const NOW_SECONDS = 1_700_000_000;
const barAt = (i) => ({ time: (NOW_SECONDS + i * 60) * 1000, open: 100, high: 102, low: 99, close: 101, volume: 10 });

function makeContext(info = symbolInfo()) {
  const options = { symbol: "TEST", interval: "1", container: "x", datafeed: {} };
  return createChartContext({
    options,
    datafeed: options.datafeed,
    locale: "en",
    fontFamily: "sans-serif",
    symbol: "TEST",
    resolution: "1",
    symbolInfo: info,
    formatPrice: createPriceFormatter(options, info),
    theme: buildTheme(options),
    features: buildFeatureSet(options),
    bars: Array.from({ length: 10 }, (_, i) => barAt(i)),
    marks: [],
    timescaleMarks: [],
    visibleRange: { from: 0, to: 9 },
    autoScalePrice: true,
    priceRange: null,
    chartStyle: "candles",
    logScale: false,
    percentScale: false,
    volumeMode: "overlay",
    magnet: false,
    stayInDrawingMode: false,
    compare: [],
    syncedCrosshair: null,
    drawingTool: "cursor",
    selectedShapeId: null,
    selectedTradingLineId: null,
    intervalChanged: new Emitter(),
    dataChanged: new Emitter(),
    drawingEvent: new Emitter(),
    tradingEvent: new Emitter(),
    viewportChanged: new Emitter(),
    crosshairMoved: new Emitter(),
    requestPaint: () => {},
  });
}

// ── IdAllocator follow-ups (W1A-06) ─────────────────────────────────────────
{
  for (const bad of [Infinity, 1.5, 0, -3, Number.NaN, 2 ** 60]) {
    throwsLike(() => new IdAllocator({ maxAttempts: bad }), RangeError, /positive integer/, `IdAllocator rejects maxAttempts ${bad}`);
  }
  assert(new IdAllocator({ maxAttempts: 1 }).next("shape") === "shape_1", "maxAttempts 1 is a valid bound");
  const historicalStudySlug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const names = ["EMA", "Bollinger Bands", "MACD (12, 26)", "  padded  ", "_private_", "Volume Weighted (VWAP)", "ÄÖ Ü"];
  assert(
    names.every((name) => idSlug(name) === historicalStudySlug(name)),
    "idSlug produces exactly the historical StudyStore slug, edge underscores included",
  );
  assert(idSlug("") === "item", "an empty name still yields a usable label");
}

// ── Trading: tick rounding ──────────────────────────────────────────────────
{
  const context = makeContext();
  const store = new TradingStore(context);
  const events = [];
  const order = store.create({ side: "buy", price: 101.5, onChange: (event) => events.push(event) });
  const tick = 1 / 100;
  let naive = 101.5;
  for (let i = 0; i < 7; i++) naive += tick;
  assert(naive !== 101.57, `naive tick accumulation drifts (${naive}), so the next check is meaningful`);
  for (let i = 0; i < 7; i++) {
    const line = store.get(order.id);
    store.move(order.id, line.price + tick, "moved", "keyboard");
  }
  assert(order.getPrice() === 101.57, `7 keyboard nudges from 101.5 give exactly 101.57 (got ${order.getPrice()})`);
  assert(events.at(-1).line.price === 101.57 && events.at(-1).reason === "keyboard", "keyboard move events carry the rounded price");
  store.move(order.id, order.getPrice() - tick * 10, "moved", "keyboard");
  assert(order.getPrice() === 101.47, "a Shift nudge moves ten ticks exactly");

  events.length = 0;
  store.move(order.id, 101.23456789, "moving", "drag");
  assert(order.getPrice() === 101.23 && events.at(-1).line.price === 101.23, "drag steps snap to the symbol tick in state and in events");
  store.move(order.id, order.getPrice(), "moved", "drag");
  assert(order.getPrice() === 101.23 && events.at(-1).type === "moved", "a committed drag keeps the on-tick price");

  order.setPrice(101.503);
  assert(order.getPrice() === 101.503, "API prices are never rounded: the host is authoritative");
  store.move(order.id, 101.503, "moved", "drag");
  assert(order.getPrice() === 101.503, "a click (release without drag steps) never snaps an off-tick API price");
  store.move(order.id, 102.3456, "moving", "drag");
  assert(order.getPrice() === 102.35, "dragging an off-tick line snaps it onto the grid");
  store.move(order.id, 101.503, "moved", "drag");
  assert(order.getPrice() === 101.503, "a cancelled drag restores the original off-tick price exactly");
  store.move(order.id, 101.503 + tick, "moved", "keyboard");
  assert(order.getPrice() === 101.51, "an up nudge from an off-tick price lands on the next tick above");
  order.setPrice(101.503);
  store.move(order.id, 101.503 - tick, "moved", "keyboard");
  assert(order.getPrice() === 101.5, "a down nudge from an off-tick price lands on the next tick below");

  const nickel = new TradingStore(makeContext(symbolInfo({ minmov: 5, pricescale: 100 })));
  const nickelLine = nickel.create({ price: 100 });
  nickel.move(nickelLine.id, 101.23, "moving", "drag");
  assert(nickelLine.getPrice() === 101.25 && nickel.priceStep(nickelLine.id) === 0.05, "minmov / pricescale defines the tick (0.05)");
  const bond = new TradingStore(makeContext(symbolInfo({ minmov: 1, pricescale: 32 })));
  const bondLine = bond.create({ price: 100 });
  bond.move(bondLine.id, 101.1, "moving", "drag");
  assert(bondLine.getPrice() === 101.09375, "fractional pricescales (1/32) round onto their grid");
}

// ── Trading: priceStep override ─────────────────────────────────────────────
{
  const store = new TradingStore(makeContext());
  const line = store.create({ price: 101, priceStep: 0.25 });
  assert(store.priceStep(line.id) === 0.25, "priceStep overrides the symbol tick per line");
  store.move(line.id, 101.3, "moving", "drag");
  assert(line.getPrice() === 101.25, "drags land on the line's priceStep");
  store.move(line.id, line.getPrice() + 0.01, "moved", "keyboard");
  assert(line.getPrice() === 101.5, "a one-tick nudge still moves one full priceStep, never zero");
  store.move(line.id, line.getPrice() - 0.1, "moved", "keyboard");
  assert(line.getPrice() === 101.25, "a Shift nudge smaller than priceStep moves one step down");
  line.setPrice(101.1);
  store.move(line.id, 101.11, "moved", "keyboard");
  assert(line.getPrice() === 101.25, "nudging up from off-grid lands on the next step above");
  line.setPrice(101.1);
  store.move(line.id, 101.09, "moved", "keyboard");
  assert(line.getPrice() === 101, "nudging down from off-grid lands on the next step below");
  const tenth = store.create({ price: 1, priceStep: 0.1 });
  for (let i = 0; i < 3; i++) store.move(tenth.id, tenth.getPrice() + 0.1, "moved", "keyboard");
  assert(tenth.getPrice() === 1.3, "decimal steps build prices from integers (1 + 3 x 0.1 === 1.3)");
  for (const bad of [0, -1, Number.NaN, Infinity, "0.25"]) {
    throwsLike(() => store.create({ price: 1, priceStep: bad }), TypeError, /priceStep must be a positive finite number/, `priceStep ${String(bad)} is rejected with guidance`);
  }
  throwsLike(() => store.createBracket({ side: "buy", entryPrice: 1, priceStep: -2 }), TypeError, /bracket priceStep/, "bracket priceStep is validated before any leg exists");
  assert(store.list().length === 2, "rejected creations leave no partial lines behind");
  const bracket = store.createBracket({ side: "buy", entryPrice: 100, stopLossPrice: 99, priceStep: 0.5 });
  assert(store.priceStep(bracket.entry.id) === 0.5 && store.priceStep(bracket.stopLoss.id) === 0.5, "bracket priceStep reaches every leg");
  const grid = priceGridFromStep(0.25);
  assert(grid.numerator === 25 && grid.denominator === 100 && roundToPriceGrid(3.38, grid) === 3.5, "price grids are exact decimal fractions");
}

// ── Trading: callback overloads ─────────────────────────────────────────────
{
  const store = new TradingStore(makeContext());
  const line = store.create({ price: 100, editable: true });
  const calls = [];
  const data = { orderId: 7 };
  line
    .onMoving(data, function (received) { calls.push(["moving", this, received]); })
    .onMove(data, function (received) { calls.push(["move", this, received]); })
    .onModify("modify-data", function (received) { calls.push(["modify", this, received]); });
  store.move(line.id, 100.5, "moving", "drag");
  store.move(line.id, 100.5, "moved", "drag");
  store.modify(line.id);
  assert(calls.length === 3, "two-argument onMoving/onMove/onModify callbacks all fire");
  assert(calls.every(([, self, received], index) => index === 2 ? self === "modify-data" && received === "modify-data" : self === data && received === data), "two-argument callbacks run with this === data and receive data");

  let cancelled = null;
  line.onCancel("text", function (received) { cancelled = { self: this, received }; });
  store.cancel(line.id);
  assert(cancelled?.self === "text" && cancelled.received === "text", "onCancel(data, cb) runs with this === data (TradingView sample form)");

  const single = store.create({ price: 100 });
  let seen = null;
  single.onMove(function (received) { seen = { self: this, received }; });
  single.setPrice(101);
  assert(seen?.self === single && seen.received === single, "the one-argument form still receives the adapter as this and argument");

  throwsLike(() => single.onCancel("text"), TypeError, /onCancel\(\) needs a callback function.*onCancel\(data, callback\)/, "a lone non-function is rejected with both valid forms");
  throwsLike(() => single.onMove({}, "nope"), TypeError, /onMove\(data, callback\) needs a function/, "a two-argument call needs a function second");

  takeErrors();
  single.onMove(() => { throw new Error("broker offline"); });
  single.setPrice(102);
  const errors = takeErrors();
  assert(single.getPrice() === 102 && errors.length === 1 && /onMove callback threw/.test(errors[0]), "a throwing callback is reported on the console and cannot corrupt state");
}

// ── Trading: per-instance ids ───────────────────────────────────────────────
{
  const first = new TradingStore(makeContext());
  const second = new TradingStore(makeContext());
  first.create({ kind: "position" });
  assert(first.create({}).id === "order_2" && second.create({}).id === "order_1", "trading ids come from the widget's IdAllocator, not a page-wide counter");
  first.create({ id: "order_40" });
  assert(first.create({}).id === "order_41", "host-supplied trading ids are reserved");
  const bracket = second.createBracket({ side: "sell", entryPrice: 10 });
  assert(bracket.id === "bracket_2" && bracket.entry.id === "bracket_2:entry", "bracket ids share the trading namespace");
}

// ── Shapes: kind validation and aliases ─────────────────────────────────────
function shapeStore(catalog) {
  const context = makeContext();
  const commands = new CommandStack();
  const pushed = [];
  const push = commands.push.bind(commands);
  commands.push = (command) => { pushed.push(command); push(command); };
  const events = [];
  context.drawingEvent.subscribe(null, (id, type) => events.push([id, type]));
  return { context, commands, pushed, events, store: new ShapeStore(context, commands, catalog) };
}
const P = (offset = 0, price = 100) => ({ time: NOW_SECONDS + offset * 60, price });

{
  const { store } = shapeStore();
  takeWarnings();
  const unknown = await rejection(store.create(P(), { shape: "arrow_up" }));
  const warned = takeWarnings();
  assert(unknown instanceof ShapeError && unknown.code === "E_SHAPE_KIND", "createShape('arrow_up') rejects with a typed ShapeError");
  assert(/Supported kinds: trend_line, horizontal_line, vertical_line, ray, extended_line, measure, fib_retracement, rectangle, text \(/.test(unknown.message) && /extended -> extended_line/.test(unknown.message), "the error lists the supported kinds and TradingView aliases");
  assert(unknown.supported.includes("text") && !unknown.supported.includes("extended"), "the error exposes canonical kinds as data");
  assert(warned.length === 1 && warned[0].includes("arrow_up"), "the rejection is also warned once, so fire-and-forget calls are never silent");
  await rejection(store.create(P(), { shape: "arrow_up" }));
  assert(takeWarnings().length === 0, "repeating the same bad call does not spam the console");
  assert(store.list().length === 0, "rejected shapes are never stored or saved");
  assert((await rejection(store.create(P(), { shape: 42 })))?.code === "E_SHAPE_KIND", "non-string kinds are rejected");

  const extended = await store.createPoints([P(0), P(5, 105)], { shape: "extended" });
  assert(store.get(extended).shape === "extended_line", "TradingView 'extended' maps to extended_line");
  const range = await store.createPoints([P(0), P(5, 105)], { shape: "date_and_price_range" });
  assert(store.get(range).shape === "measure", "'date_and_price_range' maps to measure");
  assert(SHAPE_NAME_ALIASES.extended === "extended_line", "the alias table is exported");
  assert(BUILTIN_SHAPE_TOOLS.map((tool) => tool.id).sort().join() === builtinShapeCatalog.kinds().slice().sort().join(), "the built-in catalog lists every built-in tool");
  const defaulted = await store.create(P(0, 99), {});
  assert(store.get(defaulted).shape === "horizontal_line", "an omitted shape defaults to horizontal_line");
}

// ── Shapes: point and option validation ─────────────────────────────────────
{
  const { store } = shapeStore();
  takeWarnings();
  const nan = await rejection(store.create({ time: Number.NaN, price: Number.NaN }, { shape: "horizontal_line" }));
  assert(nan?.code === "E_SHAPE_POINTS" && /finite time/.test(nan.message), "NaN times reject");
  const badPrice = await rejection(store.create({ time: NOW_SECONDS, price: Infinity }, { shape: "text" }));
  assert(badPrice?.code === "E_SHAPE_POINTS" && /non-finite price/.test(badPrice.message), "non-finite prices reject");
  const noPrice = await rejection(store.create({ time: NOW_SECONDS }, { shape: "horizontal_line" }));
  assert(noPrice?.code === "E_SHAPE_POINTS" && /needs a price/.test(noPrice.message), "a horizontal line without a price rejects");
  const onePoint = await rejection(store.create(P(), { shape: "trend_line" }));
  assert(onePoint?.code === "E_SHAPE_POINTS" && /needs 2 points, got 1; use createMultipointShape/.test(onePoint.message), "multi-point kinds need enough anchors, with guidance");
  assert((await rejection(store.createPoints("nope", { shape: "text" })))?.code === "E_SHAPE_POINTS", "non-array points reject");
  assert((await rejection(store.create(P(), { shape: "text", text: 5 })))?.code === "E_SHAPE_OPTION", "non-string text rejects");
  assert((await rejection(store.create(P(), { zOrder: "middle" })))?.code === "E_SHAPE_OPTION", "unknown zOrder values reject");
  takeWarnings();

  const ms = (NOW_SECONDS + 30) * 1000;
  const converted = await store.createPoints([{ time: ms, price: 1 }, { time: ms + 60_000, price: 2 }], { shape: "trend_line" });
  const warnings = takeWarnings();
  assert(store.get(converted).points[0].time === NOW_SECONDS + 30 && store.get(converted).points[1].time === NOW_SECONDS + 90, "millisecond times are converted to seconds");
  assert(warnings.length === 1 && /looks like milliseconds/.test(warnings[0]), "the conversion is warned once with guidance");
  const adapter = store.adapter(converted);
  throwsLike(() => adapter.setPoints([{ time: NOW_SECONDS, price: Number.NaN }, P(1)]), ShapeError, /non-finite price/, "setPoints validates like createShape");
  throwsLike(() => adapter.setPoints([P(0)]), ShapeError, /needs 2 points/, "setPoints keeps the kind's anchor count");
  throwsLike(() => store.adapter(defaultedId()).setPriceLevel(Number.NaN), ShapeError, /finite price/, "setPriceLevel rejects non-finite prices");
  function defaultedId() { return store.list()[0].id; }
}

// ── Shapes: getShapeById on unknown or removed ids ──────────────────────────
{
  const { store } = shapeStore();
  const missing = throwsLike(() => store.adapter("nope"), ShapeError, /no drawing with id "nope"/, "getShapeById on an unknown id throws");
  assert(missing.code === "E_SHAPE_NOT_FOUND", "the not-found error carries E_SHAPE_NOT_FOUND");
  const id = await store.create(P(), { shape: "horizontal_line" });
  const adapter = store.adapter(id);
  store.remove(id);
  throwsLike(() => adapter.getPoints(), ShapeError, /has been removed/, "a stale adapter throws instead of returning empty data");
  throwsLike(() => adapter.setProperties({ text: "x" }), ShapeError, /has been removed/, "a stale adapter never silently drops edits");
}

// ── Shapes: text setter ─────────────────────────────────────────────────────
{
  const { store, events, pushed, commands } = shapeStore();
  for (const kind of ["horizontal_line", "text"]) {
    const id = await store.create(P(0, 100), { shape: kind, text: "Old", overrides: { linecolor: "#abc" } });
    events.length = 0;
    const pushesBefore = pushed.length;
    const adapter = store.adapter(id);
    adapter.setProperties({ text: "x", linewidth: 2 });
    assert(store.get(id).text === "x" && !("text" in store.get(id).overrides), `${kind}: setProperties({ text }) updates the label, not an override`);
    assert(store.get(id).overrides.linewidth === 2 && store.get(id).overrides.linecolor === "#abc", `${kind}: other properties still merge into overrides`);
    assert(events.length === 1 && events[0][1] === "properties_changed", `${kind}: one properties_changed event`);
    assert(pushed.length === pushesBefore + 1, `${kind}: the edit is a single undo step`);
    assert(adapter.getProperties().text === "x", `${kind}: getProperties includes the text`);
    commands.undo();
    assert(store.get(id).text === "Old" && store.get(id).overrides.linewidth === undefined, `${kind}: undo restores text and overrides together`);
    commands.redo();
    assert(store.get(id).text === "x", `${kind}: redo reapplies the text`);
  }
  const id = store.list()[0].id;
  throwsLike(() => store.adapter(id).setProperties({ text: 12 }), ShapeError, /text must be a string/, "non-string text is rejected");
}

// ── Shapes: integer z-order ─────────────────────────────────────────────────
{
  const { store, commands, pushed, events } = shapeStore();
  const a = await store.create(P(0, 1), { shape: "horizontal_line" });
  const b = await store.create(P(0, 2), { shape: "horizontal_line" });
  const c = await store.create(P(0, 3), { shape: "horizontal_line" });
  const order = () => store.list().map((shape) => shape.id).join();
  assert(order() === [a, b, c].join() && store.list().every((shape) => Number.isSafeInteger(shape.z)), "z is an integer and new drawings stack on top");
  store.adapter(a).bringToFront();
  store.adapter(b).bringToFront();
  store.adapter(a).bringToFront();
  assert(order() === [c, b, a].join(), "bringToFront always moves to the very top, even among 'top' drawings (audit probe)");
  const pushes = pushed.length;
  store.adapter(a).bringToFront();
  store.adapter(c).sendToBack();
  assert(pushed.length === pushes && order() === [c, b, a].join(), "moves that change nothing record no undo step");
  events.length = 0;
  store.adapter(c).bringForward();
  assert(order() === [b, c, a].join(), "bringForward swaps with the drawing directly above");
  assert(events.length >= 1 && events.every(([, type]) => type === "properties_changed"), "z moves emit properties_changed");
  store.adapter(a).sendBackward();
  assert(order() === [b, a, c].join(), "sendBackward swaps with the drawing directly below");
  store.adapter(c).sendToBack();
  assert(order() === [c, b, a].join() && store.get(c).zOrder === "bottom", "sendToBack moves to the very bottom");
  const ops = store.adapter(c).availableZOrderOperations();
  assert(ops.bringForwardEnabled && ops.bringToFrontEnabled && !ops.sendBackwardEnabled && !ops.sendToBackEnabled, "availableZOrderOperations reflects the bottom position");
  const topOps = store.adapter(a).availableZOrderOperations();
  assert(!topOps.bringForwardEnabled && !topOps.bringToFrontEnabled && topOps.sendBackwardEnabled && topOps.sendToBackEnabled, "availableZOrderOperations reflects the top position");
  commands.undo();
  assert(order() === [b, a, c].join(), "each z move is one undo step");
  commands.undo();
  commands.undo();
  assert(order() === [c, b, a].join(), "undo walks z moves back in order");
  commands.redo();
  assert(order() === [b, c, a].join(), "redo reapplies a z move");

  const bottom = await store.create(P(0, 4), { shape: "horizontal_line", zOrder: "bottom" });
  assert(store.list()[0].id === bottom, "zOrder: 'bottom' places a new drawing under every other one");
  const saved = store.snapshot();
  assert(saved.map((shape) => shape.id).join() === order(), "snapshots are in paint order");

  // Equal z (for example a disableUndo drawing created between undo steps) still reorders strictly.
  const tie = shapeStore();
  tie.store.restore({ ...saved[0], id: "shape_90", z: 5 });
  tie.store.restore({ ...saved[1], id: "shape_91", z: 5 });
  tie.store.restore({ ...saved[2], id: "shape_92", z: 6 });
  tie.store.adapter("shape_90").bringForward();
  const tieOrder = tie.store.list().map((shape) => shape.id).join();
  assert(tieOrder === "shape_91,shape_90,shape_92", `ties are broken by renumbering the stack (got ${tieOrder})`);
  assert(tie.pushed.length === 1, "a renumbering move is still a single undo step");
  tie.commands.undo();
  assert(tie.store.list().map((shape) => shape.id).join() === "shape_90,shape_91,shape_92", "undoing a renumbering restores every z");
}

// ── Shapes: restore, catalogs and ids ───────────────────────────────────────
{
  const { store } = shapeStore();
  takeWarnings();
  store.restore({ id: "shape_7", shape: "extended", points: [P(0), P(1)], text: "", lock: false, disableSelection: false, disableUndo: false, showInObjectsTree: true, hidden: false, zOrder: "bottom", overrides: {} });
  assert(store.get("shape_7").shape === "extended_line" && Number.isSafeInteger(store.get("shape_7").z), "restore resolves aliases and assigns z to version-1 snapshots");
  store.restore({ id: "shape_8", shape: "flag", points: [P(0)], text: "", lock: false, disableSelection: false, disableUndo: false, showInObjectsTree: true, hidden: false, zOrder: "top", overrides: {} });
  const warned = takeWarnings();
  assert(store.get("shape_8").shape === "flag" && warned.length === 1 && /unsupported kind "flag"/.test(warned[0]), "a loaded unknown kind is kept for saving but warned about");
  assert(store.list().map((shape) => shape.id).join() === "shape_7,shape_8", "restoring without z keeps the snapshot order");
  const next = await store.create(P(0, 5), {});
  assert(next === "shape_9", "restored ids are reserved in the widget's allocator");

  const other = shapeStore();
  assert(await other.store.create(P(), {}) === "shape_1", "shape ids are per widget instance");

  const tools = [...BUILTIN_SHAPE_TOOLS];
  const custom = shapeStore(createShapeKindCatalog(() => tools));
  assert((await rejection(custom.store.createPoints([P(0), P(1)], { shape: "arrow_marker" })))?.code === "E_SHAPE_KIND", "an unregistered custom kind is rejected");
  tools.push({ id: "arrow_marker", anchors: 2, aliases: ["arrow"] });
  const arrow = await custom.store.createPoints([P(0), P(1)], { shape: "arrow" });
  assert(custom.store.get(arrow).shape === "arrow_marker", "a live catalog accepts tools registered after the store exists, aliases included");
  const free = shapeStore(createShapeKindCatalog(() => [{ id: "path", anchors: { min: 3, finish: "enter" } }]));
  assert((await rejection(free.store.createPoints([P(0), P(1)], { shape: "path" })))?.message.includes("needs 3 points"), "free-form anchor specs enforce their minimum");
}

// ── Widget integration ──────────────────────────────────────────────────────
{
  const bars = Array.from({ length: 40 }, (_, i) => ({ time: (NOW_SECONDS + i * 60) * 1000, open: 100, high: 103, low: 98, close: 101.5, volume: 10 }));
  const feed = {
    onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1"] })); },
    searchSymbols(_a, _b, _c, callback) { callback([]); },
    resolveSymbol(name, resolveInfo) { queueMicrotask(() => resolveInfo(symbolInfo({ name, ticker: name }))); },
    getBars(_info, _resolution, _params, onResult) { queueMicrotask(() => onResult(bars.map((bar) => ({ ...bar })))); },
    subscribeBars() {},
    unsubscribeBars() {},
  };
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const instance = new Widget({
    symbol: "ETHUSD",
    interval: "1",
    container: host,
    datafeed: feed,
    disabled_features: ["header_widget", "left_toolbar", "scale_bar"],
  });
  await instance.headerReady();
  const chart = instance.activeChart();
  takeWarnings();

  const bad = await rejection(chart.createShape({ time: NOW_SECONDS, price: 100 }, { shape: "arrow_up" }));
  assert(bad instanceof ShapeError && /Supported kinds/.test(bad.message), "chart.createShape('arrow_up') rejects with the supported list");
  const extended = await chart.createMultipointShape([{ time: NOW_SECONDS, price: 100 }, { time: NOW_SECONDS + 600, price: 102 }], { shape: "extended" });
  assert(instance.save().drawings.find((drawing) => drawing.id === extended)?.shape === "extended_line", "chart.createMultipointShape('extended') stores extended_line");
  throwsLike(() => chart.getShapeById("nope"), ShapeError, /no drawing with id/, "chart.getShapeById on an unknown id throws");
  takeWarnings();

  const label = await chart.createShape({ time: NOW_SECONDS + 300, price: 101 }, { shape: "horizontal_line", text: "Old" });
  chart.getShapeById(label).setProperties({ text: "x" });
  chart.getShapeById(extended).bringToFront();
  const saved = instance.save();
  assert(saved.drawings.find((drawing) => drawing.id === label)?.text === "x", "the new label is saved");
  assert(saved.drawings.at(-1).id === extended, "save() lists drawings in z order");
  chart.getShapeById(label).setProperties({ text: "changed after save" });
  await instance.load(saved);
  const reloaded = instance.save();
  assert(reloaded.drawings.find((drawing) => drawing.id === label)?.text === "x", "the label round-trips through save()/load()");
  assert(reloaded.drawings.map((drawing) => drawing.id).join() === saved.drawings.map((drawing) => drawing.id).join(), "z order round-trips through save()/load()");

  // Keyboard nudges through the real gesture layer.
  const order = await chart.createOrderLine({ side: "buy", price: 101.5 });
  window.__RAZE_DEBUG = true;
  const canvas = host.querySelector("canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, x: 0, y: 0, toJSON() {} });
  flushFrames();
  const state = window.__razeChartState;
  const y = (state.priceMax - order.getPrice()) / (state.priceMax - state.priceMin) * 338;
  const pointer = (type, clientY) => {
    const event = new window.MouseEvent(type, { clientX: 300, clientY, button: 0, bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerId: { value: 9 }, pointerType: { value: "mouse" } });
    return event;
  };
  canvas.dispatchEvent(pointer("pointermove", y));
  canvas.dispatchEvent(pointer("pointerdown", y));
  window.dispatchEvent(pointer("pointerup", y));
  assert(order.getPrice() === 101.5, "selecting an order line by click leaves its price untouched");
  for (let i = 0; i < 7; i++) canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
  assert(order.getPrice() === 101.57, `7 ArrowUp nudges from 101.5 give exactly 101.57 through the widget (got ${order.getPrice()})`);
  canvas.dispatchEvent(pointer("pointermove", y));
  canvas.dispatchEvent(pointer("pointerdown", y));
  canvas.dispatchEvent(pointer("pointermove", y + 17.3));
  window.dispatchEvent(pointer("pointerup", y + 17.3));
  const dragged = order.getPrice();
  assert(dragged < 101.57 && Math.round(dragged * 100) / 100 === dragged && String(dragged).split(".")[1]?.length <= 2, `a pointer drag commits an on-tick price (${dragged})`);
  window.__RAZE_DEBUG = false;
  instance.remove();
}

console.warn = realWarn;
console.error = realError;
console.log(`\nSTORES CONTRACT: PASS (${passed} assertions)`);
