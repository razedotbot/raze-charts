// Price-axis math and formatting: min-tick-aligned ticks with one fixed label
// precision, decade-aware log ticks, auto precision for sub-cent prices,
// cached number formatters, locale-aware labels, and autoscale for negative
// and zero prices with a log fallback.
//
// Bundles the TypeScript sources with esbuild so the internal helpers can be
// exercised directly; runs without a build.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Count Intl.NumberFormat constructions to prove the formatter cache works.
let numberFormatsBuilt = 0;
const NativeNumberFormat = Intl.NumberFormat;
Intl.NumberFormat = new Proxy(NativeNumberFormat, {
  construct(target, args) {
    numberFormatsBuilt++;
    return Reflect.construct(target, args);
  },
  apply(target, thisArg, args) {
    numberFormatsBuilt++;
    return Reflect.apply(target, thisArg, args);
  },
});

const workdir = mkdtempSync(join(tmpdir(), "raze-price-axis-"));
let mod;
try {
  const bundle = await build({
    stdin: {
      contents: [
        'export * from "./src/engine/plotScale.ts";',
        'export * from "./src/util/format.ts";',
        'export { heikinAshi } from "./src/util/heikinAshi.ts";',
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const file = join(workdir, "price-axis.mjs");
  writeFileSync(file, bundle.outputFiles[0].text);
  mod = await import(pathToFileURL(file).href);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

const {
  LOG_TICK_MIN_SPACING,
  autoFitPriceRange,
  computePriceTickMarks,
  computePriceTicks,
  createPriceFormatter,
  decimalsFromPricescale,
  formatAxisPrice,
  formatCompact,
  formatPrice,
  formatVolume,
  fromDisplay,
  heikinAshi,
  priceAxisFormat,
  toDisplay,
  yForPrice,
} = mod;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A price scale over display range [min, max] with an optional symbol. */
function scale({ min, max, plotH = 400, log = false, percent = false, pctBase = 1, symbol, formatter, logFallback }) {
  const s = {
    plotL: 0, plotT: 0, plotW: 600, plotH,
    priceMin: log ? Math.log10(min) : min,
    priceMax: log ? Math.log10(max) : max,
    pctBase,
    visibleRange: { from: 0, to: 100 },
    percentScale: percent,
    logScale: log,
  };
  if (logFallback !== undefined) s.logFallback = logFallback;
  if (symbol || formatter) {
    s.context = { symbolInfo: symbol ?? null, formatPrice: formatter ?? formatPrice };
  }
  return s;
}

const sym = (pricescale, minmov = 1) => ({ pricescale, minmov });

function labels(s, pricescale) {
  return computePriceTicks(s).map((t) => formatAxisPrice(s, t, pricescale));
}

function fractionDigits(label) {
  const dot = label.lastIndexOf(".");
  return dot < 0 ? 0 : label.length - dot - 1;
}

const unique = (xs) => new Set(xs).size === xs.length;

/** Parse an en-US label back to a number. */
const parse = (label) => Number(label.replace(/,/g, ""));

/** The formatter as it shipped before the cache (toLocaleString per call). */
function legacyFormatPrice(value, pricescale) {
  if (!Number.isFinite(value)) return "";
  const decimals = !pricescale || pricescale <= 1 ? 0 : Math.max(0, Math.round(Math.log10(pricescale)));
  if (decimals === 0) return Math.round(value).toLocaleString("en-US");
  const minFrac = Math.min(decimals, 2);
  return value.toLocaleString("en-US", { minimumFractionDigits: minFrac, maximumFractionDigits: decimals });
}

/** The linear tick algorithm as it shipped before min-tick alignment. */
function legacyLinearTicks(s) {
  const target = Math.max(2, Math.floor(s.plotH / 56));
  const range = s.priceMax - s.priceMin;
  if (range <= 0) return [];
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-12))));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const ticks = [];
  for (let d = Math.ceil(s.priceMin / step) * step; d <= s.priceMax; d += step) ticks.push(d);
  return ticks;
}

function bar(time, open, high, low, close) {
  return { time, open, high, low, close, volume: 1 };
}

/** Deterministic pseudo-random walk between `lo` and `hi`. */
function walk(n, lo, hi, seed = 7) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const out = [];
  let p = (lo + hi) / 2;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = Math.min(hi, Math.max(lo, p + (rnd() - 0.5) * (hi - lo) * 0.2));
    const c = p;
    out.push(bar(i * 60_000, o, Math.max(o, c) + rnd() * (hi - lo) * 0.02, Math.min(o, c) - rnd() * (hi - lo) * 0.02, c));
  }
  return out;
}

function fitScale(bars, extra = {}) {
  return {
    plotL: 0, plotT: 0, plotW: 600, plotH: 400,
    priceMin: 0, priceMax: 1, pctBase: 1,
    visibleRange: { from: 0, to: bars.length - 1 },
    percentScale: false, logScale: false,
    ...extra,
  };
}

function captureWarnings(fn) {
  const original = console.warn;
  const messages = [];
  console.warn = (...args) => messages.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return messages;
}

console.log("price axis");

// ── perf-cache-number-formatters ───────────────────────────────────────────

test("formatPrice is byte-identical to the toLocaleString formatter for pricescale 1, 100 and 1e8", () => {
  const values = [
    0, 1, 7, 0.5, 1.005, 12.345, 99.999, 999.995, 1234.5, 89_909, 140_000, 95_499.26, 1e6 + 0.123456789,
    0.0000182, 0.00001738, 0.000157, 0.123456789, 3.14159265358979, -1, -12.5, -95_499.26, -0.0000182,
    123_456_789.987654321, Number.MAX_SAFE_INTEGER, 1e-9, 2.5, 3.5, -2.5,
  ];
  for (let i = 0; i < 400; i++) values.push(Math.sin(i * 12.9898) * 10 ** ((i % 13) - 6));
  for (const pricescale of [1, 100, 1e8]) {
    for (const value of values) {
      const legacy = legacyFormatPrice(value, pricescale);
      // The one deliberate change: a value that rounds to zero no longer prints "-0".
      if (/^-0(\.0*)?$/.test(legacy)) continue;
      assert.equal(formatPrice(value, pricescale), legacy, `formatPrice(${value}, ${pricescale})`);
    }
  }
  assert.equal(formatPrice(Number.NaN, 100), "");
  assert.equal(formatPrice(Infinity, 100), "");
});

test("a value that rounds to zero never prints a minus sign", () => {
  assert.equal(formatPrice(-0.001, 100), "0.00");
  assert.equal(formatPrice(-0.3, 1), "0");
  assert.equal(formatPrice(-0, 1e8), "0.00");
  const s = scale({ min: -1, max: 1, symbol: sym(100) });
  assert.equal(formatAxisPrice(s, -0.001, 100), "0.00");
  const pct = scale({ min: -5, max: 5, percent: true, pctBase: 100 });
  assert.equal(formatAxisPrice(pct, 99.99999, 100), "+0.00%");
});

test("formatters are cached: repeated formatting builds no new Intl.NumberFormat", () => {
  // Warm every formatter the loop needs.
  for (const ps of [1, 100, 1e8]) formatPrice(1.5, ps);
  const s = scale({ min: 90_000, max: 100_000, symbol: sym(100) });
  formatAxisPrice(s, 95_000, 100);
  formatVolume(1234);
  formatCompact(12);
  const before = numberFormatsBuilt;
  const started = performance.now();
  for (let i = 0; i < 20_000; i++) {
    formatPrice(90_000 + i * 0.37, 100);
    formatPrice(i * 1e-7, 1e8);
    formatPrice(i, 1);
    formatAxisPrice(s, 90_000 + i * 0.5, 100);
    formatCompact(i % 999);
  }
  const elapsed = performance.now() - started;
  assert.equal(numberFormatsBuilt - before, 0, "no Intl.NumberFormat built inside the hot loop");
  console.log(`      (100k cached labels in ${elapsed.toFixed(1)} ms)`);
});

test("formatCompact keeps a single minus sign for negative values", () => {
  assert.equal(formatCompact(-1500), "-1.5K");
  assert.equal(formatCompact(-2_500_000), "-2.5M");
  assert.equal(formatCompact(1500), "1.5K");
  assert.equal(formatCompact(-12), "-12");
  assert.equal(formatVolume(-1_234_567), "-1.23M");
});

// ── series-axis-precision-inconsistent ──────────────────────────────────────

test("ticks are multiples of minmov/pricescale (minmov 25, pricescale 100)", () => {
  for (const [min, max] of [[4490, 4510], [4499, 4501], [4499.6, 4500.9], [4000, 5000]]) {
    const s = scale({ min, max, symbol: sym(100, 25) });
    const ticks = computePriceTicks(s);
    assert.ok(ticks.length >= 2, `${min}..${max} has ticks`);
    for (const t of ticks) {
      assert.ok(Math.abs(t * 4 - Math.round(t * 4)) < 1e-9, `${t} is a multiple of 0.25`);
    }
    const ls = labels(s, 100);
    assert.ok(unique(ls), `labels distinct: ${ls.join(" ")}`);
    assert.ok(ls.every((l) => fractionDigits(l) === 2), `one precision: ${ls.join(" ")}`);
    assert.ok(!ls.includes("4,500.10"));
  }
});

test("ticks are multiples of minmov/pricescale (minmov 100, pricescale 100 = whole units)", () => {
  const s = scale({ min: 101.3, max: 104.9, symbol: sym(100, 100) });
  const ticks = computePriceTicks(s);
  assert.ok(ticks.length >= 2);
  assert.ok(ticks.every((t) => Number.isInteger(t)), `whole-unit ticks: ${ticks.join(" ")}`);
  assert.equal(priceAxisFormat(s, 100).minTick, 1);
});

test("pricescale 1e8: one fixed precision across the axis column", () => {
  const s = scale({ min: 0.0000170, max: 0.0000190, symbol: sym(1e8) });
  const ls = labels(s, 1e8);
  assert.ok(ls.length >= 3);
  assert.ok(unique(ls), ls.join(" "));
  assert.ok(ls.every((l) => fractionDigits(l) === 8), `8 decimals everywhere: ${ls.join(" ")}`);
  for (const t of computePriceTicks(s)) {
    assert.ok(Math.abs(t * 1e8 - Math.round(t * 1e8)) < 1e-6, `${t} on the 1e-8 grid`);
  }
  // The crosshair and last-price labels share the column's precision.
  assert.equal(formatAxisPrice(s, 0.0000182, 1e8), "0.00001820");
});

test("the crosshair price rounds to the min tick", () => {
  const s = scale({ min: 4490, max: 4510, symbol: sym(100, 25) });
  assert.equal(formatAxisPrice(s, 4500.1, 100), "4,500.00");
  assert.equal(formatAxisPrice(s, 4500.13, 100), "4,500.25");
  assert.equal(formatAxisPrice(s, 4500.374, 100), "4,500.25");
  assert.equal(formatAxisPrice(s, 4500.376, 100), "4,500.50");
  const whole = scale({ min: 90, max: 110, symbol: sym(1) });
  assert.equal(formatAxisPrice(whole, 100.49, 1), "100");
});

test("the number format honours options.locale ('de', TradingView 'pt_BR')", () => {
  const de = createPriceFormatter({ locale: "de" }, sym(100, 25));
  const s = scale({ min: 4490, max: 4510, symbol: sym(100, 25), formatter: de });
  assert.equal(formatAxisPrice(s, 4500.13, 100), "4.500,25");
  const ls = labels(s, 100);
  assert.ok(ls.every((l) => /^\d\.\d{3},\d{2}$/.test(l)), `German grouping and decimals: ${ls.join(" ")}`);
  assert.equal(de(95_000, 100), "95.000,00", "legend/crosshair formatter uses the locale too");
  const ptBR = createPriceFormatter({ locale: "pt_BR" }, null);
  assert.equal(ptBR(1234.5, 100), "1.234,50");
  const en = createPriceFormatter({}, null);
  assert.equal(en, formatPrice, "no locale keeps the en-US built-in formatter");
  assert.equal(createPriceFormatter({ locale: "de" }, null), de, "one built-in formatter per locale");
});

test("an invalid locale warns once and falls back to en-US", () => {
  let fmt;
  const warnings = captureWarnings(() => {
    fmt = createPriceFormatter({ locale: "not a locale!" }, null);
    createPriceFormatter({ locale: "not a locale!" }, null);
  });
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /locale "not a locale!"/);
  assert.equal(fmt(1234.5, 100), "1,234.50");
});

test("custom formatters receive the raw price and own their digits", () => {
  const seen = [];
  const custom = (value, pricescale) => {
    seen.push([value, pricescale]);
    return `$${value}`;
  };
  const s = scale({ min: 4490, max: 4510, symbol: sym(100, 25), formatter: custom });
  assert.equal(formatAxisPrice(s, 4500.13, 100), "$4500.13");
  assert.deepEqual(seen, [[4500.13, 100]]);
  const factory = createPriceFormatter(
    { custom_formatters: { priceFormatterFactory: () => ({ format: (p) => `<${p}>` }) } },
    sym(100),
  );
  assert.equal(factory(1.5, 100), "<1.5>");
  const broken = createPriceFormatter({ raze: { format_price: () => { throw new Error("boom"); } }, locale: "de" }, null);
  assert.equal(broken(1.5, 100), "1,50", "a throwing custom formatter falls back to the built-in in the widget locale");
});

test("tick labels match computePriceTickMarks", () => {
  const s = scale({ min: 60_000, max: 100_000, symbol: sym(100) });
  const marks = computePriceTickMarks(s);
  assert.deepEqual(marks.map((m) => m.price), computePriceTicks(s));
  assert.deepEqual(marks.map((m) => m.label), labels(s, 100));
});

// ── perf-auto-precision ─────────────────────────────────────────────────────

test("tinyPrices (1e-5 prices, pricescale 100): axis labels are pairwise distinct", () => {
  const bars = walk(120, 0.0000095, 0.0000105);
  const fit = autoFitPriceRange(bars, fitScale(bars), true, null);
  const s = { ...scale({ min: fit.priceMin, max: fit.priceMax, symbol: sym(100) }), pctBase: fit.pctBase };
  const ls = labels(s, 100);
  assert.ok(ls.length >= 3, ls.join(" "));
  assert.ok(unique(ls), `distinct: ${ls.join(" ")}`);
  assert.ok(!ls.includes("0.00"), ls.join(" "));
  const format = priceAxisFormat(s, 100);
  assert.equal(format.aligned, false, "the axis leaves the too-coarse tick grid");
  assert.ok(ls.every((l) => fractionDigits(l) === format.decimals), "one raised precision for the column");
  assert.ok(format.decimals > 2);
});

test("with a correct pricescale the axis output is unchanged", () => {
  const cases = [
    [{ min: 87_000, max: 100_500, plotH: 400 }, 100],
    [{ min: 6_100, max: 7_300, plotH: 338 }, 1],
    [{ min: 6_100, max: 7_300, plotH: 612 }, 1],
    [{ min: 1.0812, max: 1.0934, plotH: 500 }, 100_000],
    [{ min: 18.4, max: 23.9, plotH: 280 }, 100],
    [{ min: 142.07, max: 151.93, plotH: 900 }, 100],
  ];
  for (const [range, pricescale] of cases) {
    const s = scale({ ...range, symbol: sym(pricescale) });
    const expected = legacyLinearTicks(s);
    const actual = computePriceTicks(s);
    assert.equal(actual.length, expected.length, `tick count for ${JSON.stringify(range)}`);
    actual.forEach((t, i) => assert.ok(Math.abs(t - expected[i]) <= 1e-9 * Math.abs(t), `${t} vs ${expected[i]}`));
    const legacyLabels = expected.map((t) => legacyFormatPrice(t, pricescale));
    if (pricescale <= 100) {
      assert.deepEqual(labels(s, pricescale), legacyLabels, `labels for ${JSON.stringify(range)}`);
    }
  }
});

// ── series-log-scale-ticks ──────────────────────────────────────────────────

function assertRoundLogTicks(s, pricescale, note) {
  const ticks = computePriceTicks(s);
  const ls = labels(s, pricescale);
  assert.ok(ticks.length >= 2, `${note}: at least two ticks`);
  assert.ok(unique(ls), `${note}: distinct labels ${ls.join(" ")}`);
  const decimals = decimalsFromPricescale(pricescale);
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    // Every tick equals its label at the symbol precision (a round price).
    const rounded = Math.round(t * 10 ** decimals) / 10 ** decimals;
    assert.ok(Math.abs(t - rounded) <= 1e-12 * Math.max(1, t), `${note}: ${t} is a price at ${decimals} decimals`);
    assert.equal(parse(ls[i]), rounded, `${note}: label ${ls[i]} reads the tick`);
    assert.equal(formatAxisPrice(s, rounded, pricescale), ls[i]);
    // Round: at most three significant digits (70,000 / 75,000 / 0.0000175).
    const mag = 10 ** Math.floor(Math.log10(t));
    const sig = t / mag;
    assert.ok(Math.abs(sig * 100 - Math.round(sig * 100)) < 1e-6, `${note}: ${t} is a round price`);
    if (i > 0) {
      const gap = yForPrice(s, ticks[i - 1]) - yForPrice(s, t);
      assert.ok(gap >= LOG_TICK_MIN_SPACING - 1e-6, `${note}: ${ticks[i - 1]} → ${t} is ${gap.toFixed(1)}px apart`);
    }
  }
  assert.ok(ls.every((l) => fractionDigits(l) === fractionDigits(ls[0])), `${note}: one precision ${ls.join(" ")}`);
  return ticks;
}

test("log ticks on a narrow BTC range are round prices (no 95,499.26)", () => {
  const s = scale({ min: 68_000, max: 101_000, log: true, symbol: sym(100) });
  const ticks = assertRoundLogTicks(s, 100, "btc");
  for (const p of [70_000, 80_000, 90_000, 100_000]) assert.ok(ticks.includes(p), `includes ${p}: ${ticks.join(" ")}`);
  assert.ok(labels(s, 100).every((l) => l.endsWith(".00")));
});

test("log ticks over several decades are 1 / 2 / 5 × 10ⁿ", () => {
  const s = scale({ min: 1, max: 10_000, plotH: 800, log: true, symbol: sym(100) });
  const ticks = assertRoundLogTicks(s, 100, "decades");
  for (const p of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000]) {
    assert.ok(ticks.includes(p), `includes ${p}: ${ticks.join(" ")}`);
  }
  const tight = scale({ min: 1, max: 10_000, plotH: 200, log: true, symbol: sym(100) });
  assert.deepEqual(assertRoundLogTicks(tight, 100, "decades-tight"), [1, 10, 100, 1000, 10_000]);
  const wide = scale({ min: 1e-6, max: 1e6, plotH: 300, log: true, symbol: sym(1e8) });
  const w = computePriceTicks(wide);
  assert.ok(w.every((t) => Number.isInteger(Math.log10(t))), `powers of ten only: ${w.join(" ")}`);
  assert.ok(w.length >= 3);
});

test("log ticks for a sub-cent meme coin are round and distinct", () => {
  const s = scale({ min: 0.0000170, max: 0.0000212, log: true, symbol: sym(1e8) });
  assertRoundLogTicks(s, 1e8, "meme");
  // Mis-set pricescale (100): the axis falls back to round sub-tick prices.
  const coarse = scale({ min: 0.0000170, max: 0.0000212, log: true, symbol: sym(100) });
  const ls = labels(coarse, 100);
  assert.ok(ls.length >= 2 && unique(ls) && !ls.includes("0.00"), ls.join(" "));
});

test("log ticks respect minmov", () => {
  const s = scale({ min: 3000, max: 6000, log: true, symbol: sym(100, 25) });
  for (const t of computePriceTicks(s)) assert.ok(Math.abs(t * 4 - Math.round(t * 4)) < 1e-9, `${t}`);
});

// ── series-negative-and-zero-prices ────────────────────────────────────────

test("a -20..+5 series autoscales", () => {
  const bars = walk(200, -20, 5);
  bars[10] = bar(600_000, -18, -17, -20, -19.5);
  bars[20] = bar(1_200_000, 4, 5, 3.5, 4.8);
  const fit = autoFitPriceRange(bars, fitScale(bars), true, null);
  assert.equal(fit.logFallback, false);
  assert.ok(fit.priceMin < -20 && fit.priceMin > -25, `priceMin ${fit.priceMin}`);
  assert.ok(fit.priceMax > 5 && fit.priceMax < 10, `priceMax ${fit.priceMax}`);
  const s = { ...fitScale(bars), ...fit, context: { symbolInfo: sym(100), formatPrice } };
  const ls = labels(s, 100);
  assert.ok(ls.some((l) => l.startsWith("-")) && ls.includes("0.00"), ls.join(" "));
});

test("all-negative data autoscales (WTI at -37, spreads)", () => {
  const bars = walk(100, -80, -60);
  bars[5] = bar(300_000, -79, -78.5, -80, -79.5);
  bars[50] = bar(3_000_000, -61, -60, -61.5, -60.5);
  const fit = autoFitPriceRange(bars, fitScale(bars), true, null);
  assert.ok(fit.priceMin < -79 && fit.priceMin > -90, `priceMin ${fit.priceMin}`);
  assert.ok(fit.priceMax > -61 && fit.priceMax < -50, `priceMax ${fit.priceMax}`);
  const flat = Array.from({ length: 20 }, (_, i) => bar(i, -37.63, -37.63, -37.63, -37.63));
  const f = autoFitPriceRange(flat, fitScale(flat), true, null);
  assert.ok(f.priceMin < -37.63 && f.priceMax > -37.63, `flat negative ${f.priceMin}..${f.priceMax}`);
  assert.ok(f.priceMax - f.priceMin < 2);
});

test("zero-crossing and all-zero data autoscale", () => {
  const crossing = Array.from({ length: 50 }, (_, i) => {
    const c = Math.sin(i / 5) * 3;
    return bar(i, c - 0.2, c + 0.5, c - 0.5, c);
  });
  const fit = autoFitPriceRange(crossing, fitScale(crossing), true, null);
  assert.ok(fit.priceMin < -3 && fit.priceMax > 3, `${fit.priceMin}..${fit.priceMax}`);
  const zeros = Array.from({ length: 20 }, (_, i) => bar(i, 0, 0, 0, 0));
  const z = autoFitPriceRange(zeros, fitScale(zeros), true, null);
  assert.ok(z.priceMin < 0 && z.priceMax > 0, `all-zero ${z.priceMin}..${z.priceMax}`);
  assert.ok(Math.abs(z.priceMin + z.priceMax) < 1e-9, "all-zero data is centred");
});

test("a close of 0 is a price; a non-finite close is whitespace", () => {
  const bars = [bar(0, 10, 11, 9, 10), bar(1, 0.5, 0.6, 0, 0), bar(2, 10, 12, 9, 11)];
  const fit = autoFitPriceRange(bars, fitScale(bars), true, null);
  assert.ok(fit.priceMin < 0, `zero close counts: ${fit.priceMin}`);
  const gapped = [
    bar(0, 10, 11, 9, 10),
    { time: 1, open: Number.NaN, high: Number.NaN, low: Number.NaN, close: Number.NaN },
    { time: 2, open: null, high: null, low: null, close: null },
    { time: 3 },
    bar(4, 10, 12, 9, 11),
  ];
  const g = autoFitPriceRange(gapped, fitScale(gapped), true, null);
  assert.ok(g.priceMin > 8 && g.priceMax < 13, `whitespace ignored: ${g.priceMin}..${g.priceMax}`);
  assert.ok(Number.isFinite(g.pctBase));
});

test("positive data fits exactly as before", () => {
  const bars = walk(300, 6100, 7300);
  const fit = autoFitPriceRange(bars, fitScale(bars), true, null);
  // Reference: the positive-only algorithm that shipped before.
  let bodyHi = -Infinity, bodyLo = Infinity, hi = -Infinity, lo = Infinity;
  for (const b of bars) {
    bodyHi = Math.max(bodyHi, b.open, b.close);
    bodyLo = Math.min(bodyLo, b.open, b.close);
    hi = Math.max(hi, b.high);
    lo = Math.min(lo, b.low);
  }
  const wickRoom = Math.max(bodyHi - bodyLo, bodyHi * 0.06);
  hi = Math.min(hi, bodyHi + wickRoom);
  lo = Math.max(Math.max(0, bodyLo - wickRoom), lo);
  const pad = (hi - lo) * 0.08;
  assert.equal(fit.priceMin, lo - pad);
  assert.equal(fit.priceMax, hi + pad);
  assert.equal(fit.pctBase, bars[0].close);
});

test("percent mode with a negative base keeps up as up", () => {
  const s = scale({ min: -10, max: 10, percent: true, pctBase: -20 });
  assert.equal(toDisplay(s, -20), 0);
  assert.equal(toDisplay(s, -18), 10);
  assert.equal(toDisplay(s, -22), -10);
  assert.equal(fromDisplay(s, 10), -18);
  assert.equal(formatAxisPrice(s, -18, 100), "+10.00%");
  const bars = walk(50, -20, -10);
  const fit = autoFitPriceRange(bars, fitScale(bars, { percentScale: true }), true, null);
  assert.equal(fit.pctBase, bars[0].close);
  assert.ok(fit.priceMin < fit.priceMax);
});

test("log scale falls back to linear with one warning when the data reaches <= 0", () => {
  const negative = walk(100, -20, 5);
  negative[3] = bar(180_000, -19, -18, -20, -19.5);
  negative[60] = bar(3_600_000, 4, 5, 3.8, 4.7);
  let fit;
  const warnings = captureWarnings(() => {
    fit = autoFitPriceRange(negative, fitScale(negative, { logScale: true }), true, null);
    autoFitPriceRange(negative, fitScale(negative, { logScale: true }), true, null);
    autoFitPriceRange([bar(0, 0, 1, 0, 1)], fitScale([bar(0, 0, 1, 0, 1)], { logScale: true }), true, null);
  });
  assert.equal(fit.logFallback, true);
  assert.ok(fit.priceMin < -20 && fit.priceMax > 5, `linear bounds: ${fit.priceMin}..${fit.priceMax}`);
  assert.equal(warnings.length, 1, "a single warning");
  assert.match(warnings[0], /Log scale needs prices above zero/);

  const s = { ...fitScale(negative, { logScale: true }), ...fit };
  assert.equal(toDisplay(s, -12), -12, "the fallback scale maps prices linearly");
  assert.equal(fromDisplay(s, -12), -12);
  assert.ok(computePriceTicks(s).some((t) => t < 0));

  const positive = walk(100, 100, 200);
  const ok = autoFitPriceRange(positive, fitScale(positive, { logScale: true }), true, null);
  assert.equal(ok.logFallback, false, "positive data keeps the log scale");
  assert.ok(ok.priceMax < 3, "display bounds are log10 prices");

  const manual = autoFitPriceRange(positive, fitScale(positive, { logScale: true }), false, { min: -5, max: 250 });
  assert.equal(manual.logFallback, true, "a manual range through zero cannot be log");
  assert.equal(manual.priceMin, -5);
});

// ── Heikin-Ashi with negative prices and whitespace ─────────────────────────

test("Heikin-Ashi keeps negative lows and passes whitespace through", () => {
  const bars = [bar(0, -5, -2, -9, -3), bar(1, -3, 1, -4, 0), { time: 2, open: NaN, high: NaN, low: NaN, close: NaN }, bar(3, 0, 2, -1, 1)];
  const ha = heikinAshi(bars);
  assert.equal(ha.length, 4);
  assert.equal(ha[0].low, -9, "negative low preserved");
  assert.equal(ha[1].low, Math.min(-4, ha[1].open, ha[1].close));
  assert.ok(Number.isNaN(ha[2].close), "whitespace stays whitespace");
  assert.equal(ha[3].open, (ha[1].open + ha[1].close) / 2, "whitespace does not seed the next bar");
  const positive = walk(50, 100, 120);
  const legacy = [];
  let po = 0, pc = 0;
  positive.forEach((b, i) => {
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = i === 0 ? (b.open + b.close) / 2 : (po + pc) / 2;
    legacy.push({ time: b.time, open, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), close, volume: b.volume });
    po = open;
    pc = close;
  });
  assert.deepEqual(heikinAshi(positive), legacy, "positive data is unchanged");
});

console.log(`price-axis: ${passed} passed`);
