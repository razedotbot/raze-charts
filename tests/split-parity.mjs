// Regressions for the financial monolith splits (W1A-07):
//   - Widget is a facade over src/core/widget/* controllers with a runtime
//     surface of exactly the documented IChartingLibraryWidget methods;
//   - ChartApi is composed from src/core/api/* modules and hides its state;
//   - gestures.ts coordinates the handlers in src/engine/interaction/*.
// Controllers and handlers are bundled straight from source and exercised in
// isolation against fake hosts; the public surface is checked on the build.
// Run after the build: node build.mjs && node tests/split-parity.mjs

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
};
const sameList = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const throws = (fn, pattern) => {
  try {
    fn();
  } catch (error) {
    return pattern.test(String(error?.message ?? error));
  }
  return false;
};
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));

// ── DOM environment (same shape as the other financial runtime tests) ──────
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
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
for (const [name, size] of [["clientWidth", 640], ["clientHeight", 360]]) {
  Object.defineProperty(window.HTMLElement.prototype, name, { configurable: true, get: () => size });
}
class TestResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([]); }
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver;
window.ResizeObserver = TestResizeObserver;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

// ── Acceptance: the facades stay thin ──────────────────────────────────────
const lineCount = (path) => readFileSync(join(root, path), "utf8").split("\n").length - 1;
assert(lineCount("src/core/Widget.ts") < 300, "Widget.ts stays a thin facade (under 300 lines)");
assert(lineCount("src/engine/gestures.ts") < 150, "gestures.ts stays a thin coordinator (under 150 lines)");

// ── Bundle the internal modules from source for isolated unit tests ────────
const scratch = mkdtempSync(join(tmpdir(), "raze-split-parity-"));
let internals;
try {
  const outfile = join(scratch, "internals.mjs");
  await build({
    stdin: {
      resolveDir: root,
      loader: "ts",
      contents: `
        export { studySpecFromArgs } from "./src/core/widget/StudyArgs";
        export { validateSnapshot } from "./src/core/widget/PersistenceController";
        export { EventHub } from "./src/core/widget/EventHub";
        export { CompareController } from "./src/core/widget/CompareController";
        export { ActionController } from "./src/core/widget/ActionController";
        export { LifecycleController } from "./src/core/widget/LifecycleController";
        export { LayoutController } from "./src/core/widget/LayoutController";
        export { ChromeController } from "./src/core/widget/ChromeController";
        export { WIDGET_CONTROLLERS } from "./src/core/widget/controllers";
        export { installApiModules, apiScope } from "./src/core/api/scope";
        export { API_MODULES } from "./src/core/api/index";
        export { orderHandlers, HANDLERS } from "./src/engine/interaction/registry";
        export { INTERACTION_HANDLERS } from "./src/engine/interaction/handlers";
        export { GestureController } from "./src/engine/gestures";
        export { buildFeatureSet } from "./src/core/context";
        export { buildTheme } from "./src/core/theme";
        export { Delegate } from "./src/util/delegate";
      `,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    outfile,
    logLevel: "silent",
  });
  internals = await import(pathToFileURL(outfile).href);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const {
  ActionController,
  API_MODULES,
  ChromeController,
  CompareController,
  Delegate,
  EventHub,
  GestureController,
  HANDLERS,
  INTERACTION_HANDLERS,
  LayoutController,
  LifecycleController,
  WIDGET_CONTROLLERS,
  apiScope,
  buildFeatureSet,
  buildTheme,
  installApiModules,
  orderHandlers,
  studySpecFromArgs,
  validateSnapshot,
} = internals;

// ── Controller registry ─────────────────────────────────────────────────────
assert(
  WIDGET_CONTROLLERS.map((definition) => definition.id).join(",")
    === "chrome,layout,api,events,actions,compare,persistence,contextMenu",
  "built-in widget controllers are registered in dependency order",
);

// ── StudyArgs ───────────────────────────────────────────────────────────────
const spec = studySpecFromArgs("EMA", 1, 0, { Length: 21, color: "#fff", source: "hl2", smooth: 2, flag: true });
assert(
  spec.name === "EMA" && spec.length === 21 && spec.color === "#fff"
    && spec.forceOverlay === true && spec.lock === false
    && sameList(Object.keys(spec.inputs), ["source", "smooth"]),
  "createStudy arguments map to a StudyStore spec (length alias, colour, primitive extra inputs)",
);
const bare = studySpecFromArgs("RSI");
assert(bare.length === 0 && bare.color === "" && Object.keys(bare.inputs).length === 0, "missing study inputs fall back to definition defaults");

// ── PersistenceController snapshot validation ──────────────────────────────
const validSnapshot = {
  version: 1,
  symbol: "BTCUSD",
  interval: "1",
  visibleRange: { from: 1, to: 2 },
  chartStyle: "candles",
  logScale: false,
  percentScale: false,
  drawings: [{ id: "a", shape: "trend_line", points: [{ time: 1, price: 2 }], text: "", lock: false, zOrder: "top", overrides: {} }],
  studies: [{ id: "s", name: "EMA", length: 9, color: "" }],
  compare: ["ETHUSD"],
};
validateSnapshot(validSnapshot);
assert(true, "a well-formed layout snapshot validates");
assert(throws(() => validateSnapshot({ ...validSnapshot, version: 2 }), /invalid chart layout snapshot/), "unknown snapshot versions are rejected");
assert(
  throws(() => validateSnapshot({ ...validSnapshot, drawings: [...validSnapshot.drawings, validSnapshot.drawings[0]] }), /duplicate entity ids/),
  "duplicate drawing ids are rejected",
);

// ── EventHub ────────────────────────────────────────────────────────────────
{
  const context = { drawingEvent: new Delegate(), tradingEvent: new Delegate() };
  const hub = new EventHub({ context });
  hub.attach();
  const seen = [];
  const listener = (...args) => seen.push(args);
  hub.subscribe("drawing_event", () => { throw new Error("listener failure"); });
  hub.subscribe("drawing_event", listener);
  context.drawingEvent.fire("shape_1", "create");
  assert(seen.length === 1 && seen[0].join() === "shape_1,create", "EventHub forwards drawing events and isolates a throwing listener");
  hub.unsubscribe("drawing_event", listener);
  context.drawingEvent.fire("shape_1", "remove");
  assert(seen.length === 1, "EventHub.unsubscribe detaches the listener");
  hub.subscribe("trading_event", listener);
  hub.destroy();
  context.tradingEvent.fire({ id: "o" }, "moved");
  assert(seen.length === 1, "EventHub.destroy drops every subscription");
}

// ── CompareController ──────────────────────────────────────────────────────
{
  let paints = 0;
  const context = { compare: [], requestPaint: () => { paints += 1; } };
  const lifecycle = { destroyed: false };
  const data = { loadCompare: async (symbol) => [{ time: 1, open: 1, high: 1, low: 1, close: symbol.length }] };
  const compare = new CompareController({ context, lifecycle, data });
  const first = compare.add("ETH", []);
  const second = await compare.create("SOL");
  assert(
    first === "compare_ETH_1" && second === "compare_SOL_2" && context.compare[0].color !== context.compare[1].color,
    "compare ids are sequential per widget and colours rotate",
  );
  assert(compare.remove(first) && context.compare.length === 1 && paints === 3, "removing a compare series repaints");
  assert(!compare.remove("study_1"), "remove reports ids that are not compare series");
  lifecycle.destroyed = true;
  let rejected = false;
  await compare.create("ADA").catch((error) => { rejected = /removed before compare data loaded/.test(error.message); });
  assert(rejected, "a compare that resolves after teardown rejects instead of mutating the widget");
}

// ── ActionController ───────────────────────────────────────────────────────
{
  const calls = [];
  const canvas = document.createElement("canvas");
  const context = { magnet: false, stayInDrawingMode: false, volumeMode: "overlay", requestPaint: () => calls.push("paint") };
  const commands = { undo: () => calls.push("undo"), redo: () => calls.push("redo") };
  const actions = new ActionController({ context, commands, engine: { canvas }, controllers: { chrome: {} } });
  actions.executeActionById("magnet");
  actions.executeActionById("volume_pane");
  actions.executeActionById("volume_pane");
  actions.executeActionById("volume_pane");
  actions.executeActionById("stay_in_drawing_mode");
  assert(
    context.magnet && context.stayInDrawingMode && context.volumeMode === "overlay",
    "executeActionById toggles magnet/drawing mode and cycles the volume pane",
  );
  calls.length = 0;
  actions.boot();
  const key = (init) => {
    const event = new window.KeyboardEvent("keydown", { cancelable: true, ...init });
    canvas.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const prevented = [key({ key: "z", ctrlKey: true }), key({ key: "Z", metaKey: true, shiftKey: true }), key({ key: "y", ctrlKey: true })];
  key({ key: "z" });
  assert(
    calls.join() === "undo,paint,redo,paint,redo,paint" && prevented.every(Boolean),
    "Ctrl/Cmd+Z undoes, Shift+Z and Ctrl+Y redo, and plain Z is ignored",
  );
  actions.destroy();
  key({ key: "z", ctrlKey: true });
  assert(calls.length === 6, "ActionController.destroy detaches the undo shortcuts");
}

// ── LifecycleController ────────────────────────────────────────────────────
{
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const chromeCalls = [];
    const chrome = {
      showLoadingError: () => chromeCalls.push("error"),
      showEmptyState: () => chromeCalls.push("empty"),
      syncAccessibility: () => chromeCalls.push("a11y"),
    };
    const host = { context: { bars: [{}] }, controllers: { chrome } };
    const lifecycle = new LifecycleController(host);

    let headerReady = false;
    void lifecycle.headerReady().then(() => { headerReady = true; });
    const readyCalls = [];
    lifecycle.onChartReady(() => readyCalls.push("early"));
    lifecycle.onChartReady(() => { throw new Error("consumer failure"); });
    lifecycle.markReady();
    lifecycle.onChartReady(() => readyCalls.push("late"));
    await tick();
    assert(
      headerReady && readyCalls.join() === "early,late" && errors.some(([, error]) => error?.message === "consumer failure"),
      "readiness fires once, late subscribers still run, and a throwing callback is reported",
    );

    const done = [];
    let releaseFirst;
    lifecycle.runDataChange("first", () => new Promise((resolveRun) => { releaseFirst = resolveRun; }), () => done.push("first"));
    lifecycle.runDataChange("second", () => Promise.resolve(), () => done.push("second"), () => done.push("after"));
    await tick();
    releaseFirst();
    await tick();
    assert(done.join() === "after,second", "only the newest data change completes its hooks");

    let rolledBack = false;
    host.context.bars = [];
    lifecycle.runDataChange("failing", () => Promise.reject(new Error("feed down")), undefined, undefined, () => { rolledBack = true; });
    await tick();
    assert(rolledBack && chromeCalls.includes("error"), "a failed data change rolls chrome back and shows the error state");

    lifecycle.destroyed = true;
    let started = false;
    lifecycle.runDataChange("after teardown", () => { started = true; return Promise.resolve(); });
    assert(!started, "no data change starts after teardown");
  } finally {
    console.error = originalError;
  }
}

// ── LayoutController and ChromeController against a real DOM ───────────────
{
  const options = {
    container: document.createElement("div"),
    symbol: "BTCUSD",
    interval: "1",
    datafeed: {},
    raze: { layout: "2x2" },
    disabled_features: ["header_widget"],
  };
  document.body.appendChild(options.container);
  const context = {
    options,
    theme: buildTheme(options),
    features: buildFeatureSet(options),
    fontFamily: "sans-serif",
    symbol: "BTCUSD",
  };
  const host = { options, context, container: options.container, controllers: {} };
  const chrome = new ChromeController(host);
  host.controllers.chrome = chrome;
  const layout = new LayoutController(host);
  assert(
    chrome.root.parentElement === options.container
      && chrome.root.style.getPropertyValue("--tv-color-pane-background") === context.theme.paneBackground,
    "ChromeController mounts the themed root shell into the container",
  );
  assert(!chrome.toolbar && chrome.leftSidebar, "chrome honours header_widget / left_toolbar featuresets");
  const detached = chrome.createButton({ title: "Action" });
  assert(!detached.isConnected, "createButton without a header returns a detached element");
  assert(
    layout.panes.length === 4 && layout.primary === layout.panes[0]
      && chrome.chartArea.style.display === "grid" && chrome.chartArea.style.gridTemplateColumns === "1fr 1fr",
    "LayoutController builds a 2x2 pane grid inside the chart area",
  );
  assert(layout.chart(1) === null && layout.chart() === null, "layout.chart falls back before child charts exist");
  chrome.root.remove();

  const childOptions = { ...options, container: document.createElement("div"), raze: { layout: "2x2", layout_child: true } };
  const childChrome = new ChromeController({ ...host, options: childOptions, container: childOptions.container });
  const childLayout = new LayoutController({ ...host, options: childOptions, controllers: { chrome: childChrome } });
  assert(childLayout.panes.length === 1 && childLayout.primary === childChrome.chartArea, "a layout child never nests another grid");
}

// ── API module composition ─────────────────────────────────────────────────
{
  const target = {};
  installApiModules(target, [{ a() { return 1; } }]);
  assert(Object.keys(target).length === 0 && target.a() === 1, "installed API methods are non-enumerable, like class methods");
  assert(throws(() => installApiModules(target, [{ a() {} }]), /defined by two API modules/), "two API modules cannot define the same method");
  assert(throws(() => apiScope({}), /not a chart API/), "API methods refuse foreign receivers with guidance");
  const names = API_MODULES.flatMap((module) => Object.keys(module));
  assert(new Set(names).size === names.length, "built-in API modules own distinct method names");
}

// ── Interaction handler registry ───────────────────────────────────────────
assert(
  HANDLERS.map((handler) => handler.id).join(",") === "drawing-draft,trading,drawing-edit,price-axis,time-axis,viewport",
  "interaction handlers run in the frozen gesture priority order",
);
assert(
  orderHandlers([{ id: "b", priority: 2 }, { id: "a", priority: 1 }]).map((handler) => handler.id).join() === "a,b"
    && throws(() => orderHandlers([...INTERACTION_HANDLERS, { id: "viewport", priority: 1 }]), /registered twice/),
  "handlers sort by priority and duplicate ids are rejected",
);

// ── Interaction handlers against a fake gesture host ───────────────────────
const makeHost = () => {
  const events = [];
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0 });
  const context = {
    bars: [],
    resolution: "1",
    magnet: false,
    drawingTool: "cursor",
    visibleRange: { from: 0, to: 100 },
    autoScalePrice: true,
    priceRange: null,
    selectedShapeId: "shape_1",
    selectedTradingLineId: null,
    symbolInfo: null,
    theme: { scaleText: "#fff" },
    viewportChanged: { fire: (range) => events.push(["viewport", range]) },
    crosshairMoved: { fire: (ev) => events.push(["crosshair", ev.active]) },
  };
  const host = {
    canvas,
    context,
    engine: { cssWidth: 640, cssHeight: 360, announce: (message) => events.push(["announce", message]) },
    shapes: { get: () => undefined },
    trading: { get: () => undefined },
    data: { visibleUnixRange: () => ({ ...context.visibleRange }), maybeLoadMoreHistory: async () => {} },
    plotL: 0,
    plotT: 0,
    plotW: 500,
    plotH: 300,
    subPanes: [],
    volumePane: null,
    priceMin: 10,
    priceMax: 20,
    crosshair: { x: 0, y: 0, active: false },
    hoverMark: null,
    hoverShapeId: null,
    hoverTradingLineId: null,
    hoverTradingHit: null,
    markScreen: [],
    shapeScreen: [],
    tradingScreen: [],
    draft: null,
    lastPointerType: "mouse",
    selectedShapeId: null,
    onToolDone: null,
    fitContent: () => events.push(["fit"]),
    requestPaint: () => {},
    financeView: () => ({}),
    plotScale() {
      return {
        plotL: this.plotL, plotT: this.plotT, plotW: this.plotW, plotH: this.plotH,
        priceMin: this.priceMin, priceMax: this.priceMax, pctBase: 1,
        visibleRange: context.visibleRange, percentScale: false, logScale: false,
      };
    },
  };
  return { host, events };
};
const zone = (overrides = {}) => ({ inPriceAxis: false, inTimeAxis: false, inPlot: true, contentBottom: 330, ...overrides });
const handler = (id) => HANDLERS.find((candidate) => candidate.id === id);

{
  const { host, events } = makeHost();
  const pan = handler("viewport").pointerDown(host, { x: 100, y: 100, pointerType: "mouse", zone: zone() });
  assert(pan?.kind === "pan" && host.context.selectedShapeId === null, "an unclaimed press clears the selection and starts a pan");
  pan.move(150, 100);
  assert(host.context.visibleRange.from === -10 && host.context.visibleRange.to === 90, "pan moves the range by the dragged bar distance");
  pan.cancel();
  assert(
    host.context.visibleRange.from === 0 && host.context.visibleRange.to === 100 && events.at(-1)[0] === "viewport",
    "a cancelled pan restores and republishes the start range",
  );
  const outside = handler("viewport").pointerDown(host, { x: 600, y: 100, pointerType: "mouse", zone: zone({ inPlot: false }) });
  assert(outside === true, "a press outside the plot is consumed without a drag");

  host.context.autoScalePrice = true;
  const axis = handler("price-axis").pointerDown(host, { x: 600, y: 100, pointerType: "mouse", zone: zone({ inPriceAxis: true }) });
  axis.move(600, 250);
  assert(host.context.autoScalePrice === false && host.context.priceRange.max - host.context.priceRange.min > 10, "dragging the price axis down expands the price range");
  axis.cancel();
  assert(host.context.autoScalePrice === true && host.context.priceRange === null, "a cancelled price-axis drag restores auto-scale");
  assert(handler("price-axis").pointerDown(host, { x: 1, y: 1, pointerType: "mouse", zone: zone() }) === undefined, "the price-axis handler ignores plot presses");

  const zoomIn = new window.KeyboardEvent("keydown", { key: "+", cancelable: true });
  assert(handler("viewport").keyDown(host, zoomIn) && zoomIn.defaultPrevented, "+ is handled by the viewport handler");
  assert(host.context.visibleRange.to === 100 && host.context.visibleRange.from > 0 && events.at(-1)[1] === "Zoomed in.", "keyboard zoom keeps the right edge and announces");
  const tab = new window.KeyboardEvent("keydown", { key: "Tab", cancelable: true });
  assert(!HANDLERS.some((candidate) => candidate.keyDown?.(host, tab)) && !tab.defaultPrevented, "unhandled keys fall through every handler");
}

// ── GestureController coordinator end to end ──────────────────────────────
{
  const { host, events } = makeHost();
  const gestures = new GestureController(host);
  gestures.attach();
  const pointer = (type, x, y, init = {}) => {
    const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerId: { value: init.id ?? 1 }, pointerType: { value: init.type ?? "mouse" } });
    return event;
  };
  host.canvas.dispatchEvent(pointer("pointerdown", 100, 100));
  host.canvas.dispatchEvent(pointer("pointermove", 150, 100));
  assert(host.context.visibleRange.from === -10 && events.some(([kind]) => kind === "crosshair"), "pointer drags pan through the coordinator and publish the crosshair");
  host.canvas.dispatchEvent(pointer("pointercancel", 150, 100));
  assert(host.context.visibleRange.from === 0, "pointer cancel rolls the active drag back");

  host.canvas.dispatchEvent(pointer("pointerdown", 100, 100, { id: 2, type: "touch" }));
  host.canvas.dispatchEvent(pointer("pointerdown", 200, 100, { id: 3, type: "touch" }));
  host.canvas.dispatchEvent(pointer("pointermove", 300, 100, { id: 3, type: "touch" }));
  const pinched = host.context.visibleRange.to - host.context.visibleRange.from;
  host.canvas.dispatchEvent(pointer("pointercancel", 300, 100, { id: 3, type: "touch" }));
  assert(pinched < 100 && host.context.visibleRange.to - host.context.visibleRange.from === 100, "a two-finger spread zooms in and cancel restores the range");

  const wheel = new window.WheelEvent("wheel", { deltaY: 0, deltaX: 30, clientX: 100, clientY: 100, cancelable: true });
  host.canvas.dispatchEvent(wheel);
  assert(!wheel.defaultPrevented, "horizontal-only wheel gestures are left to the page");
  const zoomWheel = new window.WheelEvent("wheel", { deltaY: 100, clientX: 250, clientY: 100, cancelable: true });
  host.canvas.dispatchEvent(zoomWheel);
  assert(zoomWheel.defaultPrevented && host.context.visibleRange.to - host.context.visibleRange.from > 100, "vertical wheel zooms out around the pointer");

  host.canvas.focus();
  host.canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", bubbles: true }));
  assert(events.at(-1)[1] === "Chart fitted to all data." && host.canvas.style.outline.includes("solid"), "keyboard input shows the focus ring and reaches handlers");
  host.canvas.dispatchEvent(new window.MouseEvent("dblclick", { clientX: 100, clientY: 100, bubbles: true }));
  assert(events.at(-1)[0] === "fit" && host.context.autoScalePrice, "double-click resets scaling and fits content");
  gestures.destroy();
  const eventsBefore = events.length;
  host.canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", bubbles: true }));
  assert(events.length === eventsBefore && host.canvas.style.outline === "none", "destroy removes every coordinator listener and the focus ring");
}

// ── Public surface of the built bundle ─────────────────────────────────────
const { ChartApi, widget } = await import(pathToFileURL(join(root, "dist/charting_library.esm.js")).href);

const WIDGET_METHODS = [
  "constructor",
  "onChartReady",
  "headerReady",
  "activeChart",
  "chart",
  "createButton",
  "setCSSCustomProperty",
  "subscribe",
  "unsubscribe",
  "onContextMenu",
  "setSymbol",
  "save",
  "load",
  "remove",
];
const CHART_API_METHODS = [
  "constructor",
  "resolution",
  "setResolution",
  "onIntervalChanged",
  "setVisibleRange",
  "getVisibleRange",
  "createShape",
  "createMultipointShape",
  "getShapeById",
  "removeEntity",
  "removeAllShapes",
  "createOrderLine",
  "createPositionLine",
  "createBracketOrder",
  "getTradingLineById",
  "removeAllTradingLines",
  "createStudy",
  "refreshMarks",
  "clearMarks",
  "resetData",
  "setSymbol",
  "symbol",
  "executeActionById",
  "createCompare",
  "timezone",
  "setTimezone",
  "onTimezoneChanged",
  "getTimezoneApi",
  "fitContent",
  "resetView",
];
assert(
  sameList(Object.getOwnPropertyNames(widget.prototype), WIDGET_METHODS),
  "Widget.prototype exposes exactly the documented IChartingLibraryWidget methods",
);
assert(
  sameList(Object.getOwnPropertyNames(ChartApi.prototype), CHART_API_METHODS) && Object.keys(ChartApi.prototype).length === 0,
  "ChartApi.prototype exposes exactly the documented IChartWidgetApi methods, non-enumerable",
);

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
  supported_resolutions: ["1"],
});
const bars = Array.from({ length: 30 }, (_, index) => ({
  time: 1_700_000_000_000 + index * 60_000,
  open: 100 + index,
  high: 102 + index,
  low: 99 + index,
  close: 101 + index,
  volume: 10,
}));
const container = document.createElement("div");
document.body.appendChild(container);
const instance = new widget({
  container,
  symbol: "BTCUSD",
  interval: "1",
  datafeed: {
    onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1"] })); },
    searchSymbols() {},
    resolveSymbol(name, resolveSymbol) { queueMicrotask(() => resolveSymbol(symbolInfo(name))); },
    getBars(_info, _resolution, params, onResult) { queueMicrotask(() => onResult(params.firstDataRequest ? bars : [], { noData: !params.firstDataRequest })); },
    subscribeBars() {},
    unsubscribeBars() {},
  },
});
await new Promise((resolveReady) => instance.onChartReady(resolveReady));

assert(
  Object.getOwnPropertyNames(instance).length === 0 && Object.getOwnPropertySymbols(instance).length === 0,
  "a widget instance carries no own properties (its runtime is #private)",
);
const leaked = ["boot", "emit", "goToDate", "runDataChange", "wireUndoKeys", "spawnLayout", "context", "data", "renderer", "engine", "api"]
  .filter((name) => name in instance);
assert(leaked.length === 0, "former Widget internals are unreachable at runtime");

const chart = instance.activeChart();
assert(chart instanceof ChartApi && instance.chart() === chart && instance.chart(3) === chart, "activeChart/chart(index) return the widget's ChartApi");
assert(Object.getOwnPropertyNames(chart).length === 0, "a ChartApi instance carries no own properties");
assert(chart.onIntervalChanged() === chart.onIntervalChanged(), "onIntervalChanged returns one live subscription per chart");
assert(
  chart.symbol() === "BTCUSD" && chart.resolution() === "1" && chart.getVisibleRange().to === Math.floor(bars.at(-1).time / 1000),
  "composed ChartApi methods read the widget state",
);
assert(throws(() => ChartApi.prototype.symbol.call({}), /not a chart API/), "ChartApi methods reject a foreign receiver");

const study = await chart.createStudy("EMA", false, false, { length: 5 });
const saved = instance.save();
assert(saved.studies.some((entry) => entry.id === String(study) && entry.length === 5), "createStudy and save() work through the facade");
chart.removeEntity(study);
assert(!instance.save().studies.length, "removeEntity dispatches to the study store");
let loadError = null;
await instance.load({ ...saved, version: 3 }).catch((error) => { loadError = error; });
assert(loadError instanceof TypeError, "load() rejects (not throws) an invalid snapshot, as before the split");

const button = instance.createButton({ title: "Custom" });
instance.setCSSCustomProperty("--raze-test", "1");
assert(button.isConnected && container.firstElementChild.style.getPropertyValue("--raze-test") === "1", "header buttons and CSS custom properties reach the chrome root");

instance.remove();
instance.remove();
assert(!container.firstElementChild, "remove() tears the widget down idempotently");

console.log("\nSPLIT PARITY: PASS");
