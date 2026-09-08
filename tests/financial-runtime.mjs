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

const { ChartEngine, Delegate, widget } = await import("../dist/charting_library.esm.js");

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
  marks: [],
  visibleRange: { from: 0, to: 1 },
  autoScalePrice: true,
  priceRange: null,
  chartStyle: "candles",
  logScale: false,
  percentScale: false,
  drawingTool: "cursor",
  selectedShapeId: null,
  intervalChanged: new Delegate(),
  dataChanged: new Delegate(),
  drawingEvent: new Delegate(),
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
assert(engine.canvas.style.outline !== "none", "the canvas does not suppress its focus indicator");
delete engineContext.options.raze.aria_label;
engineContext.symbol = "SOLUSD";
engine.syncAccessibility();
assert(engine.canvas.getAttribute("aria-label") === "SOLUSD financial chart", "default accessible name follows symbol changes");
engine.announce("Zoomed in.");
await Promise.resolve();
assert(engineHost.querySelector('[role="status"]')?.textContent === "Zoomed in.", "keyboard feedback uses a polite live region");

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

console.log("\nFINANCIAL RUNTIME: PASS");
