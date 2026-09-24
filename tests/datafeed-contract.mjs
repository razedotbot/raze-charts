// Datafeed contract (W1B-18): nextTime gaps, pagination backoff, bar
// validation and coercion, server time, supports_* gating, the TradingView
// interval payload, strict resolutions, calendar floorToBar, the width-aware
// opening view and reason-tagged range writes.
// Run after the build: node build.mjs && node tests/datafeed-contract.mjs

import { JSDOM } from "jsdom";
import {
  DataManager,
  Delegate,
  createChartContext,
  floorToBar,
  isValidResolution,
  normalizeResolution,
  parseResolution,
  resolutionLabel,
  resolutionToMs,
  widget,
} from "../dist/charting_library.esm.js";

const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
};

const settle = async (turns = 40) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};
const waitFor = async (predicate, message, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

/** Capture console output of one kind while `run` executes. */
async function capture(kind, run) {
  const original = console[kind];
  const messages = [];
  console[kind] = (...args) => messages.push(args.map(String).join(" "));
  try {
    await run(messages);
  } finally {
    console[kind] = original;
  }
  return messages;
}

const MIN = 60_000;
const BASE = Date.UTC(2024, 5, 3, 12, 0, 0);
const bar = (time, close = 100) => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 10 });
const series = (count, end = BASE, step = MIN) =>
  Array.from({ length: count }, (_, i) => bar(end - (count - 1 - i) * step, 100 + i));

const symbolInfo = (name, extra = {}) => ({
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
  supported_resolutions: ["1", "5"],
  ...extra,
});

/**
 * A datafeed whose history is answered by `history(params, callIndex, onResult,
 * onError)`. Optional methods are added only when their option is given.
 */
function makeFeed({
  config = {},
  history,
  info = {},
  marks,
  timescaleMarks,
  serverTime,
} = {}) {
  const calls = { getBars: [], getMarks: 0, getTimescaleMarks: 0, getServerTime: 0, ticks: [] };
  const feed = {
    onReady(callback) {
      queueMicrotask(() => callback({ supported_resolutions: ["1", "5"], ...config }));
    },
    searchSymbols(_input, _exchange, _type, callback) { callback([]); },
    resolveSymbol(name, onResolve) { queueMicrotask(() => onResolve(symbolInfo(name, info))); },
    getBars(_info, resolution, params, onResult, onError) {
      const index = calls.getBars.length;
      calls.getBars.push({ resolution, params: { ...params } });
      history(params, index, onResult, onError);
    },
    subscribeBars(_info, _resolution, onTick) { calls.ticks.push(onTick); },
    unsubscribeBars() {},
  };
  if (marks !== undefined) {
    feed.getMarks = (_info, _from, _to, onData) => {
      calls.getMarks += 1;
      queueMicrotask(() => onData(marks));
    };
  }
  if (timescaleMarks !== undefined) {
    feed.getTimescaleMarks = (_info, _from, _to, onData) => {
      calls.getTimescaleMarks += 1;
      queueMicrotask(() => onData(timescaleMarks));
    };
  }
  if (serverTime !== undefined) {
    feed.getServerTime = (callback) => {
      calls.getServerTime += 1;
      serverTime(callback);
    };
  }
  return { feed, calls };
}

function makeContext(datafeed, { symbol = "A", resolution = "1", clock, options = {}, hooks = {} } = {}) {
  return createChartContext({
    options: { symbol, interval: resolution, container: /** @type {any} */ ({}), datafeed, ...options },
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
    ...hooks,
  }, clock ? { clock } : {});
}

async function boot(feedSetup, contextOptions) {
  const { feed, calls } = makeFeed(feedSetup);
  const context = makeContext(feed, contextOptions);
  const manager = new DataManager(context);
  await manager.resolveAndLoad();
  await settle();
  return { feed, calls, context, manager };
}

// ── Strict resolutions ──────────────────────────────────────────────────────
{
  const forms = [
    ["1S", "1S", 1_000, "seconds"],
    ["30S", "30S", 30_000, "seconds"],
    ["1", "1", MIN, "minutes"],
    ["15", "15", 15 * MIN, "minutes"],
    ["60", "60", 60 * MIN, "hours"],
    ["240", "240", 240 * MIN, "hours"],
    ["D", "1D", 86_400_000, "days"],
    ["1D", "1D", 86_400_000, "days"],
    ["2D", "2D", 2 * 86_400_000, "days"],
    ["W", "1W", 7 * 86_400_000, "weeks"],
    ["1W", "1W", 7 * 86_400_000, "weeks"],
    ["M", "1M", 30 * 86_400_000, "months"],
    ["1M", "1M", 30 * 86_400_000, "months"],
    ["3M", "3M", 90 * 86_400_000, "months"],
    ["12M", "12M", 360 * 86_400_000, "months"],
    ["1d", "1D", 86_400_000, "days"],
    [" 5 ", "5", 5 * MIN, "minutes"],
  ];
  for (const [input, canonical, ms, kind] of forms) {
    const parsed = parseResolution(input);
    if (normalizeResolution(input) !== canonical || parsed.ms !== ms || parsed.kind !== kind) {
      throw new Error(`resolution ${JSON.stringify(input)} parsed as ${normalizeResolution(input)} ${JSON.stringify(parsed)}`);
    }
  }
  assert(true, "every TradingView resolution form parses to its canonical spelling, duration and kind");
  assert(resolutionLabel("W") === "1W" && resolutionLabel("D") === "1D" && resolutionLabel("M") === "1M", "bare D/W/M label as 1D/1W/1M");
  assert(resolutionToMs("D") === 86_400_000, "bare D is one day, not one minute");

  const invalid = ["4h", "1H", "1T", "100T", "", "abc", "0", "1m", "S", "1.5", "-1", "1Y", "5 m"];
  for (const input of invalid) {
    let error = null;
    try {
      parseResolution(input);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof RangeError) || !error.message.includes(JSON.stringify(input)) || !error.message.includes("Accepted forms")) {
      throw new Error(`expected a RangeError naming ${JSON.stringify(input)} and the accepted forms, got ${error}`);
    }
    if (isValidResolution(input)) throw new Error(`isValidResolution accepted ${JSON.stringify(input)}`);
  }
  assert(true, "invalid resolutions throw a RangeError naming the value and listing the accepted forms");
  let hint = "";
  try { resolutionToMs("4h"); } catch (error) { hint = error.message; }
  assert(hint.includes('"240"') && hint.includes('"<n>D" or "D"'), '"4h" suggests "240" and lists every form');
  try { parseResolution("1m"); } catch (error) { hint = error.message; }
  assert(hint.includes("ambiguous"), 'lower-case "1m" is rejected as ambiguous');
  try { parseResolution("100T"); } catch (error) { hint = error.message; }
  assert(hint.includes("Tick resolutions are not supported"), "tick resolutions are rejected explicitly");
}

// ── Calendar floorToBar ─────────────────────────────────────────────────────
{
  const monday = floorToBar(Date.UTC(2024, 0, 10, 15, 30), "1W");
  assert(monday === Date.UTC(2024, 0, 8) && new Date(monday).getUTCDay() === 1, "floorToBar(1W) gives Monday 00:00");
  assert(floorToBar(Date.UTC(2024, 0, 10, 15), "W", { weekStart: 0 }) === Date.UTC(2024, 0, 7), "the week start is configurable");
  assert(floorToBar(Date.UTC(2024, 2, 15, 9), "1M") === Date.UTC(2024, 2, 1), "floorToBar(1M) gives the calendar month start");
  assert(floorToBar(Date.UTC(2024, 4, 20), "3M") === Date.UTC(2024, 3, 1), "floorToBar(3M) gives the quarter start");
  assert(floorToBar(Date.UTC(2024, 10, 20), "12M") === Date.UTC(2024, 0, 1), "floorToBar(12M) gives the year start");
  assert(floorToBar(Date.UTC(2024, 0, 10, 15, 30), "D") === Date.UTC(2024, 0, 10), "floorToBar(D) gives midnight");
  const t = Date.UTC(2024, 0, 10, 15, 47, 13);
  assert(floorToBar(t, "15") === Math.floor(t / (15 * MIN)) * 15 * MIN, "intraday floors stay epoch-aligned in UTC");

  const ny = { timezone: "America/New_York" };
  // Spring forward: 2024-03-10 02:00 EST -> 03:00 EDT.
  assert(floorToBar(Date.UTC(2024, 2, 10, 15), "1D", ny) === Date.UTC(2024, 2, 10, 5), "1D floors to EST midnight on the DST-start day");
  assert(floorToBar(Date.UTC(2024, 2, 11, 15), "1D", ny) === Date.UTC(2024, 2, 11, 4), "1D floors to EDT midnight after DST starts");
  assert(floorToBar(Date.UTC(2024, 2, 13, 15), "1W", ny) === Date.UTC(2024, 2, 11, 4), "1W floors to local Monday across DST");
  assert(floorToBar(Date.UTC(2024, 2, 10, 7, 30), "240", ny) === Date.UTC(2024, 2, 10, 5), "a 4h bar spanning the DST gap starts at local midnight");
  assert(floorToBar(Date.UTC(2024, 10, 15, 12), "1M", ny) === Date.UTC(2024, 10, 1, 4), "1M floors to the local month start");
  // Fall back: 01:00-02:00 local happens twice on 2024-11-03.
  assert(floorToBar(Date.UTC(2024, 10, 3, 5, 30), "60", ny) === Date.UTC(2024, 10, 3, 5), "the first 01:00 hour (EDT) floors to its own start");
  assert(floorToBar(Date.UTC(2024, 10, 3, 6, 30), "60", ny) === Date.UTC(2024, 10, 3, 6), "the repeated 01:00 hour (EST) floors to its own start");
  assert(
    floorToBar(Date.UTC(2024, 9, 27, 12), "1D", { timezone: "Europe/London" }) === Date.UTC(2024, 9, 26, 23),
    "1D floors to BST midnight on the day London falls back",
  );
  // Atlantic/Azores falls back at midnight on 2024-10-27 (01:00 UTC+0 -> 00:00 UTC-1),
  // so local 00:00-01:00 happens twice. Calendar bars start at the first one.
  const azores = { timezone: "Atlantic/Azores" };
  const azoresDay = Date.UTC(2024, 9, 27);
  for (const hour of [0.5, 1.5, 3]) {
    const t = azoresDay + hour * 3_600_000;
    if (floorToBar(t, "1D", azores) !== azoresDay || floorToBar(t, "1W", { ...azores, weekStart: 0 }) !== azoresDay) {
      throw new Error(`Azores ${new Date(t).toISOString()} floored to ${new Date(floorToBar(t, "1D", azores)).toISOString()}`);
    }
  }
  assert(true, "1D and 1W keep one bar per local day where midnight repeats (Azores fall-back)");
  // 2023-10-29 (epoch day 19659 = 3 x 6553) starts a 3D bar and repeats its midnight too.
  const azores2023 = Date.UTC(2023, 9, 29);
  assert(
    floorToBar(azores2023 + 0.5 * 3_600_000, "3D", azores) === azores2023 && floorToBar(azores2023 + 1.5 * 3_600_000, "3D", azores) === azores2023,
    "multi-day bars do not split at a repeated midnight",
  );
  assert(
    floorToBar(azoresDay + 0.5 * 3_600_000, "60", azores) === azoresDay
      && floorToBar(azoresDay + 1.5 * 3_600_000, "60", azores) === azoresDay + 3_600_000,
    "hourly bars still give the repeated midnight hour its own bar",
  );
}

// ── nextTime gaps ───────────────────────────────────────────────────────────
{
  const gapNext = Math.floor((BASE - 10 * 86_400_000) / 1000);
  const { calls, context, manager } = await boot({
    history(params, index, onResult) {
      if (index === 0) queueMicrotask(() => onResult([], { noData: true, nextTime: gapNext }));
      else queueMicrotask(() => onResult(series(20, gapNext * 1000), { noData: false }));
    },
  });
  assert(calls.getBars.length === 2 && calls.getBars[1].params.to === gapNext, "an empty page with nextTime is re-requested with to === nextTime");
  assert(calls.getBars[1].params.firstDataRequest === false, "the gap follow-up is not a first data request");
  assert(context.bars.length === 20, "a gap feed ends the initial load with bars instead of an empty state");
  manager.destroy();
}
{
  const gapMs = BASE - 3 * 86_400_000;
  const { calls, manager } = await boot({
    history(_params, index, onResult) {
      if (index === 0) queueMicrotask(() => onResult([], { nextTime: gapMs }));
      else queueMicrotask(() => onResult(series(5, gapMs)));
    },
  });
  assert(calls.getBars[1].params.to === Math.floor(gapMs / 1000), "a millisecond nextTime is converted to seconds");
  manager.destroy();
}
{
  // Pagination: the page before the loaded bars is a gap.
  const loaded = series(30);
  const olderEnd = loaded[0].time - 7 * 86_400_000;
  const { calls, context, manager } = await boot({
    history(_params, index, onResult) {
      if (index === 0) queueMicrotask(() => onResult(loaded));
      else if (index === 1) queueMicrotask(() => onResult([], { noData: true, nextTime: Math.floor(olderEnd / 1000) }));
      else queueMicrotask(() => onResult(series(10, olderEnd)));
    },
  });
  await manager.maybeLoadMoreHistory();
  assert(
    calls.getBars.length === 3 && calls.getBars[2].params.to === Math.floor(olderEnd / 1000),
    "pagination follows a gap with to === nextTime in the same request",
  );
  assert(context.bars.length === 40 && context.bars[0].time === olderEnd - 9 * MIN, "bars from beyond the gap are merged");
  manager.destroy();
}
{
  // An endless chain of gaps is bounded, and the stop is reported.
  let next = Math.floor(BASE / 1000);
  const warnings = await capture("warn", async () => {
    const { calls, context, manager } = await boot({
      history(_params, _index, onResult) {
        next -= 86_400;
        queueMicrotask(() => onResult([], { noData: true, nextTime: next }));
      },
    });
    assert(calls.getBars.length === 6 && context.bars.length === 0, "gap retries are bounded (1 request + 5 gap hops)");
    manager.destroy();
  });
  assert(
    warnings.length === 1 && warnings[0].includes("6 empty pages in a row") && warnings[0].includes(`stopped at nextTime ${next}`),
    "running out of gap hops warns once with the nextTime it stopped at",
  );
}
{
  const warnings = await capture("warn", async () => {
    const { calls, context, manager } = await boot({
      history(params, _index, onResult) {
        queueMicrotask(() => onResult([], { noData: true, nextTime: params.to + 60 }));
      },
    });
    assert(calls.getBars.length === 1 && context.bars.length === 0, "a nextTime that is not older than `to` cannot loop");
    manager.destroy();
  });
  assert(warnings.length === 1 && warnings[0].includes("nextTime"), "a forward nextTime is reported once");
}

// ── Pagination backoff ──────────────────────────────────────────────────────
{
  let now = BASE;
  let failing = true;
  const { feed, calls } = makeFeed({
    history(_params, index, onResult, onError) {
      if (index === 0) queueMicrotask(() => onResult(series(3)));
      else if (failing) setTimeout(() => onError("rate limited"), 0);
      else queueMicrotask(() => onResult(series(3, BASE - 10 * MIN)));
    },
  });
  const context = makeContext(feed, { clock: () => now });
  const manager = new DataManager(context);
  await manager.resolveAndLoad();

  const errors = await capture("error", async () => {
    // Ten seconds of continuous left-edge dragging: one pan event every 16 ms.
    for (let elapsed = 0; elapsed < 10_000; elapsed += 16) {
      now += 16;
      await manager.maybeLoadMoreHistory();
    }
  });
  const attempts = calls.getBars.length - 1;
  assert(attempts >= 3 && attempts <= 5, `a failing feed is called at most 5 times in 10 s of dragging (got ${attempts})`);
  assert(errors.length === attempts && errors.every((line) => line.includes("retrying")), "console.error fires once per backoff window");

  failing = false;
  now += 60_000;
  await manager.maybeLoadMoreHistory();
  assert(context.bars.length === 6, "a later successful page is merged");
  failing = true;
  now += 1;
  await capture("error", async () => {
    await manager.maybeLoadMoreHistory();
    const afterReset = calls.getBars.length;
    now += 1_300;
    await manager.maybeLoadMoreHistory();
    assert(calls.getBars.length === afterReset + 1, "a successful response resets the backoff to the base delay");
  });
  manager.destroy();
}
{
  // onError() with no reason is still a failure, not a cancellation.
  let now = BASE;
  const { feed, calls } = makeFeed({
    history(_params, index, onResult, onError) {
      if (index === 0) queueMicrotask(() => onResult(series(3)));
      else queueMicrotask(() => onError());
    },
  });
  const manager = new DataManager(makeContext(feed, { clock: () => now }));
  await manager.resolveAndLoad();
  const errors = await capture("error", async () => {
    for (let elapsed = 0; elapsed < 10_000; elapsed += 16) {
      now += 16;
      await manager.maybeLoadMoreHistory();
    }
  });
  const attempts = calls.getBars.length - 1;
  assert(attempts >= 3 && attempts <= 5, `a feed calling onError() without a reason backs off too (got ${attempts} calls in 10 s)`);
  assert(
    errors.length === attempts && errors.every((line) => line.includes("retrying") && line.includes("the datafeed gave no reason")),
    "each reasonless failure logs one error per backoff window, saying no reason was given",
  );
  manager.destroy();
}
{
  let rejected = null;
  const { manager } = await boot({ history: (_p, _i, _onResult, onError) => queueMicrotask(() => onError()) })
    .catch((error) => {
      rejected = error;
      return { manager: null };
    });
  assert(
    manager === null && rejected?.message.includes("getBars failed") && rejected.message.includes("the datafeed gave no reason"),
    "an initial load failing through onError() without a reason rejects instead of ending in a silent empty state",
  );
  const { feed } = makeFeed({ history: (_p, _i, onResult) => queueMicrotask(() => onResult(series(3))) });
  feed.resolveSymbol = (_name, _onResolve, onError) => queueMicrotask(() => onError());
  let symbolError = null;
  const symbolManager = new DataManager(makeContext(feed));
  await symbolManager.resolveAndLoad().catch((error) => { symbolError = error; });
  symbolManager.destroy();
  assert(symbolError?.message.includes("resolveSymbol failed"), "resolveSymbol's onError() without a reason rejects too");
}

// ── Bar validation and coercion ─────────────────────────────────────────────
async function loadFixture(bars, options = {}) {
  let result;
  const warnings = await capture("warn", async () => {
    result = await boot({ history: (_p, _i, onResult) => queueMicrotask(() => onResult(bars)) }, { options });
  });
  result.manager.destroy();
  return { ...result, warnings };
}
{
  const good = series(4);
  const fixture = [good[0], { ...good[1], high: Number.NaN }, { ...good[2], close: undefined }, good[3]];
  const { context, warnings } = await loadFixture(fixture);
  assert(context.bars.length === 2, "history bars with NaN or missing OHLC are dropped");
  assert(
    warnings.length === 1 && warnings[0].includes("bar 1") && warnings[0].includes("Bar.high") && warnings[0].includes("dropped 2 bars"),
    "one aggregated warning names the field, the first bad index and the count",
  );
}
{
  const seconds = series(5).map((b) => ({ ...b, time: b.time / 1000 }));
  const { context, warnings } = await loadFixture(seconds);
  assert(
    warnings.length === 1 && warnings[0].includes("Bar.time looks like seconds; expected milliseconds") && warnings[0].includes("bar 0"),
    "second-based times are reported once as seconds",
  );
  assert(context.bars.length === 5, "second-based bars are reported, not silently changed");
  const coerced = await loadFixture(seconds, { raze: { coerce_bars: true } });
  assert(coerced.warnings.length === 0 && coerced.context.bars[0].time === series(5)[0].time, "coerce_bars converts seconds to milliseconds");
}
{
  const strings = series(3).map((b) => ({
    time: b.time,
    open: String(b.open),
    high: String(b.high),
    low: String(b.low),
    close: String(b.close),
    volume: String(b.volume),
  }));
  const { context, warnings } = await loadFixture(strings);
  assert(
    warnings.length === 1 && warnings[0].includes("Bar.open") && warnings[0].includes("bar 0") && warnings[0].includes("coerce_bars"),
    "numeric strings produce one warning naming the field, index and the coerce option",
  );
  assert(context.bars.length === 0, "string OHLC is not drawn as empty values");
  let coerced;
  const notes = await capture("debug", async () => {
    coerced = await loadFixture(strings, { raze: { coerce_bars: true } });
  });
  assert(notes.length === 1 && notes[0].includes("converted 3 bars"), "a repair is noted once at debug level with the bar count");
  const first = coerced.context.bars[0];
  assert(
    coerced.warnings.length === 0 && coerced.context.bars.length === 3
      && first.open === 100 && first.high === 101 && first.low === 99 && first.close === 100 && first.volume === 10,
    "coerce_bars turns numeric strings into numbers",
  );
}
{
  const inverted = series(3).map((b, i) => (i === 1 ? { ...b, high: b.low, low: b.high } : b));
  const { context, warnings } = await loadFixture(inverted);
  assert(
    warnings.length === 1 && warnings[0].includes("bar 1") && warnings[0].includes("Bar.low 102 is above Bar.high 100"),
    "an inverted high/low produces one warning with its index",
  );
  assert(context.bars[1].low > context.bars[1].high, "without coercion the inverted bar is kept as delivered");
  const coerced = await loadFixture(inverted, { raze: { coerce_bars: true } });
  assert(coerced.context.bars[1].high === 102 && coerced.context.bars[1].low === 100, "coerce_bars swaps an inverted high/low");
  assert(inverted[1].high === 100, "coercion never mutates the datafeed's objects");
}
{
  const loaded = series(3);
  let tick;
  const warnings = await capture("warn", async () => {
    const booted = await boot({ history: (_p, _i, onResult) => queueMicrotask(() => onResult(loaded)) });
    tick = booted;
    booted.calls.ticks.at(-1)({ time: BASE + MIN, open: 1, high: Number.NaN, low: 1, close: undefined });
    booted.calls.ticks.at(-1)({ time: BASE + 2 * MIN, open: Number.NaN, high: 1, low: 1, close: 1 });
    booted.calls.ticks.at(-1)(bar(BASE - 10 * MIN, 5));
  });
  assert(tick.context.bars.length === 3, "invalid and out-of-order live bars are not appended");
  assert(
    warnings.length === 2 && warnings[0].includes("subscribeBars bar 0") && warnings[0].includes("Bar.high")
      && warnings[1].includes("older than the last bar"),
    "live problems warn once per class",
  );
  const wellFormed = bar(BASE + 3 * MIN, 7);
  tick.calls.ticks.at(-1)(wellFormed);
  assert(tick.context.bars.at(-1) === wellFormed, "a well-formed live bar is appended as delivered, without a copy");
  tick.manager.destroy();
}

// ── Server time ─────────────────────────────────────────────────────────────
{
  const clientNow = Date.UTC(2024, 5, 3, 12, 0, 0, 250);
  const serverSec = Math.floor((clientNow + 5 * MIN) / 1000);
  const intervals = [];
  const cleared = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms });
    return 4242;
  };
  globalThis.clearInterval = (id) => { cleared.push(id); };
  try {
    const { calls, context, manager } = await boot({
      config: { supports_time: true },
      serverTime: (callback) => callback(serverSec),
      history: (_p, _i, onResult) => queueMicrotask(() => onResult(series(3))),
    }, { clock: () => clientNow });
    assert(calls.getServerTime === 1, "getServerTime is called at boot when supports_time is set");
    assert(calls.getBars[0].params.to === serverSec, "the first history window ends at the server time (5 min ahead)");
    assert(Math.abs(context.now() - (clientNow + 5 * MIN)) < 1_000, "context.now() follows the server clock");
    assert(intervals.length === 1 && intervals[0].ms === 5 * MIN, "server time is re-synced periodically");
    intervals[0].fn();
    assert(calls.getServerTime === 2, "the periodic re-sync calls getServerTime again");
    manager.destroy();
    assert(cleared.includes(4242), "destroy stops the periodic re-sync");
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
}
{
  const clientNow = Date.UTC(2024, 5, 3, 12, 0, 0);
  const serverSec = Math.floor(clientNow / 1000) + 90;
  const { calls, manager } = await boot({
    config: { supports_time: true },
    serverTime: (callback) => setTimeout(() => callback(serverSec), 5),
    history: (_p, _i, onResult) => queueMicrotask(() => onResult(series(3))),
  }, { clock: () => clientNow });
  assert(calls.getBars[0].params.to === serverSec, "an asynchronous server time is awaited before the first history request");
  manager.destroy();
}
{
  const warnings = await capture("warn", async () => {
    const { calls, manager } = await boot({
      serverTime: (callback) => callback(1),
      history: (_p, _i, onResult) => queueMicrotask(() => onResult(series(3))),
    });
    assert(calls.getServerTime === 0, "getServerTime is not called unless supports_time is true");
    manager.destroy();
  });
  assert(warnings.length === 1 && warnings[0].includes("supports_time"), "an unused getServerTime is reported once");
}
{
  // A feed calling onReady's callback twice must not start a second re-sync timer.
  const intervals = [];
  const cleared = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = () => {
    intervals.push(intervals.length + 1);
    return intervals.length;
  };
  globalThis.clearInterval = (id) => { cleared.push(id); };
  try {
    const { feed, calls } = makeFeed({
      config: { supports_time: true },
      serverTime: (callback) => callback(Math.floor(BASE / 1000)),
      history: (_p, _i, onResult) => queueMicrotask(() => onResult(series(3))),
    });
    feed.onReady = (callback) => queueMicrotask(() => {
      callback({ supports_time: true });
      callback({ supports_time: true });
    });
    const warnings = await capture("warn", async () => {
      const manager = new DataManager(makeContext(feed, { clock: () => BASE }));
      await manager.resolveAndLoad();
      assert(intervals.length === 1 && calls.getServerTime === 1, "a second onReady callback starts no second server-time timer");
      manager.destroy();
    });
    assert(cleared.length === 1 && cleared[0] === 1, "destroy clears the only server-time timer");
    assert(warnings.length === 1 && warnings[0].includes("onReady() called its callback more than once"), "the repeated onReady callback is reported once");
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
}

// ── supports_marks / supports_timescale_marks ───────────────────────────────
{
  const mark = { id: 1, time: Math.floor(BASE / 1000), color: "red", text: "m", label: "M", labelFontColor: "#fff", minSize: 14 };
  const history = (_p, _i, onResult) => queueMicrotask(() => onResult(series(3)));
  const on = await boot({ config: { supports_marks: true, supports_timescale_marks: true }, marks: [mark], timescaleMarks: [], history });
  assert(on.calls.getMarks === 1 && on.calls.getTimescaleMarks === 1 && on.context.marks.length === 1, "marks load when supports_marks is true");
  on.manager.destroy();

  const offWarnings = await capture("warn", async () => {
    const off = await boot({ config: { supports_marks: false, supports_timescale_marks: false }, marks: [mark], timescaleMarks: [], history });
    assert(off.calls.getMarks === 0 && off.calls.getTimescaleMarks === 0, "getMarks and getTimescaleMarks are not called when supports_* is false");
    off.manager.destroy();
  });
  assert(offWarnings.length === 0, "an explicit supports_* false is not reported");

  const unsetWarnings = await capture("warn", async () => {
    const unset = await boot({ marks: [mark], timescaleMarks: [], history });
    assert(unset.calls.getMarks === 0 && unset.calls.getTimescaleMarks === 0, "an unset supports_* flag does not call the marks methods");
    unset.manager.destroy();
  });
  assert(
    unsetWarnings.length === 2 && unsetWarnings[0].includes("supports_marks") && unsetWarnings[1].includes("supports_timescale_marks"),
    "implemented but unenabled marks methods are reported once each",
  );

  const optedOut = await boot(
    { config: { supports_marks: true }, marks: [mark], history },
    { options: { disabled_features: ["mark_on_bars"] } },
  );
  assert(optedOut.calls.getMarks === 0, 'disabled_features "mark_on_bars" opts out of bar marks');
  optedOut.manager.destroy();

  let throwing;
  const errors = await capture("error", async () => {
    const booted = await boot({ config: { supports_marks: true, supports_timescale_marks: true }, marks: [mark], timescaleMarks: [], history });
    booted.feed.getTimescaleMarks = () => { throw new Error("timescale down"); };
    booted.manager.refreshMarks();
    await settle();
    throwing = booted;
  });
  assert(
    errors.length === 1 && errors[0].includes("getTimescaleMarks failed") && throwing.context.marks.length === 1,
    "a throwing getTimescaleMarks is reported once and bar marks still load",
  );
  throwing.manager.destroy();
}

// ── Interval payload ────────────────────────────────────────────────────────
{
  const bars5 = series(400, BASE, 5 * MIN);
  const { context, manager } = await boot({
    history: (_p, index, onResult) => queueMicrotask(() => onResult(index === 0 ? series(300) : bars5)),
  });
  const order = [];
  let payload = null;
  context.rangeChanged.subscribe(null, (change) => order.push(`range:${change.reason}`));
  context.dataChanged.subscribe(null, () => order.push("data"));
  const targetFrom = Math.floor(bars5[100].time / 1000);
  const targetTo = Math.floor(bars5[200].time / 1000);
  context.intervalChanged.subscribe(null, (resolution, params) => {
    order.push(`interval:${resolution}`);
    payload = JSON.parse(JSON.stringify(params));
    params.timeframe = { type: "time-range", from: targetFrom, to: targetTo };
  });
  await manager.changeResolution("5");
  assert(
    payload?.timeframe?.type === "time-range"
      && Number.isFinite(payload.timeframe.from) && Number.isFinite(payload.timeframe.to)
      && !("value" in payload.timeframe),
    "onIntervalChanged receives { timeframe: { type: 'time-range', from, to } }",
  );
  const shown = manager.visibleUnixRange();
  assert(shown.from === targetFrom && shown.to === targetTo, "a listener's time-range assignment is applied");
  const intervalAt = order.indexOf("interval:5");
  assert(
    intervalAt >= 0 && order.indexOf("range:timeframe") > intervalAt && order.indexOf("data") > order.indexOf("range:timeframe"),
    "the listener's range is applied before the new interval's data is published for painting",
  );

  context.intervalChanged.unsubscribeAll(null);
  context.intervalChanged.subscribe(null, (_resolution, params) => {
    params.timeframe = { type: "period-back", value: "1D" };
  });
  await manager.changeResolution("1");
  const periodRange = manager.visibleUnixRange();
  assert(periodRange.to - periodRange.from <= 86_400 && periodRange.to >= Math.floor(BASE / 1000) - 60, "a period-back assignment is applied");
  manager.destroy();
}
{
  // A chosen window older than the loaded bars: it is placed before the page
  // it needs is requested, so frames painted while that page loads show it.
  const bars5 = series(400, BASE, 5 * MIN);
  const older5 = series(400, bars5[0].time - 5 * MIN, 5 * MIN);
  let deliver = null;
  let rangeAtRequest = null;
  const booted = await boot({
    history(_params, index, onResult) {
      if (index === 0) queueMicrotask(() => onResult(series(300)));
      else if (index === 1) queueMicrotask(() => onResult(bars5));
      else {
        rangeAtRequest = { ...booted.context.visibleRange };
        deliver = () => onResult(older5);
      }
    },
  });
  const { context, manager } = booted;
  const announced = [];
  context.viewportChanged.subscribe(null, (range) => announced.push(range));
  const targetFrom = Math.floor(older5[100].time / 1000);
  const targetTo = Math.floor(bars5[50].time / 1000);
  context.intervalChanged.subscribe(null, (_resolution, params) => {
    params.timeframe = { type: "time-range", from: targetFrom, to: targetTo };
  });
  const changing = manager.changeResolution("5");
  await waitFor(() => deliver !== null, "the page the chosen window needs");
  assert(
    rangeAtRequest.from < 0 && rangeAtRequest.to === 50 && context.visibleRange.to === 50,
    "the chosen window is shown over the loaded bars before its older page is requested (no default-view frame)",
  );
  assert(announced.length === 0, "the early placement is silent");
  deliver();
  await changing;
  const shown = manager.visibleUnixRange();
  assert(shown.from === targetFrom && shown.to === targetTo, "the window settles on the chosen range once the page loads");
  assert(
    announced.length === 1 && announced[0].from === targetFrom && announced[0].to === targetTo,
    "the settled range is announced once through viewportChanged",
  );
  manager.destroy();
}
{
  // With options.timeframe, the payload is the configured window the chart opens on.
  const nowSec = Math.floor(BASE / 1000);
  const { context, manager } = await boot({
    history: (_p, _i, onResult) => queueMicrotask(() => onResult(series(3000, BASE, 5 * MIN))),
  }, { clock: () => BASE, options: { timeframe: "1D" } });
  let payload = null;
  context.intervalChanged.subscribe(null, (_resolution, params) => { payload = JSON.parse(JSON.stringify(params)); });
  await manager.changeResolution("5");
  assert(
    payload?.timeframe?.type === "time-range" && payload.timeframe.from === nowSec - 86_400 && payload.timeframe.to === nowSec,
    "onIntervalChanged reports the configured timeframe as the opening window",
  );
  const shown = manager.visibleUnixRange();
  assert(shown.from === nowSec - 86_400 && shown.to === nowSec, "an unchanged payload opens on the configured timeframe");
  manager.destroy();
}

// ── Opening view and reason-tagged range writes ─────────────────────────────
{
  const reasons = [];
  const { feed, calls } = makeFeed({
    history: (_p, index, onResult) => queueMicrotask(() => onResult(index === 0 ? series(500) : series(100, BASE - 500 * MIN))),
  });
  const context = makeContext(feed, { hooks: { defaultVisibleBars: () => 50 } });
  context.rangeChanged.subscribe(null, (change) => reasons.push(change.reason));
  const manager = new DataManager(context);
  await manager.resolveAndLoad();
  const span = context.visibleRange.to - context.visibleRange.from;
  assert(context.visibleRange.from === 450 && span === 52, "the opening view uses the width-aware defaultVisibleBars()");
  context.setViewport({ from: 440, to: 500 }, "pan");
  assert(calls.getBars.length === 1, "a pan away from the left edge does not page history");
  context.setViewport({ from: 0, to: 60 }, "pan");
  assert(calls.getBars.length === 2, "a pan near the left edge pages history through rangeChanged");
  await settle();
  assert(context.visibleRange.from === 100, "pagination re-anchors the window by the prepended count");
  calls.ticks.at(-1)(bar(BASE + MIN));
  context.setViewport({ from: 550, to: 610 }, "api");
  calls.ticks.at(-1)(bar(BASE + 2 * MIN));
  assert(
    reasons.includes("load") && reasons.includes("rebase") && reasons.includes("realtime"),
    "load, pagination and realtime range writes go through setViewport with their reasons",
  );
  manager.destroy();
}

// ── symbolInfo resolutions are sanitised ────────────────────────────────────
{
  const warnings = await capture("warn", async () => {
    const { context, manager } = await boot({
      info: { supported_resolutions: ["1", "D", "4h", "1D"] },
      history: (_p, _i, onResult) => queueMicrotask(() => onResult(series(3))),
    });
    assert(context.symbolInfo.supported_resolutions.join(",") === "1,1D", "symbol resolutions are canonicalised and invalid ones dropped");
    manager.destroy();
  });
  assert(warnings.length === 1 && warnings[0].includes('"4h"') && warnings[0].includes("Accepted forms"), "invalid symbol resolutions are reported once");
}
{
  const { feed, calls } = makeFeed({ history: (_p, _i, onResult) => queueMicrotask(() => onResult(series(3))) });
  const context = makeContext(feed);
  const manager = new DataManager(context);
  await manager.resolveAndLoad();
  let rejected = null;
  await manager.changeResolution("4h").catch((error) => { rejected = error; });
  assert(rejected instanceof RangeError && calls.getBars.length === 1, "changeResolution rejects an invalid interval before any request");
  rejected = null;
  await manager.changeSymbol("B", "1H").catch((error) => { rejected = error; });
  assert(rejected instanceof RangeError && context.symbol === "A", "changeSymbol rejects an invalid interval");
  manager.destroy();
}

// ── Widget boundary: constructor, setResolution, setSymbol, marks painter ───
{
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  window.devicePixelRatio = 1;
  let arcs = 0;
  const context2d = new Proxy(
    {
      measureText: (value) => ({ width: String(value ?? "").length * 6 }),
      arc: () => { arcs += 1; },
      canvas: {},
    },
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
  const frames = new Map();
  let frameId = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  };

  const loaded = series(60);
  const mark = { id: 1, time: Math.floor(loaded[50].time / 1000), color: "red", text: "Mark", label: "M", labelFontColor: "#fff", minSize: 14 };
  const widgetFeed = (config) => makeFeed({
    config,
    marks: [mark],
    history: (_p, _i, onResult) => queueMicrotask(() => onResult(loaded)),
  });
  const mount = () => {
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    return host;
  };
  const baseOptions = {
    symbol: "A",
    interval: "1",
    disabled_features: ["header_widget", "left_toolbar", "scale_bar"],
  };

  const badHost = mount();
  let constructorError = null;
  try {
    new widget({ ...baseOptions, interval: "4h", container: badHost, datafeed: widgetFeed({}).feed });
  } catch (error) {
    constructorError = error;
  }
  assert(
    constructorError instanceof RangeError && constructorError.message.includes('"4h"') && constructorError.message.includes("Accepted forms"),
    "the widget constructor throws a RangeError for an invalid interval",
  );
  assert(badHost.childElementCount === 0, "a rejected interval leaves no DOM behind");

  const marksOn = widgetFeed({ supports_marks: true });
  const host = mount();
  const instance = new widget({ ...baseOptions, container: host, datafeed: marksOn.feed });
  await instance.headerReady();
  await waitFor(() => marksOn.calls.getMarks === 1, "marks request");
  await settle();
  arcs = 0;
  flush();
  assert(arcs > 0, "bar marks render by default when supports_marks is true");

  const chart = instance.activeChart();
  let callbackFired = false;
  let setError = null;
  try {
    chart.setResolution("4H", () => { callbackFired = true; });
  } catch (error) {
    setError = error;
  }
  await settle();
  assert(setError instanceof RangeError && !callbackFired && chart.resolution() === "1", "setResolution throws a RangeError and keeps the interval");
  setError = null;
  try {
    instance.setSymbol("B", "1H");
  } catch (error) {
    setError = error;
  }
  assert(setError instanceof RangeError && chart.symbol() === "A", "setSymbol throws a RangeError for an invalid interval");

  await new Promise((resolve) => chart.setResolution("D", resolve));
  assert(chart.resolution() === "1D" && marksOn.calls.getBars.at(-1).resolution === "1D", "setResolution('D') normalises to 1D for the chart and the feed");
  let loadError = null;
  await instance.load({ ...instance.save(), interval: "4h" }).catch((error) => { loadError = error; });
  assert(loadError instanceof RangeError && chart.resolution() === "1D", "a saved layout with an invalid interval makes load() reject with the RangeError");
  instance.remove();

  const optOut = widgetFeed({ supports_marks: true });
  const optOutHost = mount();
  const quiet = new widget({
    ...baseOptions,
    container: optOutHost,
    datafeed: optOut.feed,
    disabled_features: [...baseOptions.disabled_features, "mark_on_bars"],
  });
  await quiet.headerReady();
  await settle();
  arcs = 0;
  flush();
  assert(optOut.calls.getMarks === 0 && arcs === 0, 'disabled_features "mark_on_bars" hides marks without requesting them');
  quiet.remove();

  const failing = makeFeed({ history: (_p, _i, _onResult, onError) => queueMicrotask(() => onError()) });
  const failingHost = mount();
  const loadErrors = await capture("error", async (messages) => {
    const broken = new widget({ ...baseOptions, container: failingHost, datafeed: failing.feed });
    await waitFor(() => messages.length > 0, "the load failure report");
    broken.remove();
  });
  assert(
    loadErrors.length === 1 && loadErrors[0].includes("failed to load symbol") && loadErrors[0].includes("the datafeed gave no reason"),
    "a widget whose first getBars calls onError() without a reason logs the load failure",
  );

  // favorites.intervals feed the header's interval row: they are canonicalised
  // before it is built, and an invalid entry cannot abort the header build.
  const withinSeconds = (promise, what) => Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), 3_000)),
  ]);
  const headerChart = async (interval, favorites) => {
    // No symbol resolutions, so the header lists the favorites.
    const { feed } = makeFeed({
      info: { supported_resolutions: undefined },
      history: (_p, _i, onResult) => queueMicrotask(() => onResult(loaded)),
    });
    const root = mount();
    let chartWidget;
    const warnings = await capture("warn", async () => {
      chartWidget = new widget({
        symbol: "A",
        interval,
        container: root,
        datafeed: feed,
        disabled_features: ["left_toolbar", "scale_bar"],
        favorites: { intervals: favorites },
      });
      await withinSeconds(chartWidget.headerReady(), "headerReady");
      await withinSeconds(new Promise((resolve) => chartWidget.onChartReady(resolve)), "onChartReady");
    });
    const buttons = [...root.querySelectorAll('[role="group"][aria-label="Chart interval"] button')]
      .map((button) => `${button.textContent}:${button.getAttribute("aria-pressed")}`);
    chartWidget.remove();
    return { warnings: warnings.filter((line) => line.includes("favorites.intervals")), buttons };
  };

  const hours = await headerChart("60", ["1H", "60"]);
  assert(
    hours.warnings.length === 1 && hours.warnings[0].includes('"1H"') && hours.warnings[0].includes("Accepted forms"),
    "an invalid favorites interval is dropped with one warning listing the accepted forms",
  );
  assert(hours.buttons.join(",") === "1h:true", "the header still boots and shows the valid favorite as 1h");

  const days = await headerChart("D", ["D", "W"]);
  assert(days.warnings.length === 0, "valid favorites do not warn");
  assert(days.buttons.join(",") === "1D:true,1W:false", 'favorites "D"/"W" match interval "D": the 1D button is pressed');
}

console.log("\nDATAFEED CONTRACT: PASS");
