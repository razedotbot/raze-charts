// TradingView API contract (W1B-12): widget events, listener errors, private
// internal subscriptions, executeActionById / getCheckableActionState, and the
// createStudy inputs / overrides / options arguments plus studies_overrides.
// Run after the build: node build.mjs && node tests/widget-contract.mjs

import { JSDOM } from "jsdom";

const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
};
const throws = (fn, pattern) => {
  try {
    fn();
  } catch (error) {
    return pattern.test(String(error?.message ?? error)) ? error : false;
  }
  return false;
};
const rejects = async (promise, pattern) => {
  try {
    await promise;
  } catch (error) {
    return pattern.test(String(error?.message ?? error)) ? error : false;
  }
  return false;
};

// ── DOM environment ─────────────────────────────────────────────────────────
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
window.devicePixelRatio = 1;

const strokes = [];
const context2d = new Proxy(
  { measureText: (value) => ({ width: String(value ?? "").length * 6 }), canvas: {} },
  {
    get: (target, property) => (property in target ? target[property] : () => {}),
    set: (target, property, value) => {
      if (property === "strokeStyle") strokes.push(String(value).toLowerCase());
      target[property] = value;
      return true;
    },
  },
);
window.HTMLCanvasElement.prototype.getContext = () => context2d;
for (const [name, value] of [["clientWidth", 800], ["clientHeight", 420]]) {
  Object.defineProperty(window.HTMLElement.prototype, name, { configurable: true, get: () => value });
}
class TestResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([]); }
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver;
window.ResizeObserver = TestResizeObserver;
const frames = new Map();
let nextFrame = 0;
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++nextFrame, callback);
  return nextFrame;
};
globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
const flushFrames = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// console spies: every [raze-charts] error/warning is captured for assertions.
const errors = [];
const warnings = [];
const originalError = console.error;
const originalWarn = console.warn;
console.error = (...args) => { errors.push(args); };
console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
const errorText = (entry) => entry.map((part) => (part instanceof Error ? part.message : String(part))).join(" ");

const { Delegate, widget } = await import("../dist/charting_library.esm.js");

// ── Fixtures ────────────────────────────────────────────────────────────────
const MINUTE = 60_000;
const START = 1_700_000_000_000;
const BARS = Array.from({ length: 300 }, (_, index) => {
  const close = 100 + Math.sin(index / 9) * 5 + index * 0.02;
  return { time: START + index * MINUTE, open: close - 0.4, high: close + 1, low: close - 1, close, volume: 10 + index };
});
const symbolInfo = (name) => ({
  name,
  ticker: name,
  description: name,
  type: "crypto",
  session: "24x7",
  timezone: "Etc/UTC",
  exchange: "Test",
  listed_exchange: "Test",
  format: "price",
  minmov: 1,
  pricescale: 100,
  has_intraday: true,
  supported_resolutions: ["1", "5", "15"],
});
const feed = {
  onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1", "5", "15"] })); },
  searchSymbols(_input, _exchange, _type, callback) { callback([]); },
  resolveSymbol(name, resolve) { queueMicrotask(() => resolve(symbolInfo(name))); },
  getBars(_info, _resolution, params, onResult) {
    const bars = BARS.filter((bar) => bar.time >= params.from * 1000 && bar.time < params.to * 1000);
    queueMicrotask(() => onResult(bars.length ? bars : BARS, { noData: !bars.length }));
  },
  subscribeBars() {},
  unsubscribeBars() {},
};
const seenFlags = [];
const FLAGGED = {
  name: "Flagged",
  pane: "overlay",
  defaults: { length: 5, color: "#123456", smooth: true },
  compute: (bars, inputs) => {
    seenFlags.push(inputs);
    return bars.map((bar) => bar.close);
  },
};

const widgets = [];
async function makeWidget(options = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const instance = new widget({
    symbol: "BTCUSD",
    interval: "1",
    container,
    datafeed: feed,
    disabled_features: ["left_toolbar", "scale_bar"],
    raze: { custom_studies: [FLAGGED] },
    ...options,
  });
  widgets.push(instance);
  await instance.headerReady();
  await tick();
  return { instance, container, chart: instance.activeChart() };
}
const studyById = (instance, id) => instance.save().studies.find((study) => study.id === id);

// ── Widget events: catalogue, typed names, listener errors ─────────────────
{
  const { instance, chart } = await makeWidget();

  for (const name of ["nope", "onTick", "study_event", "undo", "onAutoSaveNeeded"]) {
    const error = throws(() => instance.subscribe(name, () => {}), /unsupported event/);
    assert(
      error instanceof TypeError && /drawing_event, trading_event, error/.test(error.message),
      `subscribe("${name}") throws a TypeError listing the supported events`,
    );
  }
  assert(throws(() => instance.unsubscribe("onTick", () => {}), /unsupported event/), "unsubscribe of an unsupported event throws too");
  assert(throws(() => instance.subscribe("drawing_event", "nope"), /needs a callback function/), "a non-function listener is rejected");

  const order = [];
  const reported = [];
  instance.subscribe("error", (report) => reported.push(report));
  instance.subscribe("drawing_event", () => { order.push("first"); throw new Error("boom"); });
  instance.subscribe("drawing_event", (id, type) => order.push(`second:${type}`));
  errors.length = 0;
  const shapeId = await chart.createShape({ time: BARS[200].time / 1000, price: 101 }, { shape: "horizontal_line" });
  assert(order.join() === "first,second:create", "a throwing drawing_event listener does not stop the next listener");
  const drawingError = errors.find((entry) => /drawing_event listener threw/.test(errorText(entry)));
  assert(
    drawingError && /\[raze-charts\]/.test(errorText(drawingError)) && /boom/.test(errorText(drawingError)),
    "the listener error is logged as [raze-charts] drawing_event listener threw with the error",
  );
  assert(
    reported.length === 1 && reported[0].code === "listener_threw" && reported[0].event === "drawing_event"
      && reported[0].cause instanceof Error && reported[0].cause.message === "boom",
    "the error event receives { code, event, cause } for the failing listener",
  );

  const trading = [];
  instance.subscribe("trading_event", () => { throw new Error("boom"); });
  instance.subscribe("trading_event", (line, type) => trading.push(type));
  errors.length = 0;
  await chart.createOrderLine({ side: "buy", price: 100, quantity: 1 });
  const tradingError = errors.find((entry) => /trading_event/.test(errorText(entry)));
  assert(
    trading.includes("create") && tradingError
      && /\[raze-charts\]/.test(errorText(tradingError)) && /boom/.test(errorText(tradingError)),
    "a throwing trading_event handler is reported with [raze-charts], trading_event and boom; others still run",
  );

  let bracketCalls = 0;
  const bracket = await chart.createBracketOrder({
    side: "buy",
    entryPrice: 100,
    stopLossPrice: 98,
    quantity: 1,
    onChange: () => { bracketCalls += 1; throw new Error("broker amend failed"); },
  });
  errors.length = 0;
  bracket.setStopLossPrice(97);
  assert(
    bracketCalls === 1 && errors.some((entry) => /\[raze-charts\] trading line callback threw/.test(errorText(entry)) && /broker amend failed/.test(errorText(entry))),
    "a throwing trading callback is logged instead of disappearing",
  );

  instance.subscribe("error", () => { throw new Error("error handler bug"); });
  const reportsBefore = reported.length;
  errors.length = 0;
  chart.getShapeById(shapeId).setPoints([{ time: BARS[201].time / 1000, price: 102 }]);
  assert(
    errors.some((entry) => /error listener threw/.test(errorText(entry))) && reported.length === reportsBefore + 1,
    "a throwing error listener is logged without recursion; other error listeners still receive reports",
  );
  instance.remove();
}

// ── Delegate scopes: host views never reach internal registrations ─────────
{
  const delegate = new Delegate("dataChanged");
  const calls = [];
  const internal = () => calls.push("internal");
  const host = () => calls.push("host");
  delegate.subscribe(null, internal);
  const view = delegate.consumerView("onDataChanged");
  view.subscribe(null, host);
  view.unsubscribeAll(null);
  view.unsubscribe(null, internal);
  delegate.fire();
  assert(calls.join() === "internal", "a consumer view's unsubscribeAll(null) and unsubscribe() cannot remove internal listeners");
  calls.length = 0;
  view.subscribe(null, host);
  delegate.unsubscribeAll(null);
  delegate.fire();
  assert(calls.join() === "host", "the delegate's own unsubscribeAll(null) leaves host registrations alone");
  calls.length = 0;
  let onceCalls = 0;
  view.subscribe(null, () => { onceCalls += 1; delegate.fire(); }, true);
  delegate.fire();
  assert(onceCalls === 1, "a singleshot listener runs once even when it fires the delegate re-entrantly");
  const reports = [];
  delegate.reportErrorsTo((error, label) => reports.push([label, error.message]));
  view.subscribe(null, () => { throw new Error("bad host"); });
  errors.length = 0;
  delegate.fire();
  assert(
    calls.includes("host") && reports.length === 1 && reports[0].join() === "onDataChanged,bad host"
      && errors.some((entry) => /\[raze-charts\] onDataChanged listener threw/.test(errorText(entry))),
    "listener errors are logged, labelled with the view name, routed to the error handler, and the rest still run",
  );
  assert(throws(() => view.subscribe(null, 42), /needs a callback function/), "a consumer view rejects a non-function listener");
}

// ── onIntervalChanged: unsubscribeAll(null) keeps the header in sync ───────
{
  const { instance, container, chart } = await makeWidget({ disabled_features: ["left_toolbar", "scale_bar"] });
  const pressed = () => Object.fromEntries(
    [...container.querySelectorAll('[aria-label^="Interval "]')].map((button) => [button.textContent, button.getAttribute("aria-pressed")]),
  );
  const subscription = chart.onIntervalChanged();
  assert(subscription === chart.onIntervalChanged(), "onIntervalChanged() returns one stable subscription view per chart");
  const seen = [];
  const reported = [];
  instance.subscribe("error", (report) => reported.push(report.event));
  subscription.subscribe(null, () => { throw new Error("host bug"); });
  subscription.subscribe(null, (interval) => seen.push(String(interval)));
  errors.length = 0;
  await new Promise((resolve) => chart.setResolution("5", resolve));
  assert(seen.join() === "5", "host interval listeners run even after an earlier one throws");
  assert(
    errors.some((entry) => /\[raze-charts\] onIntervalChanged listener threw/.test(errorText(entry)))
      && reported.includes("onIntervalChanged"),
    "an onIntervalChanged listener error is logged and reported through the error event",
  );
  subscription.unsubscribeAll(null);
  await new Promise((resolve) => chart.setResolution("15", resolve));
  const state = pressed();
  assert(seen.join() === "5", "unsubscribeAll(null) removes the host's own interval listeners");
  assert(
    String(chart.resolution()) === "15" && state["15m"] === "true" && state["1m"] === "false" && state["5m"] === "false",
    "unsubscribeAll(null) keeps the header interval sync: 15m is pressed after setResolution('15')",
  );
  instance.remove();
}

// ── createStudy: positional, in_N, boolean inputs and validation ───────────
{
  const { instance, chart } = await makeWidget();
  const ema = await chart.createStudy("EMA", false, false, [30]);
  assert(studyById(instance, ema)?.length === 30, 'createStudy("EMA", false, false, [30]) creates EMA(30)');
  const legacy = await chart.createStudy("Moving Average Exponential", false, false, { in_0: 25 });
  assert(studyById(instance, legacy)?.length === 25, "TradingView in_<n> input ids map onto declared input positions");
  const tooMany = await rejects(chart.createStudy("EMA", false, false, [30, 2]), /too many positional inputs \(2\); EMA inputs: length/);
  assert(tooMany instanceof TypeError, "extra positional inputs reject with a TypeError naming the declared inputs");
  assert(
    (await rejects(chart.createStudy("VWAP", false, false, [5]), /too many positional inputs \(1\); VWAP inputs: none/)) instanceof TypeError,
    "positional inputs for a study without declared inputs reject",
  );
  assert(
    (await rejects(chart.createStudy("EMA", false, false, { length: "30" }), /"length" must be a finite number/)) instanceof TypeError,
    "a non-numeric length rejects instead of silently using the default",
  );
  assert(
    (await rejects(chart.createStudy("EMA", false, false, { source: { field: "close" } }), /must be a finite number, string or boolean/)) instanceof TypeError,
    "an object-valued input rejects with a TypeError",
  );
  assert(
    (await rejects(chart.createStudy("EMA", false, false, 30), /inputs must be an object or a positional array/)) instanceof TypeError,
    "a scalar inputs argument rejects with a TypeError",
  );
  const unknown = await rejects(chart.createStudy("Ichimoku Cloud"), /unknown study: Ichimoku Cloud; available studies: EMA, SMA, RSI/);
  assert(unknown instanceof Error, "an unknown study rejects and lists the available studies");

  seenFlags.length = 0;
  const flagged = await chart.createStudy("Flagged", false, false, [7, false]);
  const lastInputs = seenFlags.at(-1);
  assert(
    studyById(instance, flagged)?.length === 7 && lastInputs?.smooth === false && lastInputs?.length === 7,
    "positional inputs follow the declared order (length, then defaults) and booleans reach compute",
  );
  await chart.createStudy("Flagged", false, false, { length: 4, smooth: true, label: "x" });
  assert(seenFlags.at(-1)?.smooth === true && seenFlags.at(-1)?.label === "x", "boolean and string object inputs are forwarded");
  const saved = instance.save().studies.find((study) => study.name === "Flagged" && study.length === 4);
  assert(saved?.inputs?.smooth === true, "boolean inputs round-trip through save()");
  instance.remove();
}

// ── createStudy: overrides and options ─────────────────────────────────────
{
  const { instance, chart } = await makeWidget();
  strokes.length = 0;
  const redEma = await chart.createStudy("EMA", false, false, [30], { "plot.color": "#f00" });
  flushFrames();
  assert(studyById(instance, redEma)?.color === "#f00" && strokes.includes("#f00"), '{"plot.color":"#f00"} paints the EMA red');
  strokes.length = 0;
  const rsi = await chart.createStudy("RSI", false, false, { length: 7 }, { "Plot.color": "#ff0000" });
  flushFrames();
  assert(
    studyById(instance, rsi)?.length === 7 && studyById(instance, rsi)?.color === "#ff0000" && strokes.includes("#ff0000"),
    'createStudy("RSI", false, false, {length: 7}, {"Plot.color": "#ff0000"}) paints a red RSI(7)',
  );
  const both = await chart.createStudy("SMA", false, false, { color: "#00ff00" }, { "plot.color": "#0000ff" });
  assert(studyById(instance, both)?.color === "#0000ff", "an explicit override wins over inputs.color");

  warnings.length = 0;
  await chart.createStudy("EMA", false, false, [9], { "plot.linewidth": 3, "plot.color": "#abcdef" });
  await chart.createStudy("EMA", false, false, [9], { "plot.linewidth": 3 });
  const linewidthWarnings = warnings.filter((text) => /override "plot\.linewidth" has no effect/.test(text));
  assert(
    linewidthWarnings.length === 1 && /\[raze-charts\]/.test(linewidthWarnings[0]) && /plot\.color/.test(linewidthWarnings[0]),
    "an unsupported override key warns once with the supported key",
  );
  warnings.length = 0;
  await chart.createStudy("MACD", false, false, undefined, { "plot.color": "#ff0000" });
  assert(warnings.some((text) => /MACD draws every plot in a fixed colour/.test(text)), "a colour override that cannot paint warns instead of succeeding silently");
  assert(
    (await rejects(chart.createStudy("EMA", false, false, [9], { "plot.color": 5 }), /must be a CSS colour string/)) instanceof TypeError,
    "a non-string colour override rejects",
  );
  assert(
    (await rejects(chart.createStudy("EMA", false, false, [9], "red"), /overrides must be an object/)) instanceof TypeError,
    "a non-object overrides argument rejects",
  );

  const before = instance.save().studies.length;
  const quiet = await chart.createStudy("SMA", false, false, [10], undefined, { disableUndo: true, checkLimit: true });
  chart.executeActionById("undo");
  const afterUndo = instance.save().studies;
  assert(
    afterUndo.some((study) => study.id === quiet) && afterUndo.length === before,
    "options.disableUndo keeps the creation out of undo history (undo removes the previous study instead)",
  );
  const asSeries = await chart.createStudy("RSI", false, false, [14], undefined, { priceScale: "as-series" });
  assert(studyById(instance, asSeries)?.forceOverlay === true, 'options.priceScale "as-series" puts the study on the price scale');
  warnings.length = 0;
  await chart.createStudy("RSI", false, false, [14], undefined, { priceScale: "new-left", allowChangeCurrency: true, nonsense: 1 });
  assert(
    ["priceScale", "allowChangeCurrency", "nonsense"].every((key) => warnings.some((text) => text.includes(`option ${key}=`))),
    "unsupported createStudy options warn",
  );
  instance.remove();
}

// ── studies_overrides ──────────────────────────────────────────────────────
{
  warnings.length = 0;
  const { instance, chart } = await makeWidget({
    studies_overrides: {
      "moving average exponential.plot.color": "#00f",
      "Moving Average Exponential.length": 12,
      "volume.volume.color.0": "#ffffff",
      "relative strength index.plot.linewidth": 2,
    },
  });
  assert(
    warnings.some((text) => /studies_overrides\["volume\.volume\.color\.0"\] matches no study/.test(text))
      && warnings.some((text) => /studies_overrides\["relative strength index\.plot\.linewidth"\] has no effect/.test(text)),
    "studies_overrides keys with no effect warn at construction",
  );
  const ema = await chart.createStudy("EMA");
  assert(
    studyById(instance, ema)?.color === "#00f" && studyById(instance, ema)?.length === 12,
    "studies_overrides colour and input defaults apply to new EMAs",
  );
  const explicit = await chart.createStudy("EMA", false, false, { length: 20 }, { "plot.color": "#f00" });
  assert(
    studyById(instance, explicit)?.color === "#f00" && studyById(instance, explicit)?.length === 20,
    "createStudy arguments win over studies_overrides",
  );
  instance.remove();
}

// ── executeActionById / getCheckableActionState ───────────────────────────
{
  const { instance, container, chart } = await makeWidget({ disabled_features: ["scale_bar"] });
  for (const id of ["nope", "chartProperties", "compareOrAdd"]) {
    const error = throws(() => chart.executeActionById(id), /unsupported action; supported actions: undo, redo, chartReset/);
    assert(error instanceof TypeError, `executeActionById("${id}") throws with the supported list`);
  }
  assert(throws(() => chart.getCheckableActionState("undo"), /not a toggle action; checkable actions: stayInDrawingModeAction/), "getCheckableActionState rejects actions that are not toggles");
  assert(throws(() => chart.getCheckableActionState("nope"), /unsupported action/), "getCheckableActionState rejects unknown ids");

  assert(chart.getCheckableActionState("magnet") === false, "magnet starts off");
  chart.executeActionById("magnet");
  assert(chart.getCheckableActionState("magnet") === true, "executeActionById('magnet') toggles the checkable magnet state");
  chart.executeActionById("stayInDrawingModeAction");
  assert(
    chart.getCheckableActionState("stayInDrawingModeAction") && chart.getCheckableActionState("stay_in_drawing_mode"),
    "stayInDrawingModeAction and its stay_in_drawing_mode alias share one state",
  );
  chart.executeActionById("stay_in_drawing_mode");
  assert(!chart.getCheckableActionState("stayInDrawingModeAction"), "the alias toggles it back");

  // Drawings: hide all is a view toggle outside undo history.
  const events = [];
  instance.subscribe("drawing_event", (id, type) => events.push(type));
  const first = await chart.createShape({ time: BARS[250].time / 1000, price: 100 }, { shape: "horizontal_line" });
  const second = await chart.createShape({ time: BARS[260].time / 1000, price: 101 }, { shape: "horizontal_line" });
  events.length = 0;
  chart.executeActionById("hideAllDrawingTools");
  assert(
    chart.getCheckableActionState("hideAllDrawingTools") && events.join() === "hide,hide"
      && instance.save().drawings.every((drawing) => drawing.hidden),
    "hideAllDrawingTools hides every drawing and reports the checked state",
  );
  events.length = 0;
  chart.executeActionById("hideAllDrawingTools");
  assert(
    !chart.getCheckableActionState("hideAllDrawingTools") && events.join() === "show,show"
      && instance.save().drawings.every((drawing) => !drawing.hidden),
    "running hideAllDrawingTools again shows them",
  );
  chart.executeActionById("undo");
  assert(
    instance.save().drawings.map((drawing) => drawing.id).join() === String(first),
    "hide/show-all adds no undo entries: undo removes the last created drawing",
  );
  chart.executeActionById("redo");
  assert(instance.save().drawings.some((drawing) => drawing.id === second), "redo restores it");

  // Views: resets route through the viewport seam.
  await chart.createStudy("EMA");
  await chart.setVisibleRange({ from: BARS[10].time / 1000, to: BARS[40].time / 1000 });
  const zoomed = chart.getVisibleRange();
  chart.executeActionById("timeScaleReset");
  const reset = chart.getVisibleRange();
  assert(
    zoomed.to <= BARS[41].time / 1000 && reset.to === BARS.at(-1).time / 1000 && reset.from > BARS[100].time / 1000,
    "timeScaleReset returns to the default view anchored to the latest bar",
  );
  await chart.setVisibleRange({ from: BARS[10].time / 1000, to: BARS[40].time / 1000 });
  chart.executeActionById("chartReset");
  assert(chart.getVisibleRange().to === BARS.at(-1).time / 1000, "chartReset resets the time scale too");

  // Panels.
  chart.executeActionById("insertIndicator");
  assert(document.querySelector(".raze-chart-indicators-menu"), "insertIndicator opens the Indicators panel");
  chart.executeActionById("insertIndicator");
  assert(document.querySelectorAll(".raze-chart-indicators-menu").length === 1, "a second insertIndicator does not stack panels");
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  chart.executeActionById("paneObjectTree");
  assert(document.querySelector(".raze-chart-objects-tree"), "paneObjectTree opens the objects tree");
  chart.executeActionById("symbolSearch");
  const search = container.querySelector('input[aria-label="Search symbols"]');
  assert(search && document.activeElement === search, "symbolSearch focuses the header symbol search");

  chart.executeActionById("paneRemoveAllStudiesDrawingTools");
  const cleared = instance.save();
  assert(cleared.studies.length === 0 && cleared.drawings.length === 0, "paneRemoveAllStudiesDrawingTools removes every study and drawing");
  chart.executeActionById("undo");
  assert(instance.save().drawings.length === 2, "undo restores the removed drawings");
  chart.executeActionById("undo");
  assert(instance.save().studies.length === 1, "a second undo restores the removed studies");
  instance.remove();
  assert(!document.querySelector(".raze-chart-indicators-menu, .raze-chart-objects-tree"), "remove() closes panels opened by actions");

  const headless = await makeWidget({ disabled_features: ["header_widget", "left_toolbar", "scale_bar"] });
  warnings.length = 0;
  headless.chart.executeActionById("symbolSearch");
  headless.chart.executeActionById("symbolSearch");
  assert(
    warnings.filter((text) => /executeActionById\("symbolSearch"\) needs the header_widget/.test(text)).length === 1,
    "symbolSearch without a header warns once instead of doing nothing silently",
  );
  headless.chart.executeActionById("insertIndicator");
  assert(document.querySelector(".raze-chart-indicators-menu"), "insertIndicator works without the left toolbar");
  headless.instance.remove();
}

console.error = originalError;
console.warn = originalWarn;
for (const instance of widgets) instance.remove();
console.log("\nWIDGET CONTRACT: PASS");
