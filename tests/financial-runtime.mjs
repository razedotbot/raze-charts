// Deterministic regressions for the financial canvas scheduler and semantics.
// Run after the build: node build.mjs && node tests/financial-runtime.mjs

import { JSDOM } from "jsdom";

const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
};

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
});
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
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get: () => 640,
});
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => 360,
});

const observers = [];
class TestResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    observers.push(this);
  }
  observe(target) {
    this.target = target;
    this.callback([]);
  }
  disconnect() { this.disconnected = true; }
  trigger() { this.callback([]); }
}
globalThis.ResizeObserver = TestResizeObserver;
window.ResizeObserver = TestResizeObserver;

let nextFrameId = 0;
const frames = new Map();
globalThis.requestAnimationFrame = (callback) => {
  const id = ++nextFrameId;
  frames.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

function flushFrames() {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, callback] of pending) callback(performance.now());
}

const { ChartEngine, Delegate, IntervalSelector, Toolbar, isLightColor, resolveTimeframe, widget } = await import("../dist/charting_library.esm.js");
assert(isLightColor("rgb(255, 255, 255)"), "financial chrome recognises light RGB theme backgrounds");

const datafeedPlaceholder = {};
const engineHost = window.document.createElement("div");
window.document.body.appendChild(engineHost);
const engineContext = {
  options: {
    symbol: "BTCUSD",
    interval: "1",
    container: engineHost,
    datafeed: datafeedPlaceholder,
    raze: {
      aria_label: "Portfolio overview",
      aria_description: "Bitcoin price and volume.",
    },
  },
  datafeed: datafeedPlaceholder,
  locale: "en",
  fontFamily: "sans-serif",
  symbol: "BTCUSD",
  resolution: "1",
  symbolInfo: null,
  formatPrice: String,
  theme: {
    paneBackground: "#131722",
    scaleText: "#f2f4f8",
  },
  features: new Set(),
  bars: [],
    timescaleMarks: [],
  visibleRange: { from: 0, to: 1 },
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
  intervalChanged: new Delegate(),
  dataChanged: new Delegate(),
  drawingEvent: new Delegate(),
  viewportChanged: new Delegate(),
  crosshairMoved: new Delegate(),
  requestPaint() {},
};

const scrollableToolbar = new Toolbar(engineContext);
document.body.appendChild(scrollableToolbar.el);
scrollableToolbar.createButton({ align: "left", title: "Left action" });
scrollableToolbar.createButton({ align: "right", title: "Right action" });
Object.defineProperties(scrollableToolbar.el, {
  clientWidth: { configurable: true, value: 180 },
  scrollWidth: { configurable: true, value: 560 },
});
scrollableToolbar.el.dispatchEvent(new window.Event("scroll"));
assert(scrollableToolbar.el.dataset.scrollRight === "true", "header signals that more actions are available to the right");
scrollableToolbar.el.scrollLeft = 380;
scrollableToolbar.el.dispatchEvent(new window.Event("scroll"));
assert(
  scrollableToolbar.el.dataset.scrollLeft === "true"
    && scrollableToolbar.el.dataset.scrollRight === "false",
  "header scroll rail reveals actions appended to either alignment slot",
);
assert(
  scrollableToolbar.el.querySelectorAll(".raze-chart-toolbar-rail .raze-chart-toolbar-btn").length === 2,
  "header actions share one horizontal scroll rail",
);
scrollableToolbar.destroy();

const engine = new ChartEngine(engineHost, engineContext);
assert(frames.size === 1, "initial resize queues exactly one frame");
engine.markDirty();
engine.markDirty();
assert(frames.size === 1, "multiple invalidations coalesce into one frame");

let paintCount = 0;
engine.paintHook = () => {
  paintCount += 1;
  if (paintCount === 1) engine.markDirty();
};
flushFrames();
assert(paintCount === 1 && frames.size === 1, "an invalidation during paint survives for one later frame");
flushFrames();
assert(paintCount === 2 && frames.size === 0, "the engine has no perpetual idle RAF loop");

assert(engine.canvas.getAttribute("role") === "application", "financial canvas exposes an interactive role");
assert(engine.canvas.getAttribute("aria-label") === "Portfolio overview", "custom canvas aria label is applied");
const descriptionId = engine.canvas.getAttribute("aria-describedby");
const description = descriptionId ? window.document.getElementById(descriptionId) : null;
assert(
  description?.textContent?.includes("Bitcoin price and volume.")
    && description.textContent.includes("Left and Right Arrow"),
  "custom summary and keyboard instructions are exposed through aria-describedby",
);
assert(engine.canvas.style.outline === "none", "the canvas suppresses the user-agent focus ring until keyboard focus");
delete engineContext.options.raze.aria_label;
engineContext.symbol = "SOLUSD";
engine.syncAccessibility();
assert(engine.canvas.getAttribute("aria-label") === "SOLUSD financial chart", "default accessible name follows symbol changes");
engine.announce("Zoomed in.");
await Promise.resolve();
assert(engineHost.querySelector('[role="status"]')?.textContent === "Zoomed in.", "keyboard feedback uses a polite live region");

const intervalMount = window.document.createElement("div");
window.document.body.appendChild(intervalMount);
let selectedInterval = null;
const intervalSelector = new IntervalSelector(
  {
    resolution: "1",
    fontFamily: "sans-serif",
    symbolInfo: { supported_resolutions: ["1", "5", "15", "60", "1S", "5S", "1D"] },
  },
  intervalMount,
  (resolution) => { selectedInterval = resolution; },
  ["1", "5", "15", "60"],
);
intervalMount.querySelector('[aria-label="Interval 1s"]')?.click();
assert(selectedInterval === "1S", "every supported interval is selectable from the header row");
assert(
  intervalMount.querySelector('[aria-label="Interval 1s"]')?.getAttribute("aria-current") === "true",
  "the active interval is marked in the header row",
);
assert(
  intervalMount.querySelector('[aria-label="More intervals"]') === null,
  "the interval row has no overflow dropdown",
);
const inlineLabels = [...intervalMount.querySelectorAll('[aria-label^="Interval "]')].map((button) => button.textContent);
assert(
  inlineLabels.join(",") === "1s,5s,1m,5m,15m,1h,1D",
  "supported intervals render as one duration-ordered row",
);
intervalSelector.destroy();
intervalMount.remove();

engine.markDirty();
assert(frames.size === 1, "a later invalidation schedules work");
const engineObserver = observers.at(-1);
engine.destroy();
engine.destroy();
engineContext.requestPaint();
engineObserver.trigger();
assert(frames.size === 0 && engineObserver.disconnected, "destroy cancels RAF, observer, and future invalidations");

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
const bar = {
  time: 1_700_000_000_000,
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  volume: 10,
};
const feed = {
  onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1"] })); },
  searchSymbols(_input, _exchange, _type, callback) { callback([]); },
  resolveSymbol(name, resolve) { queueMicrotask(() => resolve(symbolInfo(name))); },
  getBars(_info, _resolution, _params, onResult) { queueMicrotask(() => onResult([bar])); },
  subscribeBars() {},
  unsubscribeBars() {},
};
const widgetHost = window.document.createElement("div");
window.document.body.appendChild(widgetHost);
const instance = new widget({
  symbol: "ETHUSD",
  interval: "1",
  container: widgetHost,
  datafeed: feed,
  disabled_features: ["header_widget", "left_toolbar", "scale_bar"],
  raze: {
    aria_label: "Ether market",
    aria_description: "One-minute Ether candles.",
  },
});
await instance.headerReady();
const root = widgetHost.querySelector(".raze-chart-root");
const canvas = widgetHost.querySelector("canvas");
assert(root?.getAttribute("role") === "region", "financial widget is exposed as a named region");
assert(root?.getAttribute("aria-label") === "Ether market", "widget and canvas share the configured accessible name");
assert(root?.getAttribute("aria-describedby") === canvas?.getAttribute("aria-describedby"), "widget and canvas share the accessible summary");
assert(
  root.style.userSelect === "none" && canvas.style.userSelect === "none",
  "widget pan does not select chrome or canvas fallback text",
);

const tradingEvents = [];
instance.subscribe("trading_event", (line, type) => tradingEvents.push([line, type]));
let bracketChanges = 0;
const bracket = await instance.activeChart().createBracketOrder({
  side: "buy",
  entryPrice: 100,
  stopLossPrice: 98,
  takeProfitPrice: 104,
  quantity: 2,
  currency: "USD",
  onChange(snapshot, event) {
    bracketChanges += 1;
    assert(snapshot.id === bracket.id && event.line.groupId === bracket.id, "bracket callbacks identify the linked order");
  },
});
assert(tradingEvents.find(([line]) => line.id === bracket.stopLoss?.id)?.[0].side === "sell", "long bracket exits use the opposite trading side");
assert(bracket.snapshot().riskRewardRatio === 2, "bracket orders compute risk/reward from linked SL and TP lines");
bracket.setStopLossPrice(99);
assert(bracket.snapshot().riskRewardRatio === 4 && bracketChanges === 1, "fluent bracket updates recalculate risk/reward and notify once");
const order = await instance.activeChart().createOrderLine({ side: "sell", price: 103, quantity: "1.5" });
let orderMoved = 0;
let orderMoving = 0;
let orderCancelled = 0;
order.onMoving(() => { orderMoving += 1; }).onMove(() => { orderMoved += 1; }).onCancel(() => { orderCancelled += 1; });
order.setPrice(102.5);
assert(order.getPrice() === 102.5 && orderMoved === 1, "order-line adapters expose fluent price updates and move callbacks");
assert(instance.activeChart().getTradingLineById(order.id) === order, "trading lines can be retrieved by stable id");
window.__RAZE_DEBUG = true;
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, x: 0, y: 0, toJSON() {} });
flushFrames();
const renderState = window.__razeChartState;
const orderY = (renderState.priceMax - order.getPrice()) / (renderState.priceMax - renderState.priceMin) * 338;
const pointer = (type, y) => {
  const event = new window.MouseEvent(type, { clientX: 300, clientY: y, button: 0, bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 7 },
    pointerType: { value: "mouse" },
  });
  return event;
};
canvas.dispatchEvent(pointer("pointermove", orderY));
canvas.dispatchEvent(pointer("pointerdown", orderY));
canvas.dispatchEvent(pointer("pointermove", orderY + 24));
window.dispatchEvent(pointer("pointerup", orderY + 24));
assert(order.getPrice() < 102.5 && orderMoving === 1 && orderMoved === 2, "pointer drag moves a trading line and separates moving/final callbacks");
const draggedPrice = order.getPrice();
const nudge = new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
canvas.dispatchEvent(nudge);
assert(Math.abs(order.getPrice() - draggedPrice - 0.01) < 1e-9 && nudge.defaultPrevented, "keyboard nudge moves a selected trading line by the symbol tick");
assert(tradingEvents.some(([, type]) => type === "moved"), "trading lifecycle events reach widget subscriptions");
flushFrames();
const beforeCancelledDrag = order.getPrice();
const movesBeforeCancelledDrag = orderMoved;
const cancelY = (window.__razeChartState.priceMax - beforeCancelledDrag)
  / (window.__razeChartState.priceMax - window.__razeChartState.priceMin) * 338;
canvas.dispatchEvent(pointer("pointermove", cancelY));
canvas.dispatchEvent(pointer("pointerdown", cancelY));
canvas.dispatchEvent(pointer("pointermove", cancelY + 18));
canvas.dispatchEvent(pointer("pointercancel", cancelY + 18));
assert(
  order.getPrice() === beforeCancelledDrag && orderMoved === movesBeforeCancelledDrag + 1,
  "pointer cancellation publishes a final rollback price after the transient drag",
);
order.cancel();
assert(orderCancelled === 1 && instance.activeChart().getTradingLineById(order.id) === null, "programmatic cancel matches the on-chart cancel lifecycle");
assert(
  tradingEvents.some(([line, type]) => line.id === order.id && type === "cancelled" && line.status === "cancelled"),
  "cancel events expose a cancelled line snapshot",
);
bracket.remove();
assert(instance.activeChart().getTradingLineById(bracket.entry.id) === null, "removing a bracket clears every linked trading line");
const expandable = await instance.activeChart().createBracketOrder({ side: "sell", entryPrice: 101 });
expandable.setStopLossPrice(103).setTakeProfitPrice(97);
assert(expandable.stopLoss?.getPrice() === 103 && expandable.snapshot().riskRewardRatio === 2, "optional bracket legs can be added fluently after creation");
const removedExpandableStop = expandable.stopLoss?.id;
expandable.remove();
expandable.setStopLossPrice(105).setTakeProfitPrice(95);
assert(
  !removedExpandableStop
    || instance.activeChart().getTradingLineById(removedExpandableStop) === null,
  "a removed bracket adapter cannot resurrect orphaned exit lines",
);
assert(tradingEvents.some(([, type]) => type === "removed"), "trading removals use the declared removed lifecycle event");

let invalidBracketRejected = false;
try {
  await instance.activeChart().createBracketOrder({
    id: "invalid-bracket",
    side: "buy",
    entryPrice: 100,
    stopLossPrice: Number.NaN,
  });
} catch {
  invalidBracketRejected = true;
}
assert(
  invalidBracketRejected
    && instance.activeChart().getTradingLineById("invalid-bracket:entry") === null,
  "invalid bracket input rejects through the Promise contract without leaving a partial entry",
);

const selectStart = new window.Event("selectstart", { bubbles: true, cancelable: true });
canvas.dispatchEvent(selectStart);
assert(selectStart.defaultPrevented, "canvas selectstart is cancelled so axis labels stay unhighlighted");

const beforeDocumentKey = instance.activeChart().getVisibleRange();
window.document.dispatchEvent(new window.KeyboardEvent("keydown", {
  key: "ArrowRight",
  bubbles: true,
  cancelable: true,
}));
assert(
  JSON.stringify(instance.activeChart().getVisibleRange()) === JSON.stringify(beforeDocumentKey),
  "chart shortcuts do not intercept document-level keyboard input",
);
canvas.focus();
const canvasKey = new window.KeyboardEvent("keydown", {
  key: "ArrowRight",
  bubbles: true,
  cancelable: true,
});
canvas.dispatchEvent(canvasKey);
await Promise.resolve();
assert(canvasKey.defaultPrevented, "focused canvas handles its documented keyboard shortcuts");
assert(widgetHost.querySelector('[role="status"]')?.textContent === "Panned right.", "keyboard navigation announces its result");

let resolveDismissedMenu;
instance.onContextMenu(() => new Promise((resolve) => { resolveDismissedMenu = resolve; }));
canvas.dispatchEvent(new window.MouseEvent("contextmenu", {
  clientX: 100,
  clientY: 70,
  bubbles: true,
  cancelable: true,
}));
window.document.body.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
resolveDismissedMenu?.([{ position: "top", text: "Dismissed", click() {} }]);
await Promise.resolve();
await Promise.resolve();
assert(
  !window.document.querySelector(".raze-chart-context-menu"),
  "outside pointer dismissal invalidates a pending async context menu",
);

let resolveLateMenu;
instance.onContextMenu(() => new Promise((resolve) => { resolveLateMenu = resolve; }));
canvas.dispatchEvent(new window.MouseEvent("contextmenu", {
  clientX: 120,
  clientY: 80,
  bubbles: true,
  cancelable: true,
}));
instance.remove();
resolveLateMenu?.([{ position: "top", text: "Too late", click() {} }]);
await Promise.resolve();
await Promise.resolve();
assert(
  !widgetHost.querySelector(".raze-chart-root")
    && !window.document.querySelector(".raze-chart-context-menu")
    && frames.size === 0,
  "widget teardown removes semantics, pending frames, and late async context menus",
);

{
  const parsed = resolveTimeframe({ value: "1M", type: "period-back" }, 1_800_000_000);
  assert(parsed && parsed.to - parsed.from === 30 * 86_400, "period-back 1M is thirty days");
  const ytd = resolveTimeframe("YTD", Date.UTC(2026, 5, 15) / 1000);
  assert(ytd && new Date(ytd.from * 1000).getUTCMonth() === 0, "YTD starts at January 1");
}

{
  const rangeHost = window.document.createElement("div");
  window.document.body.appendChild(rangeHost);
  const older = 1_600_000_000_000;
  const newest = 1_700_000_000_000;
  const rangeFeed = {
    onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1"] })); },
    searchSymbols(_a, _b, _c, callback) { callback([{ symbol: "ETHUSD", full_name: "ETHUSD", description: "Ether", exchange: "Test", type: "crypto" }]); },
    resolveSymbol(name, resolve) { queueMicrotask(() => resolve(symbolInfo(name))); },
    getBars(_info, _res, params, onResult) {
      const bars = params.from * 1000 <= older
        ? [
          { ...bar, time: older, close: 90 },
          { ...bar, time: newest, close: 101 },
        ]
        : [{ ...bar, time: newest, close: 101 }];
      queueMicrotask(() => onResult(bars));
    },
    subscribeBars() {},
    unsubscribeBars() {},
  };
  const ranged = new widget({
    symbol: "ETHUSD",
    interval: "1",
    container: rangeHost,
    datafeed: rangeFeed,
    timeframe: { value: "12M", type: "period-back" },
    disabled_features: ["header_widget", "left_toolbar", "scale_bar"],
  });
  await ranged.headerReady();
  const api = ranged.activeChart();
  const drawingEvents = [];
  ranged.subscribe("drawing_event", (id, type) => drawingEvents.push([id, type]));
  const vwapId = await api.createStudy("VWAP");
  const macdId = await api.createStudy("MACD");
  const snap = ranged.save();
  assert(snap.version === 1 && snap.symbol === "ETHUSD", "save emits a versioned layout snapshot");
  assert(snap.studies.some((s) => s.name === "VWAP"), "layout snapshot includes studies");
  api.executeActionById("undo");
  assert(!ranged.save().studies.some((s) => s.id === String(macdId)), "study creation is undoable");
  api.executeActionById("redo");
  assert(ranged.save().studies.some((s) => s.id === String(macdId)), "study redo restores the original entity id");
  api.removeEntity(macdId);
  api.executeActionById("undo");
  assert(ranged.save().studies.some((s) => s.id === String(macdId)), "study removal undo restores the original entity id");

  const drawingId = await api.createShape(
    { time: Math.floor(newest / 1000), price: 101 },
    {
      shape: "horizontal_line",
      disableSelection: true,
      showInObjectsTree: false,
    },
  );
  api.executeActionById("undo");
  assert(!ranged.save().drawings.some((drawing) => drawing.id === String(drawingId)), "drawing creation is undoable");
  api.executeActionById("redo");
  const redoneDrawing = ranged.save().drawings.find((drawing) => drawing.id === String(drawingId));
  assert(
    redoneDrawing?.disableSelection === true && redoneDrawing.showInObjectsTree === false,
    "drawing redo keeps its stable id and interaction flags",
  );
  api.getShapeById(drawingId).setPriceLevel(95);
  assert(drawingEvents.at(-1)?.[1] === "points_changed", "drawing point edits emit their declared lifecycle event");
  api.executeActionById("undo");
  assert(
    api.getShapeById(drawingId).getPoints()[0]?.price === 101,
    "programmatic drawing edits participate in the same undo history",
  );
  await api.setVisibleRange({ from: Math.floor(older / 1000), to: Math.floor(newest / 1000) });
  const visible = api.getVisibleRange();
  assert(visible.from <= Math.floor(older / 1000) + 1, "setVisibleRange pages history when the window is older than loaded bars");
  await api.createCompare("BTCUSD");
  const afterCompare = ranged.save();
  assert(afterCompare.compare?.includes("BTCUSD"), "compare symbols persist in the snapshot");
  const restoredState = {
    ...afterCompare,
    symbol: "BTCUSD",
    drawings: [
      ...afterCompare.drawings.map((drawing) => ({ ...drawing })),
      { ...afterCompare.drawings[0], id: "shape_9000" },
    ],
    studies: [
      ...afterCompare.studies.map((study) => ({ ...study })),
      { id: "study_ema_9000", name: "EMA", length: 9, color: "#2962ff" },
    ],
  };
  await ranged.load(restoredState);
  const afterLoad = ranged.save();
  assert(
    afterLoad.drawings.some((drawing) => drawing.id === String(drawingId))
      && afterLoad.studies.some((study) => study.id === String(vwapId)),
    "layout load preserves drawing and study entity ids",
  );
  assert(
    rangeHost.querySelector(".raze-chart-root")?.getAttribute("aria-label") === "BTCUSD financial chart",
    "layout load refreshes the widget accessible name",
  );
  const noHistoryId = await api.createShape(
    { time: Math.floor(newest / 1000), price: 110 },
    { shape: "horizontal_line", disableUndo: true },
  );
  api.executeActionById("undo");
  assert(
    ranged.save().drawings.some((drawing) => drawing.id === String(noHistoryId)),
    "disableUndo drawings do not add a history entry after load clears prior history",
  );
  const unsavedId = await api.createShape(
    { time: Math.floor(newest / 1000), price: 111 },
    { shape: "horizontal_line", disableSave: true, disableUndo: true },
  );
  assert(
    !ranged.save().drawings.some((drawing) => drawing.id === String(unsavedId))
      && api.getShapeById(unsavedId).getPoints().length === 1,
    "disableSave keeps a live drawing out of layout snapshots",
  );

  api.removeEntity("shape_9000");
  const freshShapeId = await api.createShape(
    { time: Math.floor(newest / 1000), price: 112 },
    { shape: "horizontal_line" },
  );
  api.removeEntity("study_ema_9000");
  const freshStudyId = await api.createStudy("EMA");
  assert(
    String(freshShapeId) !== "shape_9000" && String(freshStudyId) !== "study_ema_9000",
    "restored entity ids are reserved and never reused by later creations",
  );

  const orderedA = await api.createShape(
    { time: Math.floor(newest / 1000), price: 113 },
    { shape: "horizontal_line" },
  );
  const orderedB = await api.createShape(
    { time: Math.floor(newest / 1000), price: 114 },
    { shape: "horizontal_line" },
  );
  const orderedC = await api.createShape(
    { time: Math.floor(newest / 1000), price: 115 },
    { shape: "horizontal_line" },
  );
  api.removeEntity(orderedB);
  api.executeActionById("undo");
  const orderedIds = ranged.save().drawings.map((drawing) => drawing.id);
  assert(
    orderedIds.indexOf(String(orderedA)) < orderedIds.indexOf(String(orderedB))
      && orderedIds.indexOf(String(orderedB)) < orderedIds.indexOf(String(orderedC)),
    "undoing a middle drawing removal restores its original order",
  );
  api.getShapeById(orderedA).setProperties({ linecolor: "#fff" });
  assert(drawingEvents.at(-1)?.[1] === "properties_changed", "drawing property edits emit properties_changed");
  api.removeEntity(orderedC);
  assert(drawingEvents.at(-1)?.[1] === "remove", "drawing removal emits remove");
  ranged.remove();
}

{
  const overlapHost = window.document.createElement("div");
  window.document.body.appendChild(overlapHost);
  const pendingBars = new Map();
  const overlapFeed = {
    onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1"] })); },
    searchSymbols(_a, _b, _c, callback) { callback([]); },
    resolveSymbol(name, resolve) { queueMicrotask(() => resolve(symbolInfo(name))); },
    getBars(info, _resolution, _params, onResult) {
      if (info.name === "BASE") queueMicrotask(() => onResult([{ ...bar }]));
      else pendingBars.set(info.name, onResult);
    },
    subscribeBars() {},
    unsubscribeBars() {},
  };
  const overlapWidget = new widget({
    symbol: "BASE",
    interval: "1",
    container: overlapHost,
    datafeed: overlapFeed,
    disabled_features: ["header_widget", "left_toolbar", "scale_bar"],
  });
  await overlapWidget.headerReady();
  const baseState = overlapWidget.save();
  const firstLoad = overlapWidget.load({ ...baseState, symbol: "FIRST" });
  for (let i = 0; i < 8 && !pendingBars.has("FIRST"); i++) await Promise.resolve();
  const secondLoad = overlapWidget.load({ ...baseState, symbol: "SECOND" });
  for (let i = 0; i < 8 && !pendingBars.has("SECOND"); i++) await Promise.resolve();
  pendingBars.get("SECOND")?.([{ ...bar, close: 202 }]);
  await Promise.all([firstLoad, secondLoad]);
  pendingBars.get("FIRST")?.([{ ...bar, close: 101 }]);
  await Promise.resolve();
  assert(overlapWidget.save().symbol === "SECOND", "the newest overlapping layout load wins deterministically");
  const overlapApi = overlapWidget.activeChart();
  const postLoadShape = await overlapApi.createShape(
    { time: Math.floor(bar.time / 1000), price: 202 },
    { shape: "horizontal_line" },
  );
  overlapApi.executeActionById("undo");
  assert(
    !overlapWidget.save().drawings.some((drawing) => drawing.id === String(postLoadShape)),
    "overlapping loads leave command history enabled and usable",
  );
  let malformedRejected = false;
  try {
    await overlapWidget.load({
      ...baseState,
      symbol: "MALFORMED",
      drawings: [{ ...baseState.drawings[0], id: "bad", points: [{ time: Number.NaN }] }],
    });
  } catch {
    malformedRejected = true;
  }
  assert(
    malformedRejected && overlapWidget.save().symbol === "SECOND",
    "nested malformed snapshot data rejects before changing the committed chart",
  );
  const teardownLoad = overlapWidget.load({ ...baseState, symbol: "TEARDOWN" });
  for (let i = 0; i < 8 && !pendingBars.has("TEARDOWN"); i++) await Promise.resolve();
  overlapWidget.remove();
  pendingBars.get("TEARDOWN")?.([{ ...bar }]);
  await teardownLoad;
  assert(!overlapHost.querySelector(".raze-chart-root"), "a pending layout load cannot repopulate a removed widget");
}

{
  const layoutHost = window.document.createElement("div");
  window.document.body.appendChild(layoutHost);
  const layoutWidget = new widget({
    symbol: "ETHUSD",
    interval: "1",
    container: layoutHost,
    datafeed: feed,
    disabled_features: ["header_widget", "left_toolbar", "scale_bar"],
    raze: { layout: "2x1", layout_symbols: ["ETHUSD", "BTCUSD"] },
  });
  await layoutWidget.headerReady();
  const panes = [...layoutHost.querySelectorAll(".raze-chart-layout-pane")];
  const primaryCanvas = panes[0]?.querySelector("canvas");
  assert(panes.length === 2 && primaryCanvas, "2x1 layout creates both chart panes before mounting engines");
  assert(
    observers.some((observer) => observer.target === panes[0]),
    "the primary engine measures its own grid pane instead of the outer multi-chart grid",
  );
  assert(layoutWidget.chart(1) !== layoutWidget.activeChart(), "layout chart(index) exposes the child pane API");
  layoutWidget.remove();
}

{
  const emptyHost = window.document.createElement("div");
  window.document.body.appendChild(emptyHost);
  const emptyFeed = {
    ...feed,
    getBars(_info, _resolution, _params, onResult) {
      queueMicrotask(() => onResult([], { noData: true }));
    },
  };
  const emptyWidget = new widget({
    symbol: "EMPTY",
    interval: "1",
    container: emptyHost,
    datafeed: emptyFeed,
    disabled_features: ["header_widget", "left_toolbar", "scale_bar"],
  });
  await emptyWidget.headerReady();
  assert(
    emptyHost.querySelector(".raze-chart-loading-message")?.textContent?.includes("No chart data"),
    "an empty data response remains visible as an informative state",
  );
  emptyWidget.remove();
}

{
  const errorHost = window.document.createElement("div");
  window.document.body.appendChild(errorHost);
  const errorFeed = {
    ...feed,
    getBars(_info, _resolution, _params, _onResult, onError) {
      queueMicrotask(() => onError("offline"));
    },
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  const errorWidget = new widget({
    symbol: "ERROR",
    interval: "1",
    container: errorHost,
    datafeed: errorFeed,
    disabled_features: ["header_widget", "left_toolbar", "scale_bar"],
  });
  await errorWidget.headerReady();
  console.error = originalConsoleError;
  assert(
    errorHost.querySelector('.raze-chart-loading-screen[role="alert"]')
      ?.textContent?.includes("could not be loaded"),
    "a failed initial data load exposes a persistent, accessible error state",
  );
  errorWidget.remove();
}

console.log("\nFINANCIAL RUNTIME: PASS");
