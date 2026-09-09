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
  observe() { this.callback([]); }
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

const { ChartEngine, Delegate, IntervalSelector, resolveTimeframe, widget } = await import("../dist/charting_library.esm.js");

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
order.cancel();
assert(orderCancelled === 1 && instance.activeChart().getTradingLineById(order.id) === null, "programmatic cancel matches the on-chart cancel lifecycle");
bracket.remove();
assert(instance.activeChart().getTradingLineById(bracket.entry.id) === null, "removing a bracket clears every linked trading line");
const expandable = await instance.activeChart().createBracketOrder({ side: "sell", entryPrice: 101 });
expandable.setStopLossPrice(103).setTakeProfitPrice(97);
assert(expandable.stopLoss?.getPrice() === 103 && expandable.snapshot().riskRewardRatio === 2, "optional bracket legs can be added fluently after creation");
expandable.remove();

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

instance.remove();
assert(!widgetHost.querySelector(".raze-chart-root") && frames.size === 0, "widget teardown removes semantics and pending frames");

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
  await api.createStudy("VWAP");
  await api.createStudy("MACD");
  const snap = ranged.save();
  assert(snap.version === 1 && snap.symbol === "ETHUSD", "save emits a versioned layout snapshot");
  assert(snap.studies.some((s) => s.name === "VWAP"), "layout snapshot includes studies");
  await api.setVisibleRange({ from: Math.floor(older / 1000), to: Math.floor(newest / 1000) });
  const visible = api.getVisibleRange();
  assert(visible.from <= Math.floor(older / 1000) + 1, "setVisibleRange pages history when the window is older than loaded bars");
  await api.createCompare("BTCUSD");
  const afterCompare = ranged.save();
  assert(afterCompare.compare?.includes("BTCUSD"), "compare symbols persist in the snapshot");
  ranged.remove();
}

console.log("\nFINANCIAL RUNTIME: PASS");
