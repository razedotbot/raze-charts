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
// The engine sizes the canvas from clientWidth/Height (0 in jsdom).
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => 800, configurable: true });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { get: () => 400, configurable: true });
// rAF → manual queue, so the test controls when frames run (no free-running loop).
let rafId = 0;
let rafQueue = [];
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return ++rafId; };
globalThis.cancelAnimationFrame = () => {};
const flushFrames = (n = 1) => {
  for (let i = 0; i < n; i++) {
    const q = rafQueue;
    rafQueue = [];
    for (const cb of q) cb(performance.now());
  }
};
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

// Left sidebar (drawings + indicators) — Phase 2 chrome
const sidebar = container.querySelector(".raze-chart-left-sidebar");
assert(sidebar !== null, "left sidebar mounted");
assert(sidebar.querySelectorAll("button").length >= 8, "left sidebar has drawing/action tools");
assert(container.querySelector(".raze-chart-scale-bar") !== null, "scale bar (%/log/auto) mounted");
// Indicators no longer in the header toolbar
const headerInd = [...container.querySelectorAll(".raze-chart-toolbar-btn")]
  .find((d) => d.textContent === "Indicators");
assert(!headerInd, "Indicators removed from header toolbar");

// shapes: createShape → getShapeById → setPoints/getPoints → removeEntity
const id = await chart.createShape({ time: Math.floor(Date.now() / 1000), price: 1000 }, {
  shape: "horizontal_line", lock: false, text: "Limit ↕",
  overrides: { linecolor: "#66d89e", linestyle: 2, showPrice: true },
});
assert(typeof id === "string", "createShape resolved an EntityId");
const adapter = chart.getShapeById(id);
adapter.setPoints([{ time: Math.floor(Date.now() / 1000), price: 1234 }]);
assert(adapter.getPoints()[0].price === 1234, "getShapeById().setPoints/getPoints round-trips");

// multipoint: trend_line
const now = Math.floor(Date.now() / 1000);
const trendId = await chart.createMultipointShape(
  [{ time: now - 600, price: 900 }, { time: now, price: 1100 }],
  { shape: "trend_line", overrides: { linecolor: "#66d89e" } },
);
assert(typeof trendId === "string", "createMultipointShape trend_line resolved");
assert(chart.getShapeById(trendId).getPoints().length === 2, "trend_line keeps 2 points");
chart.removeEntity(trendId);

// studies: createStudy EMA/RSI + removeEntity
const emaId = await chart.createStudy("EMA", false, false, { length: 9 });
assert(typeof emaId === "string" && emaId.includes("ema"), `createStudy EMA id (${emaId})`);
const rsiId = await chart.createStudy("RSI", false, false, { length: 14 });
assert(typeof rsiId === "string" && rsiId.includes("rsi"), `createStudy RSI id (${rsiId})`);
try {
  flushFrames(3);
  assert(true, "paint executed with EMA overlay + RSI sub-pane");
} catch (e) {
  assert(false, `paint with RSI sub-pane threw: ${e.message}`);
}
chart.removeEntity(rsiId);
assert(true, "removeEntity(study) did not throw");

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

// ── Configurable chrome: custom sidebar / studies / presets / favorites ─────
const container2 = window.document.createElement("div");
window.document.body.appendChild(container2);
let customClicked = false;

const w2 = new widget({
  symbol: "MOCK",
  datafeed: makeMockDatafeed({ bars: 400, startPrice: 500 }),
  interval: "1",
  container: container2,
  library_path: "/",
  locale: "en",
  theme: "dark",
  autosize: true,
  disabled_features: ["scale_bar", "legend_widget"],
  favorites: { intervals: ["1", "5"] },
  raze: {
    sidebar: [
      "cursor", "trend_line",
      "separator",
      "indicators",
      { id: "alerts", title: "Alerts", icon: "<svg></svg>", onClick: () => { customClicked = true; } },
      "chart_type",
    ],
    chart_types: ["candles", "line"],
    indicator_presets: [
      { name: "EMA", length: 5 },
      { label: "Mid-price", name: "MID", color: "#ffffff" },
    ],
    custom_studies: [
      {
        name: "MID",
        pane: "pane",
        defaults: { length: 1, color: "#8ecae6" },
        levels: [{ value: 500, dashed: true, axisLabel: true }],
        label: "Mid",
        formatValue: (v) => v.toFixed(3),
        compute: (bars) => bars.map((b) => (b.high + b.low) / 2),
      },
    ],
  },
});

await new Promise((r) => w2.onChartReady(r));
const chart2 = w2.activeChart();

const sb2 = container2.querySelector(".raze-chart-left-sidebar");
assert(sb2 !== null, "custom sidebar mounted");
assert(sb2.querySelectorAll("button").length === 5, "custom sidebar renders exactly the configured buttons");
const customBtn = sb2.querySelector('button[data-custom-id="alerts"]');
assert(customBtn !== null, "custom sidebar button present");
customBtn?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert(customClicked, "custom sidebar button onClick fired");

const styleBtn2 = [...sb2.querySelectorAll("button")].find((b) => b.title.startsWith("Chart type"));
styleBtn2?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const styleRows = [...window.document.querySelectorAll(".raze-chart-style-menu button")]
  .filter((b) => /Candles|Line|Area|Heikin/.test(b.textContent));
assert(styleRows.length === 2, `chart_types whitelist respected (${styleRows.length} of 4 styles)`);
await new Promise((r) => setTimeout(r, 5)); // let the popup arm its dismiss listeners
window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
assert(window.document.querySelector(".raze-chart-style-menu") === null, "Esc closes the chart-type popup");

assert(container2.querySelector(".raze-chart-scale-bar") === null, "disabled_features scale_bar hides the scale bar");

// favorites.intervals drives the header row: 1m + 5m inline, rest behind "⋯"
const favBtns = [...container2.querySelectorAll(".raze-chart-toolbar div")]
  .filter((d) => ["1s", "5s", "1m", "5m", "15m", "1h", "1D"].includes(d.textContent));
assert(
  favBtns.length === 2 && favBtns.every((d) => ["1m", "5m"].includes(d.textContent)),
  `favorites.intervals drives the header row (${favBtns.map((d) => d.textContent).join(",")})`,
);

// custom study: createStudy by name + pane rendering path
const midId = await chart2.createStudy("MID", false, false, {});
assert(typeof midId === "string" && midId.includes("mid"), `createStudy custom "MID" id (${midId})`);
try {
  flushFrames(3);
  assert(true, "paint executed with custom sub-pane (auto-range + levels) and legend disabled");
} catch (e) {
  assert(false, `paint with custom sub-pane threw: ${e.message}`);
}
let unknownRejected = false;
await chart2.createStudy("NOPE").catch(() => { unknownRejected = true; });
assert(unknownRejected, "createStudy unknown name rejects");

// indicators panel shows exactly the configured presets (2 rows + Clear all)
const indBtn2 = [...sb2.querySelectorAll("button")].find((b) => b.title === "Indicators");
indBtn2?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const menu2 = window.document.querySelector(".raze-chart-indicators-menu");
assert(menu2 !== null, "indicators panel opens from custom sidebar");
const rows2 = [...menu2.querySelectorAll("button")].map((b) => b.textContent.trim());
assert(rows2.length === 3 && rows2.some((t) => t.includes("EMA 5")) && rows2.some((t) => t.includes("Mid-price")),
  `indicator_presets drive the panel rows (${rows2.join(" | ")})`);
const midRow = [...menu2.querySelectorAll("button")].find((b) => b.textContent.includes("Mid-price"));
midRow?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert(true, "toggling a custom preset did not throw");

w2.remove();
assert(container2.querySelector(".raze-chart-root") === null, "configured widget remove() cleaned up");

console.log(process.exitCode ? "\nSMOKE: FAIL" : "\nSMOKE: PASS");
