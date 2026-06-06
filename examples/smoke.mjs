// Headless smoke test: drives the built ESM bundle under jsdom with stubbed
// canvas / ResizeObserver / requestAnimationFrame and the synthetic datafeed.
// Verifies the full P0+P1 lifecycle the app relies on. Run: node examples/smoke.mjs

import { JSDOM } from "jsdom";
import { makeMockDatafeed } from "./mock-datafeed.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;

// ── Globals the library expects ─────────────────────────────────────────────
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
// The bundle uses bare globals (performance/queueMicrotask/requestAnimationFrame)
// which resolve to Node's natives — no need to mirror them onto window.
window.devicePixelRatio = 2;

// 2D context stub — records nothing, just satisfies the renderer.
const ctxStub = new Proxy(
  { measureText: () => ({ width: 10 }), canvas: {} },
  { get: (t, p) => (p in t ? t[p] : () => {}), set: () => true },
);
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;

// ResizeObserver stub that reports a fixed size once.
window.ResizeObserver = class {
  constructor(cb) { this.cb = cb; }
  observe() { this.cb([]); }
  disconnect() {}
};
// getBoundingClientRect → fixed plot size.
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0 };
};
let rafId = 0;
globalThis.requestAnimationFrame = () => ++rafId; // don't loop in test
globalThis.cancelAnimationFrame = () => {};
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
globalThis.ResizeObserver = window.ResizeObserver;

const { widget } = await import("../dist/charting_library.esm.js");

const assert = (cond, msg) => { if (!cond) { console.error("✗ " + msg); process.exitCode = 1; } else { console.log("✓ " + msg); } };

const container = window.document.createElement("div");
window.document.body.appendChild(container);

const datafeed = makeMockDatafeed({ bars: 1500, startPrice: 1000 });
let chartReady = false;

const w = new widget({
  symbol: "MOCK",
  datafeed,
  interval: "1",
  container,
  library_path: "/",
  locale: "en",
  theme: "dark",
  autosize: true,
  disabled_features: ["header_symbol_search"],
  enabled_features: ["seconds_resolution", "mark_on_bars"],
  overrides: {
    "paneProperties.background": "#181615",
    "mainSeriesProperties.candleStyle.upColor": "#66d89e",
    "mainSeriesProperties.candleStyle.downColor": "#e57359",
  },
});

assert(typeof w.onChartReady === "function", "widget exposes onChartReady");
assert(typeof w.headerReady === "function", "widget exposes headerReady");
assert(container.querySelector("canvas") !== null, "canvas mounted into container");

await w.headerReady();
assert(true, "headerReady resolved");

// custom buttons + css props (the app calls these in headerReady)
const btn = w.createButton({ align: "left", useTradingViewStyle: false });
btn.innerHTML = "<span>MarketCap/Price</span>";
assert(btn instanceof window.HTMLElement, "createButton returns an HTMLElement");
w.setCSSCustomProperty("--tv-color-pane-background", "#181615");
assert(true, "setCSSCustomProperty did not throw");

await new Promise((r) => w.onChartReady(r));
chartReady = true;
assert(chartReady, "onChartReady fired");

const chart = w.activeChart();
assert(chart.resolution() === "1", "resolution() === initial interval");

// bars loaded
const vr = chart.getVisibleRange();
assert(vr.from > 0 && vr.to > vr.from, `getVisibleRange sane (${vr.from}..${vr.to})`);

// interval subscription + change
let intervalFired = null;
chart.onIntervalChanged().subscribe(null, (res) => { intervalFired = res; });
await new Promise((r) => chart.setResolution("5", r));
assert(chart.resolution() === "5", "setResolution changed resolution");
assert(intervalFired === "5", "onIntervalChanged fired with new resolution");

// P3: header interval selector rendered + a user click drives the change
const toolbarBtns = [...container.querySelectorAll(".raze-chart-toolbar div")]
  .filter((d) => ["1s", "1m", "5m", "15m", "1h", "4h", "1D"].includes(d.textContent));
assert(toolbarBtns.length >= 3, `interval selector rendered favorites (${toolbarBtns.length})`);
const oneMinBtn = toolbarBtns.find((d) => d.textContent === "1m");
intervalFired = null;
oneMinBtn?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 20));
assert(chart.resolution() === "1", "clicking the 1m interval button changed resolution");
assert(intervalFired === "1", "user interval click fired onIntervalChanged");

// shapes: createShape → getShapeById → setPoints/getPoints → removeEntity
const id = await chart.createShape({ time: Math.floor(Date.now() / 1000), price: 1000 }, {
  shape: "horizontal_line", lock: false, text: "Limit ↕",
  overrides: { linecolor: "#66d89e", linestyle: 2, showPrice: true },
});
assert(typeof id === "string", "createShape resolved an EntityId");
const adapter = chart.getShapeById(id);
adapter.setPoints([{ time: Math.floor(Date.now() / 1000), price: 1234 }]);
assert(adapter.getPoints()[0].price === 1234, "getShapeById().setPoints/getPoints round-trips");

// drawing_event subscription (drag emits points_changed)
let drawingEvt = null;
w.subscribe("drawing_event", (sid, type) => { drawingEvt = { sid, type }; });

// marks refresh/clear
chart.refreshMarks();
await new Promise((r) => setTimeout(r, 30));
chart.clearMarks();
assert(true, "refreshMarks/clearMarks did not throw");

// resetData (the app calls this at headerReady)
chart.resetData();
assert(true, "resetData did not throw");

// onContextMenu registration
w.onContextMenu(() => [{ position: "top", text: "Filter Timestamp", click: () => {} }]);
assert(true, "onContextMenu registered");

// teardown
w.remove();
assert(container.querySelector(".raze-chart-root") === null, "remove() cleaned up the DOM");

void drawingEvt;
console.log(process.exitCode ? "\nSMOKE: FAIL" : "\nSMOKE: PASS");
