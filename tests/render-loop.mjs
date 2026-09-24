// Render loop (W1B-07): the layered main/overlay canvases, overlay-only
// pointer frames, the synchronous resize paint, opaque contexts, the
// axis-tag pass, width-based default spacing, fit/reset through setViewport
// and the setScaleMode empty-window guard.
//
// Bundles the engine from source with esbuild (no build step needed) and
// drives a real WidgetRuntime in jsdom with a recording 2D context per
// canvas, so "the main layer painted" is observed on the canvas itself.
//   node tests/render-loop.mjs

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert(error instanceof ctor && pattern.test(String(error.message)), `${message}${error ? ` (${error.message})` : " (nothing was thrown)"}`);
};
const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

// ── DOM environment ─────────────────────────────────────────────────────────
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
window.devicePixelRatio = 1;

/** One recording 2D context per canvas: options it was created with and per-method call counts. */
const recorders = new WeakMap();
function recorderFor(canvas, options) {
  const counts = new Map();
  const target = {
    canvas,
    options,
    counts,
    calls: (name) => counts.get(name) ?? 0,
    reset: () => counts.clear(),
    measureText: (value) => ({ width: String(value ?? "").length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    getLineDash: () => [],
    isPointInPath: () => false,
  };
  return new Proxy(target, {
    get(t, property) {
      if (property in t) return t[property];
      if (typeof property !== "string") return undefined;
      return (..._args) => {
        counts.set(property, (counts.get(property) ?? 0) + 1);
      };
    },
    set(t, property, value) {
      t[property] = value;
      return true;
    },
  });
}
window.HTMLCanvasElement.prototype.getContext = function getContext(type, options) {
  if (type !== "2d") return null;
  let ctx = recorders.get(this);
  if (!ctx) {
    ctx = recorderFor(this, options);
    recorders.set(this, ctx);
  }
  return ctx;
};
window.HTMLCanvasElement.prototype.toBlob = function toBlob() {};
const ctxOf = (canvas) => recorders.get(canvas);

let hostWidth = 640;
let hostHeight = 360;
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => hostWidth });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => hostHeight });

const observers = [];
class TestResizeObserver {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }
  observe() { this.callback([]); }
  disconnect() { this.disconnected = true; }
}
globalThis.ResizeObserver = TestResizeObserver;
window.ResizeObserver = TestResizeObserver;
const triggerResize = () => {
  for (const observer of observers) if (!observer.disconnected) observer.callback([]);
};

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
  for (let guard = 0; guard < 10 && frames.size; guard++) {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  }
};

const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(" ")); };

// ── Bundle the render loop from source ──────────────────────────────────────
const entry = `
export * from "./src/core/context";
export { ChartEngine } from "./src/engine/ChartEngine";
export * from "./src/engine/ChartRenderer";
export * from "./src/engine/layers";
export * from "./src/engine/scene";
export * from "./src/engine/seriesTransform";
export * from "./src/engine/paint/axisTags";
export { AXIS_TAG_PRIORITY } from "./src/engine/paint/view";
export { WidgetRuntime } from "./src/core/widget/runtime";
export { MIN_BAR_SPACING, MAX_BAR_SPACING } from "./src/engine/layout";
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts", sourcefile: "render-loop-entry.ts" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  write: false,
  logLevel: "silent",
  define: { __RAZE_CHARTS_VERSION__: JSON.stringify("test") },
});
const scratch = mkdtempSync(join(tmpdir(), "raze-render-loop-"));
const bundlePath = join(scratch, "render-loop.mjs");
writeFileSync(bundlePath, bundled.outputFiles[0].text);
const mod = await import(pathToFileURL(bundlePath).href);
rmSync(scratch, { recursive: true, force: true });

const {
  ChartEngine,
  DEFAULT_BAR_SPACING,
  DEFAULT_VISIBLE_BARS,
  FINANCE_LAYER_ORDER,
  FINANCE_PAINT_ORDER,
  MAX_BAR_SPACING,
  SeriesTransformCache,
  WidgetRuntime,
  createChartContext,
  defaultRightPadBars,
  defaultViewRange,
  defaultVisibleBarsFor,
  drawAxisTags,
  financeMarkLayer,
  fitAllRange,
  isOpaqueColor,
  layoutAxisTags,
  paintFinanceScene,
  seriesTransformFor,
} = mod;

// ── Helpers ─────────────────────────────────────────────────────────────────
const RES_MS = 60_000;
const FIRST_MS = Date.UTC(2024, 0, 1);
function makeBars(count) {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + Math.sin(i / 7) * 5;
    return { time: FIRST_MS + i * RES_MS, open: base, high: base + 2, low: base - 2, close: base + 1, volume: 10 + i };
  });
}

function makeFeed(count) {
  const bars = makeBars(count);
  let served = false;
  return {
    onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1"] })); },
    searchSymbols(_input, _exchange, _type, callback) { callback([]); },
    resolveSymbol(name, onResolve) {
      queueMicrotask(() => onResolve({
        name, ticker: name, description: name, type: "crypto", session: "24x7", timezone: "Etc/UTC",
        exchange: "T", listed_exchange: "T", format: "price", minmov: 1, pricescale: 100,
        has_intraday: true, supported_resolutions: ["1"],
      }));
    },
    getBars(_info, _resolution, _params, onResult) {
      const payload = served ? [] : bars;
      served = true;
      queueMicrotask(() => onResult(payload, { noData: true }));
    },
    subscribeBars() {},
    unsubscribeBars() {},
  };
}

async function mountRuntime({ bars = 600, width = 640, height = 360, options = {} } = {}) {
  hostWidth = width;
  hostHeight = height;
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const runtime = new WidgetRuntime({
    symbol: "TEST",
    interval: "1",
    container,
    datafeed: makeFeed(bars),
    timezone: "Etc/UTC",
    disabled_features: ["header_widget", "left_toolbar", "scale_bar", "countdown"],
    ...options,
  }, () => { throw new Error("no child widgets in this test"); });
  await new Promise((resolveReady) => runtime.lifecycle.onChartReady(resolveReady));
  flushFrames();
  return { runtime, container };
}

function pointer(type, x, y, init = {}) {
  const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: init.buttons ?? 0, bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: init.id ?? 1 }, pointerType: { value: init.type ?? "mouse" } });
  return event;
}

function listen(delegate) {
  const seen = [];
  const fn = (...args) => seen.push(args);
  delegate.subscribe(null, fn);
  return { seen, stop: () => delegate.unsubscribe(null, fn) };
}

const spacingOf = (runtime) => runtime.renderer.plotW / (runtime.context.visibleRange.to - runtime.context.visibleRange.from);

// ── isOpaqueColor ───────────────────────────────────────────────────────────
{
  const opaque = ["#181615", "#fff", "#ffff", "#131722ff", "rgb(1, 2, 3)", "rgba(1,2,3,1)", "rgba(1 2 3 / 100%)", "hsl(10 20% 30%)", "white", "  #ABCDEF  ", "oklch(0.5 0.1 200)"];
  const translucent = ["transparent", "rgba(0,0,0,0)", "rgba(0,0,0,0.5)", "#0008", "#13172280", "rgb(1 2 3 / 0.4)", "hsla(1, 2%, 3%, 50%)", "", "var(--bg)", "currentColor", null, undefined, "#12", "rgb(1 2 3 / none)"];
  assert(opaque.every(isOpaqueColor), "opaque hex, functional and named colours allow an { alpha: false } context");
  assert(translucent.every((color) => !isOpaqueColor(color)), "transparent, translucent and unresolvable colours keep the alpha context");
}

// ── Scene: layer split ──────────────────────────────────────────────────────
{
  const overlayMarks = ["draft", "axisChrome", "crosshair", "legend", "markTooltip"];
  assert(overlayMarks.every((kind) => financeMarkLayer(kind) === "overlay"), "crosshair, legend values, mark tooltip, draft and countdown paint on the overlay layer");
  const mainMarks = ["grid", "volume", "series", "overlayStudies", "shapes", "barMarks", "priceAxis", "subPanes", "timeAxis", "lastPrice", "trading", "separators"];
  assert(mainMarks.every((kind) => financeMarkLayer(kind) === "main"), "grid, series, volume, studies, drawings, axes, last price and trading paint on the main layer");
  assert(
    FINANCE_LAYER_ORDER.main.indexOf("axisTags") > FINANCE_LAYER_ORDER.main.indexOf("timeAxis")
      && FINANCE_LAYER_ORDER.main.indexOf("axisTags") > FINANCE_LAYER_ORDER.main.indexOf("priceAxis")
      && FINANCE_LAYER_ORDER.overlay.indexOf("axisTags") > FINANCE_LAYER_ORDER.overlay.indexOf("crosshair"),
    "each layer runs the axis-tag pass after the axes and the painters that queue tags",
  );
  assert(new Set(FINANCE_PAINT_ORDER).size === FINANCE_PAINT_ORDER.length && FINANCE_PAINT_ORDER.length === 18, "the single-canvas order lists every mark exactly once");
}

// ── Axis-tag pass: de-collision and painting ────────────────────────────────
{
  const tag = (coord, kind, text = kind, extra = {}) => ({ axis: "price", coord, text, background: "#000", color: "#fff", source: { kind }, ...extra });
  const tags = [tag(100, "drawing"), tag(104, "series"), tag(98, "custom")];
  const placed = layoutAxisTags(tags, () => 16, () => ({ start: 0, end: 300 }));
  assert(placed.map((p) => p.tag.source.kind).join(",") === "custom,drawing,series", "tags paint in ascending priority so the most important pill is on top");
  const series = placed.find((p) => p.tag.source.kind === "series");
  assert(series.start === 104 - 8, "the highest-priority tag keeps its exact position");
  const sorted = [...placed].sort((a, b) => a.start - b.start);
  assert(sorted.every((p, i) => i === 0 || p.start >= sorted[i - 1].start + sorted[i - 1].size), "lower-priority tags slide to the nearest free slot instead of overlapping");
  const clamped = layoutAxisTags([tag(2, "trading")], () => 16, () => ({ start: 10, end: 200 }));
  assert(clamped[0].start === 10, "a tag is clamped into its band");
  const explicit = layoutAxisTags([tag(50, "custom", "a", { priority: 500 }), tag(52, "series")], () => 16, () => ({ start: 0, end: 300 }));
  assert(explicit.at(-1).tag.text === "a" && explicit.at(-1).start === 42, "an explicit priority outranks the source default");

  const ctx = recorderFor(null, {});
  const view = { plotL: 0, plotT: 0, plotW: 500, plotH: 300, priceAxisW: 64, fontFamily: "sans-serif", subPanes: [], volumePane: null, axisTags: [] };
  drawAxisTags(ctx, view, [...tags, { ...tag(250, "study"), axis: "time" }]);
  assert(ctx.calls("fillText") === 4 && ctx.calls("fill") === 4, "the pass paints every queued price and time tag");
}

// ── Series transform cache ──────────────────────────────────────────────────
{
  assert(seriesTransformFor("heikin_ashi") !== null && seriesTransformFor("candles") === null, "only transformed styles have a series transform");
  const cache = new SeriesTransformCache();
  const bars = makeBars(5);
  const ha = cache.resolve("heikin_ashi", bars);
  assert(ha !== bars && cache.resolve("heikin_ashi", bars) === ha, "the transformed series is reused until invalidated");
  cache.invalidate();
  assert(cache.current.length === 0 && cache.resolve("heikin_ashi", bars) !== ha, "invalidate() drops the cached transform");
  assert(cache.resolve("line", bars) === bars && cache.current === bars, "untransformed styles paint the source bars");
}

// ── Default spacing and fit maths ───────────────────────────────────────────
{
  assert(DEFAULT_BAR_SPACING === 6, "the default bar spacing is 6 CSS px (TradingView and lightweight-charts)");
  for (const plotWidth of [326, 416, 1216]) {
    const count = defaultVisibleBarsFor(plotWidth);
    const range = defaultViewRange(10_000, count);
    const spacing = plotWidth / (range.to - range.from);
    assert(Math.abs(spacing - 6) <= 0.25, `default view at a ${plotWidth}px plot keeps 6 px per bar (got ${spacing.toFixed(2)})`);
  }
  assert(defaultVisibleBarsFor(0) === null && defaultVisibleBarsFor(Number.NaN) === null, "no default count while the plot width is unknown");
  assert(defaultRightPadBars(120) === 7 && defaultRightPadBars(10) === 1 && defaultRightPadBars(5000) === 8, "right padding follows the historical 6% (1 to 8 bars) rule");
  const all = fitAllRange(5_000, 1_000);
  assert(all.from === -0.5 && all.to === 5_007 && all.to - all.from >= 5_000, "fit shows every one of 5,000 bars");
  const few = fitAllRange(3, 1_000);
  assert(near(1_000 / (few.to - few.from), MAX_BAR_SPACING) && few.to === 3, "a handful of bars never spreads wider than MAX_BAR_SPACING and stays anchored right");
}

// ── Context: setScaleMode rejects an empty price window ─────────────────────
{
  const ctx = createChartContext({ options: {}, bars: [], visibleRange: { from: 0, to: 1 }, autoScalePrice: true, priceRange: null, logScale: false, percentScale: false, chartStyle: "candles", requestPaint() {} });
  throwsLike(() => ctx.setScaleMode({ priceRange: { min: 5, max: 5 } }, "api"), RangeError, /priceRange is empty.*max > min/, "setScaleMode rejects a min === max price window with guidance");
  assert(ctx.autoScalePrice === true && ctx.priceRange === null, "a rejected window leaves the scale untouched");
  assert(ctx.setScaleMode({ priceRange: { min: 5, max: 6 } }, "api") && ctx.priceRange.max === 6, "a non-empty window is still accepted");
  assert(ctx.setScaleMode({ autoScale: true }, "reset") && ctx.autoScalePrice, "reset is a scale-change reason");
}

// ── Engine: layers, invalidation and resize ─────────────────────────────────
{
  hostWidth = 640;
  hostHeight = 360;
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const context = createChartContext({
    options: {}, symbol: "LAYER", theme: { paneBackground: "#181615" }, bars: [], visibleRange: { from: 0, to: 1 },
    autoScalePrice: true, priceRange: null, logScale: false, percentScale: false, chartStyle: "candles", requestPaint() {},
  });
  frames.clear();
  const engine = new ChartEngine(host, context);
  const main = engine.mainCanvas;
  const interactive = engine.canvas;
  const children = [...host.children];
  assert(children[0] === interactive && interactive.classList.contains("raze-chart-canvas"), "the interactive overlay canvas stays the host's first canvas");
  assert(children[1] === engine.overlayHost, "the DOM overlay host still stacks directly above the interactive canvas");
  assert(children.includes(main) && main !== interactive && main.classList.contains("raze-chart-layer-main"), "the main scene canvas is a separate layer");
  assert(main.style.zIndex === "-1" && host.style.isolation === "isolate", "the main bitmap paints below the interactive canvas inside the host's own stacking context");
  assert(main.getAttribute("aria-hidden") === "true" && main.style.pointerEvents === "none" && !main.hasAttribute("tabindex"), "the main bitmap is presentation only: hidden from AT, no pointer events, not focusable");
  assert(interactive.getAttribute("role") === "application" && interactive.tabIndex === 0, "the interactive canvas keeps the role, name and focus");
  assert(ctxOf(main).options?.alpha === false && engine.mainLayerOpaque, "an opaque pane background gets an { alpha: false } main context");
  assert(ctxOf(interactive).options?.alpha === true, "the overlay context keeps alpha so the scene shows through");

  let mainHook = 0;
  let overlayHook = 0;
  let mainChanged = false;
  engine.paintHook = () => { mainHook += 1; };
  engine.overlayPaintHook = () => { overlayHook += 1; };
  engine.mainInvalidationCheck = () => mainChanged;
  flushFrames();
  const stats = engine.paintStats;
  const before = { ...stats };
  mainHook = 0;
  overlayHook = 0;
  for (let i = 0; i < 100; i++) {
    context.requestOverlayPaint();
    flushFrames();
  }
  assert(mainHook === 0 && stats.main === before.main, "100 overlay invalidations paint the main layer 0 times");
  assert(overlayHook === 100 && stats.overlay - before.overlay === 100, "each overlay invalidation paints the overlay once");
  context.requestOverlayPaint();
  context.requestOverlayPaint();
  context.requestOverlayPaint();
  assert(frames.size === 1, "overlay invalidations coalesce into one frame");
  flushFrames();
  assert(overlayHook === 101, "a coalesced frame paints the overlay at most once");
  context.requestOverlayPaint();
  context.requestPaint();
  flushFrames();
  assert(mainHook === 1 && overlayHook === 102, "a main invalidation repaints the main layer and the overlay above it once");
  mainChanged = true;
  context.requestOverlayPaint();
  flushFrames();
  assert(mainHook === 2, "an overlay frame still repaints the main layer when main-layer state changed");
  mainChanged = false;

  ctxOf(main).reset();
  const resizes = [];
  engine.onResize = (size) => resizes.push({ ...size, mainAtCall: mainHook });
  hostWidth = 800;
  triggerResize();
  assert(resizes.length === 1 && resizes[0].width === 800 && resizes[0].previousWidth === 640, "onResize reports the new and previous size");
  assert(mainHook === 3 && ctxOf(main).calls("fillRect") >= 1, "a resize repaints synchronously, inside the ResizeObserver callback");
  assert(main.width === 800 && interactive.width === 800, "both bitmaps follow the host size");
  flushFrames();
  assert(mainHook === 3, "a single resize causes exactly one paint");
  triggerResize();
  assert(mainHook === 3 && resizes.length === 1, "an unchanged size neither resizes nor repaints");
  assert(stats.resize >= 1, "resize paints are counted");

  ctxOf(main).reset();
  context.theme.paneBackground = "rgba(24, 22, 21, 0.5)";
  context.requestPaint();
  flushFrames();
  const swapped = engine.mainCanvas;
  assert(swapped !== main && !main.isConnected && swapped.isConnected, "a translucent pane background swaps the main bitmap");
  assert(ctxOf(swapped).options?.alpha === true && !engine.mainLayerOpaque, "the new main context keeps alpha so a translucent pane composites over the page");
  assert(ctxOf(swapped).calls("clearRect") === 1 && swapped.width === 800, "a translucent main layer is cleared before the background fill and keeps its size");
  assert(swapped.classList.contains("raze-chart-layer-main") && swapped.style.zIndex === "-1", "the swapped bitmap keeps its class and stacking");
  assert(engine.canvas === interactive && interactive.isConnected, "the interactive canvas (listeners, focus, ARIA) is never replaced");

  const composite = engine.composite();
  const compositeCtx = ctxOf(composite);
  assert(composite.width === 800 && compositeCtx.calls("drawImage") === 2, "composite() stacks the main layer and the overlay into one bitmap");

  const noOverlay = new ChartEngine(window.document.createElement("div"), createChartContext({ options: {}, symbol: "X", theme: { paneBackground: "transparent" }, requestPaint() {} }));
  let full = 0;
  noOverlay.paintHook = () => { full += 1; };
  flushFrames();
  full = 0;
  noOverlay.markOverlayDirty();
  flushFrames();
  assert(full === 1, "without an overlay hook, overlay invalidations repaint the whole frame");
  assert(ctxOf(noOverlay.mainCanvas).options?.alpha === true, "a transparent theme starts with an alpha main context");
  noOverlay.destroy();

  engine.destroy();
  assert(!main.isConnected && !swapped.isConnected && !interactive.isConnected && host.style.isolation === "", "destroy removes every layer and restores the host");
}

// ── Widget runtime: overlay-only pointer frames ─────────────────────────────
{
  const { runtime } = await mountRuntime({ bars: 600, width: 640 });
  const { engine, renderer, context } = runtime;
  const main = ctxOf(engine.mainCanvas);
  const overlay = ctxOf(engine.canvas);
  const stats = engine.paintStats;
  engine.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0 });
  engine.canvas.dispatchEvent(pointer("pointermove", 200, 120));
  flushFrames();
  main.reset();
  overlay.reset();
  const before = { ...stats };
  let frameCount = 0;
  for (let i = 0; i < 100; i++) {
    engine.canvas.dispatchEvent(pointer("pointermove", 100 + i * 3, 80 + (i % 20) * 5));
    if (frames.size) frameCount += 1;
    flushFrames();
  }
  assert(renderer.crosshair.active, "the crosshair is on during the sweep");
  assert(stats.main === before.main && main.calls("setTransform") === 0 && main.calls("fillRect") === 0, "100 crosshair pointermoves cause 0 main-layer paints");
  assert(stats.overlay - before.overlay === frameCount && overlay.calls("setTransform") === frameCount, "the overlay paints once per frame");
  assert(overlay.calls("stroke") >= 100, "the overlay draws the crosshair on every frame");

  // Main-layer state changed by a gesture without markDirty() is still painted.
  main.reset();
  context.visibleRange = { from: context.visibleRange.from - 1, to: context.visibleRange.to - 1 };
  renderer.requestPaint();
  flushFrames();
  assert(main.calls("setTransform") === 1, "a viewport change behind an overlay request repaints the main layer");
  main.reset();
  renderer.hoverShapeId = "shape_1";
  renderer.requestPaint();
  flushFrames();
  assert(main.calls("setTransform") === 1, "a hover-target change repaints the main layer (drawing handles)");
  renderer.hoverShapeId = null;
  renderer.requestPaint();
  flushFrames();

  // A pressed pointer (drags edit drawings in place) always repaints the main layer.
  main.reset();
  engine.canvas.dispatchEvent(pointer("pointerdown", 300, 100, { buttons: 1 }));
  engine.canvas.dispatchEvent(pointer("pointermove", 310, 100, { buttons: 1 }));
  flushFrames();
  assert(main.calls("setTransform") >= 1, "moves while a pointer is pressed repaint the main layer");
  window.dispatchEvent(pointer("pointerup", 310, 100));
  flushFrames();
  main.reset();
  engine.canvas.dispatchEvent(pointer("pointermove", 320, 100));
  flushFrames();
  assert(main.calls("setTransform") === 0, "after release, hover moves are overlay-only again");

  engine.canvas.dispatchEvent(pointer("pointerleave", 320, 100));
  main.reset();
  flushFrames();
  assert(!renderer.crosshair.active && main.calls("setTransform") === 0, "leaving the chart clears the crosshair on the overlay only");
  runtime.remove();
}

// ── Widget runtime: default spacing at boot, fit and reset ──────────────────
for (const width of [390, 480, 1280]) {
  const { runtime } = await mountRuntime({ bars: 5_000, width, height: 420 });
  const spacing = spacingOf(runtime);
  assert(Math.abs(spacing - 6) <= 1, `boot spacing is 6±1 px at ${width}px (got ${spacing.toFixed(2)})`);
  runtime.remove();
}
{
  const { runtime } = await mountRuntime({ bars: 5_000, width: 1100, height: 520 });
  const { context, renderer } = runtime;
  const viewport = listen(context.viewportChanged);
  const ranges = listen(context.rangeChanged);
  const scales = listen(context.scaleChanged);
  context.setScaleMode({ priceRange: { min: 90, max: 95 } }, "api");
  scales.seen.length = 0;
  renderer.canvas.focus();
  renderer.canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", bubbles: true }));
  const { from, to } = context.visibleRange;
  assert(to - from >= 5_000 && from <= 0 && to >= 4_999, `F fits all 5,000 bars (span ${(to - from).toFixed(1)})`);
  assert(viewport.seen.length === 1 && ranges.seen.length === 1 && ranges.seen[0][0].reason === "fit", "F fires exactly one viewportChanged and one rangeChanged (reason fit)");
  assert(context.autoScalePrice && context.priceRange === null && scales.seen.length === 1 && scales.seen[0][0].reason === "fit", "F re-enables price autoscale through setScaleMode");
  const unix = viewport.seen[0][0];
  assert(unix.from === Math.floor(FIRST_MS / 1000) && unix.to === Math.floor((FIRST_MS + 4_999 * RES_MS) / 1000), "the published range spans the first to the last loaded bar");
  renderer.canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", bubbles: true }));
  assert(viewport.seen.length === 1, "fitting an already fitted view fires nothing");

  const api = runtime.controllers.api.api;
  api.resetView();
  const spacing = spacingOf(runtime);
  assert(Math.abs(spacing - 6) <= 1 && near(context.visibleRange.to, 4_999 + defaultRightPadBars(context.defaultVisibleBars())), `resetView returns to 6 px per bar anchored to the latest bar (got ${spacing.toFixed(2)})`);
  assert(viewport.seen.length === 2 && ranges.seen.at(-1)[0].reason === "reset", "resetView fires one viewportChanged (reason reset)");
  api.fitContent();
  assert(viewport.seen.length === 3 && context.visibleRange.to - context.visibleRange.from >= 5_000, "chart.fitContent() is the API for the F behaviour");

  // Double-click in the plot fits too (one event).
  api.resetView();
  const count = viewport.seen.length;
  runtime.engine.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1100, height: 520, right: 1100, bottom: 520, x: 0, y: 0 });
  runtime.engine.canvas.dispatchEvent(new window.MouseEvent("dblclick", { clientX: 300, clientY: 200, bubbles: true }));
  assert(viewport.seen.length === count + 1 && context.visibleRange.to - context.visibleRange.from >= 5_000, "double-click fits all bars with exactly one viewportChanged");

  // The ALL preset (header timeframe bar) also fires exactly one event.
  api.resetView();
  const beforePreset = viewport.seen.length;
  await runtime.controllers.chrome.applyPreset("ALL");
  assert(viewport.seen.length === beforePreset + 1 && context.visibleRange.from <= 0, "the ALL preset fires exactly one viewportChanged");

  // Resize keeps the bar spacing, anchored to the right edge.
  api.resetView();
  flushFrames();
  const beforeSpacing = spacingOf(runtime);
  const beforeTo = context.visibleRange.to;
  const resizeEvents = viewport.seen.length;
  const mainCtx = ctxOf(runtime.engine.mainCanvas);
  mainCtx.reset();
  hostWidth = 700;
  triggerResize();
  assert(mainCtx.calls("setTransform") === 1, "a live resize paints the main layer synchronously");
  flushFrames();
  const afterSpacing = spacingOf(runtime);
  assert(Math.abs(afterSpacing - beforeSpacing) < 0.05 && context.visibleRange.to === beforeTo, `resize keeps ${beforeSpacing.toFixed(2)} px per bar anchored right (got ${afterSpacing.toFixed(2)})`);
  assert(ranges.seen.at(-1)[0].reason === "resize" && viewport.seen.length === resizeEvents + 1, "the resize adjustment goes through setViewport (reason resize) once");
  assert(mainCtx.calls("setTransform") === 1, "the resize frame is not painted a second time by the next animation frame");
  runtime.remove();
}

// ── Widget runtime: a chart that boots with no width ────────────────────────
{
  const { runtime } = await mountRuntime({ bars: 1_000, width: 0, height: 0 });
  const { context } = runtime;
  const fallback = defaultViewRange(1_000, DEFAULT_VISIBLE_BARS);
  assert(context.visibleRange.from === fallback.from && context.visibleRange.to === fallback.to, "a hidden chart boots with the 120-bar fallback view");
  hostWidth = 900;
  hostHeight = 400;
  triggerResize();
  flushFrames();
  const spacing = spacingOf(runtime);
  assert(Math.abs(spacing - 6) <= 1, `once laid out, the untouched fallback view becomes the 6 px default (got ${spacing.toFixed(2)})`);
  runtime.remove();
}

// ── Single-canvas scene paint still paints every mark ───────────────────────
{
  const { runtime } = await mountRuntime({ bars: 300, width: 640 });
  const ctx = recorderFor(null, {});
  const view = runtime.renderer.financeView();
  view.crosshair = { x: 100, y: 100, active: true };
  paintFinanceScene(ctx, view, [95, 100, 105], []);
  assert(ctx.calls("fillText") > 0 && ctx.calls("stroke") > 0, "paintFinanceScene paints the main layer and the overlay into one context");
  runtime.remove();
}

// ── Accessibility text matches the documented F behaviour ───────────────────
{
  const { runtime, container } = await mountRuntime({ bars: 300, width: 640 });
  const description = container.querySelector(".raze-chart-a11y-description")?.textContent ?? "";
  assert(/F fits all loaded data/.test(description), "the keyboard instructions say F fits all loaded data");
  const docs = readFileSync(resolve(root, "docs/accessibility.md"), "utf8");
  assert(/\|\s*`F`\s*\|\s*Fit all loaded data/.test(docs), "docs/accessibility.md documents F as fitting all loaded data");
  runtime.remove();
}

assert(!warnings.some((w) => w.includes("[raze-charts]")), `no library warnings were logged${warnings.length ? `: ${warnings.join(" | ")}` : ""}`);
console.warn = originalWarn;
dom.window.close();
console.log(`RENDER LOOP: PASS (${passed} assertions)`);
