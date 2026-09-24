// Study contract v2 (W1B-15): defaults and context reach compute(), typed
// input schemas validate/clamp/reject, defineIndicator's incremental update()
// runs once per tick, undo history keeps specs instead of value arrays, the
// undo depth is capped, ids come from the per-widget allocator, and the
// widget API rejects invalid inputs (booleans, objects, arrays and the
// positional form included) and round-trips boolean inputs. Restores
// (load(), restore(), undo) are lenient: stale saved inputs fall back to
// defaults with one warning per study. Visible-range studies recompute on
// gesture pans, which publish only viewportChanged.
// Run after the build: node build.mjs && node tests/study-contract.mjs

import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";

const root = await import("../dist/charting_library.esm.js");
const studies = await import("../dist/studies.esm.js");
const { CommandStack, Delegate, IdAllocator, StudyInputError, StudyRegistry, StudyStore, BUILTIN_STUDIES, createChartContext } = root;
const { bool, color, createStudyContext, defineIndicator, float, int, price, resolution, runIndicator, select, session, source, sourceValue, symbol, text, time } = studies;

let checks = 0;
const ok = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const bar = (i, close, extra = {}) => ({
  time: 1_700_000_000_000 + i * 60_000,
  open: close - 0.5,
  high: close + 1,
  low: close - 1,
  close,
  volume: 100 + i,
  ...extra,
});
const series = (n, f = (i) => 100 + Math.sin(i / 3) * 5 + i * 0.1) => Array.from({ length: n }, (_, i) => bar(i, f(i)));

/** A minimal context (what older tests and headless hosts pass). */
const plainContext = (bars) => ({ bars, dataChanged: new Delegate(), requestPaint() {} });

/** A context with every seam (ids, rangeChanged, timezone…), as the widget builds it. */
const seamContext = (bars, extra = {}, options = {}) => createChartContext({
  options: { timezone: "exchange" },
  datafeed: {},
  locale: "en",
  fontFamily: "sans-serif",
  symbol: "AAPL",
  resolution: "60",
  symbolInfo: { name: "AAPL", timezone: "America/New_York", session: "0930-1600", pricescale: 100 },
  theme: {},
  features: new Set(),
  formatPrice: (value, scale) => `${value.toFixed(2)}@${scale}`,
  bars,
  marks: [],
  timescaleMarks: [],
  visibleRange: { from: 0, to: 10 },
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
  ...extra,
}, options);

const captureWarnings = (fn) => {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  try {
    const result = fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
};
const captureWarningsAsync = async (fn) => {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── ind-defaults-forwarded ────────────────────────────────────────────────
{
  const seen = [];
  const custom = {
    name: "Offset close",
    pane: "overlay",
    defaults: { length: 5, color: "#123456", offset: 3, source: "high" },
    compute: (bars, inputs) => {
      seen.push({ ...inputs });
      return bars.map((item) => item.close + inputs.offset);
    },
  };
  const store = new StudyStore(plainContext(series(8)), new StudyRegistry([custom]));
  const id = store.add({ name: custom.name });
  assert.deepEqual(seen.at(-1), { offset: 3, source: "high", length: 5 }, "compute receives every default except color, plus length");
  const study = store.get(id);
  assert.deepEqual(study.inputs, { offset: 3, source: "high" }, "the effective inputs (what save() persists) include the defaults");
  ok(study.color === "#123456" && study.length === 5, "length and color keep their shorthand");
  store.add({ name: custom.name, length: 9, inputs: { offset: 7 } });
  assert.deepEqual(seen.at(-1), { offset: 7, source: "high", length: 9 }, "caller inputs override defaults; length is the shorthand");
  checks += 3;
  store.destroy();
}

// ── Typed input schema on a v1 definition ─────────────────────────────────
{
  let received = null;
  const schemaDef = {
    name: "Schema study",
    pane: "pane",
    inputs: {
      length: int(14, { min: 2, max: 50 }),
      smooth: bool(false),
      mode: select(["sma", "ema"], "ema"),
      level: float(0.5, { min: 0, max: 1 }),
      src: source("close"),
    },
    compute: (bars, inputs, ctx) => {
      received = { inputs: { ...inputs }, ctx };
      return bars.map(() => 1);
    },
  };
  const store = new StudyStore(plainContext(series(20)), new StudyRegistry([schemaDef]));
  store.add({ name: schemaDef.name });
  assert.deepEqual(received.inputs, { length: 14, smooth: false, mode: "ema", level: 0.5, src: "close" }, "schema defaults reach compute");

  const { result: clampedId, warnings } = captureWarnings(() => store.add({ name: schemaDef.name, length: 100, inputs: { level: -3 } }));
  const clamped = store.get(clampedId);
  ok(clamped.length === 50 && clamped.inputs.length === 50, "the length shorthand feeds the declared input and clamps to max");
  ok(clamped.inputs.level === 0, "floats clamp to min");
  ok(warnings.some((line) => line.includes('"length" = 100') && line.includes("clamped to 50")), "clamping warns with the input and the bound");

  const coercedId = store.add({ name: schemaDef.name, inputs: { length: "21.4", smooth: "true", src: "HL2", in_2: "sma" } });
  assert.deepEqual(
    store.get(coercedId).inputs,
    { length: 21, smooth: true, mode: "sma", level: 0.5, src: "hl2" },
    "numeric strings, boolean strings, case-insensitive sources and TradingView in_N ids are coerced",
  );

  const reject = (inputs, code, fragment) => {
    let error = null;
    try {
      store.add({ name: schemaDef.name, inputs });
    } catch (caught) {
      error = caught;
    }
    ok(error instanceof StudyInputError && error instanceof TypeError, `${JSON.stringify(inputs)} throws a StudyInputError`);
    ok(error.code === code && error.study === "Schema study" && error.message.includes(fragment), `${code}: ${error.message}`);
  };
  const before = store.list().length;
  reject({ smooth: "yes" }, "invalid-value", "expected true or false");
  reject({ mode: "wma" }, "invalid-value", "one of sma, ema");
  reject({ src: "typical" }, "invalid-value", "one of open, high");
  reject({ length: Number.NaN }, "invalid-value", "a finite number");
  reject({ lenght: 3 }, "unknown-input", "Supported inputs: length, smooth, mode, level, src");
  reject({ in_9: 3 }, "unknown-input", "Supported inputs");
  ok(store.list().length === before, "rejected inputs add nothing");
  ok(studies.normalizeInputSchema(schemaDef.inputs, schemaDef.name).length.title === "Length", "normalizeInputSchema() fills titles from ids");
  store.destroy();
}

// ── Schema validation at registration ─────────────────────────────────────
{
  const bad = (inputs, fragment) => {
    const error = assert.throws(() => defineIndicator({
      name: "Bad",
      pane: "pane",
      inputs,
      plots: [{ id: "v", title: "V", style: "line" }],
      compute: (bars) => ({ v: bars.map(() => null) }),
    }), (caught) => caught instanceof studies.StudyInputError && caught.code === "invalid-schema" && caught.message.includes(fragment));
    void error;
    checks += 1;
  };
  bad({ "9lives": int(1) }, "ids must match");
  bad({ n: { type: "integer", title: "N", default: 1 } }, 'unknown type "integer"');
  bad({ n: int(0, { min: 1 }) }, "outside [1");
  bad({ n: int(1, { min: 5, max: 2 }) }, "min (5) is greater than max (2)");
  bad({ n: select([], "a") }, "non-empty options");
  bad({ n: source("typical") }, "not a valid source value");
  bad({ n: session("9:30-16:00") }, "not a valid session value");

  const plot = [{ id: "v", title: "V", style: "line" }];
  const compute = (bars) => ({ v: bars.map(() => null) });
  const failsWith = (definition, fragment) => {
    assert.throws(() => defineIndicator(definition), (caught) => caught instanceof TypeError && caught.message.includes(fragment));
    checks += 1;
  };
  failsWith({ name: "", pane: "pane", inputs: {}, plots: plot, compute }, "non-empty name");
  failsWith({ name: "X", pane: "top", inputs: {}, plots: plot, compute }, 'pane must be "overlay" or "pane"');
  failsWith({ name: "X", pane: "pane", inputs: {}, plots: [], compute }, "plots must list at least one");
  failsWith({ name: "X", pane: "pane", inputs: {}, plots: [...plot, ...plot], compute }, 'plot id "v" is declared twice');
  failsWith({ name: "X", pane: "pane", inputs: {}, plots: [{ id: "v", title: "V", style: "spline" }], compute }, 'unknown style "spline"');
  failsWith({ name: "X", pane: "pane", inputs: {}, plots: plot }, "provide compute(bars, inputs, ctx)");
  failsWith({ name: "X", pane: "pane", inputs: {}, plots: plot, update: () => ({}) }, "update() needs an init");
  failsWith({ name: "X", pane: "pane", inputs: {}, plots: plot, compute, fills: [{ id: "f", between: ["v", "w"], color: "#000" }] }, "must name two different plots");
  failsWith({ name: "X", pane: "pane", inputs: {}, plots: plot, compute, dependsOn: ["bars"] }, 'unknown dependency "bars"');
}

// ── Every input type resolves ─────────────────────────────────────────────
{
  const schema = {
    n: int(3),
    f: float(1.5),
    b: bool(true),
    s: source("hlc3"),
    o: select([{ value: "a", title: "Alpha" }, { value: "b", title: "Beta" }]),
    c: color("#ff0000"),
    sess: session("0930-1600:23456"),
    t: time(1_700_000_000),
    p: price(101.25),
    sym: symbol("MSFT"),
    r: resolution("1D"),
    x: text("note"),
  };
  const Probe = defineIndicator({
    name: "Every input",
    pane: "pane",
    inputs: schema,
    plots: [{ id: "v", title: "", style: "line" }],
    compute: (bars) => ({ v: bars.map(() => 0) }),
  });
  ok(Object.keys(Probe.inputs).length === 12 && Probe.inputs.sess.title === "Sess", "all 12 input types normalize, with titles from ids");
  ok(Probe.indicator.plots[0].title === "V", "empty plot titles are filled from the id");
  ok(Probe.defaults.o === "a", "select defaults to its first option");
  const store = new StudyStore(plainContext(series(3)), new StudyRegistry([Probe]));
  const id = store.add({ name: "Every input", inputs: { r: 60, sym: "AAPL", sess: " 24x7 ", t: "1700000100" } });
  const values = store.get(id).inputs;
  ok(values.r === "60" && values.sym === "AAPL" && values.sess === "24x7" && values.t === 1_700_000_100, "text-like inputs accept numbers; sessions trim; time accepts numeric strings");
  store.destroy();
}

// ── ind-compute-context ───────────────────────────────────────────────────
{
  const contexts = [];
  const Session = defineIndicator({
    name: "Session probe",
    pane: "overlay",
    inputs: {},
    plots: [{ id: "v", title: "V", style: "line" }],
    compute: (bars, _inputs, ctx) => {
      contexts.push(ctx);
      return { v: bars.map(() => 1) };
    },
  });
  let rangeComputes = 0;
  let lastRange = null;
  const Visible = defineIndicator({
    name: "Visible range probe",
    pane: "overlay",
    inputs: {},
    dependsOn: ["visibleRange"],
    plots: [{ id: "v", title: "V", style: "line" }],
    compute: (bars, _inputs, ctx) => {
      rangeComputes += 1;
      lastRange = ctx.visibleRange;
      return { v: bars.map(() => ctx.visibleRange.to) };
    },
  });
  const context = seamContext(series(40));
  const store = new StudyStore(context, new StudyRegistry([Session, Visible]));
  store.add({ name: "Session probe" });
  const ctx = contexts[0];
  ok(ctx.symbolInfo.timezone === "America/New_York" && ctx.resolution === "60" && ctx.symbol === "AAPL", "ctx exposes symbolInfo, resolution and symbol");
  ok(ctx.timezone === "America/New_York", 'ctx.timezone resolves the "exchange" setting against the symbol');
  ok(ctx.visibleRange === null, "visibleRange is only exposed to studies that depend on it");
  ok(ctx.formatPrice(1.5) === "1.50@100", "ctx.formatPrice uses the symbol formatter and pricescale");
  ok(Object.isFrozen(ctx), "the compute context is read-only");
  assert.throws(() => { ctx.symbol = "MSFT"; }, TypeError, "assigning to ctx throws");
  context.setTimezone("Asia/Tokyo");
  ok(ctx.timezone === "Asia/Tokyo", "ctx is a live view of the chart");

  store.add({ name: "Visible range probe" });
  ok(rangeComputes === 1 && lastRange.from === 0 && lastRange.to === 10, "visible-range studies receive the range");
  for (let step = 1; step <= 5; step++) context.setViewport({ from: step, to: 10 + step }, "pan");
  ok(rangeComputes === 1, "panning schedules instead of recomputing synchronously");
  await wait(20);
  ok(rangeComputes === 2 && lastRange.to === 15, "a burst of pans recomputes once, with the latest range");
  context.setViewport({ from: 6, to: 16 }, "pan");
  await wait(30);
  ok(rangeComputes === 2, "the next recompute waits for the throttle window");
  await wait(120);
  ok(rangeComputes === 3 && lastRange.to === 16, "the trailing pan recomputes once the window passes");
  const computesBefore = contexts.length;
  context.setViewport({ from: 7, to: 17 }, "pan");
  await wait(150);
  ok(contexts.length === computesBefore, "studies that do not depend on the range never recompute on pan");

  // requestRecompute() is throttled through the same queue.
  lastRange = null;
  contexts[0].requestRecompute();
  await wait(150);
  ok(contexts.length === computesBefore + 1, "ctx.requestRecompute() schedules one recompute");
  store.destroy();
  context.setViewport({ from: 8, to: 18 }, "pan");
  await wait(150);
  ok(rangeComputes === 4, "destroy() unsubscribes from range changes");
}

// ── vision-study-plugin-v2: incremental update() ──────────────────────────
{
  const calls = [];
  let inits = 0;
  const RunningMean = defineIndicator({
    name: "Running mean",
    shortTitle: "RM",
    pane: "overlay",
    inputs: { src: source("close") },
    plots: [
      { id: "mean", title: "Mean", style: "line", color: "#ff9800" },
      { id: "count", title: "Count", style: "columns", visible: false },
    ],
    init: () => {
      inits += 1;
      return { sum: 0, count: 0 };
    },
    update: ({ bar, index, mode }, state, { src }) => {
      calls.push({ index, mode });
      const sum = state.sum + sourceValue(bar, src);
      const count = state.count + 1;
      return { state: { sum, count }, values: { mean: sum / count, count } };
    },
  });
  const expected = (bars, src = "close") => {
    let sum = 0;
    return bars.map((item, i) => (sum += sourceValue(item, src)) / (i + 1));
  };
  const context = plainContext(series(50));
  const store = new StudyStore(context, new StudyRegistry([RunningMean]));
  const id = store.add({ name: "Running mean", inputs: { src: "hl2" } });
  const study = store.get(id);
  ok(calls.length === 50 && inits === 1, "the first compute replays update() once per bar from init()");
  assert.deepEqual(study.values, expected(context.bars, "hl2"), "replayed values match a reference");
  ok(study.series.length === 1 && study.series[0].id === "mean" && study.series[0].color === "#ff9800", "hidden plots are not painted; plot colours apply");
  ok(study.outputs.count.length === 50 && study.outputs.count[49] === 50, "hidden plots still compute into outputs");
  ok(study.def.label === "RM" && study.def.shortTitle === "RM", "shortTitle labels the study");
  const valuesArray = study.values;

  calls.length = 0;
  for (let step = 0; step < 30; step++) {
    const last = context.bars.length - 1;
    const close = 90 + ((step * 7) % 11);
    if (step % 3 === 0) context.bars.push(bar(last + 1, close));
    else context.bars[last] = bar(last, close);
    context.dataChanged.fire();
    ok(calls.length === 1, `tick ${step}: exactly one update() call (got ${calls.length})`);
    ok(calls[0].mode === (step % 3 === 0 ? "append" : "replace-last") && calls[0].index === context.bars.length - 1, `tick ${step}: mode and index`);
    assert.deepEqual(study.values, expected(context.bars, "hl2"), `tick ${step}: incremental values match a full recompute`);
    // runIndicator() replays the definition itself; keep its calls out of the spy.
    const reference = runIndicator(RunningMean, context.bars, { src: "hl2" }).mean;
    inits -= 1;
    calls.length = 0;
    assert.deepEqual(study.values, reference, `tick ${step}: parity with runIndicator`);
    ok(study.values === valuesArray, `tick ${step}: outputs update in place`);
  }
  ok(inits === 1, "ticks never call init() again (no full recompute)");

  context.bars = [bar(-1, 80), ...context.bars];
  context.dataChanged.fire();
  ok(inits === 2 && calls.length === context.bars.length, "a history prepend takes the full replay path");
  assert.deepEqual(store.get(id).values, expected(context.bars, "hl2"));
  store.destroy();
}

// ── update() purity is enforced loudly ────────────────────────────────────
{
  const Mutating = defineIndicator({
    name: "Mutating",
    pane: "pane",
    inputs: {},
    plots: [{ id: "v", title: "V", style: "line" }],
    init: () => ({ count: 0 }),
    update: (_input, state) => {
      state.count += 1;
      return { state, values: { v: state.count } };
    },
  });
  const context = plainContext(series(5));
  const store = new StudyStore(context, new StudyRegistry([Mutating]));
  const changes = [];
  store.changed.subscribe(null, (change) => changes.push(change));
  const id = store.add({ name: "Mutating" });
  context.bars[4] = bar(4, 120);
  const { warnings } = captureWarnings(() => context.dataChanged.fire());
  const study = store.get(id);
  ok(study.error && study.error.includes("must return a new state"), "mutating the committed state fails with guidance");
  ok(study.series.length === 0 && warnings.length === 1, "a failed update clears the plot and warns once");
  ok(changes.some((change) => change.kind === "error" && change.id === String(id) && change.error === study.error), "failures are published on the change delegate");
  store.destroy();
}

// ── compute-only v2 and fill-between series ───────────────────────────────
{
  let computes = 0;
  const Channel = defineIndicator({
    name: "Channel",
    pane: "overlay",
    inputs: { width: float(2, { min: 0 }) },
    plots: [
      { id: "upper", title: "Upper", style: "line", color: "#26a69a", lineWidth: 2 },
      { id: "lower", title: "Lower", style: "line", color: "#ef5350", lineStyle: 2 },
    ],
    fills: [{ id: "band", title: "Channel", between: ["upper", "lower"], color: "#2962ff" }],
    compute: (bars, { width }) => {
      computes += 1;
      return {
        upper: Float64Array.from(bars, (item) => item.close + width),
        lower: bars.map((item, i) => (i === 0 ? null : item.close - width)),
      };
    },
  });
  const context = plainContext(series(6));
  const store = new StudyStore(context, new StudyRegistry([Channel]));
  const study = store.get(store.add({ name: "Channel" }));
  const [upper, lower, edgeA, edgeB] = study.series;
  ok(upper.color === "#26a69a" && upper.lineWidth === 2 && lower.lineStyle === 2 && lower.color === "#ef5350", "plot descriptors style the series");
  ok(Array.isArray(upper.values) && upper.values.length === 6, "Float64Array outputs become aligned arrays");
  ok(edgeA.style === "band" && edgeB.style === "band" && edgeA.values === upper.values && edgeB.values === lower.values, "the fill is a band pair sharing the plot arrays");
  ok(edgeA.fill === "band" && edgeA.color === "#2962ff" && edgeA.inLegend === false, "fill edges carry the fill id and colour and stay out of the legend");
  context.bars[5] = bar(5, 130);
  context.dataChanged.fire();
  ok(computes === 2 && study.series[0].values[5] === 132, "compute-only indicators fall back to a full recompute on ticks");

  const Zone = defineIndicator({
    name: "Zone",
    pane: "pane",
    inputs: {},
    range: { min: 0, max: 100 },
    levels: [{ value: 30, axisLabel: true }, { value: 70, dashed: true }],
    precision: 1,
    plots: [{ id: "v", title: "V", style: "line" }],
    fills: [{ id: "zone", between: { levels: [30, 70] }, color: "#7e57c2" }],
    init: () => 0,
    update: ({ index }) => ({ state: index, values: { v: index } }),
  });
  const zoneContext = plainContext(series(3));
  const zoneStore = new StudyStore(zoneContext, new StudyRegistry([Zone]));
  const zone = zoneStore.get(zoneStore.add({ name: "Zone" }));
  const levelEdges = zone.series.filter((item) => item.fill === "zone");
  ok(levelEdges.length === 2 && levelEdges[0].values.every((v) => v === 30) && levelEdges[1].values.every((v) => v === 70), "level fills become constant band edges");
  zoneContext.bars.push(bar(3, 100));
  zoneContext.dataChanged.fire();
  ok(levelEdges.every((edge) => edge.values.length === 4), "level-fill edges grow with incremental appends");
  ok(zone.def.range.max === 100 && zone.def.levels.length === 2 && zone.def.levels[0].axisLabel && zone.def.formatValue(12.345) === "12.3", "range, levels and precision map onto the v1 definition");

  const { warnings } = captureWarnings(() => defineIndicator({
    name: "Two fills",
    pane: "pane",
    inputs: {},
    plots: [{ id: "a", title: "A", style: "line" }, { id: "b", title: "B", style: "line" }],
    fills: [{ id: "f1", between: ["a", "b"], color: "#000" }, { id: "f2", between: { levels: [0, 1] }, color: "#111" }],
    compute: (bars) => ({ a: bars.map(() => 0), b: bars.map(() => 1) }),
  }));
  ok(warnings.length === 1 && warnings[0].includes("only the first fill"), "additional fills warn instead of being dropped silently");

  const Misaligned = defineIndicator({
    name: "Misaligned",
    pane: "pane",
    inputs: {},
    plots: [{ id: "v", title: "V", style: "line" }],
    compute: () => ({ v: [1] }),
  });
  const misStore = new StudyStore(plainContext(series(4)), new StudyRegistry([Misaligned]));
  const { result: misId } = captureWarnings(() => misStore.add({ name: "Misaligned" }));
  ok(misStore.get(misId).error.includes("has 1 values for 4 bars"), "misaligned outputs are reported as errors");

  // Handles also work as plain v1 definitions (screeners, other hosts).
  const direct = Channel.compute(series(3), { length: 0, width: 1 });
  ok(direct.series.length === 4 && direct.series[0].values[0] === series(3)[0].close + 1, "handle.compute() is a working full-array fallback");
  ok(Object.isFrozen(Channel) && Object.isFrozen(Channel.indicator), "handles are frozen");
  store.destroy();
  zoneStore.destroy();
  misStore.destroy();
}

// ── Per-widget ids (IdAllocator) ──────────────────────────────────────────
{
  const makeStore = () => {
    const context = seamContext(series(5));
    return { context, store: new StudyStore(context, new StudyRegistry(BUILTIN_STUDIES)) };
  };
  const a = makeStore();
  const b = makeStore();
  const idsA = ["EMA", "RSI", "EMA"].map((name) => a.store.add({ name }));
  const idsB = ["EMA", "RSI", "EMA"].map((name) => b.store.add({ name }));
  assert.deepEqual(idsA, ["study_ema_1", "study_rsi_2", "study_ema_3"], "study ids keep the historical shape");
  assert.deepEqual(idsB, idsA, "two widgets produce identical ids for identical operations");
  ok(a.context.ids.peek("study") === 3, "ids come from the context allocator");
  a.store.restore({ id: "study_sma_40", name: "SMA", length: 5, color: "#fff", lock: false, forceOverlay: false, inputs: {} });
  ok(a.store.add({ name: "SMA" }) === "study_sma_41", "restored ids are reserved");
  const plain = new StudyStore(plainContext(series(5)), new StudyRegistry(BUILTIN_STUDIES));
  ok(plain.add({ name: "EMA" }) === "study_ema_1", "contexts without the seam get a private allocator");
  const shared = new IdAllocator();
  shared.next("study", { label: "study_ema" });
  const sharedStore = new StudyStore(seamContext(series(5), {}, { ids: shared }), new StudyRegistry(BUILTIN_STUDIES));
  ok(sharedStore.add({ name: "EMA" }) === "study_ema_2", "a host-supplied allocator continues its own sequence");
  checks += 2;
  for (const store of [a.store, b.store, plain, sharedStore]) store.destroy();
}

// ── update(): in-place edits with one undo step ───────────────────────────
{
  const commands = new CommandStack();
  const context = plainContext(series(40));
  const store = new StudyStore(context, new StudyRegistry(BUILTIN_STUDIES), commands);
  const changes = [];
  store.changed.subscribe(null, (change) => changes.push(change.kind));
  const id = store.add({ name: "RSI", length: 14 });
  const original = [...store.get(id).values];
  ok(store.update(id, { length: 7, color: "#ff0000" }), "update() applies to live studies");
  const edited = store.get(id);
  ok(edited.id === id && edited.length === 7 && edited.color === "#ff0000", "the id is kept");
  assert.deepEqual(edited.values, BUILTIN_STUDIES.find((d) => d.name === "RSI").compute(context.bars, { length: 7 }), "the study recomputes");
  commands.undo();
  ok(store.get(id).length === 14 && store.get(id).color !== "#ff0000", "one undo restores the previous spec");
  assert.deepEqual(store.get(id).values, original);
  commands.redo();
  ok(store.get(id).length === 7, "redo re-applies the edit");
  ok(changes.includes("add") && changes.includes("inputs"), "edits publish change events");
  const depth = commands.undoDepth;
  ok(store.update(id, { length: 7 }) && commands.undoDepth === depth, "no-op edits record no undo step");
  ok(!store.update("study_missing_1", { length: 3 }), "unknown ids return false");
  store.destroy();
}

// ── perf-undo-study-clones: spec-only undo, capped depth ──────────────────
{
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc");
  const heap = () => {
    for (let i = 0; i < 4; i++) gc();
    return process.memoryUsage().heapUsed;
  };
  const n = 500_000;
  const bars = new Array(n);
  for (let i = 0; i < n; i++) bars[i] = bar(i, 100 + Math.sin(i / 50) * 10 + (i % 7) * 0.01);
  const commands = new CommandStack();
  const context = plainContext(bars);
  const store = new StudyStore(context, new StudyRegistry(BUILTIN_STUDIES), commands);
  const names = ["EMA", "SMA", "RSI", "VWAP", "Bollinger Bands", "MACD"];
  const baseline = heap();
  const ids = names.map((name) => store.add({ name }));
  const values = new Map(ids.map((id) => [id, store.get(id).series.map((item) => item.values.slice(-5))]));
  for (const id of ids) store.remove(id);
  const retained = heap() - baseline;
  const retainedMb = retained / 1024 / 1024;
  console.log(`retained after add/remove of 6 studies at 500k bars: ${retainedMb.toFixed(2)} MB`);
  ok(retainedMb < 2, `adding then removing 6 studies at 500k bars retains ${retainedMb.toFixed(2)} MB (< 2 MB)`);

  for (let i = 0; i < 6; i++) commands.undo(); // undo the removals, newest first
  assert.deepEqual(store.list().map((study) => study.id), ids, "undo restores the original ids in order");
  for (const id of ids) {
    assert.deepEqual(store.get(id).series.map((item) => item.values.slice(-5)), values.get(id), `undo restores identical values for ${id}`);
  }
  for (let i = 0; i < 6; i++) commands.undo(); // undo the additions
  ok(store.list().length === 0, "undoing the additions removes every study");
  for (let i = 0; i < 12; i++) commands.redo();
  assert.deepEqual(store.list().map((study) => study.id), [], "redo replays additions and removals");
  for (let i = 0; i < 6; i++) commands.undo();
  assert.deepEqual(store.list().map((study) => study.id), ids, "redo/undo keep the ids stable");
  checks += 4;
  store.destroy();
}
{
  const commands = new CommandStack();
  ok(commands.limit === 100, "the undo depth defaults to 100");
  let undone = 0;
  for (let i = 0; i < 150; i++) commands.push({ undo: () => { undone += 1; }, redo() {} });
  ok(commands.undoDepth === 100, "the oldest steps are dropped beyond the limit");
  commands.limit = 10;
  ok(commands.undoDepth === 10, "lowering the limit trims immediately");
  while (commands.undo());
  ok(undone === 10 && commands.redoDepth === 10, "only the retained steps undo");
  const custom = new CommandStack({ limit: 3 });
  for (let i = 0; i < 5; i++) custom.push({ undo() {}, redo() {} });
  ok(custom.undoDepth === 3, "the limit is configurable in the constructor");
  ok(new CommandStack({ limit: Infinity }).limit === Infinity, "Infinity disables the cap");
  assert.throws(() => new CommandStack({ limit: 0 }), /positive integer or Infinity/);
  assert.throws(() => { commands.limit = 2.5; }, /positive integer or Infinity/);
  checks += 2;
}

// ── Disabled undo for API-created studies ─────────────────────────────────
{
  const commands = new CommandStack();
  const store = new StudyStore(plainContext(series(5)), new StudyRegistry(BUILTIN_STUDIES), commands);
  store.add({ name: "EMA", disableUndo: true });
  ok(commands.undoDepth === 0 && store.list().length === 1, "disableUndo adds without an undo step");
  store.destroy();
}

// ── Invalid inputs: strict creates, lenient restores, schema-less checks ──
{
  const Evolving = defineIndicator({
    name: "Evolving",
    pane: "pane",
    inputs: { len: int(10, { min: 1, max: 50 }), mode: select(["fast", "slow"], "fast"), show: bool(true) },
    plots: [{ id: "v", title: "V", style: "line" }],
    compute: (bars, { len }) => ({ v: bars.map(() => len) }),
  });
  const Plain = {
    name: "Plain v1",
    pane: "overlay",
    defaults: { length: 5, offset: 2 },
    compute: (bars, inputs) => bars.map((item) => item.close + inputs.offset + (inputs.flag ? 1 : 0)),
  };
  const bars = series(12);
  const store = new StudyStore(plainContext(bars), new StudyRegistry([Evolving, Plain]), new CommandStack());
  // A layout saved before the plugin renamed an input and dropped a select option.
  const stale = { len: 20, mode: "medium", removed: 3 };

  assert.throws(() => store.add({ name: "Evolving", inputs: stale }), (error) => error.name === "StudyInputError", "add() is strict by default");
  const { result: id, warnings } = captureWarnings(() => store.add({ id: "study_evolving_7", name: "Evolving", inputs: stale, invalidInputs: "default" }));
  const study = store.get(id);
  assert.deepEqual(study.inputs, { len: 20, mode: "fast", show: true }, "lenient adds keep valid inputs and default the rest");
  ok(warnings.length === 1, `one warning per study (got ${warnings.length})`);
  ok(
    warnings[0].includes('study "Evolving" (study_evolving_7)')
      && warnings[0].includes('input "mode" reset to its default: expected one of fast, slow, got "medium"')
      && warnings[0].includes('input "removed" dropped: unknown input. Supported inputs: len, mode, show')
      && warnings[0].includes("Save the layout again"),
    `the warning names the study, each input and the fix: ${warnings[0]}`,
  );
  ok(study.inputWarning.startsWith('input "mode" reset to its default') && study.inputWarning.includes('input "removed" dropped'), "the problem is recorded on StudyInstance.inputWarning");
  ok(study.error === null && study.values.every((value) => value === 20), "the restored study computes with its surviving inputs");

  // restore() (undo/redo, snapshots) never throws for stale inputs either.
  const { result: restored, warnings: restoreWarnings } = captureWarnings(() => store.restore({
    id: "study_evolving_9", name: "Evolving", length: 0, color: "#fff", lock: false, forceOverlay: false, inputs: { len: 999, show: "maybe" },
  }));
  const restoredStudy = store.get("study_evolving_9");
  ok(restored && restoredStudy.inputs.show === true && restoredStudy.inputs.len === 50, "restore() clamps and defaults invalid values instead of throwing");
  ok(restoreWarnings.some((line) => line.includes('input "show" reset to its default')), "restore() warns about the reset input");

  // Edits stay strict, and a successful edit clears the warning.
  assert.throws(() => store.update(id, { inputs: { mode: "medium" } }), (error) => error.code === "invalid-value", "update() stays strict");
  ok(store.update(id, { inputs: { mode: "slow" } }) && store.get(id).inputWarning === undefined, "a successful edit clears inputWarning");

  // Definitions without a schema: numbers, strings and booleans only.
  const plainId = store.add({ name: "Plain v1", inputs: { flag: true } });
  ok(store.get(plainId).inputs.flag === true && store.get(plainId).values[0] === bars[0].close + 3, "definitions without a schema receive booleans");
  let plainError = null;
  try {
    store.add({ name: "Plain v1", inputs: { offset: { value: 3 } } });
  } catch (error) {
    plainError = error;
  }
  ok(
    plainError instanceof StudyInputError && plainError.code === "invalid-value" && plainError.input === "offset"
      && plainError.message.includes('expected a number, string or boolean, got {"value":3}'),
    "objects reject for definitions without a schema",
  );
  const { result: lenientPlain, warnings: plainWarnings } = captureWarnings(() => store.add({
    name: "Plain v1", inputs: { offset: [1], extra: () => 1 }, invalidInputs: "default",
  }));
  assert.deepEqual(store.get(lenientPlain).inputs, { offset: 2 }, "lenient mode keeps the default and drops values that have none");
  ok(
    plainWarnings.length === 1 && plainWarnings[0].includes('input "offset" reset to its default') && plainWarnings[0].includes('input "extra" dropped: expected a number, string or boolean, got a function'),
    "the schema-less warning says which values were reset or dropped",
  );
  checks += 2;
  store.destroy();
}

// ── Gesture pans publish only viewportChanged ─────────────────────────────
{
  let computes = 0;
  const GestureRange = defineIndicator({
    name: "Gesture range probe",
    pane: "pane",
    inputs: {},
    dependsOn: ["visibleRange"],
    plots: [{ id: "v", title: "V", style: "line" }],
    compute: (bars, _inputs, ctx) => {
      computes += 1;
      return { v: bars.map(() => ctx.visibleRange.to) };
    },
  });
  const context = seamContext(series(40));
  const store = new StudyStore(context, new StudyRegistry([GestureRange]));
  const id = store.add({ name: "Gesture range probe" });
  // What drag, wheel, pinch and axis-scale gestures do today: write the range,
  // then publish the public event (no rangeChanged).
  for (let step = 1; step <= 4; step++) {
    context.visibleRange = { from: step, to: 20 + step };
    context.viewportChanged.fire({ from: 0, to: 0 });
  }
  ok(computes === 1, "gesture pans schedule the recompute instead of running it synchronously");
  await wait(30);
  ok(computes === 2 && store.get(id).values[0] === 24, "a burst of gesture pans recomputes once, with the latest range");
  await wait(120);
  context.setViewport({ from: 5, to: 30 }, "pan"); // fires rangeChanged and viewportChanged
  await wait(30);
  ok(computes === 3 && store.get(id).values[0] === 30, "setViewport's two events coalesce into one recompute");
  store.destroy();
  context.viewportChanged.fire({ from: 0, to: 0 });
  await wait(150);
  ok(computes === 3, "destroy() unsubscribes from viewportChanged");
}

// ── Widget integration: createStudy rejects, booleans round-trip, ctx ─────
{
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node });
  // A recording 2D context: every fill() remembers its fillStyle and path size.
  const fills = [];
  let pathPoints = 0;
  const context2d = new Proxy(
    { measureText: (value) => ({ width: String(value ?? "").length * 6 }), canvas: {} },
    {
      get: (target, property) => {
        if (property === "beginPath") return () => { pathPoints = 0; };
        if (property === "moveTo" || property === "lineTo") return () => { pathPoints += 1; };
        if (property === "fill") return () => { fills.push({ style: target.fillStyle, points: pathPoints }); };
        return property in target ? target[property] : () => {};
      },
      set: (target, property, value) => { target[property] = value; return true; },
    },
  );
  window.HTMLCanvasElement.prototype.getContext = () => context2d;
  for (const [key, value] of [["clientWidth", 640], ["clientHeight", 360]]) {
    Object.defineProperty(window.HTMLElement.prototype, key, { configurable: true, get: () => value });
  }
  class TestResizeObserver { constructor(callback) { this.callback = callback; } observe() { this.callback([]); } disconnect() {} }
  globalThis.ResizeObserver = TestResizeObserver;
  window.ResizeObserver = TestResizeObserver;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

  const symbolInfo = (name) => ({
    name, ticker: name, description: name, type: "stock", session: "0930-1600", timezone: "America/New_York",
    exchange: "Test", listed_exchange: "Test", format: "price", minmov: 1, pricescale: 100, has_intraday: true, supported_resolutions: ["1"],
  });
  const feedBars = series(30).map((item, i) => ({ ...item, time: 1_700_000_000_000 + i * 60_000 }));
  const feed = {
    onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1"] })); },
    searchSymbols(_a, _b, _c, callback) { callback([]); },
    resolveSymbol(name, resolve) { queueMicrotask(() => resolve(symbolInfo(name))); },
    getBars(_info, _resolution, _params, onResult) { queueMicrotask(() => onResult(feedBars.map((item) => ({ ...item })), { noData: true })); },
    subscribeBars() {},
    unsubscribeBars() {},
  };
  const seen = [];
  const Probe = defineIndicator({
    name: "Context probe",
    pane: "pane",
    inputs: { flag: bool(false), mode: select(["fast", "slow"], "fast"), len: int(10, { min: 1, max: 100 }) },
    plots: [{ id: "v", title: "V", style: "line" }],
    compute: (bars, inputs, ctx) => {
      seen.push({ inputs, timezone: ctx.symbolInfo?.timezone, resolution: ctx.resolution, zone: ctx.timezone });
      return { v: bars.map(() => (inputs.flag ? 1 : 0)) };
    },
  });
  const Cloud = defineIndicator({
    name: "Cloud",
    pane: "overlay",
    inputs: { width: float(1, { min: 0 }) },
    plots: [
      { id: "upper", title: "Upper", style: "line", color: "#26a69a" },
      { id: "lower", title: "Lower", style: "line", color: "#ef5350" },
    ],
    fills: [{ id: "cloud", between: ["upper", "lower"], color: "#00897b" }],
    compute: (bars, { width }) => ({
      upper: bars.map((item) => item.close + width),
      lower: bars.map((item) => item.close - width),
    }),
  });
  const positionalSeen = [];
  const Positional = defineIndicator({
    name: "Positional probe",
    pane: "pane",
    inputs: { length: int(10, { min: 1, max: 100 }), src: source("close") },
    plots: [{ id: "v", title: "V", style: "line" }],
    compute: (bars, inputs) => {
      positionalSeen.push({ ...inputs });
      return { v: bars.map(() => inputs.length) };
    },
  });
  const looseSeen = [];
  const Loose = {
    name: "Loose v1",
    pane: "pane",
    defaults: { length: 3, offset: 1 },
    compute: (bars, inputs) => {
      looseSeen.push({ ...inputs });
      return bars.map((item) => item.close + inputs.offset);
    },
  };
  let gestureComputes = 0;
  const GestureRange = defineIndicator({
    name: "Gesture range",
    pane: "pane",
    inputs: {},
    dependsOn: ["visibleRange"],
    plots: [{ id: "v", title: "V", style: "line" }],
    compute: (bars, _inputs, ctx) => {
      gestureComputes += 1;
      return { v: bars.map(() => ctx.visibleRange?.to ?? null) };
    },
  });
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const chartWidget = new root.widget({
    symbol: "AAPL",
    interval: "1",
    container: host,
    datafeed: feed,
    disabled_features: ["header_widget", "left_toolbar", "scale_bar"],
    raze: { custom_studies: [Probe, Cloud, Positional, Loose, GestureRange] },
  });
  await chartWidget.headerReady();
  for (let i = 0; i < 20 && !chartWidget.save().symbol; i++) await wait(5);
  await wait(20);
  const api = chartWidget.activeChart();
  // A "true" string is coerced by the schema, so the stored input is a real
  // boolean (real boolean arguments are covered below).
  const id = await api.createStudy("Context probe", false, false, { flag: "true", len: 20 });
  const last = seen.at(-1);
  ok(last.inputs.flag === true && last.inputs.len === 20 && last.inputs.mode === "fast", "createStudy inputs reach compute with defaults filled in");
  ok(last.timezone === "America/New_York" && last.resolution === "1" && last.zone === "America/New_York", "a custom study receives ctx.symbolInfo.timezone and ctx.resolution");

  const saved = chartWidget.save();
  const savedStudy = saved.studies.find((study) => study.id === String(id));
  assert.deepEqual(savedStudy.inputs, { flag: true, mode: "fast", len: 20 }, "save() persists the effective inputs, booleans included");
  await chartWidget.load(JSON.parse(JSON.stringify(saved)));
  const reloaded = chartWidget.save().studies.find((study) => study.id === String(id));
  assert.deepEqual(reloaded.inputs, savedStudy.inputs, "boolean inputs round-trip through save() and load()");
  ok(seen.at(-1).inputs.flag === true, "the reloaded study computes with the saved boolean");

  let rejection = null;
  await api.createStudy("Context probe", false, false, { flag: "x" }).catch((error) => { rejection = error; });
  ok(rejection instanceof StudyInputError && rejection.code === "invalid-value" && rejection.input === "flag", "createStudy rejects wrongly typed inputs with a StudyInputError");
  ok(rejection.name === "StudyInputError" && !(rejection instanceof studies.StudyInputError), "errors from the root bundle are identified by name across bundles");
  rejection = null;
  await api.createStudy("Context probe", false, false, { flg: 1 }).catch((error) => { rejection = error; });
  ok(rejection?.code === "unknown-input" && rejection.message.includes("Supported inputs: flag, mode, len"), "unknown ids reject with the supported list");
  const { result: clampedPromise, warnings } = captureWarnings(() => api.createStudy("Context probe", false, false, { len: 500 }));
  const clampedId = await clampedPromise;
  ok(warnings.some((line) => line.includes('"len" = 500')), "clamping through the API warns");
  const clamped = chartWidget.save().studies.find((study) => study.id === String(clampedId));
  ok(clamped.inputs.len === 100, "out-of-range inputs clamp to the declared max");

  // ── A fill-between of two outputs renders ──
  fills.length = 0;
  const cloudId = await api.createStudy("Cloud", false, false, { width: 3 });
  await wait(30);
  const cloudFills = fills.filter((entry) => entry.style === "#00897b33");
  ok(cloudId && cloudFills.length > 0, "the fill between two plots is painted with the fill colour");
  ok(cloudFills.every((entry) => entry.points >= 4), "the fill path spans both plot edges");

  // ── createStudy forwards every caller value to validation ──
  const realBool = await api.createStudy("Context probe", false, false, { flag: true });
  ok(seen.at(-1).inputs.flag === true, "a real boolean input reaches compute()");
  ok(chartWidget.save().studies.find((study) => study.id === String(realBool)).inputs.flag === true, "save() stores the real boolean");
  for (const bad of [{ flag: {} }, { flag: [1] }, { mode: { value: "slow" } }]) {
    rejection = null;
    await api.createStudy("Context probe", false, false, bad).catch((error) => { rejection = error; });
    ok(rejection?.name === "StudyInputError" && rejection.code === "invalid-value", `${JSON.stringify(bad)} rejects with invalid-value instead of being dropped`);
  }

  // TradingView's legacy positional form maps onto the declared inputs.
  const positionalId = await api.createStudy("Positional probe", false, false, [20]);
  ok(positionalId && positionalSeen.at(-1).length === 20 && positionalSeen.at(-1).src === "close", "a positional array sets the first declared input");
  await api.createStudy("Positional probe", false, false, [30, "hl2"]);
  ok(positionalSeen.at(-1).length === 30 && positionalSeen.at(-1).src === "hl2", "positional values map in declaration order");
  rejection = null;
  await api.createStudy("Positional probe", false, false, [1, "close", 3]).catch((error) => { rejection = error; });
  ok(rejection?.code === "unknown-input" && rejection.message.includes("received 3 positional inputs but the study declares 2 (length, src)"), "longer positional arrays reject with the declared inputs");
  rejection = null;
  await api.createStudy("Positional probe", false, false, ["x"]).catch((error) => { rejection = error; });
  ok(rejection?.code === "invalid-value" && rejection.input === "length", "positional values are validated like named ones");

  // The length/colour shorthand is used or rejected, never silently dropped.
  const emaId = await api.createStudy("EMA", false, false, { length: "21" });
  ok(chartWidget.save().studies.find((study) => study.id === String(emaId)).length === 21, "a numeric-string length is used");
  for (const [bad, input] of [[{ length: "long" }, "length"], [{ Length: true }, "Length"], [{ color: 0xff0000 }, "color"]]) {
    rejection = null;
    await api.createStudy("EMA", false, false, bad).catch((error) => { rejection = error; });
    ok(rejection?.code === "invalid-value" && rejection.input === input, `${JSON.stringify(bad)} rejects instead of using the default`);
  }

  // Definitions without a schema get booleans and reject objects.
  await api.createStudy("Loose v1", false, false, { flag: true, offset: 4 });
  ok(looseSeen.at(-1).flag === true && looseSeen.at(-1).offset === 4, "definitions without a schema receive boolean inputs");
  rejection = null;
  await api.createStudy("Loose v1", false, false, { offset: { by: 2 } }).catch((error) => { rejection = error; });
  ok(rejection?.code === "invalid-value" && rejection.input === "offset", "objects reject for definitions without a schema");

  // ── A visible-range study recomputes when the user pans (gesture path) ──
  await api.createStudy("Gesture range");
  await wait(150);
  const beforePan = gestureComputes;
  const canvas = host.querySelector("canvas");
  canvas.focus();
  for (let i = 0; i < 3; i++) {
    canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  }
  ok(gestureComputes === beforePan, "keyboard pans schedule the recompute");
  await Promise.resolve();
  ok(host.querySelector('[role="status"]')?.textContent === "Panned left.", "the keyboard pan ran through the gesture handlers");
  await wait(150);
  ok(gestureComputes === beforePan + 1, `a burst of keyboard pans recomputes the visible-range study once (got ${gestureComputes - beforePan})`);

  // ── load() restores what it can when saved inputs went stale ──
  const drawingId = await api.createShape({ time: Math.floor(feedBars[20].time / 1000), price: 101 }, { shape: "horizontal_line" });
  const layout = JSON.parse(JSON.stringify(chartWidget.save()));
  const savedCount = layout.studies.length;
  const staleStudy = layout.studies.find((study) => study.id === String(realBool));
  // The plugin since removed an input and a select option.
  staleStudy.inputs = { ...staleStudy.inputs, removedInput: 5, mode: "medium" };
  // A hand-written entry without an id.
  layout.studies.push({ name: "Context probe", length: 0, color: "", inputs: { flag: "sometimes", len: 30 } });
  const { warnings: loadWarnings } = await captureWarningsAsync(() => chartWidget.load(layout));
  const reloadedLayout = chartWidget.save();
  ok(reloadedLayout.studies.length === savedCount + 1, `load() restores every saved study (${reloadedLayout.studies.length}/${savedCount + 1})`);
  ok(reloadedLayout.drawings.some((drawing) => drawing.id === String(drawingId)), "drawings survive a layout with stale study inputs");
  assert.deepEqual(
    reloadedLayout.studies.find((study) => study.id === String(realBool)).inputs,
    { flag: true, mode: "fast", len: 10 },
    "stale inputs fall back to their defaults and valid ones are kept",
  );
  const idless = reloadedLayout.studies.at(-1);
  ok(idless.name === "Context probe" && idless.inputs.flag === false && idless.inputs.len === 30, "saved studies without an id restore leniently too");
  ok(
    loadWarnings.some((line) => line.includes(`(${realBool})`) && line.includes('input "removedInput" dropped') && line.includes('input "mode" reset to its default')),
    "load() warns once per stale study, naming the inputs",
  );
  ok(loadWarnings.some((line) => line.includes('input "flag" reset to its default')), "the id-less study's reset input is reported");
  api.executeActionById("undo");
  ok(chartWidget.save().studies.length === savedCount + 1, "load() finished: its history was cleared, so undo changes nothing");
  checks += 1;

  chartWidget.remove();

  // raze.undo_limit configures the widget's history depth.
  const limitedHost = window.document.createElement("div");
  window.document.body.appendChild(limitedHost);
  const limited = new root.widget({
    symbol: "AAPL",
    interval: "1",
    container: limitedHost,
    datafeed: feed,
    disabled_features: ["header_widget", "left_toolbar", "scale_bar"],
    raze: { undo_limit: 1 },
  });
  await limited.headerReady();
  await wait(20);
  const limitedApi = limited.activeChart();
  const first = await limitedApi.createStudy("EMA");
  const second = await limitedApi.createStudy("SMA");
  limitedApi.executeActionById("undo");
  limitedApi.executeActionById("undo");
  const remaining = limited.save().studies.map((study) => study.id);
  ok(remaining.includes(String(first)) && !remaining.includes(String(second)), "raze.undo_limit: 1 keeps only the newest undo step");
  limited.remove();
  assert.throws(
    () => new root.widget({ symbol: "AAPL", interval: "1", container: limitedHost, datafeed: feed, raze: { undo_limit: 0 } }),
    /CommandStack limit must be a positive integer or Infinity/,
    "invalid undo limits throw",
  );
  checks += 1;
  checks += 2;
}

console.log(`STUDY CONTRACT: PASS (${checks} checks)`);
process.exit(0);
