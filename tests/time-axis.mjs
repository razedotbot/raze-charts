// Financial time axis, display timezone and crosshair (W1B-05).
//
// Bundles the painters and the time core from source with esbuild and paints
// into a recording canvas, so the assertions read exactly what the widget
// draws: tick labels in the display zone (DST-correct, calendar-aligned,
// pixel-per-bar density), crosshair time labels, the synced crosshair across
// layout panes, the volume-pane readout, price ticks that carry their own
// label, zone-aware session breaks and the chart timezone API. The results
// are identical under several process time zones (child processes).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fingerprintOnly = process.env.RAZE_TIME_AXIS_FINGERPRINT === "1";

const entry = `
export * from "./src/util/time/index.ts";
export { FinancialTimeAxis, assertTimezoneSetting, resolveDisplayTimeZone } from "./src/engine/timeAxis.ts";
export { TimeIndex } from "./src/data/TimeIndex.ts";
export * from "./src/engine/paint/axes.ts";
export { drawCrosshair, formatVolumeLabel } from "./src/engine/paint/crosshair.ts";
export { drawSessionBreaks } from "./src/engine/paint/session.ts";
export { drawAxisChrome } from "./src/engine/paint/chrome.ts";
export { createChartContext, buildFeatureSet } from "./src/core/context.ts";
export { ChartApi } from "./src/core/ChartApi.ts";
export { buildTheme } from "./src/core/theme.ts";
export { createPriceFormatter } from "./src/util/format.ts";
export { TIME_AXIS_H } from "./src/engine/layout.ts";
`;
const workdir = mkdtempSync(join(tmpdir(), "raze-time-axis-"));
let m;
try {
  const bundle = await build({
    stdin: { contents: entry, resolveDir: root, loader: "ts", sourcefile: "time-axis-entry.ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: ["es2020"],
    write: false,
    logLevel: "silent",
    define: { __RAZE_CHARTS_VERSION__: JSON.stringify("test") },
  });
  const file = join(workdir, "time-axis.mjs");
  writeFileSync(file, bundle.outputFiles[0].text);
  m = await import(pathToFileURL(file).href);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

const {
  ChartApi,
  DAY_MS,
  FinancialTimeAxis,
  HOUR_MS,
  TIME_AXIS_H,
  TIME_LABEL_MIN_SPACING,
  TimeIndex,
  barTicks,
  buildFeatureSet,
  buildTheme,
  calendarTicks,
  computeTickWeights,
  computeTimeAxisTicks,
  createChartContext,
  createPriceFormatter,
  displayTimeZoneId,
  drawCrosshair,
  drawPriceAxis,
  drawSessionBreaks,
  drawAxisChrome,
  drawTimeAxis,
  floorToCalendar,
  floorWall,
  formatCrosshairTimeLabel,
  formatVolumeLabel,
  getTimeZone,
  wallFromFields,
} = m;

const MIN = 60_000;
const CHAR_W = 6.2;
let checks = 0;
const ok = (value, message) => {
  assert.ok(value, message);
  checks++;
};

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Equity-style 1-minute sessions (09:30-16:00 local, weekdays) in `zoneId`. */
function sessions(days, zoneId, start = Date.UTC(2024, 0, 2)) {
  const zone = getTimeZone(zoneId);
  const bars = [];
  for (let day = start; bars.length < days * 390; day += DAY_MS) {
    const wd = new Date(day).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const d = new Date(day);
    const open = zone.fromWall(wallFromFields(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9, 30));
    for (let i = 0; i < 390; i++) bars.push(bar(open + i * MIN, i));
  }
  return bars;
}

function series(start, end, step, { weekdays = false } = {}) {
  const out = [];
  for (let t = start, i = 0; t < end; t += step, i++) {
    const wd = new Date(t).getUTCDay();
    if (weekdays && (wd === 0 || wd === 6)) continue;
    out.push(bar(t, i));
  }
  return out;
}

function bar(time, i = 0, volume = 1000 + (i % 7) * 100) {
  const base = 100 + Math.sin(i / 9) * 20;
  return { time, open: base, high: base + 2, low: base - 2, close: base + 1, volume };
}

/** A canvas that records what is drawn. Text is `CHAR_W` px per character. */
function recorder() {
  const ops = [];
  const state = { font: "", fillStyle: "", strokeStyle: "", textAlign: "", textBaseline: "", lineWidth: 1, globalAlpha: 1 };
  const target = {
    ...state,
    measureText: (text) => ({ width: String(text).length * CHAR_W }),
    fillText(text, x, y) { ops.push({ op: "fillText", text: String(text), x, y, font: target.font, fillStyle: target.fillStyle }); },
    moveTo(x, y) { ops.push({ op: "moveTo", x, y }); },
    lineTo(x, y) { ops.push({ op: "lineTo", x, y }); },
    fillRect(x, y, w, h) { ops.push({ op: "fillRect", x, y, w, h }); },
  };
  const ctx = new Proxy(target, {
    get: (t, p) => (p in t ? t[p] : () => {}),
    set: (t, p, v) => {
      t[p] = v;
      return true;
    },
  });
  return { ctx, ops, texts: () => ops.filter((o) => o.op === "fillText").map((o) => o.text) };
}

class Emitter {
  constructor() { this.listeners = []; }
  subscribe(_obj, fn) { this.listeners.push(fn); }
  unsubscribe(_obj, fn) { this.listeners = this.listeners.filter((l) => l !== fn); }
  unsubscribeAll() { this.listeners = []; }
  fire(...args) { for (const fn of this.listeners.slice()) fn(...args); }
}

function makeContext({ options = {}, bars = [], resolution = "1", symbol = "TEST", symbolInfo = null, volumeMode = "overlay", locale = "en" } = {}) {
  const opts = { symbol, interval: resolution, container: "x", datafeed: {}, ...options };
  const paints = { count: 0 };
  const ctx = createChartContext({
    options: opts,
    datafeed: opts.datafeed,
    locale,
    fontFamily: "Arial",
    symbol,
    resolution,
    symbolInfo,
    formatPrice: createPriceFormatter(opts, null),
    theme: buildTheme(opts),
    features: buildFeatureSet(opts),
    bars,
    marks: [],
    timescaleMarks: [],
    visibleRange: { from: 0, to: Math.max(1, bars.length) },
    autoScalePrice: true,
    priceRange: null,
    chartStyle: "candles",
    logScale: false,
    percentScale: false,
    volumeMode,
    magnet: false,
    stayInDrawingMode: false,
    compare: [],
    syncedCrosshair: null,
    drawingTool: "cursor",
    selectedShapeId: null,
    selectedTradingLineId: null,
    intervalChanged: new Emitter(),
    dataChanged: new Emitter(),
    drawingEvent: new Emitter(),
    tradingEvent: new Emitter(),
    viewportChanged: new Emitter(),
    crosshairMoved: new Emitter(),
    requestPaint: () => { paints.count++; },
  }, { clock: () => Date.UTC(2024, 0, 15, 12) });
  return { ctx, paints };
}

/** A FinanceView over `ctx` whose plot is `plotW` px wide and shows bars [from, to]. */
function makeView(ctx, { plotW = 1002, plotH = 400, from = 0, to = ctx.bars.length, volumePane = null, subPanes = [], priceMin = 0, priceMax = 200 } = {}) {
  ctx.visibleRange = { from, to };
  const top = volumePane ? volumePane.top + volumePane.h : plotH;
  return {
    plotL: 0, plotT: 0, plotW, plotH, priceMin, priceMax, pctBase: 1,
    visibleRange: ctx.visibleRange, percentScale: false, logScale: false,
    context: ctx, cssWidth: plotW + 60, cssHeight: top + TIME_AXIS_H, dpr: 1, priceAxisW: 60,
    subPanes, volumePane, seriesBars: ctx.bars,
    crosshair: { x: 0, y: 0, active: false },
    fontFamily: "Arial",
    axisTags: [],
    axisChromeRect: { x: plotW, y: top, w: 60, h: TIME_AXIS_H },
    markScreen: [], shapeScreen: [], tradingScreen: [], timescaleMarkScreen: [],
    hoverMark: null, hoverTimescaleMark: null, hoverShapeId: null, draft: null,
    selectedShapeId: null, selectedTradingLineId: null,
  };
}

/** Paint the time axis and return the drawn labels with their x centres. */
function paintAxis(v) {
  const rec = recorder();
  const ticks = computeTimeAxisTicks(rec.ctx, v);
  drawTimeAxis(rec.ctx, v, ticks);
  const drawn = rec.ops.filter((o) => o.op === "fillText").map((o) => ({ label: o.text, x: o.x, bold: o.font.startsWith("600") }));
  return { ticks, drawn, labels: drawn.map((d) => d.label) };
}

/** The x → index transform of makeView (plotL 0, bar centres at +0.5). */
const indexAtX = (v, x) => v.visibleRange.from + x / (v.plotW / (v.visibleRange.to - v.visibleRange.from)) - 0.5;
const xOf = (v, index) => (index - v.visibleRange.from + 0.5) * (v.plotW / (v.visibleRange.to - v.visibleRange.from));

// ── Fingerprint: identical output under every process time zone ────────────

function fingerprint() {
  const out = {};
  for (const zone of ["America/New_York", "Asia/Tokyo", "Australia/Sydney", "Etc/UTC"]) {
    const bars = series(Date.UTC(2026, 10, 1, 12) - 47 * HOUR_MS, Date.UTC(2026, 10, 1, 13), HOUR_MS);
    const { ctx } = makeContext({ options: { timezone: zone }, bars, resolution: "60" });
    const v = makeView(ctx, { plotW: 1400 });
    out[zone] = {
      axis: paintAxis(v).labels,
      crosshair: formatCrosshairTimeLabel(ctx, bars[bars.length - 1].time),
      floor: floorToCalendar(Date.UTC(2024, 10, 3, 6, 30, 30), "hour", 1, zone),
    };
  }
  out.local = new Date(Date.UTC(2024, 0, 1, 12)).getHours();
  return out;
}

if (fingerprintOnly) {
  process.stdout.write(JSON.stringify(fingerprint()));
  process.exit(0);
}

// ── W1A-05 leftovers in the time core ───────────────────────────────────────

// floorToCalendar inside the repeated fall-back hour floors to the pass that contains the instant.
{
  const ny = "America/New_York";
  assert.equal(floorToCalendar(Date.UTC(2024, 10, 3, 6, 30, 30), "hour", 1, ny), Date.UTC(2024, 10, 3, 6), "second 01:30 floors to 01:00 EST");
  assert.equal(floorToCalendar(Date.UTC(2024, 10, 3, 5, 30), "hour", 1, ny), Date.UTC(2024, 10, 3, 5), "first 01:30 floors to 01:00 EDT");
  assert.equal(floorToCalendar(Date.UTC(2024, 10, 3, 6, 47), "minute", 15, ny), Date.UTC(2024, 10, 3, 6, 45));
  assert.equal(floorToCalendar(Date.UTC(2024, 10, 3, 6, 5), "day", 1, ny), Date.UTC(2024, 10, 3, 4), "days still floor to local midnight");
  assert.equal(floorToCalendar(Date.UTC(2024, 3, 6, 16, 20), "hour", 1, "Australia/Sydney"), Date.UTC(2024, 3, 6, 16), "Sydney's second 02:20 floors to 02:00 AEST");
  // Property sweep over both fall-back days and a spring-forward day: the
  // period start is never after the instant, lies less than a period before
  // it, and reads the floored local wall time.
  for (const [zoneId, start] of [[ny, Date.UTC(2024, 10, 3, 2)], ["Australia/Sydney", Date.UTC(2024, 3, 6, 12)], [ny, Date.UTC(2024, 2, 10, 4)]]) {
    const zone = getTimeZone(zoneId);
    for (const [unit, step, size] of [["minute", 1, MIN], ["minute", 5, 5 * MIN], ["minute", 15, 15 * MIN], ["minute", 30, 30 * MIN], ["hour", 1, HOUR_MS]]) {
      for (let t = start; t < start + 6 * HOUR_MS; t += 7 * MIN + 13_000) {
        const floored = floorToCalendar(t, unit, step, zone);
        ok(floored <= t && t - floored < size, `${zoneId} ${step} ${unit} at ${new Date(t).toISOString()}: ${new Date(floored).toISOString()} starts the period`);
        assert.equal(zone.toWall(floored), floorWall(zone.toWall(t), unit, step), `${zoneId} ${step} ${unit}: floored wall time`);
      }
    }
  }
}

// calendarTicks never truncates a wide axis: every year up to the right edge.
{
  for (const [width, minSpacing] of [[30000, 3], [16000, 1]]) {
    const ticks = calendarTicks({ from: Date.UTC(2020, 0, 1), to: Date.UTC(2024, 0, 1), width, minSpacing });
    const years = ticks.filter((t) => t.unit === "year").map((t) => t.label);
    assert.deepEqual(years, ["2020", "2021", "2022", "2023", "2024"], `${width}px @${minSpacing}: every year boundary`);
    ok(ticks[ticks.length - 1].x > width * 0.99, `${width}px @${minSpacing}: ticks reach the right edge (${ticks[ticks.length - 1].x})`);
    ok(ticks.length > 100, `${width}px @${minSpacing}: still a dense axis (${ticks.length})`);
    for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].x - ticks[i - 1].x >= minSpacing - 1e-6);
  }
}

// barTicks on a narrow axis with room for two labels shows two (the seed 777
// fuzz fixture: ten years of gapped Tokyo dailies in 65 px, where a lone
// '2030' used to block both neighbours).
{
  let seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bars = [];
  for (let t = Date.UTC(2025, 0, 27); t <= Date.UTC(2034, 10, 2); t += DAY_MS) if (rnd() < 0.4834) bars.push({ time: t });
  const weights = computeTickWeights(bars, "Asia/Tokyo");
  const n = Math.floor(65 / 0.038);
  const ticks = barTicks({ bars, weights, from: bars.length - n, to: bars.length - 1, barSpacing: 0.038, minSpacing: 32, timeZone: "Asia/Tokyo" });
  ok(ticks.length >= 2, `narrow ten-year axis shows two labels (${ticks.map((t) => t.label)})`);
  for (let i = 1; i < ticks.length; i++) ok(ticks[i].x - ticks[i - 1].x >= 32, "and keeps them 32 px apart");

  // Fuzz: random gapped series, zones, spacings and narrow widths.
  const zones = ["Etc/UTC", "Asia/Tokyo", "America/New_York", "Australia/Sydney"];
  let failures = 0;
  for (let s0 = 1; s0 <= 60; s0++) {
    seed = s0 * 7919;
    const step = [MIN, 5 * MIN, HOUR_MS, DAY_MS, 7 * DAY_MS][s0 % 5];
    const keep = 0.2 + rnd() * 0.8;
    const pts = [];
    let t = Date.UTC(2000 + Math.floor(rnd() * 30), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28));
    const count = 200 + Math.floor(rnd() * 3000);
    while (pts.length < count) pts.push({ time: (t += step * (rnd() < keep ? 1 : 1 + Math.floor(rnd() * 50))) });
    const zone = zones[s0 % 4];
    const w = computeTickWeights(pts, zone);
    for (let k = 0; k < 20; k++) {
      const width = 30 + rnd() * 150;
      const minSpacing = 20 + rnd() * 60;
      const bs = Math.exp(Math.log(0.005) + rnd() * Math.log(40 / 0.005));
      const span = Math.max(2, Math.min(pts.length, Math.floor(width / bs)));
      const from = Math.floor(rnd() * (pts.length - span + 1));
      const tk = barTicks({ bars: pts, weights: w, from, to: from + span - 1, barSpacing: bs, minSpacing, timeZone: zone });
      if (tk.length < Math.min(2, Math.floor(((span - 1) * bs) / minSpacing))) failures++;
    }
  }
  assert.equal(failures, 0, "no narrow axis with room for two labels shows fewer");
}

// barTicks rejects a non-finite logical range instead of returning nothing.
{
  const bars = series(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 2), HOUR_MS);
  const weights = computeTickWeights(bars);
  for (const [from, to] of [[Number.NaN, 5], [0, Infinity], [-Infinity, 3]]) {
    assert.throws(() => barTicks({ bars, weights, from, to, barSpacing: 10 }), (e) => e instanceof RangeError && /finite logical range/.test(e.message));
  }
  assert.deepEqual(barTicks({ bars, weights, from: 100, to: 200, barSpacing: 10 }), [], "a finite range beside the bars is simply empty");
}

// FinancialTimeAxis.weights() returns an exact-length view that later calls never overwrite.
{
  const axis = new FinancialTimeAxis({ timeZone: "America/New_York" });
  const bars = series(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 5), 15 * MIN);
  const first = axis.weights(bars, "minutes");
  assert.equal(first.length, bars.length, "exactly one weight per bar");
  assert.equal(axis.weights(bars, "minutes"), first, "an unchanged series returns the same view");
  const snapshot = [...first];
  axis.weights(bars, "days");
  axis.setOptions({ timeZone: "Asia/Tokyo" });
  axis.weights(bars, "minutes");
  bars.unshift({ time: bars[0].time - 15 * MIN });
  axis.weights(bars, "minutes");
  assert.deepEqual([...first], snapshot, "a kept result survives a kind switch, a new zone and a prepend");
  const before = axis.weights(bars, "minutes");
  const kept = [...before];
  for (let i = 0; i < 300; i++) bars.push({ time: bars[bars.length - 1].time + 15 * MIN });
  const after = axis.weights(bars, "minutes");
  assert.equal(after.length, bars.length);
  assert.deepEqual([...before], kept, "appends never write into an earlier view");
  assert.deepEqual([...after], [...computeTickWeights(bars, "Asia/Tokyo")], "and match a full recompute");
}

// ── Display zone on the widget axis and crosshair ───────────────────────────

// A 14:30Z bar reads 09:30 in New York in winter and 10:30 in summer.
{
  for (const [date, local] of [[Date.UTC(2024, 0, 16), "09:30"], [Date.UTC(2024, 6, 16), "10:30"]]) {
    const bars = series(date + 12 * HOUR_MS, date + 20 * HOUR_MS, 30 * MIN);
    const { ctx } = makeContext({ options: { timezone: "America/New_York" }, bars, resolution: "30" });
    const v = makeView(ctx, { plotW: bars.length * 90 });
    const { ticks } = paintAxis(v);
    const at = ticks.find((t) => t.time === date + 14.5 * HOUR_MS);
    assert.equal(at?.label, local, `14:30Z tick in ${new Date(date).toISOString().slice(0, 7)} (${ticks.map((t) => t.label)})`);
    const day = new Date(date).getUTCDate();
    const month = ["Jan", "Jul"][date === Date.UTC(2024, 0, 16) ? 0 : 1];
    assert.equal(formatCrosshairTimeLabel(ctx, date + 14.5 * HOUR_MS), `${day} ${month} '24 ${local}`);
  }
}

// The audits' fixtures: 12:00Z reads 07:00 in New York; 22:00Z on 14 Jan reads 17:00.
{
  const bars = series(Date.UTC(2024, 0, 15, 0), Date.UTC(2024, 0, 15, 18), HOUR_MS);
  const { ctx } = makeContext({ options: { timezone: "America/New_York" }, bars, resolution: "60" });
  const { ticks } = paintAxis(makeView(ctx, { plotW: bars.length * 90 }));
  assert.equal(ticks.find((t) => t.time === Date.UTC(2024, 0, 15, 12))?.label, "07:00");
  assert.equal(formatCrosshairTimeLabel(ctx, Date.UTC(2024, 0, 15, 12)), "15 Jan '24 07:00");
  assert.equal(formatCrosshairTimeLabel(ctx, Date.UTC(2024, 0, 14, 22)), "14 Jan '24 17:00");
}

// run-tz: 1h bars ending 2026-11-01T12:00Z. New York 07:00, Tokyo 21:00; the
// fall-back day shows 01:00 twice; day ticks sit at local midnight.
{
  const bars = series(Date.UTC(2026, 10, 1, 12) - 47 * HOUR_MS, Date.UTC(2026, 10, 1, 13), HOUR_MS);
  const last = bars[bars.length - 1].time;
  const expected = { "America/New_York": "1 Nov '26 07:00", "Asia/Tokyo": "1 Nov '26 21:00", "Etc/UTC": "1 Nov '26 12:00" };
  for (const [zone, label] of Object.entries(expected)) {
    const { ctx } = makeContext({ options: { timezone: zone }, bars, resolution: "60" });
    assert.equal(formatCrosshairTimeLabel(ctx, last), label, `${zone} crosshair`);
    const { ticks } = paintAxis(makeView(ctx, { plotW: bars.length * 90 }));
    const tz = getTimeZone(zone);
    for (const t of ticks.filter((x) => x.index > 0 && (x.unit === "day" || x.unit === "week" || x.unit === "month"))) {
      assert.equal(tz.wallParts(t.time).hour, 0, `${zone}: ${t.label} sits at local midnight`);
    }
    if (zone === "America/New_York") {
      const ones = ticks.filter((t) => t.label === "01:00" && t.time >= Date.UTC(2026, 10, 1, 4));
      assert.deepEqual(ones.map((t) => t.time), [Date.UTC(2026, 10, 1, 5), Date.UTC(2026, 10, 1, 6)], "01:00 twice on the fall-back day");
    }
  }
  // Three zones give three different axes (the audit saw identical UTC axes).
  const axisIn = (zone) => paintAxis(makeView(makeContext({ options: { timezone: zone }, bars, resolution: "60" }).ctx, { plotW: 1200 })).ticks.map((t) => `${t.label}@${t.time}`).join(" ");
  const distinct = new Set(["America/New_York", "Asia/Tokyo", "Etc/UTC"].map(axisIn));
  assert.equal(distinct.size, 3, "each zone labels its own local times");
}

// "exchange" (and an unset timezone) follow symbolInfo.timezone; custom_timezones alias IANA zones.
{
  const bars = series(Date.UTC(2024, 0, 15, 0), Date.UTC(2024, 0, 16, 0), HOUR_MS);
  const symbolInfo = { timezone: "Asia/Tokyo" };
  for (const timezone of ["exchange", undefined]) {
    const { ctx } = makeContext({ options: { timezone }, bars, resolution: "60", symbolInfo });
    assert.equal(displayTimeZoneId(ctx), "Asia/Tokyo", `timezone ${timezone} follows the symbol`);
    assert.equal(formatCrosshairTimeLabel(ctx, Date.UTC(2024, 0, 15, 12)), "15 Jan '24 21:00");
  }
  const { ctx } = makeContext({ options: { timezone: "desk", custom_timezones: [{ id: "desk", alias: "Europe/Berlin", title: "Trading desk" }] }, bars, resolution: "60" });
  assert.equal(displayTimeZoneId(ctx), "Europe/Berlin", "a custom_timezones id displays as its alias");
  assert.equal(formatCrosshairTimeLabel(ctx, Date.UTC(2024, 0, 15, 12)), "15 Jan '24 13:00");
}

/**
 * The zone name the corner caption paints. The corner cell is widened so the
 * full IANA name fits; a narrow cell abbreviates it to the UTC offset
 * (covered by tests/axis-chrome.mjs).
 */
function caption(ctx) {
  const rec = recorder();
  const v = makeView(ctx);
  drawAxisChrome(rec.ctx, { ...v, axisChromeRect: { ...v.axisChromeRect, w: 200 } });
  return rec.texts()[0]?.split("  ")[0];
}

// An unknown configured zone warns once with guidance and shows UTC; nothing throws mid-paint.
{
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const bars = series(Date.UTC(2024, 0, 15, 0), Date.UTC(2024, 0, 16, 0), HOUR_MS);
    const { ctx } = makeContext({ options: { timezone: "Mars/Olympus_Mons" }, bars, resolution: "60" });
    const v = makeView(ctx, { plotW: 1200 });
    paintAxis(v);
    paintAxis(v);
    assert.equal(formatCrosshairTimeLabel(ctx, Date.UTC(2024, 0, 15, 12)), "15 Jan '24 12:00");
    assert.equal(warnings.length, 1, `one warning, not one per frame (${warnings.length})`);
    ok(/Mars\/Olympus_Mons/.test(warnings[0]) && /IANA/.test(warnings[0]) && /Etc\/UTC/.test(warnings[0]), `the warning names the zone and the fallback: ${warnings[0]}`);
    assert.equal(caption(ctx), "Etc/UTC", "the caption names the zone the axis shows, not the rejected one");
    // The rejected zone is not validated again on every paint and crosshair move.
    const IntlDateTimeFormat = Intl.DateTimeFormat;
    let constructed = 0;
    Intl.DateTimeFormat = function (...args) {
      constructed++;
      return new IntlDateTimeFormat(...args);
    };
    try {
      for (let i = 0; i < 20; i++) formatCrosshairTimeLabel(ctx, bars[i % bars.length].time);
      paintAxis(v);
    } finally {
      Intl.DateTimeFormat = IntlDateTimeFormat;
    }
    assert.equal(constructed, 0, "an unchanged invalid setting is resolved once");
    const bad = makeContext({ options: { timezone: "exchange" }, bars, resolution: "60", symbolInfo: { timezone: "Nowhere/City" } }).ctx;
    formatCrosshairTimeLabel(bad, bars[0].time);
    ok(/symbolInfo\.timezone.*"Nowhere\/City"/.test(warnings[1] ?? ""), "a bad symbol zone names symbolInfo.timezone");
  } finally {
    console.warn = warn;
  }
}

// Daily bars are trading dates (00:00 UTC stamps): their labels do not move with the display zone.
{
  const bars = series(Date.UTC(2023, 6, 3), Date.UTC(2024, 6, 1), DAY_MS, { weekdays: true });
  const labelsIn = (zone) => {
    const { ctx } = makeContext({ options: { timezone: zone }, bars, resolution: "1D" });
    return { axis: paintAxis(makeView(ctx)).labels, crosshair: formatCrosshairTimeLabel(ctx, Date.UTC(2024, 1, 1)) };
  };
  const utc = labelsIn("Etc/UTC");
  assert.deepEqual(labelsIn("America/New_York"), utc, "New York dailies read like UTC dailies");
  assert.deepEqual(labelsIn("Asia/Tokyo"), utc, "Tokyo dailies too");
  assert.equal(utc.crosshair, "1 Feb '24");
}

// ── Density, calendar alignment and label placement ─────────────────────────

// Gapped equity sessions: 500 visible 1-minute bars over a 1002 px plot show
// 7-10 labels (the audit saw three); session opens show their date; the count
// follows the plot width, not the size of the gaps.
{
  const bars = sessions(6, "America/New_York");
  const draw = (plotW, fixture = bars) => {
    const { ctx } = makeContext({ options: { timezone: "America/New_York" }, bars: fixture, resolution: "1" });
    return paintAxis(makeView(ctx, { plotW, from: fixture.length - 500, to: fixture.length }));
  };
  const full = draw(1002);
  ok(full.drawn.length >= 7 && full.drawn.length <= 10, `7-10 labels on 1002 px (${full.labels})`);
  const ny = getTimeZone("America/New_York");
  const opens = full.ticks.filter((t) => t.unit === "day" || t.unit === "week");
  ok(opens.length >= 1 && opens.every((t) => ny.wallParts(t.time).hour === 9 && ny.wallParts(t.time).minute === 30), "session opens carry the date");
  ok(opens.every((t) => t.major) && full.drawn.filter((d) => /^\d{1,2}$/.test(d.label)).every((d) => d.bold), "and are drawn emphasised");
  ok(full.labels.filter((l) => !/^\d{1,2}$/.test(l)).every((l) => /^\d\d:\d\d$/.test(l)), "other labels are HH:mm");
  const counts = [500, 1002, 2000].map((w) => draw(w).drawn.length);
  ok(counts[0] < counts[1] && counts[1] < counts[2], `label count scales with the plot width (${counts})`);
  const weekend = sessions(6, "America/New_York", Date.UTC(2024, 0, 3));
  const weekdays = sessions(6, "America/New_York", Date.UTC(2024, 0, 8));
  const a = draw(1002, weekend).drawn.length;
  const b = draw(1002, weekdays).drawn.length;
  ok(Math.abs(a - b) <= 1, `weekend gaps do not change the density (${a} vs ${b})`);
}

// Ten years of daily bars label every year; two years show month starts and years.
{
  const daily = series(Date.UTC(2015, 0, 1), Date.UTC(2025, 0, 1), DAY_MS, { weekdays: true });
  const { ctx } = makeContext({ bars: daily, resolution: "1D" });
  const ten = paintAxis(makeView(ctx, { plotW: 1002, from: 0, to: daily.length }));
  const years = ten.labels.filter((l) => /^\d{4}$/.test(l));
  ok(years.length >= 8, `ten years show their years (${ten.labels})`);
  assert.equal(new Set(ten.labels).size, ten.labels.length, "with no repeated label");
  ok(ten.ticks.every((t) => t.unit === "year" || t.unit === "month"), "and only calendar boundaries");

  const two = paintAxis(makeView(ctx, { plotW: 1002, from: daily.length - 522, to: daily.length }));
  ok(two.labels.includes("2024") && two.labels.includes("Apr") && two.labels.includes("Jul") && two.labels.includes("Oct"), `two years: '2024 Apr Jul Oct' (${two.labels})`);
  for (const t of two.ticks) {
    const d = new Date(t.time);
    ok(t.unit === "year" ? d.getUTCMonth() === 0 : t.unit === "month", `${t.label} is a month start`);
    ok(d.getUTCDate() <= 3, `${t.label} sits on the first trading day of its month`);
  }
}

// DST crossings (March and November) on 15-minute New York bars: no label is
// duplicated or skipped, except the repeated 01:00 hour, which appears twice.
{
  for (const [start, name] of [[Date.UTC(2024, 2, 9, 12), "spring"], [Date.UTC(2024, 10, 2, 12), "fall"]]) {
    const bars = series(start, start + 30 * HOUR_MS, 15 * MIN);
    const { ctx } = makeContext({ options: { timezone: "America/New_York" }, bars, resolution: "15" });
    const { ticks, labels } = paintAxis(makeView(ctx, { plotW: bars.length * 24 }));
    const hours = ticks.filter((t) => t.unit === "hour" || t.unit === "minute");
    const seen = new Map();
    for (const t of hours) seen.set(t.label, (seen.get(t.label) ?? 0) + 1);
    const repeated = [...seen].filter(([, n]) => n > 1).map(([l]) => l);
    const zone = getTimeZone("America/New_York");
    // Over 30 hours a label can recur on the next day; only same-day repeats count.
    const sameDay = hours.filter((t, i) => hours.findIndex((u) => u.label === t.label && zone.wallParts(u.time).day === zone.wallParts(t.time).day) !== i);
    if (name === "fall") {
      assert.deepEqual(sameDay.map((t) => t.label), ["01:00"], `fall-back repeats only 01:00 (${labels})`);
      ok(repeated.includes("01:00"), "the repeated hour is labelled twice");
    } else {
      assert.equal(sameDay.length, 0, `spring-forward repeats nothing (${labels})`);
      ok(!labels.includes("02:00"), "and never labels the skipped 02:00");
    }
    for (let i = 1; i < ticks.length; i++) ok(ticks[i].time > ticks[i - 1].time, `${name}: ticks advance in time`);
    for (let i = 1; i < ticks.length; i++) {
      const gap = ticks[i].time - ticks[i - 1].time;
      ok(gap <= 3 * HOUR_MS, `${name}: no hole in the labels (${ticks[i - 1].label} -> ${ticks[i].label})`);
    }
  }
}

// Labels never overlap, never leave the plot and never enter the corner cell.
{
  const fixtures = [
    ["1m", series(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 8), MIN)],
    ["1h", series(Date.UTC(2023, 0, 1), Date.UTC(2024, 0, 1), HOUR_MS)],
    ["1D", series(Date.UTC(2010, 0, 1), Date.UTC(2025, 0, 1), DAY_MS, { weekdays: true })],
  ];
  for (const [resolution, bars] of fixtures) {
    const { ctx } = makeContext({ options: { timezone: "Europe/London" }, bars, resolution: resolution === "1h" ? "60" : resolution === "1m" ? "1" : "1D" });
    for (const plotW of [300, 640, 1002, 1600]) {
      for (const count of [40, 300, 3000]) {
        const n = Math.min(bars.length, count);
        const v = makeView(ctx, { plotW, from: bars.length - n, to: bars.length });
        const { drawn } = paintAxis(v);
        ok(drawn.length >= 2, `${resolution} ${n} bars @${plotW}px: at least two labels (${drawn.map((d) => d.label)})`);
        for (let i = 0; i < drawn.length; i++) {
          const half = (drawn[i].label.length * CHAR_W) / 2;
          ok(drawn[i].x - half >= v.plotL && drawn[i].x + half <= v.axisChromeRect.x, `${resolution} @${plotW}px: '${drawn[i].label}' stays inside the plot`);
          if (i > 0) {
            const gap = drawn[i].x - drawn[i - 1].x;
            ok(gap >= TIME_LABEL_MIN_SPACING - 1e-6 && gap >= half + (drawn[i - 1].label.length * CHAR_W) / 2, `${resolution} @${plotW}px: '${drawn[i - 1].label}' and '${drawn[i].label}' do not overlap`);
          }
        }
      }
    }
  }
}

// Ticks are cached across pointer-only repaints and recomputed when the zone changes.
{
  const bars = series(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 3), 15 * MIN);
  const { ctx } = makeContext({ options: { timezone: "Etc/UTC" }, bars, resolution: "15" });
  const v = makeView(ctx);
  const rec = recorder();
  const a = computeTimeAxisTicks(rec.ctx, v);
  assert.equal(computeTimeAxisTicks(rec.ctx, makeView(ctx)), a, "an unchanged view reuses its ticks");
  ctx.setTimezone("Asia/Tokyo");
  const b = computeTimeAxisTicks(rec.ctx, makeView(ctx));
  ok(b !== a && b.map((t) => t.label).join() !== a.map((t) => t.label).join(), "a new zone recomputes the labels");

  // Labels are measured in the bold weight dates and months are drawn in, so
  // a bold label never crowds its neighbour.
  const fonts = [];
  const measuring = recorder();
  const measureText = measuring.ctx.measureText;
  measuring.ctx.measureText = (text) => (fonts.push(measuring.ctx.font), measureText(text));
  computeTimeAxisTicks(measuring.ctx, makeView(ctx, { from: 1, to: bars.length }));
  ok(fonts.length > 1 && fonts.every((font) => font.startsWith("600 11px")), `labels are measured bold (${[...new Set(fonts)]})`);

  // A web font that finishes loading (other glyph widths) re-measures the labels.
  const view = makeView(ctx);
  const before = computeTimeAxisTicks(measuring.ctx, view);
  assert.equal(computeTimeAxisTicks(measuring.ctx, view), before, "unchanged metrics reuse the ticks");
  measuring.ctx.measureText = (text) => ({ width: String(text).length * CHAR_W * 1.2 });
  ok(computeTimeAxisTicks(measuring.ctx, view) !== before, "new glyph widths recompute the ticks");
}

// A replaced tickMarkFormatter relabels the axis even when the view is unchanged.
{
  const bars = series(Date.UTC(2024, 0, 15, 0), Date.UTC(2024, 0, 17, 0), HOUR_MS);
  const custom_formatters = { tickMarkFormatter: () => "A" };
  const { ctx } = makeContext({ options: { custom_formatters }, bars, resolution: "60" });
  const rec = recorder();
  const v = makeView(ctx, { plotW: bars.length * 40 });
  ok(computeTimeAxisTicks(rec.ctx, v).every((t) => t.label === "A"), "first formatter");
  custom_formatters.tickMarkFormatter = () => "B";
  ok(computeTimeAxisTicks(rec.ctx, v).every((t) => t.label === "B"), "the new formatter is used without a view change");
}

// custom_formatters.tickMarkFormatter / dateFormatter / timeFormatter.
{
  const bars = series(Date.UTC(2024, 0, 15, 0), Date.UTC(2024, 0, 17, 0), HOUR_MS);
  const calls = [];
  const { ctx } = makeContext({
    options: {
      timezone: "America/New_York",
      custom_formatters: {
        tickMarkFormatter: (date, type) => (calls.push([date.getUTCHours(), type]), type === "Time" ? `${date.getUTCHours()}h` : `<${type}>`),
        dateFormatter: { format: (date) => `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}` },
        timeFormatter: { format: (date) => `${date.getUTCHours()}:${String(date.getUTCMinutes()).padStart(2, "0")}` },
      },
    },
    bars,
    resolution: "60",
  });
  const { labels, ticks } = paintAxis(makeView(ctx, { plotW: bars.length * 40 }));
  ok(labels.some((l) => /^\d+h$/.test(l)) && labels.includes("<DayOfMonth>"), `tickMarkFormatter labels the axis (${labels})`);
  ok(calls.length > 0 && calls.every(([, type]) => ["Year", "Month", "DayOfMonth", "Time", "TimeWithSeconds"].includes(type)), "with TradingView tick-mark types");
  const ny = getTimeZone("America/New_York");
  const hourTicks = ticks.filter((t) => /^\d+h$/.test(t.label));
  ok(hourTicks.length > 0 && hourTicks.every((t) => `${ny.wallParts(t.time).hour}h` === t.label), "and the local time in the date's UTC fields");
  assert.equal(formatCrosshairTimeLabel(ctx, Date.UTC(2024, 0, 15, 12)), "2024-1-15 7:00", "dateFormatter + timeFormatter build the crosshair label");

  // null asks for the default label, silently.
  const partial = makeContext({ options: { timezone: "America/New_York", custom_formatters: { tickMarkFormatter: (date, type) => (type === "Time" ? null : `D${date.getUTCDate()}`), timeFormatter: { format: () => null } } }, bars, resolution: "60" }).ctx;
  const partialLabels = paintAxis(makeView(partial, { plotW: bars.length * 40 })).labels;
  ok(partialLabels.includes("D16") && partialLabels.some((l) => /^\d\d:00$/.test(l)), `null keeps the default label (${partialLabels})`);
  assert.equal(formatCrosshairTimeLabel(partial, Date.UTC(2024, 0, 15, 12)), "15 Jan '24 07:00");

  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const broken = makeContext({ options: { custom_formatters: { tickMarkFormatter: () => 42, dateFormatter: { format: () => { throw new Error("boom"); } } } }, bars, resolution: "60" }).ctx;
    const drawn = paintAxis(makeView(broken, { plotW: bars.length * 40 })).labels;
    ok(drawn.length > 0 && drawn.every((l) => typeof l === "string" && l !== "42"), "a formatter returning a non-string falls back to the default label");
    assert.equal(formatCrosshairTimeLabel(broken, Date.UTC(2024, 0, 15, 12)), "15 Jan '24 12:00", "a throwing dateFormatter falls back");
    ok(warnings.some((w) => /tickMarkFormatter must return a string/.test(w)) && warnings.some((w) => /dateFormatter threw/.test(w)), `each problem warns (${warnings})`);
    assert.equal(warnings.length, 2, "once");
  } finally {
    console.warn = warn;
  }
}

// ── Price axis ──────────────────────────────────────────────────────────────

{
  const { ctx } = makeContext({ bars: series(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 2), HOUR_MS) });
  const v = makeView(ctx);
  const rec = recorder();
  drawPriceAxis(rec.ctx, v, [{ value: 100, label: "100.000" }, { price: 150, label: "150.000" }, 50]);
  const texts = rec.texts();
  ok(texts.includes("100.000") && texts.includes("150.000"), `tick labels are painted as given (${texts})`);
  ok(texts.includes(ctx.formatPrice(50, 100)) || texts.some((t) => /^50/.test(t)), "bare numbers are still formatted");
}

// ── Crosshair ───────────────────────────────────────────────────────────────

/** Vertical and horizontal dashed crosshair segments painted by drawCrosshair. */
function crosshairLines(ops) {
  const lines = [];
  for (let i = 0; i + 1 < ops.length; i++) {
    if (ops[i].op === "moveTo" && ops[i + 1].op === "lineTo") lines.push({ x0: ops[i].x, y0: ops[i].y, x1: ops[i + 1].x, y1: ops[i + 1].y });
  }
  return { vertical: lines.filter((l) => l.x0 === l.x1), horizontal: lines.filter((l) => l.y0 === l.y1) };
}

// Layout sync: the vertical line and time label always follow the source time;
// the horizontal line only when the symbol matches (or an unnamed price is in range).
{
  const bars = series(Date.UTC(2024, 0, 15, 0), Date.UTC(2024, 0, 15, 4), MIN);
  const target = bars[120].time;
  const cases = [
    ["another symbol far out of range", { symbol: "BTC", price: 60_000 }, false],
    ["another symbol whose price happens to be in range", { symbol: "BTC", price: 120 }, false],
    ["the same symbol", { symbol: "ETH", price: 120 }, true],
    ["an unnamed source in range", { price: 120 }, true],
    ["an unnamed source out of range", { price: 60_000 }, false],
  ];
  for (const [name, source, horizontal] of cases) {
    const { ctx } = makeContext({ options: { timezone: "America/New_York" }, bars, symbol: "ETH" });
    ctx.syncedCrosshair = { unixTime: target / 1000, active: true, ...source };
    const v = makeView(ctx);
    const rec = recorder();
    drawCrosshair(rec.ctx, v);
    const lines = crosshairLines(rec.ops);
    assert.equal(lines.vertical.length, 1, `${name}: the vertical line is drawn`);
    ok(Math.abs(lines.vertical[0].x0 - (Math.round(xOf(v, 120)) + 0.5)) < 1e-9, `${name}: at the source time`);
    assert.equal(lines.horizontal.length, horizontal ? 1 : 0, `${name}: horizontal line ${horizontal ? "shown" : "hidden"}`);
    ok(rec.texts().includes("14 Jan '24 21:00"), `${name}: the time label is drawn in the display zone (${rec.texts()})`);
  }
  // A time outside the visible range draws nothing.
  const { ctx } = makeContext({ bars, symbol: "ETH" });
  ctx.syncedCrosshair = { unixTime: bars[200].time / 1000, price: 100, active: true, symbol: "BTC" };
  const rec = recorder();
  drawCrosshair(rec.ctx, makeView(ctx, { from: 0, to: 100 }));
  assert.equal(rec.ops.length, 0, "a synced time off screen draws nothing");
}

// The dedicated volume pane gets a horizontal line and a compact volume label.
{
  const bars = series(Date.UTC(2024, 0, 15, 0), Date.UTC(2024, 0, 15, 2), MIN).map((b, i) => ({ ...b, volume: i === 40 ? 70_200 : 1_000 + i }));
  const { ctx } = makeContext({ bars, volumeMode: "pane" });
  const volumePane = { top: 410, h: 100 };
  const v = makeView(ctx, { volumePane });
  v.crosshair = { x: xOf(v, 30), y: 460, active: true };
  const rec = recorder();
  drawCrosshair(rec.ctx, v);
  const lines = crosshairLines(rec.ops);
  assert.equal(lines.horizontal.length, 1, "a horizontal line crosses the volume pane");
  assert.equal(lines.horizontal[0].y0, 460.5);
  ok(rec.texts().includes("35.1K"), `the axis shows the volume at the pointer (${rec.texts()})`);
  ok(Math.abs(indexAtX(v, v.crosshair.x) - 30) < 1e-9, "fixture sanity");
  assert.equal(formatVolumeLabel(812.4), "812");
  assert.equal(formatVolumeLabel(3.14159), "3.14");
  assert.equal(formatVolumeLabel(0.012345), "0.0123");
  assert.equal(formatVolumeLabel(1_250_000), "1.25M");
  // Overlay volume keeps the main-pane price readout.
  const overlay = makeContext({ bars, volumeMode: "overlay" }).ctx;
  const ov = makeView(overlay);
  ov.crosshair = { x: xOf(ov, 30), y: 380, active: true };
  const rec2 = recorder();
  drawCrosshair(rec2.ctx, ov);
  ok(!rec2.texts().some((t) => /K$/.test(t)), "overlay volume shows the price, not a volume");
}

// In the whitespace after the last bar the time label shows that future bar slot.
{
  const bars = series(Date.UTC(2024, 0, 15, 14), Date.UTC(2024, 0, 15, 15), MIN);
  const { ctx } = makeContext({ options: { timezone: "America/New_York" }, bars });
  const v = makeView(ctx, { from: 0, to: bars.length + 20 });
  v.crosshair = { x: xOf(v, bars.length + 4), y: 100, active: true };
  const rec = recorder();
  drawCrosshair(rec.ctx, v);
  ok(rec.texts().includes("15 Jan '24 10:04"), `future slot label (${rec.texts()})`);
}

// ── Session breaks in the display zone ──────────────────────────────────────

{
  // Round-the-clock 5-minute bars break at each local midnight of the zone.
  const bars = series(Date.UTC(2024, 0, 15), Date.UTC(2024, 0, 18), 5 * MIN);
  const idx = new TimeIndex(bars, 5 * MIN);
  assert.deepEqual(idx.sessionBreaks(), [], "without a zone a gapless series has no breaks (unchanged)");
  const tokyo = getTimeZone("Asia/Tokyo");
  const breaks = idx.sessionBreaks({ timeZone: tokyo });
  ok(breaks.length === 3 && breaks.every((i) => tokyo.wallParts(bars[i].time).hour === 0 && tokyo.wallParts(bars[i].time).minute === 0), `Tokyo midnights (${breaks.map((i) => new Date(bars[i].time).toISOString())})`);
  const ranged = idx.sessionBreaks({ timeZone: tokyo, from: breaks[1] - 10, to: breaks[1] + 10 });
  assert.deepEqual(ranged, [breaks[1]], "a range only scans its bars");
  assert.throws(() => idx.sessionBreaks({ from: Number.NaN }), (e) => e instanceof RangeError && /finite logical index/.test(e.message), "a non-finite range is rejected");

  // Equity sessions: one break per session open, whatever the zone.
  const eq = sessions(4, "America/New_York");
  const eqIdx = new TimeIndex(eq, MIN);
  assert.deepEqual(eqIdx.sessionBreaks({ timeZone: "Asia/Tokyo" }), eqIdx.sessionBreaks(), "gapped sessions break at their opens only");

  // A futures session opening at 18:00 New York after a one-hour pause is not split again at midnight.
  const ny = getTimeZone("America/New_York");
  const fut = [];
  for (let day = 15; day <= 18; day++) {
    const open = ny.fromWall(wallFromFields(2024, 0, day - 1, 18));
    for (let i = 0; i < 23 * 60; i += 5) fut.push({ time: open + i * MIN });
  }
  const futBreaks = new TimeIndex(fut, 5 * MIN).sessionBreaks({ timeZone: ny });
  ok(futBreaks.length === 3 && futBreaks.every((i) => ny.wallParts(fut[i].time).hour === 18), `futures break at 18:00 opens only (${futBreaks.map((i) => ny.wallParts(fut[i].time).hour)})`);

  // The live futures session (open at 18:00, not closed yet) is judged by the complete one before it.
  const live = fut.slice(0, fut.length - 12 * 60 / 5);
  const liveBreaks = new TimeIndex(live, 5 * MIN).sessionBreaks({ timeZone: ny });
  ok(liveBreaks.every((i) => ny.wallParts(live[i].time).hour === 18) && liveBreaks.length === 3, "a live futures session is not split at midnight");

  // Forex 24x5 (Sunday 17:00 to Friday 17:00 New York): a break at the Sunday open and at every
  // local midnight inside the week, Monday included, in every week and every display zone.
  const fx = [];
  for (let t = Date.UTC(2024, 0, 7, 22); t < Date.UTC(2024, 0, 27); t += 5 * MIN) {
    const { weekday, hour } = ny.wallParts(t);
    if (!(weekday === 6 || (weekday === 5 && hour >= 17) || (weekday === 0 && hour < 17))) fx.push({ time: t });
  }
  const fxIdx = new TimeIndex(fx, 5 * MIN);
  const label = (zone, i) => {
    const p = zone.wallParts(fx[i].time);
    return `${"SMTWTFS"[p.weekday]}${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  };
  const week = (open, midnights) => [open, ...midnights.map((d) => `${d}00:00`)];
  const nyWeeks = fxIdx.sessionBreaks({ timeZone: ny }).map((i) => label(ny, i));
  assert.deepEqual(
    nyWeeks,
    ["M00:00", "T00:00", "W00:00", "T00:00", "F00:00", ...week("S17:00", ["M", "T", "W", "T", "F"]), ...week("S17:00", ["M", "T", "W", "T", "F"])],
    "forex in New York breaks at every in-session midnight, Monday included",
  );
  const tokyoWeeks = fxIdx.sessionBreaks({ timeZone: tokyo }).map((i) => label(tokyo, i));
  assert.deepEqual(
    tokyoWeeks,
    ["T00:00", "W00:00", "T00:00", "F00:00", "S00:00", ...week("M07:00", ["T", "W", "T", "F", "S"]), ...week("M07:00", ["T", "W", "T", "F", "S"])],
    "forex in Tokyo breaks at every in-session Tokyo midnight",
  );
  // Windowing reads the same verdicts as a whole-series walk.
  const fxAll = fxIdx.sessionBreaks({ timeZone: ny });
  for (let from = 0; from < fx.length; from += 211) {
    const to = from + 400;
    assert.deepEqual(
      fxIdx.sessionBreaks({ timeZone: ny, from, to }),
      fxAll.filter((i) => i >= from && i <= to),
      `a window from ${from} matches the full walk`,
    );
  }

  // 24x7 crypto with a 30-minute outage keeps the midnight breaks on the days either side of it.
  const utc = getTimeZone("Etc/UTC");
  const crypto = series(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 6), 5 * MIN)
    .filter((b) => !(b.time >= Date.UTC(2024, 0, 3, 12) && b.time < Date.UTC(2024, 0, 3, 12, 30)));
  const cryptoBreaks = new TimeIndex(crypto, 5 * MIN).sessionBreaks({ timeZone: utc });
  assert.deepEqual(
    cryptoBreaks.map((i) => new Date(crypto[i].time).toISOString().slice(5, 16)),
    ["01-02T00:00", "01-03T00:00", "01-03T12:30", "01-04T00:00", "01-05T00:00"],
    "an outage opens a session without erasing the nearby midnights",
  );
  // Less than a day of gapless bars has no complete session to judge by: it counts as round-the-clock.
  const short = series(Date.UTC(2024, 0, 1, 18), Date.UTC(2024, 0, 2, 6), MIN);
  assert.deepEqual(
    new TimeIndex(short, MIN).sessionBreaks({ timeZone: utc }).map((i) => new Date(short[i].time).toISOString().slice(11, 16)),
    ["00:00"],
    "a short gapless window still breaks at midnight",
  );

  // Daily bars keep gap-only breaks.
  const daily = series(Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1), DAY_MS, { weekdays: true });
  const dailyIdx = new TimeIndex(daily, DAY_MS);
  assert.deepEqual(dailyIdx.sessionBreaks({ timeZone: tokyo }), dailyIdx.sessionBreaks(), "daily bars ignore the zone");

  // The painter uses the chart's display zone.
  const { ctx } = makeContext({ options: { timezone: "Asia/Tokyo", enabled_features: ["session_breaks"] }, bars, resolution: "5" });
  const v = makeView(ctx);
  const rec = recorder();
  drawSessionBreaks(rec.ctx, v);
  const xs = rec.ops.filter((o) => o.op === "moveTo").map((o) => o.x);
  assert.deepEqual(xs, breaks.map((i) => Math.round(xOf(v, i - 0.5)) + 0.5), "session break lines at Tokyo midnights");
}

// ── Chart API: timezone(), setTimezone(), onTimezoneChanged(), getTimezoneApi() ──

{
  const bars = series(Date.UTC(2024, 0, 15, 0), Date.UTC(2024, 0, 16, 0), HOUR_MS);
  const { ctx, paints } = makeContext({
    options: { timezone: "Etc/UTC", custom_timezones: [{ id: "desk", alias: "Europe/Berlin", title: "Trading desk" }, { id: "bad", alias: "Nowhere/City" }] },
    bars,
    resolution: "60",
    symbolInfo: { timezone: "America/Chicago" },
  });
  const chart = new ChartApi(ctx, {});
  assert.equal(chart.timezone(), "Etc/UTC");
  const seen = [];
  const listener = (zone, previous) => seen.push([zone, previous]);
  chart.onTimezoneChanged().subscribe(null, listener);
  assert.equal(chart.onTimezoneChanged(), chart.onTimezoneChanged(), "one subscription object per chart");

  const before = formatCrosshairTimeLabel(ctx, Date.UTC(2024, 0, 15, 12));
  const paintsBefore = paints.count;
  chart.setTimezone("Asia/Tokyo");
  ok(paints.count > paintsBefore, "setTimezone repaints");
  assert.deepEqual(seen, [["Asia/Tokyo", "Etc/UTC"]], "and fires onTimezoneChanged");
  assert.equal(chart.timezone(), "Asia/Tokyo");
  assert.equal(before, "15 Jan '24 12:00");
  assert.equal(formatCrosshairTimeLabel(ctx, Date.UTC(2024, 0, 15, 12)), "15 Jan '24 21:00", "the crosshair follows the new zone");
  const { ticks } = paintAxis(makeView(ctx, { plotW: bars.length * 90 }));
  assert.equal(ticks.find((t) => t.time === Date.UTC(2024, 0, 15, 12))?.label, "21:00", "the axis follows the new zone");
  assert.equal(caption(ctx), "Asia/Tokyo", "the corner caption follows the new zone");

  chart.setTimezone("Asia/Tokyo");
  assert.equal(seen.length, 1, "an unchanged zone fires nothing");
  chart.setTimezone("exchange");
  assert.equal(formatCrosshairTimeLabel(ctx, Date.UTC(2024, 0, 15, 12)), "15 Jan '24 06:00", "exchange uses symbolInfo.timezone (Chicago)");
  chart.setTimezone("desk");
  assert.equal(displayTimeZoneId(ctx), "Europe/Berlin", "custom_timezones ids are accepted");
  assert.equal(caption(ctx), "Europe/Berlin", "the caption names the zone a custom id displays");
  chart.setTimezone("+05:30");
  assert.equal(formatCrosshairTimeLabel(ctx, Date.UTC(2024, 0, 15, 12)), "15 Jan '24 17:30", "fixed offsets are accepted");

  const rejects = (value, ctor, pattern) => assert.throws(() => chart.setTimezone(value), (e) => e instanceof ctor && pattern.test(e.message), `setTimezone(${JSON.stringify(value)})`);
  rejects("Mars/Olympus_Mons", RangeError, /Unknown time zone "Mars\/Olympus_Mons".*America\/New_York/);
  rejects("bad", RangeError, /custom_timezones entry "bad" aliases "Nowhere\/City"/);
  rejects(42, TypeError, /time zone name/);
  rejects("", TypeError, /time zone name/);
  rejects(null, TypeError, /time zone name/);
  assert.equal(chart.timezone(), "+05:30", "a rejected zone leaves the setting unchanged");

  const api = chart.getTimezoneApi();
  assert.equal(chart.getTimezoneApi(), api, "one timezone API object per chart");
  api.setTimezone("Asia/Tokyo");
  assert.deepEqual(api.getTimezone(), { id: "Asia/Tokyo", title: "Tokyo", offset: 540 });
  api.setTimezone("desk");
  assert.equal(api.getTimezone().title, "Trading desk");
  api.setTimezone("exchange");
  assert.deepEqual(api.getTimezone(), { id: "exchange", title: "Exchange", offset: -360 });
  const available = api.availableTimezones();
  ok(available[0].id === "exchange" && available.some((z) => z.id === "Etc/UTC") && available.some((z) => z.id === "desk"), "availableTimezones lists exchange, UTC and custom zones");
  ok(available.every((z) => typeof z.id === "string" && typeof z.title === "string"), "every entry has an id and a title");
  if (typeof Intl.supportedValuesOf === "function") ok(available.some((z) => z.id === "America/New_York" && z.title === "New York"), "and the IANA zones Intl knows");
  assert.throws(() => api.setTimezone("Nope/Nope"), RangeError);
  const heard = seen.length;
  assert.equal(heard, 7, "every effective change was heard");
  chart.onTimezoneChanged().unsubscribe(null, listener);
  chart.setTimezone("Etc/UTC");
  assert.equal(seen.length, heard, "unsubscribe stops notifications");
}

// ── Identical results whatever the process time zone is ────────────────────

{
  const expected = fingerprint();
  const locals = new Set();
  for (const tz of ["UTC", "America/Los_Angeles", "Asia/Kolkata"]) {
    const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, TZ: tz, RAZE_TIME_AXIS_FINGERPRINT: "1" },
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);
    locals.add(parsed.local);
    delete parsed.local;
    const mine = { ...expected };
    delete mine.local;
    assert.deepEqual(parsed, mine, `TZ=${tz} paints identical axes and crosshair labels`);
  }
  assert.equal(locals.size, 3, "the child processes really ran under three process time zones");
  assert.deepEqual(expected["America/New_York"].crosshair, "1 Nov '26 07:00");
  assert.deepEqual(expected["Asia/Tokyo"].crosshair, "1 Nov '26 21:00");
}

console.log(`TIME AXIS: PASS (${checks} extra checks)`);
