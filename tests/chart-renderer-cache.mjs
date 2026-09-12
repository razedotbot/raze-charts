import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { ChartRenderer, Delegate } = await import("../dist/charting_library.esm.js");

const dataChanged = new Delegate();
const context = {
  bars: [
    { time: 1_000, open: 100, high: 108, low: 96, close: 104, volume: 10 },
    { time: 2_000, open: 104, high: 112, low: 101, close: 110, volume: 12 },
  ],
  chartStyle: "heikin_ashi",
  dataChanged,
  selectedShapeId: null,
  selectedTradingLineId: null,
  visibleRange: { from: 0, to: 1 },
  autoScalePrice: true,
  priceRange: null,
  percentScale: false,
  logScale: false,
  volumeMode: "overlay",
  fontFamily: "sans-serif",
};

let paintRequests = 0;
const engine = {
  canvas: document.createElement("canvas"),
  paintHook: null,
  markDirty() { paintRequests += 1; },
};
const shapes = { list: () => [] };
const trading = { list: () => [], autoScalePrices: () => [] };
const studies = { list: () => [], paneDefs: () => [], paneStudies: () => [] };

const renderer = new ChartRenderer(context, engine, shapes, trading, {}, studies);
renderer.attach();

renderer.refreshSeriesBars();
const firstTransform = renderer.financeView().seriesBars;
renderer.refreshSeriesBars();
assert.strictEqual(
  renderer.financeView().seriesBars,
  firstTransform,
  "Heikin-Ashi repaint reuses the transformed series",
);

context.bars[1] = { ...context.bars[1], close: 106 };
dataChanged.fire();
assert.equal(paintRequests, 1, "data changes still request a repaint");
renderer.refreshSeriesBars();
const afterInPlaceUpdate = renderer.financeView().seriesBars;
assert.notStrictEqual(
  afterInPlaceUpdate,
  firstTransform,
  "forming-bar data changes invalidate the cached transformation",
);
assert.equal(afterInPlaceUpdate[1].close, (104 + 112 + 101 + 106) / 4);

context.bars = context.bars.map((bar) => ({ ...bar }));
renderer.refreshSeriesBars();
const afterArrayReplacement = renderer.financeView().seriesBars;
assert.notStrictEqual(
  afterArrayReplacement,
  afterInPlaceUpdate,
  "replacing the source array invalidates the cache without relying on an event",
);

context.chartStyle = "candles";
renderer.refreshSeriesBars();
assert.strictEqual(
  renderer.financeView().seriesBars,
  context.bars,
  "non-Heikin styles render the source bars directly",
);
context.chartStyle = "heikin_ashi";
renderer.refreshSeriesBars();
assert.notStrictEqual(
  renderer.financeView().seriesBars,
  afterArrayReplacement,
  "changing back to Heikin-Ashi starts a fresh transform lifecycle",
);

renderer.destroy();
assert.equal(renderer.financeView().seriesBars.length, 0, "destroy releases the cached series");
dataChanged.fire();
assert.equal(paintRequests, 1, "destroy unsubscribes cache invalidation from the chart context");

dom.window.close();
console.log("CHART RENDERER CACHE: PASS");
