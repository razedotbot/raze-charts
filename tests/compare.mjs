// Compare series lifecycle (W1B-19): resolution failures reject, compares
// follow the main series through resolution/symbol changes, pagination and
// resets, stream live bars under their own GUIDs, unsubscribe on removal and
// teardown, and switch the price scale to percent on the first compare.
//
// Part A drives CompareController and DataManager bundled from source against
// a real ChartContext, so compare bars can be inspected directly. Part B runs
// the built widget end to end through the public API.
// Run after the build: node build.mjs && node tests/compare.mjs

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
const spinUntil = async (predicate, message) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  }
  throw new Error(`Timed out waiting for ${message}`);
};
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
};
/** Run `fn` with console.error captured; returns the captured messages. */
const captureErrors = async (fn) => {
  const original = console.error;
  const messages = [];
  console.error = (...args) => messages.push(args.map((arg) => String(arg?.message ?? arg)).join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return messages;
};

// ── Fake datafeed ──────────────────────────────────────────────────────────
const STEP_SEC = { "1": 60, "5": 300, "15": 900 };
/** Oldest second any symbol has data for; pagination stops here. */
const DATA_START = Math.floor(Date.now() / 1000) - 60 * 20_000;

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

function makeFeed() {
  const feed = {
    getBarsCalls: [],
    subscriptions: new Map(),
    subscribed: [],
    unsubscribed: [],
    /** symbol -> reason; resolveSymbol fails for these. */
    unresolvable: new Map([["NOPE", "unknown symbol"]]),
    /** `${symbol}@${resolution}` -> reason; getBars fails for these. */
    failingHistory: new Map([["BROKEN@1", "history backend offline"]]),
    /** symbols whose resolveSymbol never answers. */
    hanging: new Set(),
    onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1", "5", "15"] })); },
    searchSymbols(_input, _exchange, _type, callback) { callback([]); },
    resolveSymbol(name, onResolve, onError) {
      if (feed.hanging.has(name)) return;
      queueMicrotask(() => {
        if (feed.unresolvable.has(name)) onError(feed.unresolvable.get(name));
        else onResolve(symbolInfo(name));
      });
    },
    getBars(info, resolution, params, onResult, onError) {
      feed.getBarsCalls.push({ symbol: info.name, resolution, ...params });
      const failure = feed.failingHistory.get(`${info.name}@${resolution}`);
      if (failure) {
        queueMicrotask(() => onError(failure));
        return;
      }
      const step = STEP_SEC[resolution];
      const bars = [];
      const start = Math.max(params.from, DATA_START);
      for (let t = Math.ceil(start / step) * step; t < params.to; t += step) {
        const close = info.name.length * 100 + (t / step) % 17;
        bars.push({ time: t * 1000, open: close, high: close + 1, low: close - 1, close, volume: 1 });
      }
      queueMicrotask(() => onResult(bars, { noData: bars.length === 0 }));
    },
    subscribeBars(info, resolution, onTick, guid, onReset) {
      feed.subscriptions.set(guid, { symbol: info.name, resolution, onTick, onReset, guid });
      feed.subscribed.push({ symbol: info.name, resolution, guid });
    },
    unsubscribeBars(guid) {
      feed.subscriptions.delete(guid);
      feed.unsubscribed.push(guid);
    },
    subscriptionFor(symbol) {
      return [...feed.subscriptions.values()].filter((sub) => sub.symbol === symbol);
    },
    callsFor(symbol) {
      return feed.getBarsCalls.filter((call) => call.symbol === symbol);
    },
  };
  return feed;
}

const stepOf = (bars) => (bars.length > 1 ? (bars[1].time - bars[0].time) / 1000 : null);

// ── Part A: controller + data manager from source ──────────────────────────
const scratch = mkdtempSync(join(tmpdir(), "raze-compare-"));
let internals;
try {
  const outfile = join(scratch, "compare.mjs");
  await build({
    stdin: {
      resolveDir: root,
      loader: "ts",
      contents: `
        export { CompareController } from "./src/core/widget/CompareController";
        export { CompareLoader, CompareRequests, normaliseCompareBars } from "./src/data/CompareLoader";
        export { DataManager } from "./src/data/DataManager";
        export { createChartContext } from "./src/core/context";
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
const { CompareController, CompareRequests, DataManager, Delegate, createChartContext, normaliseCompareBars } = internals;

function makeHost(feed, symbol = "AAA") {
  const options = { symbol, interval: "1", datafeed: feed, container: null };
  const context = createChartContext({
    options,
    datafeed: feed,
    locale: "en",
    fontFamily: "sans-serif",
    symbol,
    resolution: "1",
    symbolInfo: null,
    formatPrice: String,
    theme: {},
    features: new Set(),
    bars: [],
    marks: [],
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
    selectedTradingLineId: null,
    intervalChanged: new Delegate(),
    dataChanged: new Delegate(),
    drawingEvent: new Delegate(),
    tradingEvent: new Delegate(),
    viewportChanged: new Delegate(),
    crosshairMoved: new Delegate(),
    requestPaint() {},
  });
  const lifecycle = {
    destroyed: false,
    reportError(operation, error) { console.error(`[raze-charts] failed to ${operation}`, error); },
  };
  const data = new DataManager(context);
  const host = { context, lifecycle, data };
  const compare = new CompareController(host);
  compare.attach();
  return { context, data, compare, lifecycle, host };
}

{
  assert(
    JSON.stringify(normaliseCompareBars([
      { time: 2000, close: 2 },
      null,
      { time: Number.NaN, close: 1 },
      { time: 1000, close: 1 },
      { time: 2000, close: 3 },
    ]).map((b) => [b.time, b.close])) === "[[1000,1],[2000,3]]",
    "compare bars are validated, de-duplicated (last wins) and sorted",
  );
  const requests = new CompareRequests();
  const pending = requests.run(() => {});
  requests.cancel();
  assert((await pending) === null && (await requests.run((ok) => ok(1))) === null, "a cancelled request group settles pending and later requests as null");
}

{
  const feed = makeFeed();
  const { context, data, compare } = makeHost(feed);
  await data.resolveAndLoad();
  assert(context.bars.length > 100 && stepOf(context.bars) === 60, "the main series loads at 1 minute");
  const mainGuid = feed.subscriptionFor("AAA")[0]?.guid;

  // Unknown symbols and history failures reject and add nothing.
  const scaleEvents = [];
  context.scaleChanged.subscribe(null, (change) => scaleEvents.push(change));
  const unknown = await rejection(compare.create("NOPE"));
  assert(
    unknown?.message === '[raze-charts] compare symbol "NOPE" could not be resolved: unknown symbol',
    "createCompare(\"NOPE\") rejects with the datafeed's reason",
  );
  assert(context.compare.length === 0 && feed.callsFor("NOPE").length === 0 && feed.subscriptionFor("NOPE").length === 0, "an unresolved compare adds no series, history request or subscription");
  const broken = await rejection(compare.create("BROKEN"));
  assert(
    /compare symbol "BROKEN" history could not be loaded at 1: history backend offline/.test(broken?.message ?? ""),
    "a compare history failure rejects with the symbol, resolution and reason",
  );
  assert(context.compare.length === 0 && feed.subscriptionFor("BROKEN").length === 0, "a failed compare history adds nothing");
  const blank = await rejection(compare.create("   "));
  assert(blank instanceof TypeError && /needs a symbol name/.test(blank.message), "a blank compare symbol rejects with guidance");
  assert(scaleEvents.length === 0 && context.scaleState().mode === "normal", "failed compares leave the price scale alone");

  // A successful compare covers the main window, streams live bars and switches to percent.
  const id = await compare.create("BBB");
  const entry = () => context.compare.find((item) => item.id === id);
  assert(id === "compare_BBB_1" && entry()?.resolution === "1", "createCompare resolves a per-widget id and records the loaded resolution");
  const firstCall = feed.callsFor("BBB")[0];
  assert(
    firstCall.firstDataRequest === true
      && firstCall.from === Math.floor(context.bars[0].time / 1000)
      && firstCall.to === Math.floor(context.bars.at(-1).time / 1000) + 60,
    "the compare history window matches the main series' loaded window",
  );
  assert(entry().bars[0].time === context.bars[0].time && entry().bars.at(-1).time === context.bars.at(-1).time, "compare bars span the main series");
  assert(
    context.scaleState().mode === "percent" && scaleEvents.at(-1)?.reason === "compare",
    "the first compare switches the price scale to percent with the compare reason",
  );
  const [liveSub] = feed.subscriptionFor("BBB");
  assert(liveSub && liveSub.resolution === "1" && liveSub.guid !== mainGuid, "the compare subscribes to live bars with its own GUID");
  const lastTime = entry().bars.at(-1).time;
  liveSub.onTick({ time: lastTime, open: 1, high: 1, low: 1, close: 7 });
  assert(entry().bars.at(-1).close === 7, "a live tick updates the forming compare bar");
  liveSub.onTick({ time: lastTime + 60_000, open: 1, high: 1, low: 1, close: 8 });
  assert(entry().bars.at(-1).time === lastTime + 60_000 && entry().bars.at(-1).close === 8, "a live tick appends a new compare bar");
  const lengthBefore = entry().bars.length;
  liveSub.onTick({ time: lastTime - 60_000 * 5, open: 1, high: 1, low: 1, close: 9 });
  liveSub.onTick({ time: Number.NaN, open: 1, high: 1, low: 1, close: 9 });
  assert(entry().bars.length === lengthBefore, "stale and malformed live ticks are ignored");

  // Resolution change: refetch at the new resolution, never draw 1m bars on a 5m axis.
  let staleDrawn = false;
  context.dataChanged.subscribe(null, () => {
    const item = entry();
    if (item && item.bars.length > 1 && stepOf(item.bars) !== STEP_SEC[context.resolution]) staleDrawn = true;
  });
  await data.changeResolution("5");
  await spinUntil(() => entry()?.resolution === "5" && entry().bars.length > 0, "the compare reload at 5");
  assert(!staleDrawn, "compare bars of the old resolution are never left on the new axis");
  const reloadCall = feed.callsFor("BBB").at(-1);
  assert(reloadCall.resolution === "5" && reloadCall.firstDataRequest === true, "setResolution(\"5\") refetches the compare at 5");
  assert(stepOf(entry().bars) === 300 && stepOf(context.bars) === 300, "after setResolution(\"5\") the compare step is 300 s like the main step");
  assert(!feed.subscriptions.has(liveSub.guid) && feed.unsubscribed.includes(liveSub.guid), "the old-resolution compare subscription is unsubscribed");
  const [liveSub5] = feed.subscriptionFor("BBB");
  assert(liveSub5?.resolution === "5" && liveSub5.guid !== liveSub.guid, "the compare resubscribes at the new resolution with a new GUID");
  liveSub.onTick({ time: entry().bars.at(-1).time + 60_000, open: 1, high: 1, low: 1, close: 1 });
  assert(entry().bars.every((b) => (b.time / 1000) % 300 === 0), "ticks from the unsubscribed GUID are ignored");
  liveSub5.onTick({ time: entry().bars.at(-1).time + 300_000, open: 1, high: 1, low: 1, close: 11 });
  assert(entry().bars.at(-1).close === 11, "live compare ticks arrive at the new resolution");

  // Left pagination: the compare pages over the same range as the main series.
  const coveredBefore = entry().bars[0].time;
  context.setViewport({ from: 0, to: 60 }, "pan");
  const callsBeforePage = feed.callsFor("BBB").length;
  await data.maybeLoadMoreHistory();
  assert(context.bars[0].time < coveredBefore, "the main series paged older history");
  await spinUntil(() => entry().bars[0].time === context.bars[0].time, "the compare page");
  const pageCall = feed.callsFor("BBB")[callsBeforePage];
  assert(
    pageCall?.firstDataRequest === false
      && pageCall.from === Math.floor(context.bars[0].time / 1000)
      && pageCall.to === Math.floor(coveredBefore / 1000),
    "the compare page requests exactly the range the main series added",
  );
  assert(feed.callsFor("BBB").length === callsBeforePage + 1, "one main page triggers one compare page");
  assert(stepOf(entry().bars) === 300 && new Set(entry().bars.map((b) => b.time)).size === entry().bars.length, "paged compare bars merge without duplicates");
  context.dataChanged.fire();
  await settle();
  assert(feed.callsFor("BBB").length === callsBeforePage + 1, "an unchanged main window does not refetch the compare");

  // History reaching the start: revealTimeRange pages without dataChanged.
  await data.revealTimeRange(DATA_START - 3600, Math.floor(context.bars.at(-1).time / 1000));
  await spinUntil(() => entry().bars[0].time === context.bars[0].time, "the compare to follow revealTimeRange");
  assert(Math.floor(entry().bars[0].time / 1000) <= DATA_START + 300, "compare history follows revealTimeRange back to the data start");

  // Symbol change: refetch at the same resolution.
  const callsBeforeSymbol = feed.callsFor("BBB").length;
  await data.changeSymbol("CCCC");
  await spinUntil(() => feed.callsFor("BBB").length > callsBeforeSymbol && feed.subscriptionFor("BBB").length === 1, "the compare reload after setSymbol");
  assert(feed.callsFor("BBB").at(-1).resolution === "5" && stepOf(entry().bars) === 300, "setSymbol refetches the compare at the main resolution");
  await data.changeSymbol("AAA", "15");
  await spinUntil(() => entry()?.resolution === "15" && entry().bars.length > 0, "the compare reload at 15");
  assert(stepOf(entry().bars) === 900 && stepOf(context.bars) === 900, "setSymbol with a new interval refetches the compare at that interval");

  // The compare's own reset-cache callback reloads it.
  const callsBeforeReset = feed.callsFor("BBB").length;
  feed.subscriptionFor("BBB")[0].onReset();
  await spinUntil(() => feed.callsFor("BBB").length > callsBeforeReset && feed.subscriptionFor("BBB").length === 1, "the compare reset reload");
  assert(feed.callsFor("BBB").at(-1).firstDataRequest === true, "onResetCacheNeeded refetches the compare");
  const callsBeforeApiReset = feed.callsFor("BBB").length;
  compare.reload();
  await spinUntil(() => feed.callsFor("BBB").length > callsBeforeApiReset && feed.subscriptionFor("BBB").length === 1, "the resetData reload");
  assert(feed.subscriptionFor("BBB").length === 1, "a reset keeps exactly one live compare subscription");

  // A failed reload is reported once and retried only on the next target change or reset.
  feed.failingHistory.set("BBB@5", "rate limited");
  const callsAt5 = () => feed.callsFor("BBB").filter((call) => call.resolution === "5").length;
  const callsAt5Before = callsAt5();
  const errors = await captureErrors(async () => {
    await data.changeResolution("5");
    await spinUntil(() => feed.callsFor("BBB").at(-1).resolution === "5", "the failing compare reload");
    await settle();
    for (let i = 0; i < 3; i += 1) context.dataChanged.fire();
    await settle();
  });
  assert(errors.length === 1 && /reload compare "BBB" at 5/.test(errors[0]) && /rate limited/.test(errors[0]), "a failed compare reload is reported with the symbol, resolution and reason");
  assert(entry().bars.length === 0 && entry().resolution === "5", "a failed reload shows no bars of the old resolution");
  assert(callsAt5() === callsAt5Before + 1, "later main updates do not hammer a failing compare");
  feed.failingHistory.delete("BBB@5");
  compare.reload();
  await spinUntil(() => entry().bars.length > 0 && feed.subscriptionFor("BBB").length === 1, "the retried reload");
  assert(stepOf(entry().bars) === 300, "resetData retries a failed compare reload");

  // Removal unsubscribes and restores the scale mode the compare replaced.
  const beforeRemove = feed.subscriptionFor("BBB")[0];
  assert(compare.remove(id) && context.compare.length === 0, "remove() drops the compare series");
  assert(!feed.subscriptions.has(beforeRemove.guid) && feed.unsubscribed.at(-1) === beforeRemove.guid, "remove() unsubscribes the compare's live bars");
  beforeRemove.onTick({ time: Date.now(), open: 1, high: 1, low: 1, close: 1 });
  assert(context.compare.length === 0, "late ticks after removal are ignored");
  assert(context.scaleState().mode === "normal", "removing the last compare restores the previous scale mode");
  assert(!compare.remove(id), "removing an unknown compare id reports false");

  // A user's scale choice survives removal.
  const second = await compare.create("BBB");
  const third = await compare.create("DDDD");
  assert(context.scaleState().mode === "percent" && context.compare[0].color !== context.compare[1].color, "compares get distinct colours");
  context.setScaleMode({ mode: "log" }, "scale-bar");
  compare.remove(second);
  const colorAfterRemove = (await compare.create("EEEEE")) && context.compare.at(-1).color;
  assert(colorAfterRemove !== context.compare[0].color, "a new compare never repeats a colour still on screen");
  compare.remove(third);
  compare.remove(context.compare[0].id);
  assert(context.scaleState().mode === "log", "a scale mode the user picked after the compare is kept when compares are removed");

  // A compare created while the main series is changing catches up.
  context.setScaleMode({ mode: "normal" }, "api");
  const pendingCompare = compare.create("BBB");
  const switching = data.changeResolution("1");
  const lateId = await pendingCompare;
  await switching;
  await spinUntil(() => context.compare.find((item) => item.id === lateId)?.resolution === "1" && feed.subscriptionFor("BBB").length === 1, "the late compare to catch up");
  assert(stepOf(context.compare.find((item) => item.id === lateId).bars) === 60, "a compare loaded during a resolution change follows the new resolution");

  // Layout restore: prepare() fetches, restore() replaces and unsubscribes the old series.
  const prepared = await compare.prepare("FFFFFF");
  assert(prepared && prepared.symbol === "FFFFFF" && feed.subscriptionFor("FFFFFF").length === 0, "prepare() loads without showing or subscribing");
  const oldGuid = feed.subscriptionFor("BBB")[0].guid;
  compare.restore([prepared]);
  assert(context.compare.length === 1 && context.compare[0].symbol === "FFFFFF", "restore() replaces the compare set");
  assert(feed.unsubscribed.includes(oldGuid) && feed.subscriptionFor("FFFFFF").length === 1, "restore() unsubscribes replaced compares and subscribes restored ones");
  const unknownPrepare = await rejection(compare.prepare("NOPE"));
  assert(/could not be resolved/.test(unknownPrepare?.message ?? ""), "prepare() rejects an unresolvable symbol");

  // A direct write that drops an entry still stops its subscription.
  const directGuid = feed.subscriptionFor("FFFFFF")[0].guid;
  context.compare = [];
  context.dataChanged.fire();
  assert(feed.unsubscribed.includes(directGuid), "an entry removed by a direct write is unsubscribed on the next sync");

  // Teardown: pending creates reject and every subscription is released.
  await compare.create("GGG");
  feed.hanging.add("HANG");
  const pending = compare.create("HANG");
  compare.destroy();
  const removed = await rejection(pending);
  assert(/removed before compare data loaded/.test(removed?.message ?? ""), "a pending createCompare rejects when the widget is removed");
  assert(feed.subscriptionFor("GGG").length === 0, "destroy() unsubscribes every compare");
  const gone = await rejection(compare.create("BBB"));
  assert(/removed before compare data loaded/.test(gone?.message ?? ""), "createCompare after teardown rejects");
  data.destroy();
}

{
  // A compare created before the main series loads covers it once it does.
  const feed = makeFeed();
  const { context, data, compare } = makeHost(feed);
  const early = compare.create("BBB");
  const loading = data.resolveAndLoad();
  const id = await early;
  await loading;
  const entry = () => context.compare.find((item) => item.id === id);
  await spinUntil(() => entry().bars[0]?.time <= context.bars[0].time, "the early compare to cover the main window");
  assert(stepOf(entry().bars) === 60, "an early compare aligns with the main series once it loads");
  compare.destroy();
  data.destroy();
}

{
  // A failed reload leaves the compare on the failed target, so moving the
  // main series anywhere else, back to the compare's previous target included,
  // refetches it instead of leaving the line empty and unsubscribed.
  const feed = makeFeed();
  const { context, data, compare } = makeHost(feed);
  await data.resolveAndLoad();
  const id = await compare.create("BBB");
  const entry = () => context.compare.find((item) => item.id === id);
  feed.failingHistory.set("BBB@5", "rate limited");
  const errors = await captureErrors(async () => {
    await data.changeResolution("5");
    await spinUntil(() => feed.callsFor("BBB").at(-1).resolution === "5", "the failing compare reload at 5");
    await settle();
  });
  assert(
    errors.length === 1 && entry().bars.length === 0 && entry().resolution === "5" && feed.subscriptionFor("BBB").length === 0,
    "a reload failing at 5 leaves the compare empty at 5 with no live subscription",
  );
  feed.failingHistory.delete("BBB@5");
  const callsBeforeBack = feed.callsFor("BBB").length;
  await data.changeResolution("1");
  await spinUntil(() => entry().bars.length > 0 && feed.subscriptionFor("BBB").length === 1, "the compare to recover at 1");
  assert(
    feed.callsFor("BBB").length === callsBeforeBack + 1 && feed.callsFor("BBB").at(-1).resolution === "1",
    "returning the main series to the compare's previous resolution refetches it once",
  );
  const [recovered] = feed.subscriptionFor("BBB");
  assert(
    stepOf(entry().bars) === 60 && entry().resolution === "1" && recovered.resolution === "1",
    "the recovered compare has 1-minute bars, the chart's resolution and one live subscription at 1",
  );
  recovered.onTick({ time: entry().bars.at(-1).time + 60_000, open: 1, high: 1, low: 1, close: 4 });
  assert(entry().bars.at(-1).close === 4, "live ticks reach the recovered compare");

  // A reload failing on a symbol-only change keeps the compare's bars (still
  // valid at this resolution) live, parks it, and recovers on the next move.
  feed.failingHistory.set("BBB@1", "rate limited");
  const barsBefore = entry().bars.map((bar) => bar.time).join();
  const callsBeforeSymbol = feed.callsFor("BBB").length;
  const symbolErrors = await captureErrors(async () => {
    await data.changeSymbol("CCCC");
    await spinUntil(() => feed.callsFor("BBB").length > callsBeforeSymbol, "the failing compare reload after setSymbol");
    await settle();
  });
  assert(
    symbolErrors.length === 1 && /reload compare "BBB" at 1/.test(symbolErrors[0]),
    "a reload failing after setSymbol is reported once",
  );
  assert(entry().bars.map((bar) => bar.time).join() === barsBefore && entry().resolution === "1", "a reload failing after setSymbol keeps the compare's bars at the unchanged resolution");
  const [kept] = feed.subscriptionFor("BBB");
  assert(feed.subscriptionFor("BBB").length === 1 && kept.guid !== recovered.guid && kept.resolution === "1", "the kept compare stays subscribed to live bars");
  kept.onTick({ time: entry().bars.at(-1).time + 60_000, open: 1, high: 1, low: 1, close: 6 });
  assert(entry().bars.at(-1).close === 6, "live ticks reach a compare whose reload failed");
  const callsParked = feed.callsFor("BBB").length;
  context.setViewport({ from: 0, to: 60 }, "pan");
  await data.maybeLoadMoreHistory();
  for (let i = 0; i < 3; i += 1) context.dataChanged.fire();
  await settle();
  assert(feed.callsFor("BBB").length === callsParked, "a compare whose reload failed is neither reloaded nor paged by later main updates");
  feed.failingHistory.delete("BBB@1");
  await data.changeSymbol("AAA");
  await spinUntil(
    () => feed.callsFor("BBB").length > callsParked && feed.subscriptionFor("BBB").length === 1 && !feed.subscriptions.has(kept.guid),
    "the compare to recover after returning to the previous symbol",
  );
  assert(
    feed.callsFor("BBB").at(-1).firstDataRequest === true && entry().bars[0].time <= context.bars[0].time && stepOf(entry().bars) === 60,
    "returning the main series to the compare's previous symbol refetches it over the main window",
  );
  compare.destroy();
  data.destroy();
}

{
  // Removing the last compare restores the manual price range the percent
  // switch cleared, unless the scale or the main target changed meanwhile.
  const feed = makeFeed();
  const { context, data, compare } = makeHost(feed);
  await data.resolveAndLoad();
  const range = (state) => (state.priceRange ? `${state.priceRange.min}..${state.priceRange.max}` : "auto");
  context.setScaleMode({ priceRange: { min: 100, max: 200 } }, "axis-drag");
  const first = await compare.create("BBB");
  assert(context.scaleState().mode === "percent" && context.scaleState().autoScale === true, "the first compare switches to percent with autoscale");
  compare.remove(first);
  const restored = context.scaleState();
  assert(
    restored.mode === "normal" && restored.autoScale === false && range(restored) === "100..200",
    "removing the last compare restores the mode and the manual price range it cleared",
  );

  const second = await compare.create("BBB");
  context.setScaleMode({ priceRange: { min: 120, max: 180 } }, "axis-drag");
  compare.remove(second);
  const kept = context.scaleState();
  assert(kept.mode === "normal" && kept.autoScale === false && range(kept) === "120..180", "a range the user set while comparing is kept when the last compare goes");

  const third = await compare.create("BBB");
  context.setScaleMode({ priceRange: { min: 130, max: 170 } }, "axis-drag");
  context.setScaleMode({ autoScale: true }, "axis-reset");
  compare.remove(third);
  assert(context.scaleState().mode === "normal" && range(context.scaleState()) === "auto", "an autoscale the user chose while comparing is kept");

  context.setScaleMode({ priceRange: { min: 100, max: 200 } }, "axis-drag");
  const fourth = await compare.create("BBB");
  await data.changeResolution("5");
  await spinUntil(() => context.compare[0]?.resolution === "5" && context.compare[0].bars.length > 0, "the compare reload at 5");
  compare.remove(fourth);
  const refit = context.scaleState();
  assert(refit.mode === "normal" && refit.autoScale === true && refit.priceRange === null, "after an interval change the old manual range is not restored");
  compare.destroy();
  data.destroy();
}

// ── Part B: the built widget, end to end ───────────────────────────────────
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

const { widget } = await import("../dist/charting_library.esm.js");

{
  const feed = makeFeed();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const instance = new widget({
    symbol: "AAA",
    interval: "1",
    container: host,
    datafeed: feed,
    disabled_features: ["header_widget", "left_toolbar", "scale_bar"],
  });
  await instance.headerReady();
  const api = instance.activeChart();

  const unknown = await rejection(api.createCompare("NOPE"));
  assert(/compare symbol "NOPE" could not be resolved: unknown symbol/.test(unknown?.message ?? ""), "widget createCompare(\"NOPE\") rejects");
  assert(instance.save().compare.length === 0 && instance.save().percentScale === false, "a rejected compare adds nothing to the widget");

  const id = await api.createCompare("BBB");
  assert(String(id) === "compare_BBB_1" && instance.save().compare.join() === "BBB", "widget createCompare adds the series");
  assert(instance.save().percentScale === true, "the widget switches to percent on the first compare");

  await new Promise((resolveChange) => api.setResolution("5", resolveChange));
  await spinUntil(() => feed.subscriptionFor("BBB")[0]?.resolution === "5", "the widget compare to follow setResolution");
  assert(feed.callsFor("BBB").at(-1).resolution === "5", "widget setResolution(\"5\") refetches the compare at 5");

  const callsBeforeReset = feed.callsFor("BBB").length;
  api.resetData();
  await spinUntil(() => feed.callsFor("BBB").length > callsBeforeReset && feed.subscriptionFor("BBB").length === 1, "the widget compare reset");
  assert(feed.callsFor("BBB").at(-1).firstDataRequest === true, "resetData() refetches compare series too");

  const guid = feed.subscriptionFor("BBB")[0].guid;
  api.removeEntity(id);
  assert(feed.unsubscribed.includes(guid) && instance.save().compare.length === 0, "removeEntity unsubscribes the compare");
  assert(instance.save().percentScale === false, "removing the last compare restores the price scale");

  // Layout restore brings compares back live; an unresolvable one rejects the load.
  const snapshot = { ...instance.save(), compare: ["BBB"] };
  await instance.load(snapshot);
  assert(instance.save().compare.join() === "BBB" && feed.subscriptionFor("BBB").length === 1, "layout load restores a live compare");
  const badLoad = await rejection(instance.load({ ...snapshot, compare: ["NOPE"] }));
  assert(/compare symbol "NOPE" could not be resolved/.test(badLoad?.message ?? ""), "a layout with an unresolvable compare rejects");
  assert(instance.save().compare.join() === "BBB", "a rejected layout load keeps the committed compares");

  const liveGuid = feed.subscriptionFor("BBB")[0].guid;
  instance.remove();
  assert(feed.unsubscribed.includes(liveGuid) && feed.subscriptionFor("BBB").length === 0, "widget remove() unsubscribes every compare");
}

console.log("compare lifecycle regressions passed");
