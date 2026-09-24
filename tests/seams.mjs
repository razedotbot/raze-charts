// Contract tests for the wave-1A shared seams (W1A-06): context setters and
// change delegates, clock, timezone, featureset policy, per-instance ids,
// persistence slices, plugin contract helpers, scene v2 guard, the engine's
// overlay host/invalidation and the renderer's new view fields.
//
// The seams are internal modules, so this test bundles them from source with
// esbuild (no build step needed): node tests/seams.mjs

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};
const throwsLike = (fn, ctor, pattern, message) => {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert(
    error instanceof ctor && pattern.test(String(error.message)),
    `${message}${error ? "" : " (nothing was thrown)"}`,
  );
};

// ── DOM environment (mirrors tests/financial-runtime.mjs) ────────────────────
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
window.devicePixelRatio = 2;
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
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 640 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 360 });
class TestResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([]); }
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver;
window.ResizeObserver = TestResizeObserver;
let nextFrameId = 0;
const frames = new Map();
globalThis.requestAnimationFrame = (callback) => {
  const id = ++nextFrameId;
  frames.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
const flushFrames = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
};

// ── Bundle the seam modules from source ──────────────────────────────────────
const entry = `
export * from "./src/core/context";
export * from "./src/core/ids";
export * from "./src/core/stateTypes";
export * from "./src/drawings/types";
export * from "./src/studies/types";
export * from "./src/chart/sceneTypes";
export { AXIS_TAG_PRIORITY } from "./src/engine/paint/view";
export { ChartEngine } from "./src/engine/ChartEngine";
export { ChartRenderer } from "./src/engine/ChartRenderer";
export { Widget } from "./src/core/Widget";
export { createWidgetContext } from "./src/core/widget/runtime";
export { compileChart, defineChart, line } from "./src/chart/index";
export { buildTheme } from "./src/core/theme";
export { createPriceFormatter } from "./src/util/format";
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts", sourcefile: "seams-entry.ts" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  write: false,
  logLevel: "silent",
  define: { __RAZE_CHARTS_VERSION__: JSON.stringify("test") },
});
const scratch = mkdtempSync(join(tmpdir(), "raze-seams-"));
const bundlePath = join(scratch, "seams.mjs");
writeFileSync(bundlePath, bundled.outputFiles[0].text);
const seams = await import(pathToFileURL(bundlePath).href);
rmSync(scratch, { recursive: true, force: true });

const {
  AXIS_TAG_PRIORITY,
  CHART_STYLES,
  CHART_TYPE_CHANGE_REASONS,
  ChartEngine,
  ChartRenderer,
  DEFAULT_VISIBLE_BARS,
  ID_NAMESPACES,
  IdAllocator,
  RESERVED_SLICE_KEYS,
  SCALE_CHANGE_REASONS,
  SCENE_CONTRACT_VERSION,
  STUDY_INPUT_TYPES,
  STUDY_SOURCES,
  VIEWPORT_CHANGE_REASONS,
  Widget,
  createWidgetContext,
  anchorsComplete,
  buildFeatureSet,
  buildTheme,
  compileChart,
  createChartContext,
  createPriceFormatter,
  defaultInputValues,
  defineChart,
  defineStateSlice,
  findNonJsonValue,
  idSlug,
  isIncrementalIndicator,
  isSceneV2,
  line,
  minAnchors,
  readScaleState,
  resolveTimezone,
  stateSliceIssues,
  visibleUnixRange,
} = seams;

// ── Context factory ─────────────────────────────────────────────────────────
class Emitter {
  constructor() { this.listeners = []; }
  subscribe(_obj, fn) { this.listeners.push(fn); }
  unsubscribe(_obj, fn) { this.listeners = this.listeners.filter((l) => l !== fn); }
  unsubscribeAll() { this.listeners = []; }
  fire(...args) { for (const fn of this.listeners.slice()) fn(...args); }
}

const barAt = (i) => ({ time: 1_700_000_000_000 + i * 60_000, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 10 });
function makeContext(overrides = {}, factoryOptions = {}) {
  const options = { symbol: "TEST", interval: "1", container: "x", datafeed: {}, timezone: "America/New_York", ...(overrides.options ?? {}) };
  let paints = 0;
  const init = {
    options,
    datafeed: options.datafeed,
    locale: "en",
    fontFamily: "sans-serif",
    symbol: "TEST",
    resolution: "1",
    symbolInfo: null,
    formatPrice: createPriceFormatter(options, null),
    theme: buildTheme(options),
    features: buildFeatureSet(options),
    bars: Array.from({ length: 10 }, (_, i) => barAt(i)),
    marks: [],
    timescaleMarks: [],
    visibleRange: { from: 0, to: 5 },
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
    intervalChanged: new Emitter(),
    dataChanged: new Emitter(),
    drawingEvent: new Emitter(),
    tradingEvent: new Emitter(),
    viewportChanged: new Emitter(),
    crosshairMoved: new Emitter(),
    requestPaint: () => { paints += 1; },
    ...overrides.init,
  };
  const ctx = createChartContext(init, factoryOptions);
  return { ctx, init, paints: () => paints };
}

{
  const { ctx, init } = makeContext();
  assert(ctx === init, "createChartContext extends the supplied state object in place");
  assert(ctx.ids instanceof IdAllocator, "every context owns an IdAllocator");
  assert(ctx.overlayHost === null, "overlayHost is null until an engine mounts");
  assert(ctx.defaultVisibleBars() === DEFAULT_VISIBLE_BARS && DEFAULT_VISIBLE_BARS === 120, "defaultVisibleBars() falls back to the historical 120-bar view");
  let paints = 0;
  ctx.requestPaint = () => { paints += 1; };
  ctx.requestOverlayPaint();
  assert(paints === 1, "requestOverlayPaint() falls back to the (late-bound) requestPaint()");
  const other = makeContext().ctx;
  assert(other.ids !== ctx.ids && other.rangeChanged !== ctx.rangeChanged, "contexts never share allocators or delegates");
  const hooked = makeContext({ init: { defaultVisibleBars: () => 42 } }).ctx;
  assert(hooked.defaultVisibleBars() === 42, "a pre-installed defaultVisibleBars provider is kept");
}

// ── setViewport ─────────────────────────────────────────────────────────────
{
  const { ctx, paints } = makeContext();
  const ranges = [];
  const unix = [];
  ctx.rangeChanged.subscribe(null, (change) => ranges.push(change));
  ctx.viewportChanged.subscribe(null, (range) => unix.push(range));
  const requested = { from: 2, to: 7 };
  assert(ctx.setViewport(requested, "pan") === true, "setViewport reports an effective change");
  requested.from = 99;
  assert(ctx.visibleRange.from === 2 && ctx.visibleRange.to === 7, "setViewport stores a copy, not the caller's object");
  assert(
    ranges.length === 1
      && ranges[0].reason === "pan"
      && ranges[0].previous.from === 0 && ranges[0].previous.to === 5
      && ranges[0].range.from === 2 && ranges[0].range.to === 7,
    "rangeChanged fires once with the reason, previous and next range",
  );
  const expectedUnix = visibleUnixRange(ctx.bars, { from: 2, to: 7 });
  assert(
    unix.length === 1 && unix[0].from === expectedUnix.from && unix[0].to === expectedUnix.to
      && expectedUnix.from === Math.floor(barAt(2).time / 1000),
    "the public viewportChanged receives the Unix-second window",
  );
  assert(paints() === 1, "an effective viewport change requests exactly one repaint");
  assert(ctx.setViewport({ from: 2, to: 7 }, "zoom") === false && ranges.length === 1 && unix.length === 1 && paints() === 1, "an unchanged range is a no-op with no events");
  ctx.setViewport({ from: 12, to: 17 }, "rebase");
  assert(ranges.length === 2 && unix.length === 1, "rebase re-anchors indices without a public time-range event");
  ctx.setViewport({ from: 13, to: 18 }, "rebase", { notify: true });
  assert(unix.length === 2, "notify:true forces the public event");
  ctx.setViewport({ from: 14, to: 19 }, "api", { notify: false });
  assert(ranges.length === 4 && unix.length === 2, "notify:false suppresses only the public event");
  assert(ctx.setViewport({ from: 3, to: 3 }, "fit") === true, "a single-bar range (from === to) stays valid, as with ALL on one bar");
  throwsLike(() => ctx.setViewport({ from: 5, to: 1 }, "api"), RangeError, /inverted/, "an inverted range throws a RangeError");
  throwsLike(() => ctx.setViewport({ from: Number.NaN, to: 1 }, "api"), RangeError, /finite/, "a non-finite range throws a RangeError");
  throwsLike(() => ctx.setViewport({ from: 1, to: 2 }, "scroll"), TypeError, /Supported reasons: .*pan/, "an unknown reason throws and lists the supported reasons");
  assert(ctx.visibleRange.from === 3 && ctx.visibleRange.to === 3, "rejected writes leave the range untouched");
  assert(VIEWPORT_CHANGE_REASONS.includes("rebase") && Object.isFrozen(VIEWPORT_CHANGE_REASONS), "viewport reasons are a frozen, documented vocabulary");
  let reentrant = 0;
  ctx.rangeChanged.subscribe(null, (change) => {
    if (change.reason === "zoom") {
      reentrant += 1;
      ctx.setViewport({ from: 0, to: 4 }, "cancel");
    }
  });
  ctx.setViewport({ from: 1, to: 9 }, "zoom");
  assert(reentrant === 1 && ctx.visibleRange.to === 4, "listeners may re-enter setViewport (for example to clamp)");
}

// ── setScaleMode / scaleState ───────────────────────────────────────────────
{
  const { ctx, paints } = makeContext();
  const changes = [];
  ctx.scaleChanged.subscribe(null, (change) => changes.push(change));
  assert(ctx.scaleState().mode === "normal" && ctx.scaleState().autoScale === true && ctx.scaleState().priceRange === null, "scaleState() reads the legacy flags");
  ctx.setScaleMode({ mode: "log" }, "scale-bar");
  assert(ctx.logScale === true && ctx.percentScale === false, "mode log writes the legacy logScale flag");
  ctx.setScaleMode({ mode: "percent" }, "scale-bar");
  assert(ctx.logScale === false && ctx.percentScale === true, "log and percent stay mutually exclusive");
  assert(
    changes.length === 2 && changes[1].previous.mode === "log" && changes[1].state.mode === "percent" && changes[1].reason === "scale-bar",
    "scaleChanged carries previous state, next state and reason",
  );
  ctx.setScaleMode({ priceRange: { min: 90, max: 120 } }, "axis-drag");
  assert(ctx.autoScalePrice === false && ctx.priceRange.min === 90 && ctx.priceRange.max === 120, "a manual price range turns autoscale off");
  ctx.setScaleMode({ autoScale: true }, "axis-reset");
  assert(ctx.autoScalePrice === true && ctx.priceRange === null, "re-enabling autoscale clears the manual range");
  assert(ctx.setScaleMode({ autoScale: true }, "fit") === false && changes.length === 4, "an unchanged scale is a no-op with no event");
  assert(paints() === 4, "each effective scale change requests one repaint");
  throwsLike(() => ctx.setScaleMode({ autoScale: true, priceRange: { min: 1, max: 2 } }, "api"), TypeError, /autoscale replaces/, "autoScale:true with a pinned range is rejected as contradictory");
  throwsLike(() => ctx.setScaleMode({ log: true }, "api"), TypeError, /does not support "log"/, "unknown patch keys are rejected instead of ignored");
  throwsLike(() => ctx.setScaleMode({ mode: "indexed" }, "api"), TypeError, /Supported modes: normal, log, percent/, "unsupported scale modes are rejected with the supported list");
  throwsLike(() => ctx.setScaleMode({ priceRange: { min: 5, max: 1 } }, "api"), RangeError, /inverted/, "an inverted manual range is rejected");
  throwsLike(() => ctx.setScaleMode({ mode: "log" }, "drag"), TypeError, /Supported reasons/, "an unknown scale reason is rejected");
  const legacy = readScaleState({ logScale: true, percentScale: true, autoScalePrice: true, priceRange: { min: 1, max: 2 } });
  assert(legacy.mode === "percent" && legacy.priceRange === null, "readScaleState matches the painters: percent wins and autoscale ignores a stale manual range");
  assert(SCALE_CHANGE_REASONS.includes("compare") && SCALE_CHANGE_REASONS.includes("axis-drag"), "scale reasons cover compare and axis gestures");
}

// ── setChartType ────────────────────────────────────────────────────────────
{
  const { ctx } = makeContext();
  const changes = [];
  ctx.chartTypeChanged.subscribe(null, (change) => changes.push(change));
  assert(ctx.setChartType("heikin_ashi", "sidebar") === true && ctx.chartStyle === "heikin_ashi", "setChartType writes chartStyle");
  assert(changes.length === 1 && changes[0].previous === "candles" && changes[0].reason === "sidebar", "chartTypeChanged reports previous style and reason");
  assert(ctx.setChartType("heikin_ashi", "api") === false && changes.length === 1, "an unchanged chart type is a no-op");
  throwsLike(() => ctx.setChartType("renko", "api"), TypeError, /Supported chart types: candles/, "unknown chart types throw with the supported list");
  assert(CHART_STYLES.length === 8 && CHART_STYLES.includes("baseline"), "CHART_STYLES lists every implemented style");
  assert(CHART_TYPE_CHANGE_REASONS.includes("load"), "chart-type reasons include load");
}

// ── Clock, timezone and featureset policy ───────────────────────────────────
{
  let clock = 1_000;
  const { ctx } = makeContext({}, { clock: () => clock });
  assert(ctx.now() === 1_000, "now() reads the injected clock");
  ctx.setServerTimeOffset(300_000);
  clock = 2_000;
  assert(ctx.now() === 302_000, "now() applies the server offset to the live clock");
  throwsLike(() => ctx.setServerTimeOffset(Number.NaN), RangeError, /finite/, "a non-finite server offset is rejected");
  const real = makeContext().ctx;
  const before = Date.now();
  const read = real.now();
  assert(read >= before && read <= Date.now(), "now() defaults to Date.now()");

  assert(ctx.timezone === "America/New_York", "timezone initialises from options.timezone");
  const tzChanges = [];
  ctx.timezoneChanged.subscribe(null, (zone, previous) => tzChanges.push([zone, previous]));
  assert(ctx.setTimezone("Asia/Tokyo") === true && ctx.timezone === "Asia/Tokyo", "setTimezone updates the live setting");
  assert(tzChanges.length === 1 && tzChanges[0][1] === "America/New_York", "timezoneChanged reports the previous setting");
  assert(ctx.setTimezone("Asia/Tokyo") === false && tzChanges.length === 1, "an unchanged timezone is a no-op");
  throwsLike(() => ctx.setTimezone("  "), TypeError, /IANA zone/, "a blank timezone is rejected");
  throwsLike(() => { ctx.timezone = "UTC"; }, TypeError, /timezone/, "the timezone field cannot be assigned directly");
  assert(makeContext({ options: { timezone: undefined } }).ctx.timezone === null, "an unset option follows the symbol (null)");
  assert(resolveTimezone("exchange", { timezone: "America/Chicago" }) === "America/Chicago", "exchange resolves to the symbol zone");
  assert(resolveTimezone("exchange", null) === "Etc/UTC", "exchange without symbol info falls back to UTC");
  assert(resolveTimezone(null, { timezone: "Asia/Tokyo" }) === "Asia/Tokyo", "an unset zone follows the symbol");
  assert(resolveTimezone("Europe/Berlin", { timezone: "Asia/Tokyo" }) === "Europe/Berlin", "an explicit zone wins");

  const base = buildFeatureSet({ disabled_features: ["countdown"] });
  assert(!base.has("countdown") && base.has("header_widget"), "buildFeatureSet keeps its defaults without a config");
  const aliased = buildFeatureSet(
    { disabled_features: ["timeframes_toolbar"], enabled_features: ["legacy_on"] },
    { aliases: { timeframes_toolbar: "time_frames_toolbar", legacy_on: "modern_on" }, defaultsOn: ["extra"] },
  );
  assert(!aliased.has("time_frames_toolbar") && aliased.has("modern_on") && aliased.has("extra"), "featureset aliases and extra defaults apply without editing context.ts");
}

// ── IdAllocator ─────────────────────────────────────────────────────────────
{
  const a = new IdAllocator();
  const b = new IdAllocator();
  assert(a.next("shape") === "shape_1" && a.next("shape") === "shape_2", "ids keep the historical <label>_<n> shape");
  assert(b.next("shape") === "shape_1", "allocators are per instance, so creation order elsewhere never shifts ids");
  assert(a.next("study", { label: `study_${idSlug("Bollinger Bands")}` }) === "study_bollinger_bands_1", "labels share their namespace counter");
  assert(a.next("study", { label: "study_ema" }) === "study_ema_2", "study ids share one sequence across names, as before");
  a.reserve("shape", "shape_40");
  assert(a.next("shape") === "shape_41", "reserve() moves the counter past restored ids");
  a.reserve("shape", "custom-id");
  a.reserve("shape", "shape_3");
  assert(a.peek("shape") === 41, "reserve() ignores ids without a larger trailing sequence");
  const taken = new Set(["order_1", "order_2"]);
  assert(b.next("trading", { label: "order", isTaken: (id) => taken.has(id) }) === "order_3", "isTaken skips ids that are already live");
  const factoryCalls = [];
  const custom = new IdAllocator({ factory: (request) => { factoryCalls.push(request); return `${request.namespace}:${request.sequence}`; } });
  assert(custom.next("compare") === "compare:1" && factoryCalls[0].label === "compare" && Object.isFrozen(factoryCalls[0]), "a host factory receives a frozen request");
  throwsLike(() => new IdAllocator({ factory: () => "" }).next("shape"), TypeError, /non-empty string/, "an empty factory id is rejected");
  throwsLike(() => new IdAllocator({ factory: () => "same", maxAttempts: 3 }).next("shape", { isTaken: () => true }), Error, /after 3 attempts/, "allocation gives up with guidance instead of looping forever");
  throwsLike(() => a.next("widgets"), TypeError, /Supported namespaces: shape/, "unknown namespaces are rejected with the supported list");
  throwsLike(() => a.next("shape", { label: "has space" }), TypeError, /whitespace/, "labels with whitespace are rejected");
  throwsLike(() => new IdAllocator({ maxAttempts: 0 }), RangeError, /positive integer/, "maxAttempts must be positive");
  a.reset();
  assert(a.next("shape") === "shape_1", "reset() forgets every counter");
  assert(ID_NAMESPACES.includes("trading") && Object.isFrozen(ID_NAMESPACES), "namespaces are a frozen list");
  assert(idSlug("") === "item" && idSlug("MACD (12, 26)") === "macd_12_26_", "idSlug normalises free-form names exactly like historical study ids");
}

// ── StateSlice contract ─────────────────────────────────────────────────────
{
  const slice = {
    key: "drawings",
    version: 1,
    requiresDataReload: false,
    save: () => [],
    validate: () => [],
    apply: () => {},
  };
  assert(defineStateSlice(slice) === slice, "defineStateSlice returns a valid slice unchanged");
  throwsLike(() => defineStateSlice({ ...slice, key: "Drawings" }), TypeError, /invalid state slice "Drawings": key must match/, "slice keys must be lowercase identifiers");
  throwsLike(() => defineStateSlice({ ...slice, key: "trading" }), TypeError, /reserved/, "broker state can never be registered as a slice");
  throwsLike(() => defineStateSlice({ ...slice, version: 2 }), TypeError, /needs migrate/, "a slice past version 1 must migrate older payloads");
  assert(stateSliceIssues({ key: "x" }).length >= 4, "stateSliceIssues reports every missing member");
  assert(RESERVED_SLICE_KEYS.includes("trading"), "trading is a reserved slice key");
  assert(findNonJsonValue({ a: [1, { b: "ok" }], c: null }) === null, "plain JSON passes the serialisability check");
  const nan = findNonJsonValue({ drawings: [{ points: [{ time: Number.NaN }] }] });
  assert(nan?.path === "/drawings/0/points/0/time", "non-finite numbers are reported with a JSON-pointer path");
  assert(findNonJsonValue({ at: new Date(0) })?.path === "/at", "class instances such as Date are reported");
  assert(findNonJsonValue({ "a/b": undefined })?.path === "/a~1b", "pointer segments are escaped");
}

// ── Plugin contract helpers ─────────────────────────────────────────────────
{
  assert(minAnchors(2) === 2 && minAnchors({ min: 3, finish: "enter" }) === 3, "minAnchors reads fixed and free-form specs");
  assert(anchorsComplete(2, 2) && !anchorsComplete(2, 1), "fixed-count drafts complete at the declared count");
  assert(!anchorsComplete({ min: 2, finish: "double-click" }, 50) && anchorsComplete({ min: 2, max: 5, finish: "either" }, 5), "free-form drafts complete only at max or on the finish gesture");
  const schema = {
    fast: { type: "int", title: "Fast", default: 12, min: 1 },
    source: { type: "source", title: "Source", default: "close" },
    smooth: { type: "bool", title: "Smooth", default: false },
  };
  const defaults = defaultInputValues(schema);
  assert(defaults.fast === 12 && defaults.source === "close" && defaults.smooth === false, "defaultInputValues reads every schema default");
  const incremental = { name: "X", pane: "overlay", inputs: schema, plots: [], init: () => 0, update: () => ({ state: 0, values: {} }) };
  assert(isIncrementalIndicator(incremental) && !isIncrementalIndicator({ ...incremental, update: undefined, init: undefined, compute: () => ({}) }), "isIncrementalIndicator distinguishes update() studies");
  assert(STUDY_INPUT_TYPES.length === 12 && STUDY_SOURCES.includes("hlc3"), "the input schema covers every documented input type and source");
  assert(AXIS_TAG_PRIORITY.crosshair > AXIS_TAG_PRIORITY.series && AXIS_TAG_PRIORITY.series > AXIS_TAG_PRIORITY.drawing, "the crosshair tag outranks the last price, which outranks drawings");
}

// ── Scene contract v2 guard ─────────────────────────────────────────────────
{
  const definition = defineChart({ marks: [line([{ x: 1, y: 2 }, { x: 2, y: 3 }], { x: "x", y: "y" })] });
  const scene = compileChart(definition, { width: 320, height: 200 });
  // Wave 1B fills every v2 field: contractVersion, formatters and axes (W1B-01),
  // legendLayout and hoverSamples (W1B-02).
  assert(isSceneV2(scene), "compiled scenes carry the full v2 contract");
  assert(!isSceneV2({ ...scene, legendLayout: undefined }), "a hand-built scene missing a v2 field falls back to v1");
  const axis = { position: "bottom", size: 20, labelExtent: 12, ticks: [] };
  const upgraded = {
    ...scene,
    contractVersion: SCENE_CONTRACT_VERSION,
    formatters: { x: String, y: String },
    axes: { x: axis, y: { ...axis, position: "right" } },
    legendLayout: { placement: "top", rows: [], size: 0, overflow: 0 },
    hoverSamples: [],
  };
  assert(isSceneV2(upgraded), "a scene with every v2 field passes the guard");
  assert(!isSceneV2({ ...upgraded, axes: undefined }), "a partially upgraded scene falls back to v1");
}

// ── ChartEngine: overlay host and overlay invalidation ──────────────────────
{
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const { ctx } = makeContext();
  frames.clear();
  const engine = new ChartEngine(host, ctx);
  const overlay = host.querySelector(".raze-chart-overlay-host");
  assert(overlay === engine.overlayHost && ctx.overlayHost === overlay, "the engine installs its overlay host on the context");
  assert(overlay.previousElementSibling === engine.canvas, "the overlay host stacks directly above the canvas");
  assert(overlay.style.pointerEvents === "none" && overlay.style.position === "absolute", "the overlay host never steals canvas gestures");
  assert(!overlay.hasAttribute("aria-hidden") && !overlay.hasAttribute("role"), "the overlay host stays exposed to assistive tech for accessible children");
  let painted = 0;
  engine.paintHook = () => { painted += 1; };
  flushFrames();
  painted = 0;
  ctx.requestOverlayPaint();
  ctx.requestOverlayPaint();
  ctx.requestPaint();
  assert(frames.size === 1, "overlay and main invalidations coalesce into one frame");
  flushFrames();
  assert(painted === 1, "an overlay invalidation paints (single-layer engine)");
  engine.destroy();
  assert(!host.querySelector(".raze-chart-overlay-host") && ctx.overlayHost === null, "destroy removes the overlay host and clears the context seam");
  ctx.requestOverlayPaint();
  assert(frames.size === 0, "after destroy, overlay requests fall back to the inert requestPaint");

  const bare = { options: {}, symbol: "BARE", theme: { paneBackground: "#000" }, requestPaint() {} };
  const bareEngine = new ChartEngine(window.document.createElement("div"), bare);
  assert(typeof bare.requestOverlayPaint === "function" && bare.overlayHost === bareEngine.overlayHost, "engines also install seams on plain legacy contexts");
  bareEngine.destroy();
}

// ── ChartRenderer: new view fields ──────────────────────────────────────────
{
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const { ctx } = makeContext();
  const engine = new ChartEngine(host, ctx);
  const stubStore = { list: () => [], paneDefs: () => [], autoScalePrices: () => [] };
  const renderer = new ChartRenderer(ctx, engine, stubStore, stubStore, {}, stubStore);
  renderer.plotL = 0;
  renderer.plotT = 0;
  renderer.plotW = 560;
  renderer.plotH = 300;
  renderer.priceAxisW = 80;
  renderer.hoverShapeId = "shape_7";
  const first = renderer.financeView();
  const second = renderer.financeView();
  assert(first.dpr === engine.dpr && first.dpr === 2, "the view exposes the device pixel ratio for bitmap-space snapping");
  assert(Array.isArray(first.axisTags) && first.axisTags.length === 0 && first.axisTags !== second.axisTags, "every view starts with a fresh, empty axis-tag queue");
  assert(
    first.axisChromeRect.x === 560 && first.axisChromeRect.y === 300 && first.axisChromeRect.w === 80 && first.axisChromeRect.h === 22,
    "axisChromeRect is the price-axis x time-axis corner cell",
  );
  renderer.volumePane = { top: 303, h: 57 };
  assert(renderer.financeView().axisChromeRect.y === 360, "the corner cell sits below the volume pane when it has its own pane");
  assert(first.hoverShapeId === "shape_7" && first.hoverTimescaleMark === null, "hover state for drawings and timescale marks reaches painters");
  assert(first.timescaleMarkScreen === renderer.timescaleMarkScreen, "timescale-mark hit targets are shared with the renderer like other hit lists");
  engine.destroy();
}

// ── Widget integration: every widget context carries the seams ──────────────
{
  const bar = { time: 1_700_000_000_000, open: 100, high: 102, low: 99, close: 101, volume: 10 };
  const feed = {
    onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1"] })); },
    searchSymbols(_input, _exchange, _type, callback) { callback([]); },
    resolveSymbol(name, resolve) {
      queueMicrotask(() => resolve({ name, ticker: name, description: name, type: "crypto", session: "24x7", timezone: "Etc/UTC", exchange: "T", listed_exchange: "T", format: "price", minmov: 1, pricescale: 100, has_intraday: true, supported_resolutions: ["1"] }));
    },
    getBars(_info, _resolution, _params, onResult) { queueMicrotask(() => onResult([bar])); },
    subscribeBars() {},
    unsubscribeBars() {},
  };
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const options = {
    symbol: "ETHUSD",
    interval: "1",
    container,
    datafeed: feed,
    timezone: "Europe/London",
    disabled_features: ["header_widget", "left_toolbar", "scale_bar"],
  };
  // The widget's state is unreachable at runtime (W1A-07), so the context is
  // checked through the runtime's own builder, which the Widget uses.
  const context = createWidgetContext(options);
  assert(typeof context.setViewport === "function" && context.ids instanceof IdAllocator, "widget contexts are built by createChartContext");
  assert(context.timezone === "Europe/London", "widget contexts seed the timezone seam from options");
  const instance = new Widget(options);
  await instance.headerReady();
  assert(container.querySelectorAll(".raze-chart-overlay-host").length === 1, "the widget's engine mounts the overlay host");
  instance.remove();
  assert(!container.querySelector(".raze-chart-overlay-host"), "widget teardown removes the overlay host");
}

console.log(`\nSEAMS: PASS (${passed} assertions)`);
