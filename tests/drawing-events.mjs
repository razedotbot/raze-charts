// Widget-level drawing events (draw-declared-events-missing): clicking a
// drawing fires drawing_event 'click', dragging fires 'move' then one
// 'points_changed', and the new widget events drawing_selection_changed (ids)
// and drawing_tool_changed (tool id) fire once per effective change from the
// canvas, the keyboard, the sidebar and store removals. The last section
// checks, from source, that the controller's context shim is undone on destroy.
// Run after the build: node build.mjs && node tests/drawing-events.mjs

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
};

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
window.HTMLCanvasElement.prototype.getContext = () => new Proxy(
  { measureText: (value) => ({ width: String(value ?? "").length * 6 }), canvas: {} },
  {
    get: (target, property) => (property in target ? target[property] : () => {}),
    set: (target, property, value) => {
      target[property] = value;
      return true;
    },
  },
);
for (const [name, size] of [["clientWidth", 900], ["clientHeight", 400]]) {
  Object.defineProperty(window.HTMLElement.prototype, name, { configurable: true, get: () => size });
}
class TestResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([]); }
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver;
window.ResizeObserver = TestResizeObserver;
const frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++frameId, callback);
  return frameId;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
const flushFrames = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
};

const { widget } = await import("../dist/charting_library.esm.js");

const T0 = 1_700_000_040;
const bars = Array.from({ length: 200 }, (_, i) => ({
  time: (T0 + i * 60) * 1000, open: 100, high: 104, low: 96, close: 101, volume: 1,
}));
const feed = {
  onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1"] })); },
  searchSymbols(_input, _exchange, _type, callback) { callback([]); },
  resolveSymbol(name, resolve) {
    queueMicrotask(() => resolve({
      name, ticker: name, description: name, type: "crypto", session: "24x7", timezone: "Etc/UTC",
      exchange: "Test", listed_exchange: "Test", format: "price", minmov: 1, pricescale: 100,
      has_intraday: true, supported_resolutions: ["1"],
    }));
  },
  getBars(_info, _resolution, params, onResult) {
    queueMicrotask(() => onResult(params.firstDataRequest ? bars : [], { noData: !params.firstDataRequest }));
  },
  subscribeBars() {},
  unsubscribeBars() {},
};
const container = document.createElement("div");
document.body.appendChild(container);
const instance = new widget({
  symbol: "TEST",
  interval: "1",
  container,
  datafeed: feed,
  disabled_features: ["header_widget", "scale_bar", "legend_widget"],
  raze: { compact_breakpoint: 0 },
});
await instance.headerReady();
await new Promise((resolve) => instance.onChartReady(resolve));

const log = [];
instance.subscribe("drawing_event", (id, type) => log.push(["drawing_event", id, type]));
instance.subscribe("drawing_selection_changed", (ids) => log.push(["selection", ids]));
instance.subscribe("drawing_tool_changed", (tool) => log.push(["tool", tool]));

const chart = instance.activeChart();
const id = await chart.createShape({ time: T0 + 150 * 60, price: 100 }, { shape: "horizontal_line", lock: false });
const canvas = container.querySelector("canvas");
const rect = canvas.getBoundingClientRect();
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: rect.width || 900, bottom: rect.height || 400, width: rect.width || 900, height: rect.height || 400, x: 0, y: 0, toJSON() {} });
window.__RAZE_DEBUG = true;
chart.setVisibleRange?.({ from: T0 + 100 * 60, to: T0 + 199 * 60 });
flushFrames();
flushFrames();
const state = window.__razeChartState;
assert(state && state.priceMax > 100 && state.priceMin < 100, "the horizontal line is inside the painted price range");

// Find the line's row: sweep the plot until a pointer hover reports the move cursor.
const pointer = (type, x, y) => {
  const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
  return event;
};
const x = 300;
let lineY = -1;
for (let y = 10; y < 360 && lineY < 0; y += 1) {
  canvas.dispatchEvent(pointer("pointermove", x, y));
  if (canvas.style.cursor === "ns-resize") lineY = y + 2;
}
assert(lineY > 0, "hovering the horizontal line shows its drag cursor");

log.length = 0;
canvas.dispatchEvent(pointer("pointerdown", x, lineY));
window.dispatchEvent(pointer("pointerup", x, lineY));
assert(
  JSON.stringify(log) === JSON.stringify([["selection", [id]], ["drawing_event", id, "click"]]),
  "clicking a drawing selects it (drawing_selection_changed with its id) and fires drawing_event 'click'",
);

log.length = 0;
canvas.dispatchEvent(pointer("pointerdown", x, lineY));
canvas.dispatchEvent(pointer("pointermove", x, lineY + 20));
canvas.dispatchEvent(pointer("pointermove", x, lineY + 30));
window.dispatchEvent(pointer("pointerup", x, lineY + 30));
assert(
  JSON.stringify(log) === JSON.stringify([["drawing_event", id, "move"], ["drawing_event", id, "points_changed"]]),
  "dragging fires 'move' at most once per frame, then one 'points_changed'; re-selecting the same drawing is not a change",
);

log.length = 0;
canvas.focus();
canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
assert(JSON.stringify(log) === JSON.stringify([["selection", []]]), "Escape clears the selection with one empty drawing_selection_changed");

log.length = 0;
const trend = container.querySelector('[aria-label="Trend line"]');
trend?.click();
assert(trend && JSON.stringify(log) === JSON.stringify([["tool", "trend_line"]]), "picking a sidebar tool fires drawing_tool_changed once");
canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
assert(JSON.stringify(log.at(-1)) === JSON.stringify(["tool", "cursor"]) && log.filter(([kind]) => kind === "tool").length === 2,
  "Escape returns to the cursor with exactly one drawing_tool_changed");

flushFrames();
canvas.dispatchEvent(pointer("pointerdown", x, lineY + 30));
window.dispatchEvent(pointer("pointerup", x, lineY + 30));
assert(JSON.stringify(log.at(-1)) === JSON.stringify(["drawing_event", id, "click"]), "the dragged line is selected again where it was dropped");
log.length = 0;
chart.removeEntity(id);
assert(log.some(([kind, ids]) => kind === "selection" && ids.length === 0), "removing the selected drawing reports an empty selection");

instance.remove();

// ── The observer shim is undone on destroy ────────────────────────────────
// DrawingEventsController temporarily swaps two context fields for accessors
// (see docs/seams.md). Destroy must put plain data properties back with the
// current values, and an accessor the context already had is delegated to,
// never shadowed.
const scratch = mkdtempSync(join(tmpdir(), "raze-drawing-events-"));
let source;
try {
  const outfile = join(scratch, "controller.mjs");
  await build({
    stdin: {
      resolveDir: root,
      loader: "ts",
      contents: `
        export { DrawingEventsController } from "./src/core/widget/DrawingEventsController";
        export { createChartContext } from "./src/core/context";
      `,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    outfile,
    logLevel: "silent",
  });
  source = await import(pathToFileURL(outfile).href);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const makeContext = () => source.createChartContext({
  options: { symbol: "T" }, bars: [], resolution: "1", symbolInfo: null, theme: {}, fontFamily: "sans-serif",
  magnet: false, stayInDrawingMode: false, drawingTool: "cursor", visibleRange: { from: 0, to: 10 },
  autoScalePrice: true, priceRange: null, logScale: false, percentScale: false,
  selectedShapeId: null, selectedTradingLineId: null, requestPaint: () => {},
});
{
  const emitted = [];
  const context = makeContext();
  const controller = new source.DrawingEventsController({ context, controllers: { events: { emit: (...args) => emitted.push(args) } } });
  controller.attach();
  context.selectedShapeId = "a";
  context.selectedShapeId = "a";
  context.drawingTool = "trend_line";
  assert(JSON.stringify(emitted) === JSON.stringify([["drawing_selection_changed", ["a"]], ["drawing_tool_changed", "trend_line"]]),
    "the observed fields emit once per effective change");
  controller.destroy();
  const selection = Object.getOwnPropertyDescriptor(context, "selectedShapeId");
  const tool = Object.getOwnPropertyDescriptor(context, "drawingTool");
  assert(selection.value === "a" && selection.writable && !selection.get && tool.value === "trend_line" && tool.writable && !tool.get,
    "destroy restores plain data properties holding the current values");
  context.selectedShapeId = "b";
  assert(emitted.length === 2 && context.selectedShapeId === "b", "a destroyed controller emits nothing");
}
{
  const emitted = [];
  const context = makeContext();
  let stored = "cursor";
  const accessor = { configurable: true, enumerable: true, get: () => stored, set: (next) => { stored = next; } };
  Object.defineProperty(context, "drawingTool", accessor);
  const controller = new source.DrawingEventsController({ context, controllers: { events: { emit: (...args) => emitted.push(args) } } });
  controller.attach();
  context.drawingTool = "text";
  assert(stored === "text" && JSON.stringify(emitted) === JSON.stringify([["drawing_tool_changed", "text"]]),
    "an accessor the context already defines is delegated to, not shadowed");
  controller.destroy();
  assert(Object.getOwnPropertyDescriptor(context, "drawingTool").get === accessor.get, "destroy puts the original accessor back");
}
console.log("\nDRAWING EVENTS: PASS");
