// Reference values for every built-in study, plus the edge cases that used to
// break them: zero/negative prices, NaN bars, flat and short histories,
// session-anchored VWAP across time zones and DST, honoured inputs, exact
// name resolution, pane value precision and O(n) Bollinger Bands.
// Run after the build: node build.mjs && node tests/study-reference.mjs

import assert from "node:assert/strict";
import * as studies from "../dist/studies.esm.js";
import { BUILTIN_STUDIES, Delegate, StudyRegistry, StudyStore } from "../dist/charting_library.esm.js";

let passed = 0;
async function test(name, body) {
  await body();
  passed += 1;
  console.log(`✓ ${name}`);
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ── Independent reference implementations (textbook, O(n·L)) ───────────────

const isNum = (value) => typeof value === "number" && Number.isFinite(value);

/** Drop gaps, run `kernel`, and put the results back where the finite samples were. */
function skipGaps(values, kernel) {
  const index = [];
  const finite = [];
  values.forEach((value, i) => {
    if (isNum(value)) {
      index.push(i);
      finite.push(value);
    }
  });
  const inner = kernel(finite);
  const out = values.map(() => null);
  inner.forEach((value, j) => { out[index[j]] = value; });
  return out;
}

const refSma = (values, length) => skipGaps(values, (xs) => xs.map((_, i) => {
  if (i < length - 1) return null;
  let sum = 0;
  for (let j = i - length + 1; j <= i; j++) sum += xs[j];
  return sum / length;
}));

const refEma = (values, length) => skipGaps(values, (xs) => {
  const out = xs.map(() => null);
  if (xs.length < length) return out;
  let prev = xs.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = prev;
  for (let i = length; i < xs.length; i++) {
    prev = (xs[i] - prev) * (2 / (length + 1)) + prev;
    out[i] = prev;
  }
  return out;
});

const refRsi = (values, length) => skipGaps(values, (xs) => {
  const out = xs.map(() => null);
  if (xs.length <= length) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const change = xs[i] - xs[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  gain /= length;
  loss /= length;
  out[length] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = length + 1; i < xs.length; i++) {
    const change = xs[i] - xs[i - 1];
    gain = (gain * (length - 1) + Math.max(change, 0)) / length;
    loss = (loss * (length - 1) + Math.max(-change, 0)) / length;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
});

const refStdev = (values, length) => skipGaps(values, (xs) => xs.map((_, i) => {
  if (i < length - 1) return null;
  const window = xs.slice(i - length + 1, i + 1);
  const mean = window.reduce((a, b) => a + b, 0) / length;
  return Math.sqrt(window.reduce((acc, x) => acc + (x - mean) ** 2, 0) / length);
}));

const refBollinger = (values, length, mult) => {
  const mid = refSma(values, length);
  const dev = refStdev(values, length);
  return {
    mid,
    upper: mid.map((m, i) => (m == null ? null : m + mult * dev[i])),
    lower: mid.map((m, i) => (m == null ? null : m - mult * dev[i])),
  };
};

const refMacd = (values, fast, slow, signal) => {
  const f = refEma(values, fast);
  const s = refEma(values, slow);
  const line = values.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
  const sig = refEma(line.map((v) => v ?? Number.NaN), signal);
  return { macd: line, signal: sig, hist: line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i])) };
};

/** Local calendar day + minutes of an instant, straight from Intl (no library code). */
function localClock(time, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(new Date(time)).map((part) => [part.type, part.value]));
  return {
    day: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / DAY,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Session VWAP by brute force: reset whenever the trading day changes. */
function refVwap(bars, timeZone = "UTC", sessionStartMinutes = 0) {
  let key = null;
  let pv = 0;
  let volume = 0;
  return bars.map((bar) => {
    const clock = localClock(bar.time, timeZone);
    const day = clock.minutes >= sessionStartMinutes ? clock.day : clock.day - 1;
    if (day !== key) {
      key = day;
      pv = 0;
      volume = 0;
    }
    const price = (bar.high + bar.low + bar.close) / 3;
    pv += price * bar.volume;
    volume += bar.volume;
    return volume > 0 ? pv / volume : null;
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function assertSeries(actual, expected, label, tolerance = 1e-9) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    if (e == null) {
      assert.equal(a, null, `${label}[${i}] is a gap/warm-up (got ${a})`);
      continue;
    }
    assert.ok(isNum(a), `${label}[${i}] is finite (got ${a})`);
    const scale = Math.max(1, Math.abs(e));
    assert.ok(Math.abs(a - e) <= tolerance * scale, `${label}[${i}]: ${a} vs reference ${e}`);
  }
}

function seededWalk(count, start, volatility, seed = 42) {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    price += (random() - 0.5) * volatility;
    out.push(price);
  }
  return out;
}

const barsFrom = (closes, { start = 0, step = MINUTE, volume = (i) => 100 + (i % 7) * 10 } = {}) =>
  closes.map((close, i) => ({
    time: start + i * step,
    open: isNum(close) ? close - 0.25 : close,
    high: isNum(close) ? close + 0.5 : close,
    low: isNum(close) ? close - 0.75 : close,
    close,
    volume: volume(i),
  }));

const definition = (name) => {
  const def = BUILTIN_STUDIES.find((item) => item.name === name);
  assert.ok(def, `${name} is a built-in`);
  return def;
};

const seriesOf = (result, index = 0) => (Array.isArray(result) ? result : result.series[index].values);

function captureWarnings(body) {
  const original = console.warn;
  const messages = [];
  console.warn = (...args) => messages.push(args.map(String).join(" "));
  try {
    body();
  } finally {
    console.warn = original;
  }
  return messages;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

// StockCharts' published EMA and RSI worked examples.
const STOCKCHARTS_EMA_CLOSES = [
  22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29,
  22.15, 22.39, 22.38, 22.61, 23.36, 24.05, 23.75, 23.83, 23.95, 23.63,
  23.82, 23.87, 23.65, 23.19, 23.10, 23.33, 22.68, 23.10, 22.40, 22.17,
];
const STOCKCHARTS_EMA10 = [
  22.22, 22.21, 22.24, 22.27, 22.33, 22.52, 22.80, 22.97, 23.13, 23.28, 23.34,
  23.43, 23.51, 23.53, 23.47, 23.40, 23.39, 23.26, 23.23, 23.08, 22.92,
];
const STOCKCHARTS_RSI_CLOSES = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433,
  46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116,
  46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288,
  44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314,
];
const STOCKCHARTS_RSI14 = [
  70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71,
  50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77,
];

const WALK = seededWalk(400, 6400, 40);
const FLAT = Array.from({ length: 60 }, () => 101.25);
const NEGATIVE = seededWalk(200, -40, 3, 7).map((value, i) => (i % 17 === 0 ? 0 : value));
const SHORT = [10, 11, 9];
const WITH_GAP = WALK.map((value, i) => (i === 250 ? Number.NaN : value));

const FIXTURES = { walk: WALK, flat: FLAT, negative: NEGATIVE, short: SHORT, gap: WITH_GAP };

// ── Tests ───────────────────────────────────────────────────────────────────

await test("EMA(10) and RSI(14) match StockCharts' published worked examples", () => {
  const ema = studies.ema(STOCKCHARTS_EMA_CLOSES, 10);
  STOCKCHARTS_EMA10.forEach((expected, i) => {
    assert.ok(Math.abs(ema[i + 9] - expected) < 0.006, `EMA10[${i + 9}] ${ema[i + 9]} ≈ ${expected}`);
  });
  const rsi = studies.rsi(STOCKCHARTS_RSI_CLOSES, 14);
  STOCKCHARTS_RSI14.forEach((expected, i) => {
    assert.ok(Math.abs(rsi[i + 14] - expected) < 0.006, `RSI14[${i + 14}] ${rsi[i + 14]} ≈ ${expected}`);
  });
  assert.equal(rsi[13], null, "RSI warm-up is null");
});

await test("every built-in matches its reference on walk, flat, negative, short and gap fixtures", () => {
  for (const [name, closes] of Object.entries(FIXTURES)) {
    const bars = barsFrom(closes);
    assertSeries(seriesOf(definition("SMA").compute(bars, { length: 20 })), refSma(closes, 20), `SMA ${name}`);
    assertSeries(seriesOf(definition("EMA").compute(bars, { length: 9 })), refEma(closes, 9), `EMA ${name}`);
    assertSeries(seriesOf(definition("RSI").compute(bars, { length: 14 })), refRsi(closes, 14), `RSI ${name}`);
    const bb = definition("Bollinger Bands").compute(bars, { length: 20 });
    const bbRef = refBollinger(closes, 20, 2);
    assertSeries(seriesOf(bb, 0), bbRef.mid, `BB mid ${name}`);
    assertSeries(seriesOf(bb, 1), bbRef.upper, `BB upper ${name}`);
    assertSeries(seriesOf(bb, 2), bbRef.lower, `BB lower ${name}`);
    const macd = definition("MACD").compute(bars, { length: 26 });
    const macdRef = refMacd(closes, 12, 26, 9);
    assertSeries(seriesOf(macd, 0), macdRef.macd, `MACD ${name}`);
    assertSeries(seriesOf(macd, 1), macdRef.signal, `MACD signal ${name}`);
    assertSeries(seriesOf(macd, 2), macdRef.hist, `MACD hist ${name}`);
    const vwap = seriesOf(definition("VWAP").compute(bars, { length: 14 }));
    const vwapRef = refVwap(bars.filter((bar) => isNum(bar.close)));
    assertSeries(vwap.filter((_, i) => isNum(closes[i])), vwapRef, `VWAP ${name}`);
  }
  // A flat series has zero spread: the bands sit exactly on the basis.
  const flatBands = studies.bollinger(FLAT, 20, 2);
  assert.equal(studies.stdev(FLAT, 20)[40], 0, "flat stdev is exactly 0");
  assert.equal(flatBands.upper[40], flatBands.mid[40]);
  const flatRsi = studies.rsi(FLAT, 14);
  assert.equal(flatRsi[30], 100, "RSI of an unchanged series follows Wilder's avgLoss = 0 rule");
  // Short history: only warm-up.
  assert.deepEqual(studies.ema(SHORT, 9), [null, null, null]);
  assert.deepEqual(studies.macd(SHORT).macd, [null, null, null]);
});

await test("zero and negative closes are values, not placeholders", () => {
  const bars = [-37.63, 0, 10].map((close, i) => ({ time: i * DAY, open: 5, high: 11, low: -40, close, volume: 1 }));
  assert.deepEqual(studies.closesFromBars(bars), [-37.63, 0, 10]);
  const sma = seriesOf(definition("SMA").compute(bars, { length: 3 }));
  assert.equal(sma[2].toFixed(2), "-9.21", "SMA(3) of [-37.63, 0, 10]");
  assert.equal(studies.sma([-37.63, 0, 10], 3)[2].toFixed(2), "-9.21");
  const ema = studies.ema([-5, -4, -6, -3], 2);
  assert.deepEqual(ema.map((v) => (v == null ? v : Number(v.toFixed(6)))), [null, -4.5, -5.5, -3.833333]);
});

await test("a NaN bar is a gap: each study is finite again at k + length (k + 1 for VWAP)", () => {
  const k = 250;
  const bars = barsFrom(WITH_GAP);
  bars[k] = { time: bars[k].time, open: Number.NaN, high: Number.NaN, low: Number.NaN, close: Number.NaN, volume: Number.NaN };
  const cases = [
    ["SMA", { length: 20 }, 20, 0],
    ["EMA", { length: 20 }, 20, 0],
    ["RSI", { length: 14 }, 14, 0],
    ["Bollinger Bands", { length: 20 }, 20, 0],
    ["Bollinger Bands", { length: 20 }, 20, 1],
    ["MACD", { length: 26 }, 26, 0],
    ["MACD", { length: 26 }, 26, 1],
    ["MACD", { length: 26 }, 26, 2],
    ["VWAP", { length: 14 }, 1, 0],
  ];
  for (const [name, inputs, recovery, index] of cases) {
    const values = seriesOf(definition(name).compute(bars, inputs), index);
    assert.equal(values[k], null, `${name}#${index} emits null on the NaN bar`);
    for (let i = k + recovery; i < bars.length; i++) {
      assert.ok(isNum(values[i]), `${name}#${index} is finite at ${i} (got ${values[i]})`);
    }
    for (let i = 40; i < k; i++) assert.ok(isNum(values[i]), `${name}#${index} before the gap at ${i}`);
  }
  // Non-numeric fields from a feed (null/undefined close) are gaps too.
  const nullBars = barsFrom([1, 2, null, 4, 5]);
  assert.deepEqual(studies.sma(studies.closesFromBars(nullBars), 2).map((v) => (v == null ? v : v)), [null, 1.5, null, 3, 4.5]);
});

await test("incremental and full EMA/SMA/RSI agree on negative, zero and NaN ticks", () => {
  const initial = barsFrom(seededWalk(40, -3, 1.5, 11));
  const context = { bars: initial, dataChanged: new Delegate(), requestPaint: () => {} };
  const store = new StudyStore(context, new StudyRegistry(BUILTIN_STUDIES));
  for (const name of ["EMA", "SMA", "RSI"]) assert.ok(store.add({ name, length: 5 }));
  const tick = (bar, append) => {
    if (append) context.bars.push(bar);
    else context.bars[context.bars.length - 1] = bar;
    context.dataChanged.fire();
    for (const study of store.list()) {
      const full = seriesOf(study.def.compute(context.bars, { length: study.length }));
      assertSeries(study.values, full, `${study.name} after ${append ? "append" : "replace"} ${bar.close}`, 1e-10);
    }
  };
  let time = initial[initial.length - 1].time;
  const nan = { open: Number.NaN, high: Number.NaN, low: Number.NaN, close: Number.NaN, volume: 0 };
  tick({ time: (time += MINUTE), open: -1, high: 0, low: -2, close: -1.5, volume: 1 }, true);
  tick({ time, open: -1, high: 0, low: -3, close: 0, volume: 2 }, false);
  tick({ time: (time += MINUTE), ...nan }, true);
  tick({ time: (time += MINUTE), open: 1, high: 2, low: 0, close: 0.5, volume: 1 }, true);
  tick({ time, open: 1, high: 2, low: -9, close: -8.25, volume: 3 }, false);
  for (let i = 0; i < 8; i++) tick({ time: (time += MINUTE), open: -i, high: 1, low: -i - 1, close: -i / 2, volume: 1 }, true);
  tick({ time, ...nan }, false);
  tick({ time, open: 2, high: 3, low: 1, close: 2.5, volume: 1 }, false);
  store.destroy();
});

await test("MACD, Bollinger and moving averages honour their inputs (names, aliases and in_N)", () => {
  const closes = WALK;
  const bars = barsFrom(closes);
  const macd = definition("MACD");
  const named = macd.compute(bars, { length: 26, fast: 5, slow: 35, signal: 5 });
  const reference = studies.macd(closes, 5, 35, 5);
  assert.deepEqual(named.series[0].values, reference.macd, "{fast:5, slow:35, signal:5} equals macd(closes, 5, 35, 5)");
  assert.deepEqual(named.series[1].values, reference.signal);
  assert.deepEqual(named.series[2].values, reference.hist);
  const tv = macd.compute(bars, { length: 26, in_0: 14, in_1: 30, in_3: "close", in_2: 9 });
  assert.deepEqual(tv.series[0].values, studies.macd(closes, 14, 30, 9).macd, "TradingView's documented in_N example");
  assert.deepEqual(tv.series[1].values, studies.macd(closes, 14, 30, 9).signal);
  const spelled = macd.compute(bars, { length: 26, "Fast Length": 8, slowLength: 21, signal_smoothing: 5 });
  assert.deepEqual(spelled.series[0].values, studies.macd(closes, 8, 21, 5).macd, "TradingView input titles resolve");
  assert.deepEqual(macd.compute(bars, { length: 30 }).series[0].values, studies.macd(closes, 12, 30, 9).macd, "length is the slow length");
  const hl2 = studies.sourceValues(bars, "hl2");
  assert.deepEqual(macd.compute(bars, { length: 26, source: "hl2" }).series[0].values, studies.macd(hl2, 12, 26, 9).macd);

  const bb = definition("Bollinger Bands");
  const wide = bb.compute(bars, { length: 20, mult: 3 });
  const bbRef = studies.bollinger(closes, 20, 3);
  assert.deepEqual(wide.series[1].values, bbRef.upper, "Bollinger multiplier input");
  assert.deepEqual(bb.compute(bars, { length: 20, in_1: 1.5 }).series[2].values, studies.bollinger(closes, 20, 1.5).lower);
  assert.deepEqual(bb.compute(bars, { length: 20, StdDev: 2.5 }).series[1].values, studies.bollinger(closes, 20, 2.5).upper, "TradingView's StdDev title");
  assert.deepEqual(bb.compute(bars, { length: 20, multiplier: 1.5 }).series[1].values, studies.bollinger(closes, 20, 1.5).upper, "multiplier alias");
  assert.deepEqual(definition("SMA").compute(bars, { length: 9, period: 30 }), studies.sma(closes, 30), "period alias");
  assert.deepEqual(definition("EMA").compute(bars, { length: 9, Length: 12, len: 14 }).slice(-3), studies.ema(closes, 14).slice(-3), "title and len alias");
  assert.deepEqual(
    definition("VWAP").compute(bars, { "Anchor Period": "week" }),
    studies.vwap(bars, { anchor: "week" }),
    "VWAP anchor by its title",
  );
  const shifted = bb.compute(bars, { length: 20, offset: 3 });
  assert.deepEqual(shifted.series[0].values.slice(3), studies.sma(closes, 20).slice(0, -3), "offset shifts the plot right");
  assert.deepEqual(shifted.series[0].values.slice(0, 3), [null, null, null]);

  for (const name of ["EMA", "SMA"]) {
    const def = definition(name);
    const kernel = name === "EMA" ? studies.ema : studies.sma;
    assert.deepEqual(def.compute(bars, { length: 9, in_0: 30 }), kernel(closes, 30), `${name} in_0 is the length`);
    assert.deepEqual(def.compute(bars, { length: 9, source: "ohlc4" }), kernel(studies.sourceValues(bars, "ohlc4"), 9), `${name} source`);
    assert.deepEqual(def.compute(bars, { length: 9, in_1: "high" }), kernel(studies.sourceValues(bars, "high"), 9), `${name} in_1 is the source`);
    assert.deepEqual(def.compute(bars, { length: 9, offset: -2 }).slice(0, -2), kernel(closes, 9).slice(2), `${name} negative offset`);
  }
  assert.deepEqual(
    definition("RSI").compute(bars, { length: 14, src: "low" }),
    studies.rsi(studies.sourceValues(bars, "low"), 14),
    "RSI source alias",
  );
  const vwapHigh = definition("VWAP").compute(bars, { length: 14, source: "high" });
  assert.deepEqual(vwapHigh, studies.vwap(bars, { source: "high" }), "VWAP source");
});

await test("unknown or invalid built-in inputs warn with guidance instead of being ignored", () => {
  const bars = barsFrom(WALK.slice(0, 60));
  const warnings = captureWarnings(() => {
    definition("MACD").compute(bars, { length: 26, fastperiodz: 3 });
    definition("MACD").compute(bars, { length: 26, fastperiodz: 3 });
    definition("EMA").compute(bars, { length: 9, source: "median" });
    definition("SMA").compute(bars, { length: 9, in_7: 4 });
    definition("Bollinger Bands").compute(bars, { length: 20, mult: -1 });
  });
  assert.equal(warnings.filter((w) => w.includes('"fastperiodz"')).length, 1, "each unknown key warns once");
  assert.match(warnings.find((w) => w.includes("fastperiodz")), /Supported inputs: fast \(in_0\), slow \(in_1\), signal \(in_2\), source \(in_3\)/);
  assert.ok(warnings.some((w) => /EMA input "source" expects one of open, high, low, close/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => w.includes('SMA input "in_7" is not supported')), warnings.join("\n"));
  assert.ok(warnings.some((w) => /Bollinger Bands input "mult" must be between/.test(w)), warnings.join("\n"));
  const silent = captureWarnings(() => {
    definition("EMA").compute(bars, { length: 9, color: "#fff" });
    definition("VWAP").compute(bars, { length: 14 });
    definition("MACD").compute(bars, { length: 26, fast: 5, slow: 35 });
  });
  assert.deepEqual(silent, [], "the store's length/colour shorthand never warns");

  // A fast length that is not below slow draws an inverted or flat MACD: say so with the effective values.
  const inverted = captureWarnings(() => definition("MACD").compute(bars, { length: 10 }));
  assert.ok(
    inverted.some((w) => /MACD input "fast" is 12 but slow is 10 \(the length shorthand sets slow\).*Pass a fast length below slow/.test(w)),
    inverted.join("\n"),
  );
  const flat = captureWarnings(() => definition("MACD").compute(bars, { length: 26, in_0: 9, in_1: 9 }));
  assert.ok(flat.some((w) => w.includes('MACD input "fast" is 9 but slow is 9')), flat.join("\n"));
});

await test("createStudy name resolution is exact: unsupported TradingView names reject", () => {
  const registry = new studies.StudyRegistry();
  const unsupported = [
    "Double Exponential Moving Average",
    "Triple Exponential Moving Average",
    "Zero Lag Exponential Moving Average",
    "Bollinger Bands %B",
    "Bollinger Bands Width",
    "Anchored VWAP",
    "MACD 4C",
    "Relative Strength Comparison",
    "Relative Strength Index Stochastic",
    "Simple Moving Average Ribbon",
  ];
  for (const name of unsupported) assert.equal(registry.resolve(name), null, `${name} does not resolve`);
  const supported = {
    "Moving Average Exponential": "EMA",
    "moving average exponential": "EMA",
    "Relative Strength Index": "RSI",
    "Moving Average": "SMA",
    "Volume Weighted Average Price": "VWAP",
    "Bollinger Bands": "Bollinger Bands",
    "BB": "Bollinger Bands",
    "Moving Average Convergence Divergence": "MACD",
    "MACD@tv-basicstudies": "MACD",
    "  rsi  ": "RSI",
  };
  for (const [name, expected] of Object.entries(supported)) assert.equal(registry.resolve(name)?.name, expected, name);

  const message = registry.unknownStudyMessage("Anchored VWAP");
  assert.match(message, /^\[raze-charts\] unknown study: Anchored VWAP\. Available studies: EMA, SMA, RSI, VWAP, Bollinger Bands, MACD\./);

  // The store (createStudy/load) uses the same exact resolution.
  const context = { bars: barsFrom(WALK.slice(0, 50)), dataChanged: new Delegate(), requestPaint: () => {} };
  const store = new StudyStore(context, new StudyRegistry(BUILTIN_STUDIES));
  for (const name of unsupported) assert.equal(store.add({ name }), null, `StudyStore rejects ${name}`);
  assert.ok(store.add({ name: "Moving Average Exponential", length: 5 }));
  store.destroy();

  // Keyword matching still powers pickers, through searchStudies() only.
  const search = (query) => studies.searchStudies(registry.list(), query).map((d) => d.name);
  assert.deepEqual(search("exponential"), ["EMA"]);
  assert.deepEqual(search("mov").slice(0, 3), ["EMA", "SMA", "MACD"]);
  assert.equal(search("band")[0], "Bollinger Bands");
  assert.deepEqual(search("momentum"), ["RSI", "MACD"]);
  assert.equal(search("").length, registry.list().length);
  assert.equal(registry.search, undefined, "the widget registry does not ship keyword search");
});

await test("VWAP anchors to the symbol session and time zone (Sydney, New York, Chicago, UTC)", () => {
  const vwap = definition("VWAP");
  const at = (iso, typical, volume = 1) => ({ time: Date.parse(iso), open: typical, high: typical, low: typical, close: typical, volume });

  // ASX 10:00-16:00 AEDT opens at 23:00 UTC: the session crosses UTC midnight.
  const asx = [
    at("2024-01-14T23:00:00Z", 100), at("2024-01-15T00:00:00Z", 102), at("2024-01-15T01:00:00Z", 104),
    at("2024-01-15T02:00:00Z", 106), at("2024-01-15T03:00:00Z", 108), at("2024-01-15T04:00:00Z", 110),
    at("2024-01-15T23:00:00Z", 200), at("2024-01-16T00:00:00Z", 202),
  ];
  const sydneyCtx = { symbolInfo: { timezone: "Australia/Sydney", session: "1000-1600" } };
  assert.deepEqual(vwap.compute(asx, { length: 14 }, sydneyCtx), [100, 101, 102, 103, 104, 105, 200, 201]);
  assertSeries(vwap.compute(asx, { length: 14 }, sydneyCtx), refVwap(asx, "Australia/Sydney", 600), "ASX VWAP");
  assert.deepEqual(studies.vwap(asx).slice(0, 2), [100, 102], "without a session, UTC days still apply");

  // NYSE 09:30-16:00 America/New_York, across the March 2024 DST change.
  const nyse = [];
  for (const date of ["2024-03-07", "2024-03-08", "2024-03-11", "2024-03-12"]) {
    const offset = date < "2024-03-10" ? "-05:00" : "-04:00";
    for (let minutes = 9 * 60 + 30; minutes <= 16 * 60; minutes += 30) {
      const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
      const mm = String(minutes % 60).padStart(2, "0");
      nyse.push(at(`${date}T${hh}:${mm}:00${offset}`, 50 + nyse.length, 1 + (nyse.length % 5)));
    }
  }
  const nyCtx = { symbolInfo: { timezone: "America/New_York", session: "0930-1600:23456" } };
  const nyValues = vwap.compute(nyse, { length: 14 }, nyCtx);
  assertSeries(nyValues, refVwap(nyse, "America/New_York", 570), "NYSE VWAP");
  const perDay = nyse.length / 4;
  for (let day = 0; day < 4; day++) {
    assert.equal(nyValues[day * perDay], nyse[day * perDay].close, `VWAP resets at 09:30 ET on day ${day}`);
  }

  // CME Globex 17:00-16:00 America/Chicago: one session spans two calendar days.
  const globex = [];
  const open = Date.parse("2024-06-09T17:00:00-05:00"); // Sunday open
  for (let i = 0; i < 48; i++) {
    const time = open + i * HOUR;
    const local = localClock(time, "America/Chicago").minutes;
    if (local >= 16 * 60 && local < 17 * 60) continue; // daily maintenance break
    globex.push({ time, open: 10 + i, high: 10 + i, low: 10 + i, close: 10 + i, volume: 2 });
  }
  const cmeCtx = { symbolInfo: { timezone: "America/Chicago", session: "1700-1600" } };
  const cme = vwap.compute(globex, { length: 14 }, cmeCtx);
  assertSeries(cme, refVwap(globex, "America/Chicago", 17 * 60), "CME VWAP");
  const mondayOpen = globex.findIndex((bar) => bar.time === Date.parse("2024-06-10T17:00:00-05:00"));
  assert.ok(mondayOpen > 20, "fixture has the Monday 17:00 re-open");
  assert.equal(cme[mondayOpen], globex[mondayOpen].close, "resets at the next 17:00 CT open");
  assert.ok(cme[mondayOpen - 1] < globex[mondayOpen - 1].close, "continuous across local and UTC midnight");
  // Weekly anchor: Sunday evening already belongs to Monday's trading week.
  const weekly = vwap.compute(globex, { length: 14, anchor: "Week" }, cmeCtx);
  assert.equal(weekly[0], globex[0].close);
  assert.ok(weekly.slice(1).every((value, i) => value < globex[i + 1].close), "one weekly accumulation");

  // 24x7 UTC crypto is unchanged: UTC-day resets.
  const crypto = barsFrom(WALK.slice(0, 200), { start: Date.UTC(2024, 0, 1, 20), step: 15 * MINUTE });
  const cryptoCtx = { symbolInfo: { timezone: "Etc/UTC", session: "24x7" } };
  assertSeries(vwap.compute(crypto, { length: 14 }, cryptoCtx), refVwap(crypto), "24x7 VWAP");
  assertSeries(vwap.compute(crypto, { length: 14 }), refVwap(crypto), "VWAP without context");
});

await test("VWAP carries through zero-volume bars and warns on unusable sessions", () => {
  const at = (iso, typical, volume = 1) => ({ time: Date.parse(iso), open: typical, high: typical, low: typical, close: typical, volume });
  const bars = [
    { time: 0, open: 10, high: 10, low: 10, close: 10, volume: 5 },
    { time: MINUTE, open: 30, high: 30, low: 30, close: 30, volume: 0 },
    { time: 2 * MINUTE, open: 40, high: 40, low: 40, close: 40, volume: 5 },
  ];
  assert.deepEqual(studies.vwap(bars), [10, 10, 25], "a no-volume bar carries the running VWAP");
  assert.throws(() => studies.vwap(bars, { session: "9:30 to 4" }), /unrecognised session "9:30 to 4"/);
  assert.throws(() => studies.vwap(bars, { timezone: "Mars/Olympus" }), /Unknown time zone/);
  let values;
  const warnings = captureWarnings(() => {
    values = definition("VWAP").compute(bars, { length: 14 }, { symbolInfo: { timezone: "Mars/Olympus", session: "24x7" } });
  });
  assert.deepEqual(values, [10, 10, 25], "a bad zone falls back to UTC days instead of blanking the study");
  assert.ok(warnings.some((w) => /Mars\/Olympus.*falls back to UTC/.test(w)), warnings.join("\n"));
  const noVolume = captureWarnings(() => {
    definition("VWAP").compute(bars.map(({ volume: _volume, ...bar }) => bar), { length: 14 });
  });
  assert.ok(noVolume.some((w) => /VWAP needs bar volume/.test(w)));
  // Multi-segment sessions anchor on the first segment's start.
  const lunch = [
    at("2024-05-06T09:30:00+08:00", 10), at("2024-05-06T13:30:00+08:00", 20),
    at("2024-05-07T09:00:00+08:00", 30), at("2024-05-07T09:30:00+08:00", 40),
  ];
  assert.deepEqual(studies.vwap(lunch, { timezone: "Asia/Hong_Kong", session: "0930-1200,1300-1600:23456" }), [10, 15, 20, 40]);
  assert.deepEqual(studies.vwap(lunch, { timezone: "Asia/Hong_Kong", session: "0000-0000" }), [10, 15, 30, 35]);
});

await test("pane values keep significant digits on sub-cent symbols; RSI keeps one decimal", () => {
  const macd = definition("MACD");
  for (const [value, text] of [
    [-0.00000318, "-0.00000318"],
    [0.000123456, "0.0001235"],
    [-34.8, "-34.80"],
    [0.5, "0.50"],
    [0, "0.00"],
    [1234.5678, "1234.57"],
  ]) {
    assert.equal(macd.formatValue(value), text, `MACD formats ${value}`);
  }
  // A MACD computed on 0.00012 prices is legible (at least two significant digits).
  const tiny = seededWalk(120, 0.00012, 0.000002, 5);
  const last = studies.macd(tiny).macd.at(-1);
  const digits = macd.formatValue(last).replace(/^-?0\.0*/, "").replace(/\D/g, "");
  assert.ok(digits.length >= 2 && /[1-9]/.test(digits), `${macd.formatValue(last)} shows significant digits`);
  assert.equal(definition("RSI").formatValue(48.44), "48.4");
});

/** Corrected two-pass mean and population deviation of every full window: the accurate reference. */
function refWindows(values, length) {
  const mean = values.map(() => null);
  const dev = values.map(() => null);
  for (let i = length - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) sum += values[j];
    const m = sum / length;
    let squares = 0;
    let residual = 0;
    for (let j = i - length + 1; j <= i; j++) {
      const d = values[j] - m;
      squares += d * d;
      residual += d;
    }
    mean[i] = m + residual / length;
    dev[i] = Math.sqrt(Math.max(0, squares - (residual * residual) / length) / length);
  }
  return { mean, dev };
}

/**
 * Every sample within `tolerance` of the reference relative to that sample's
 * own magnitude (no floor of 1), and exactly 0 where the reference is 0.
 */
function assertRelative(actual, expected, label, tolerance) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    if (e == null || e === 0) {
      if (a !== e) assert.fail(`${label}[${i}]: expected ${e}, got ${a}`);
      continue;
    }
    const error = Math.abs(a - e) / Math.abs(e);
    if (!(error <= tolerance)) {
      assert.fail(`${label}[${i}]: ${a} vs reference ${e} (relative error ${error.toExponential(2)})`);
    }
  }
}

/** Stdev to 1e-9 of itself, the basis to 1e-12, and each band to 1e-9 of its width (plus the level's rounding). */
function assertBands(values, length, label) {
  const ref = refWindows(values, length);
  assertRelative(studies.stdev(values, length), ref.dev, `${label} stdev(${length})`, 1e-9);
  assertRelative(studies.sma(values, length), ref.mean, `${label} sma(${length})`, 1e-12);
  const bands = studies.bollinger(values, length, 2);
  assertRelative(bands.mid, ref.mean, `${label} basis(${length})`, 1e-12);
  for (let i = length - 1; i < values.length; i++) {
    for (const [band, sign] of [[bands.upper, 1], [bands.lower, -1]]) {
      const expected = ref.mean[i] + sign * 2 * ref.dev[i];
      const allowed = 1e-9 * 2 * ref.dev[i] + 4 * Number.EPSILON * Math.abs(expected);
      if (!(Math.abs(band[i] - expected) <= allowed)) {
        assert.fail(`${label} ${sign > 0 ? "upper" : "lower"}(${length})[${i}]: ${band[i]} vs reference ${expected}`);
      }
    }
  }
}

/** A price on an exact cent grid moving by at most two cents a bar. */
function centTicks(count, start, seed) {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let cents = Math.round(start * 100);
  return Array.from({ length: count }, () => (cents += Math.round((random() - 0.5) * 4)) / 100);
}

await test("rolling stdev and bands stay exact through cancellation: price level, bad prints, level changes", () => {
  // BTC-like: 60 000 with cent ticks. The spread is ~1e-7 of the level; L=2
  // windows are often exactly flat and must read exactly 0.
  const btc = centTicks(20_000, 60_000, 5);
  assertBands(btc, 20, "cent ticks at 60k");
  assertBands(btc, 2, "cent ticks at 60k");

  // One bad print (1e9, and a 10000x spike) in a 50k series: the bands are
  // exact while it is in the window and the moment it leaves.
  const noise = Array.from({ length: 50_000 }, (_, i) => 50_000 + ((i * 7919) % 500) / 100);
  const spike = noise.map((value, i) => (i === 25_000 ? 1e9 : value));
  assertBands(spike, 20, "1e9 spike");
  assertBands(noise.map((value, i) => (i === 25_000 ? value * 10_000 : value)), 20, "10000x spike");
  const at = 25_000 + 20;
  assert.ok(studies.stdev(spike, 20)[at] > 1, "the deviation recovers as soon as the spike leaves the window");

  // Recurring spikes on a price near 1: the plain SMA stays exact between them.
  const sawtooth = Array.from({ length: 6_000 }, (_, i) => (i % 97 === 0 ? 1e7 : 1 + ((i * 31) % 1000) / 1e6));
  assertBands(sawtooth, 20, "recurring spikes");

  // A 1000:1 level change (a rebase or a unit change mid-history).
  const rebase = Array.from({ length: 6_000 }, (_, i) => (i < 3_000 ? 60_000 : 60) + ((i * 7919) % 1000) / (i < 3_000 ? 20 : 20_000));
  assertBands(rebase, 20, "1000:1 rebase");
  assertBands(rebase, 200, "1000:1 rebase");

  // A volatile stretch followed by a flat one: exactly zero spread, bands on the basis.
  const settle = [...seededWalk(300, 1_000, 50, 4), ...new Array(60).fill(1_000.1)];
  const settled = studies.bollinger(settle, 20, 2);
  for (let i = 300 + 19; i < settle.length; i++) {
    assert.equal(studies.stdev(settle, 20)[i], 0, `flat window ${i} has zero deviation`);
    assert.equal(settled.upper[i], settled.mid[i], `flat window ${i} upper band sits on the basis`);
  }
});

await test("rolling stdev is O(n): matches the naive definition and is window-length independent", () => {
  // 1e-9 relative to the naive two-pass result, far from zero and on a long walk.
  const offset = seededWalk(5_000, 50_000, 25, 3);
  assertSeries(studies.stdev(offset, 20), refStdev(offset, 20), "stdev(20) near 50k", 1e-9);
  const long = seededWalk(200_000, 100, 0.5, 9);
  const fast = studies.stdev(long, 50);
  for (let i = 49; i < long.length; i += 997) {
    const window = long.slice(i - 49, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / 50;
    const naive = Math.sqrt(window.reduce((acc, x) => acc + (x - mean) ** 2, 0) / 50);
    assert.ok(Math.abs(fast[i] - naive) <= 1e-9 * naive, `stdev[${i}] ${fast[i]} vs ${naive}`);
  }

  const big = Array.from({ length: 100_000 }, (_, i) => 50_000 + Math.sin(i / 10) * 100 + (i % 13));
  const best = (fn) => {
    let min = Infinity;
    for (let run = 0; run < 15; run++) {
      const started = performance.now();
      fn();
      min = Math.min(min, performance.now() - started);
    }
    return min;
  };
  best(() => studies.bollinger(big, 200)); // warm up
  const bb200 = best(() => studies.bollinger(big, 200));
  const bb20 = best(() => studies.bollinger(big, 20));
  const bb500 = best(() => studies.bollinger(big, 500));
  console.log(`  bollinger(100k): L=20 ${bb20.toFixed(2)} ms, L=200 ${bb200.toFixed(2)} ms, L=500 ${bb500.toFixed(2)} ms`);
  assert.ok(bb200 < 5, `bollinger(100k, 200) takes ${bb200.toFixed(2)} ms (< 5 ms)`);
  assert.ok(bb500 < bb20 * 2 + 1, "cost does not grow with the window length");
});

console.log(`\nSTUDY REFERENCE: PASS (${passed} checks)`);
