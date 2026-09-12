// Deterministic regressions for callback ordering and widget teardown.
// Run after the build: node build.mjs && node tests/data-manager.mjs

import { JSDOM } from "jsdom";
import { DataManager, Delegate, widget } from "../dist/charting_library.esm.js";

const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
};

const spinUntil = async (predicate, message) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${message}`);
};

const bar = (time, close) => ({
  time,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 10,
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

function makeControlledFeed() {
  let readyCallback = null;
  const resolves = [];
  const history = [];
  const marks = [];
  const timescale = [];
  const subscriptions = [];
  const unsubscribed = [];

  const feed = {
    onReady(callback) { readyCallback = callback; },
    searchSymbols(_input, _exchange, _type, callback) { callback([]); },
    resolveSymbol(symbol, onResolve, onError) {
      resolves.push({ symbol, onResolve, onError });
    },
    getBars(info, resolution, params, onResult, onError) {
      history.push({ info, resolution, params, onResult, onError });
    },
    subscribeBars(info, resolution, onTick, guid, onReset) {
      subscriptions.push({ info, resolution, onTick, guid, onReset });
    },
    unsubscribeBars(guid) { unsubscribed.push(guid); },
    getMarks(info, from, to, onData, resolution) {
      marks.push({ info, from, to, onData, resolution });
    },
    getTimescaleMarks(info, from, to, onData, resolution) {
      timescale.push({ info, from, to, onData, resolution });
    },
  };

  return {
    feed,
    resolves,
    history,
    marks,
    timescale,
    subscriptions,
    unsubscribed,
    ready() {
      readyCallback?.({ supported_resolutions: ["1", "5", "15"] });
    },
  };
}

function makeContext(datafeed, symbol = "A", resolution = "1") {
  return {
    options: { symbol, interval: resolution, container: /** @type {any} */ ({}), datafeed },
    datafeed,
    locale: "en",
    fontFamily: "sans-serif",
    symbol,
    resolution,
    symbolInfo: null,
    formatPrice: (value) => String(value),
    theme: /** @type {any} */ ({}),
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
}

// A stale initial A request must not contaminate the newer B@5 target.
{
  const controlled = makeControlledFeed();
  const context = makeContext(controlled.feed);
  const manager = new DataManager(context);
  const intervals = [];
  context.intervalChanged.subscribe(null, (resolution) => intervals.push(resolution));

  const boot = manager.resolveAndLoad();
  controlled.ready();
  await spinUntil(() => controlled.resolves.length === 1, "initial symbol resolution");
  controlled.resolves[0].onResolve(symbolInfo("A"));
  await spinUntil(() => controlled.history.length === 1, "initial history request");
  const staleHistory = controlled.history[0];

  const switchTarget = manager.changeSymbol("B", "5");
  await spinUntil(() => controlled.resolves.length === 2, "replacement symbol resolution");
  controlled.resolves[1].onResolve(symbolInfo("B"));
  await spinUntil(() => controlled.history.length === 2, "replacement history request");
  controlled.history[1].onResult([bar(2_000, 20)], { noData: false });
  await Promise.all([boot, switchTarget]);

  assert(context.symbol === "B" && context.resolution === "5", "latest symbol and interval commit atomically");
  assert(context.bars.length === 1 && context.bars[0].close === 20, "latest history wins the race");
  assert(
    context.visibleRange.to - context.visibleRange.from >= 120,
    "sparse initial history preserves the default candle density",
  );
  assert(intervals.join(",") === "5", "combined symbol/interval change emits intervalChanged once");

  staleHistory.onResult([bar(9_000, 999)], { noData: false });
  await Promise.resolve();
  assert(context.bars.length === 1 && context.bars[0].close === 20, "late stale history callback is ignored");
  assert(controlled.subscriptions.length === 1, "cancelled target never starts a live subscription");

  const staleMarks = controlled.marks[0];
  const oldSubscription = controlled.subscriptions[0];
  const resolutionChange = manager.changeSymbol("B", "15");
  assert(
    controlled.unsubscribed.includes(oldSubscription.guid),
    "same-symbol interval change unsubscribes the previous stream immediately",
  );
  oldSubscription.onTick(bar(3_000, 300));
  assert(context.bars.length === 1 && context.bars[0].close === 20, "late tick from an old guid is ignored");

  staleMarks.onData([{ id: "stale", time: 2, color: "red", text: "stale", label: "S" }]);
  await Promise.resolve();
  assert(context.marks.length === 0, "late marks from an old interval are ignored");

  await spinUntil(() => controlled.history.length === 3, "same-symbol interval history");
  assert(controlled.resolves.length === 2, "same-symbol interval change reuses resolved symbol metadata");
  controlled.history[2].onResult([bar(4_000, 40)], { noData: false });
  await resolutionChange;
  assert(context.symbol === "B" && context.resolution === "15", "same-symbol interval is reloaded");

  await spinUntil(() => controlled.marks.length === 2, "new interval marks request");
  setTimeout(() => {
    controlled.marks[1].onData([
      { id: "fresh", time: 4, color: "green", text: "fresh", label: "F" },
    ]);
  }, 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert(context.marks.length === 1 && context.marks[0].id === "fresh", "asynchronous getMarks result is applied");

  const currentSubscription = controlled.subscriptions.at(-1);
  oldSubscription.onTick(bar(5_000, 500));
  currentSubscription.onTick(bar(5_000, 50));
  assert(context.bars.at(-1).close === 50, "only the current live callback can mutate bars");

  manager.resetData();
  await spinUntil(() => controlled.history.length === 4, "reset history request");
  manager.destroy();
  controlled.history[3].onResult([bar(6_000, 60)], { noData: false });
  currentSubscription.onTick(bar(7_000, 70));
  await Promise.resolve();
  assert(context.bars.at(-1).close === 50, "destroy cancels pending reset history and live callbacks");
}

// A manager destroyed before onReady must settle instead of retaining boot.
{
  const controlled = makeControlledFeed();
  const context = makeContext(controlled.feed);
  const manager = new DataManager(context);
  const boot = manager.resolveAndLoad();
  manager.destroy();
  await boot;
  controlled.ready();
  await Promise.resolve();
  assert(controlled.resolves.length === 0, "destroy during datafeed readiness prevents symbol resolution");
  assert(manager.getConfig() === null, "late onReady cannot mutate a destroyed manager");
}

// Active datafeed failures are contextual errors and do not erase committed data.
{
  const controlled = makeControlledFeed();
  const context = makeContext(controlled.feed);
  context.bars = [bar(1_000, 10)];
  const manager = new DataManager(context);
  const boot = manager.resolveAndLoad();
  controlled.ready();
  await spinUntil(() => controlled.resolves.length === 1, "error-case resolution");
  controlled.resolves[0].onResolve(symbolInfo("A"));
  await spinUntil(() => controlled.history.length === 1, "error-case history");
  controlled.history[0].onError("backend unavailable");
  let message = "";
  await boot.catch((error) => { message = error.message; });
  assert(message.includes("getBars failed") && message.includes("backend unavailable"), "history failures reject with context");
  assert(context.bars.length === 1 && context.bars[0].close === 10, "failed reload preserves committed bars");
  manager.destroy();
}

// A terminal initial page can still contain bars. `noData` is authoritative:
// scrolling left must not request the same terminal page again.
{
  const controlled = makeControlledFeed();
  const context = makeContext(controlled.feed);
  const manager = new DataManager(context);
  const boot = manager.resolveAndLoad();
  controlled.ready();
  await spinUntil(() => controlled.resolves.length === 1, "terminal-page resolution");
  controlled.resolves[0].onResolve(symbolInfo("A"));
  await spinUntil(() => controlled.history.length === 1, "terminal initial history");
  controlled.history[0].onResult([bar(120_000, 10)], { noData: true });
  await boot;

  await manager.maybeLoadMoreHistory();
  assert(controlled.history.length === 1, "non-empty initial noData page disables pagination");
  manager.destroy();
}

// A feed that repeats a boundary page has made no progress. Stop pagination
// even when that feed forgot to set `noData`, otherwise each pan retries it.
{
  const controlled = makeControlledFeed();
  const context = makeContext(controlled.feed);
  const manager = new DataManager(context);
  const boot = manager.resolveAndLoad();
  controlled.ready();
  await spinUntil(() => controlled.resolves.length === 1, "duplicate-page resolution");
  controlled.resolves[0].onResolve(symbolInfo("A"));
  await spinUntil(() => controlled.history.length === 1, "duplicate-page initial history");
  controlled.history[0].onResult([bar(120_000, 10), bar(180_000, 11)], { noData: false });
  await boot;

  const page = manager.maybeLoadMoreHistory();
  await spinUntil(() => controlled.history.length === 2, "duplicate boundary page");
  controlled.history[1].onResult([bar(120_000, 10)], { noData: false });
  await page;
  await manager.maybeLoadMoreHistory();
  assert(controlled.history.length === 2, "duplicate history page permanently stops pagination");
  manager.destroy();
}

// Unix ranges map through the continuous TimeIndex rather than an O(n) scan.
// This preserves requested whitespace before/after the loaded series.
{
  const controlled = makeControlledFeed();
  const context = makeContext(controlled.feed);
  context.bars = [bar(120_000, 10), bar(180_000, 11), bar(240_000, 12)];
  const manager = new DataManager(context);

  manager.applyIndexRangeFromUnix(0, 60);
  assert(
    context.visibleRange.from === -2 && context.visibleRange.to === -1,
    "range before the first bar maps to left logical whitespace",
  );

  manager.applyIndexRangeFromUnix(300, 360);
  assert(
    context.visibleRange.from === 3 && context.visibleRange.to === 4,
    "range after the last bar maps to right logical whitespace",
  );

  manager.applyIndexRangeFromUnix(150, 210);
  assert(
    context.visibleRange.from === 0.5 && context.visibleRange.to === 1.5,
    "range between bars preserves fractional logical positions",
  );

  let directError = "";
  try {
    manager.applyIndexRangeFromUnix(10, 5);
  } catch (error) {
    directError = error.message;
  }
  assert(directError.includes("from") && directError.includes("after"), "reversed ranges fail clearly");

  let asyncError = "";
  await manager.revealTimeRange(Number.NaN, 5).catch((error) => { asyncError = error.message; });
  assert(asyncError.includes("finite Unix seconds"), "non-finite ranges reject before reaching the feed");
  manager.destroy();
}

// Minimal DOM integration: Widget.setSymbol must pass the interval even when
// the symbol string is unchanged, and remove() must settle headerReady mid-boot.
{
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  window.devicePixelRatio = 1;
  const context2d = new Proxy(
    { measureText: (value) => ({ width: String(value ?? "").length * 6 }), canvas: {} },
    { get: (target, property) => (property in target ? target[property] : () => {}), set: () => true },
  );
  window.HTMLCanvasElement.prototype.getContext = () => context2d;
  class TestResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe() { this.callback([]); }
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver;
  window.ResizeObserver = TestResizeObserver;
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => 800 });
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { get: () => 400 });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

  const requestedResolutions = [];
  const immediateFeed = {
    onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1", "5"] })); },
    searchSymbols(_a, _b, _c, callback) { callback([]); },
    resolveSymbol(name, resolve) { queueMicrotask(() => resolve(symbolInfo(name))); },
    getBars(_info, resolution, _params, onResult) {
      requestedResolutions.push(resolution);
      queueMicrotask(() => onResult([bar(resolution === "5" ? 5_000 : 1_000, 10)]));
    },
    subscribeBars() {},
    unsubscribeBars() {},
    getMarks(_info, _from, _to, callback) { setTimeout(() => callback([]), 0); },
  };
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const instance = new widget({
    symbol: "SAME",
    interval: "1",
    container: host,
    datafeed: immediateFeed,
  });
  await instance.headerReady();
  await new Promise((resolve) => instance.setSymbol("SAME", "5", resolve));
  assert(instance.activeChart().resolution() === "5", "Widget.setSymbol applies a new interval for the same symbol");
  assert(requestedResolutions.at(-1) === "5", "Widget.setSymbol reloads history at its interval argument");
  instance.remove();

  let delayedReady;
  let resolveCalls = 0;
  const delayedFeed = {
    ...immediateFeed,
    onReady(callback) { delayedReady = callback; },
    resolveSymbol() { resolveCalls += 1; },
  };
  const delayedHost = window.document.createElement("div");
  window.document.body.appendChild(delayedHost);
  const delayed = new widget({
    symbol: "WAIT",
    interval: "1",
    container: delayedHost,
    datafeed: delayedFeed,
  });
  let chartReady = false;
  delayed.onChartReady(() => { chartReady = true; });
  const headerReady = delayed.headerReady();
  delayed.remove();
  await headerReady;
  delayedReady({ supported_resolutions: ["1"] });
  await Promise.resolve();
  delayed.remove();
  assert(!delayedHost.querySelector(".raze-chart-root"), "remove during boot tears down the DOM and is idempotent");
  assert(resolveCalls === 0 && !chartReady, "late boot callbacks cannot resurrect a removed widget");
}

{
  const controlled = makeControlledFeed();
  const context = makeContext(controlled.feed);
  const payloads = [];
  context.intervalChanged.subscribe(null, (_res, payload) => payloads.push(payload));
  const manager = new DataManager(context);
  const boot = manager.resolveAndLoad();
  controlled.ready();
  await spinUntil(() => controlled.resolves.length === 1, "timeframe payload resolution");
  controlled.resolves[0].onResolve(symbolInfo("A"));
  await spinUntil(() => controlled.history.length === 1, "timeframe payload history");
  const now = Date.now();
  controlled.history[0].onResult([
    bar(now - 3_600_000, 10),
    bar(now - 1_800_000, 11),
    bar(now, 12),
  ], { noData: false });
  await boot;
  await spinUntil(() => controlled.marks.length === 1 && controlled.timescale.length === 1, "marks and timescale requests");
  controlled.marks[0].onData([]);
  controlled.timescale[0].onData([{ id: "evt", time: Math.floor(now / 1000), color: "red", label: "E", tooltip: ["event"] }]);
  await spinUntil(() => context.timescaleMarks.length === 1, "timescale marks applied");

  const older = now - 10 * 86_400_000;
  const reveal = manager.revealTimeRange(Math.floor(older / 1000), Math.floor(now / 1000));
  await spinUntil(() => controlled.history.length === 2, "revealTimeRange pages older history");
  controlled.history[1].onResult([bar(older, 8), bar(now - 3_600_000, 10)], { noData: false });
  await reveal;
  assert(context.bars[0].time === older, "setVisibleRange-style reveal merges older bars");

  const changed = manager.changeResolution("5");
  await spinUntil(() => controlled.history.length === 3, "resolution change after reveal");
  controlled.history[2].onResult([bar(now, 12)], { noData: false });
  await changed;
  assert(payloads.at(-1)?.timeframe?.type === "time-range", "intervalChanged carries a timeframe payload");
  manager.destroy();
}

console.log("\nDATA MANAGER: PASS");
