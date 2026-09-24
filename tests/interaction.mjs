// Interaction correctness (W1B-10): delta-normalised wheel zoom, pan bounds,
// monotonic zoom limits, anchor-vs-body drawing drags with a drag slop,
// topmost-first hit-testing, Escape cancelling a drag, bar-snapped anchors,
// no refit on a drawing double-click, drawing click/move events, the inline
// text editor and timescale-mark tooltips.
//
// The gesture coordinator and its handlers are bundled straight from source
// and driven with real DOM events against a gesture host built on the real
// chart context, shape store and command stack.

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let assertions = 0;
const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  assertions += 1;
  console.log(`✓ ${message}`);
};
const near = (actual, expected, epsilon = 1e-9) => Math.abs(actual - expected) <= epsilon;
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));

// ── DOM environment ────────────────────────────────────────────────────────
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
let frames = [];
window.requestAnimationFrame = (callback) => frames.push(callback);
window.cancelAnimationFrame = () => {};
globalThis.requestAnimationFrame = window.requestAnimationFrame;
const flushFrames = () => {
  const pending = frames;
  frames = [];
  for (const callback of pending) callback(0);
};
const warnings = [];
const warn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));

// ── Source bundle ──────────────────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), "raze-interaction-"));
let lib;
try {
  const outfile = join(scratch, "interaction.mjs");
  await build({
    stdin: {
      resolveDir: root,
      loader: "ts",
      contents: `
        export { GestureController } from "./src/engine/gestures";
        export { createChartContext } from "./src/core/context";
        export { ShapeStore } from "./src/core/ShapeStore";
        export { CommandStack } from "./src/core/CommandStack";
        export { Delegate } from "./src/util/delegate";
        export { wheelZoomFactor } from "./src/engine/interaction/wheel";
        export { topmostFirst } from "./src/engine/interaction/hitTest";
        export { timeScalePolicy } from "./src/engine/interaction/limits";
        export { activeInlineTextEditor } from "./src/ui/InlineTextEditor";
      `,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    outfile,
    logLevel: "silent",
  });
  lib = await import(pathToFileURL(outfile).href);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const {
  CommandStack, Delegate, GestureController, ShapeStore, activeInlineTextEditor,
  createChartContext, timeScalePolicy, topmostFirst, wheelZoomFactor,
} = lib;

// ── Fake gesture host on the real context, shape store and undo stack ─────
// Plot: x 0..500, y 0..300, price = 300 - y. Bars are one minute apart.
const T0 = 1_700_000_040;
const makeBars = (count) => Array.from({ length: count }, (_, i) => ({
  time: (T0 + i * 60) * 1000, open: 100 + i, high: 110 + i, low: 90 + i, close: 105 + i, volume: 1,
}));

function makeHost({ bars = 300, range = { from: 200, to: 300 }, options = {}, magnet = false } = {}) {
  const events = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0 });
  const overlayHost = document.createElement("div");
  container.append(canvas, overlayHost);
  const drawingEvent = new Delegate();
  drawingEvent.subscribe(null, (id, type) => events.push(["drawing", id, type]));
  const context = createChartContext({
    options: { symbol: "T", ...options },
    bars: makeBars(bars),
    resolution: "1",
    symbolInfo: null,
    theme: { scaleText: "#fff", drawingDefault: "#123456" },
    fontFamily: "sans-serif",
    magnet,
    stayInDrawingMode: false,
    drawingTool: "cursor",
    visibleRange: { ...range },
    autoScalePrice: true,
    priceRange: null,
    logScale: false,
    percentScale: false,
    selectedShapeId: null,
    selectedTradingLineId: null,
    drawingEvent,
    viewportChanged: new Delegate(),
    crosshairMoved: new Delegate(),
    requestPaint: () => {},
    overlayHost,
  });
  const commands = new CommandStack();
  let undoEntries = 0;
  const push = commands.push.bind(commands);
  commands.push = (command) => {
    if (commands.enabled) undoEntries += 1;
    push(command);
  };
  const host = {
    canvas,
    context,
    engine: { cssWidth: 640, cssHeight: 360, announce: (message) => events.push(["announce", message]) },
    shapes: new ShapeStore(context, commands),
    trading: { get: () => undefined },
    data: { maybeLoadMoreHistory: async () => {} },
    plotL: 0,
    plotT: 0,
    plotW: 500,
    plotH: 300,
    subPanes: [],
    volumePane: null,
    priceMin: 0,
    priceMax: 300,
    crosshair: { x: 0, y: 0, active: false },
    hoverMark: null,
    hoverTimescaleMark: null,
    hoverShapeId: null,
    hoverTradingLineId: null,
    hoverTradingHit: null,
    markScreen: [],
    timescaleMarkScreen: [],
    shapeScreen: [],
    tradingScreen: [],
    draft: null,
    lastPointerType: "mouse",
    selectedShapeId: null,
    onToolDone: (tool) => events.push(["toolDone", tool]),
    fitContent: () => events.push(["fit"]),
    requestPaint: () => {},
    plotScale() {
      return {
        plotL: this.plotL, plotT: this.plotT, plotW: this.plotW, plotH: this.plotH,
        priceMin: this.priceMin, priceMax: this.priceMax, pctBase: 1,
        visibleRange: context.visibleRange, percentScale: context.percentScale, logScale: context.logScale,
      };
    },
    financeView() {
      return { ...this.plotScale(), context, shapes: this.shapes, shapeScreen: this.shapeScreen };
    },
  };
  const gestures = new GestureController(host);
  gestures.attach();
  const span = () => context.visibleRange.to - context.visibleRange.from;
  return { host, context, events, gestures, span, undo: () => undoEntries, commands };
}

const pointer = (type, x, y, init = {}) => {
  const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: init.id ?? 1 }, pointerType: { value: init.type ?? "mouse" } });
  return event;
};
const wheel = (deltaY, init = {}) => new window.WheelEvent("wheel", {
  deltaY, deltaMode: init.deltaMode ?? 0, ctrlKey: !!init.ctrlKey, clientX: init.x ?? 250, clientY: 150, cancelable: true, bubbles: true,
});
const drag = (h, from, to, steps = [], init = {}) => {
  h.host.canvas.dispatchEvent(pointer("pointerdown", from[0], from[1], init));
  for (const [x, y] of steps) h.host.canvas.dispatchEvent(pointer("pointermove", x, y, init));
  h.host.canvas.dispatchEvent(pointer("pointermove", to[0], to[1], init));
  window.dispatchEvent(pointer("pointerup", to[0], to[1], init));
};
/** Bar centres (index i visible when from - 0.5 <= i <= to - 0.5) inside the data. */
const visibleBars = ({ context }) => {
  const { from, to } = context.visibleRange;
  const first = Math.max(0, Math.ceil(from - 0.5));
  const last = Math.min(context.bars.length - 1, Math.floor(to - 0.5));
  return Math.max(0, last - first + 1);
};

// ── ui-wheel-zoom-delta / perf-wheel-delta-normalization ───────────────────
{
  const h = makeHost();
  const before = h.span();
  for (let i = 0; i < 20; i++) h.host.canvas.dispatchEvent(wheel(1));
  assert(h.span() / before - 1 < 0.25 && h.span() > before, "20 one-pixel trackpad deltas change the span by under 25%");
}
{
  const h = makeHost();
  const before = h.span();
  for (let i = 0; i < 20; i++) h.host.canvas.dispatchEvent(wheel(2));
  assert(h.span() / before <= 1.5, "40 px of pixel-mode deltas change the span by at most 1.5x");
}
{
  const h = makeHost();
  const before = h.span();
  const event = wheel(100);
  h.host.canvas.dispatchEvent(event);
  const growth = h.span() / before - 1;
  assert(event.defaultPrevented && growth >= 0.1 && growth <= 0.12, `one 100 px mouse notch zooms out by 10-12% (${(growth * 100).toFixed(1)}%)`);
  const back = h.span();
  h.host.canvas.dispatchEvent(wheel(-100));
  assert(near(h.span(), back / 1.11, 1e-6), "the opposite notch zooms back in by the same factor");
}
{
  assert(near(wheelZoomFactor({ deltaY: 3, deltaMode: 1, ctrlKey: false }), wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false })),
    "deltaMode LINE is normalised: a three-line notch equals a 100 px notch");
  assert(near(wheelZoomFactor({ deltaY: 1, deltaMode: 2, ctrlKey: false }, 300), wheelZoomFactor({ deltaY: 300, deltaMode: 0, ctrlKey: false })),
    "deltaMode PAGE is normalised to the plot height");
  const pinchScale = 1.25;
  assert(near(wheelZoomFactor({ deltaY: 100 * Math.log(pinchScale), deltaMode: 0, ctrlKey: true }), pinchScale, 1e-9),
    "ctrl+wheel follows the pinch curve (span scales with the finger distance)");
  assert(wheelZoomFactor({ deltaY: 5000, deltaMode: 0, ctrlKey: false }) <= 1.5 + 1e-12, "one accelerated flick cannot zoom by more than 1.5x");
}
{
  const h = makeHost({ range: { from: 100, to: 200 } });
  const pivotBefore = h.context.visibleRange.from + 400 / 5 - 0.5;
  h.host.canvas.dispatchEvent(wheel(-30, { ctrlKey: true, x: 400 }));
  const s = h.span();
  const pivotAfter = h.context.visibleRange.from + 400 / (500 / s) - 0.5;
  assert(s < 100 && near(pivotBefore, pivotAfter, 1e-9), "ctrl+wheel pinch zooms around the cursor");
}

// ── perf-zoom-limits-consistency / series-zoom-out-snaps-in ────────────────
for (const bars of [1_500, 100_000]) {
  const h = makeHost({ bars, range: { from: 0, to: bars - 1 } });
  const all = h.span();
  h.host.canvas.dispatchEvent(wheel(100));
  assert(h.span() >= all, `a zoom-out wheel after ALL on ${bars} bars never shrinks the span`);
  h.host.canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "-", bubbles: true, cancelable: true }));
  assert(h.span() >= all && h.events.at(-1)[1] === "Zoom limit reached.", "the - key at the limit keeps the span and says so");
  h.host.canvas.dispatchEvent(pointer("pointerdown", 250, 350));
  h.host.canvas.dispatchEvent(pointer("pointermove", 150, 350));
  window.dispatchEvent(pointer("pointerup", 150, 350));
  assert(h.span() >= all, "a zoom-out time-axis drag never shrinks the span either");
  h.host.canvas.dispatchEvent(wheel(-100));
  assert(h.span() < all, "zooming in from ALL still narrows the view");
}
{
  const h = makeHost();
  for (let i = 0; i < 200; i++) h.host.canvas.dispatchEvent(wheel(100));
  const limit = h.span();
  assert(near(limit, 500 / 1.5, 1e-6), "repeated wheel-out stops at plotW / min bar spacing");
  const custom = makeHost({ options: { time_scale: { min_bar_spacing: 5 } } });
  for (let i = 0; i < 200; i++) custom.host.canvas.dispatchEvent(wheel(100));
  assert(near(custom.span(), 100, 1e-6), "time_scale.min_bar_spacing sets the zoom-out limit");
}

// ── perf-pan-bounds / series-pan-unbounded ─────────────────────────────────
{
  const h = makeHost();
  drag(h, [50, 150], [490, 150], [[250, 150]]);
  for (let i = 0; i < 10; i++) drag(h, [10, 150], [490, 150]);
  assert(visibleBars(h) >= 3 && h.context.visibleRange.to >= 2.5, "dragging 10 widths into the past keeps at least 3 bars in the plot");
  for (let i = 0; i < 12; i++) drag(h, [490, 150], [10, 150]);
  assert(visibleBars(h) >= 3 && h.context.visibleRange.from <= 297.5, "dragging 10 widths into the future keeps at least 3 bars in the plot");
  const pinned = { ...h.context.visibleRange };
  drag(h, [490, 150], [10, 150]);
  assert(h.context.visibleRange.from === pinned.from, "further drags into empty space are held at the bound");
  drag(h, [10, 150], [60, 150]);
  assert(h.context.visibleRange.from < pinned.from, "dragging back toward the data moves immediately");
}
{
  const h = makeHost();
  const arrow = (key) => h.host.canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  for (let i = 0; i < 100; i++) arrow("ArrowRight");
  assert(visibleBars(h) >= 3 && h.events.at(-1)[1] === "End of the data.", "keyboard panning obeys the same bound and announces the end");
  for (let i = 0; i < 200; i++) arrow("ArrowLeft");
  assert(visibleBars(h) >= 3 && h.events.at(-1)[1] === "Start of the data.", "keyboard panning stops at the start of the data");
}
{
  const h = makeHost({ range: { from: 250, to: 350 } });
  h.host.canvas.dispatchEvent(pointer("pointerdown", 200, 150, { id: 2, type: "touch" }));
  h.host.canvas.dispatchEvent(pointer("pointerdown", 300, 150, { id: 3, type: "touch" }));
  for (let i = 1; i <= 8; i++) h.host.canvas.dispatchEvent(pointer("pointermove", 300 - i * 12, 150, { id: 3, type: "touch" }));
  window.dispatchEvent(pointer("pointerup", 200, 150, { id: 2, type: "touch" }));
  window.dispatchEvent(pointer("pointerup", 204, 150, { id: 3, type: "touch" }));
  assert(visibleBars(h) >= 3, "pinch zoom obeys the pan bound");
}
{
  const right = makeHost({ options: { time_scale: { fix_right_edge: true } } });
  drag(right, [400, 150], [100, 150]);
  assert(right.context.visibleRange.to <= 300 + 1e-9, "time_scale.fix_right_edge leaves no empty space after the last bar");
  const left = makeHost({ range: { from: 10, to: 110 }, options: { time_scale: { fix_left_edge: true } } });
  drag(left, [100, 150], [400, 150]);
  assert(left.context.visibleRange.from >= -1e-9, "time_scale.fix_left_edge leaves no empty space before the first bar");
  const zoomed = makeHost({ range: { from: 0, to: 100 }, options: { time_scale: { fix_left_edge: true } } });
  zoomed.host.canvas.dispatchEvent(wheel(100, { x: 250 }));
  assert(zoomed.context.visibleRange.from >= -1e-9, "zooming out obeys the fixed left edge");
}
{
  const before = warnings.length;
  const options = { time_scale: { fix_left_edge: "yes", min_bar_spacing: -1, bogus: true } };
  const policy = timeScalePolicy(options);
  timeScalePolicy(options);
  const emitted = warnings.slice(before);
  assert(
    emitted.length === 3 && emitted.every((w) => w.startsWith("[raze-charts] time_scale"))
      && emitted.some((w) => w.includes("one of min_bar_spacing, fix_left_edge, fix_right_edge"))
      && !policy.fixLeftEdge && policy.minBarSpacing === 1.5,
    "invalid time_scale options warn once each with guidance and fall back to defaults",
  );
}

// ── Drawings: hit order, anchor vs body, slop, events, undo, Escape ───────
// Trend line from bar 220 @ 100 to bar 260 @ 200: screen (102.5, 200) -> (302.5, 100).
const trendPoints = () => [{ time: T0 + 220 * 60, price: 100 }, { time: T0 + 260 * 60, price: 200 }];
async function withTrend(h, options = {}) {
  const id = await h.host.shapes.createPoints(trendPoints(), { shape: "trend_line", overrides: {}, ...options });
  const shape = h.host.shapes.get(id);
  h.host.shapeScreen.push({ shape, y: 150, hit: "body" });
  return { id, shape };
}
const snapshot = (shape) => JSON.stringify(shape.points);

{
  const h = makeHost();
  const red = await withTrend(h);
  const blue = await withTrend(h);
  h.host.canvas.dispatchEvent(pointer("pointerdown", 202.5, 150));
  window.dispatchEvent(pointer("pointerup", 202.5, 150));
  assert(h.context.selectedShapeId === blue.id, "overlapping drawings select the one painted on top");
  h.host.canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
  assert(!h.host.shapes.get(blue.id) && h.host.shapes.get(red.id), "Delete removes the visible (top) drawing");
  const ordered = topmostFirst([{ z: 5, id: "a" }, { z: 1, id: "b" }, { z: 5, id: "c" }]);
  assert(ordered.map((hit) => hit.id).join() === "c,a,b", "painter z-order wins, then later paint order");
}
{
  const h = makeHost();
  const { id, shape } = await withTrend(h);
  const before = snapshot(shape);
  const undo = h.undo();
  h.events.length = 0;
  drag(h, [202.5, 150], [204, 151]);
  assert(snapshot(shape) === before && h.undo() === undo, "a click with under 2px of jitter leaves the points byte-identical and adds no undo entry");
  assert(h.events.some(([kind, eventId, type]) => kind === "drawing" && eventId === id && type === "click"), "clicking a drawing fires drawing_event 'click'");
}
{
  const h = makeHost();
  const { id, shape } = await withTrend(h);
  const start = shape.points.map((point) => ({ ...point }));
  const undo = h.undo();
  h.events.length = 0;
  drag(h, [202.5, 150], [262.5, 210], [[220, 160], [240, 190]]);
  const dt = shape.points.map((point, i) => point.time - start[i].time);
  const dp = shape.points.map((point, i) => point.price - start[i].price);
  assert(dt[0] === 12 * 60 && dt[1] === 12 * 60 && near(dp[0], -60) && near(dp[1], -60),
    "a body drag 60px right and 60px down shifts every anchor by the same bars and price");
  assert(h.undo() === undo + 1, "a body drag adds exactly one undo entry");
  const types = h.events.filter(([kind]) => kind === "drawing").map(([, , type]) => type);
  assert(types.join() === "move,points_changed", "drag moves are throttled to one 'move' per frame, then one 'points_changed'");
  flushFrames();
  h.events.length = 0;
  drag(h, [262.5, 210], [300, 220], [[280, 215]]);
  flushFrames();
  drag(h, [300, 220], [320, 230], [[310, 225]]);
  const later = h.events.filter(([kind]) => kind === "drawing").map(([, , type]) => type);
  assert(later.filter((type) => type === "move").length === 2 && h.context.selectedShapeId === id, "every new frame may carry one more 'move'");
}
{
  const h = makeHost();
  const { shape } = await withTrend(h);
  const second = { ...shape.points[1] };
  drag(h, [102.5, 200], [152.5, 150]);
  assert(shape.points[0].time === T0 + 230 * 60 && near(shape.points[0].price, 150), "dragging an anchor handle moves only that anchor");
  assert(JSON.stringify(shape.points[1]) === JSON.stringify(second), "the other anchor stays put");
}
{
  const h = makeHost();
  const { shape } = await withTrend(h);
  const before = snapshot(shape);
  const undo = h.undo();
  h.events.length = 0;
  h.host.canvas.dispatchEvent(pointer("pointerdown", 202.5, 150));
  h.host.canvas.dispatchEvent(pointer("pointermove", 240, 190));
  assert(snapshot(shape) !== before, "the drag is live before Escape");
  const escape = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  h.host.canvas.dispatchEvent(escape);
  assert(snapshot(shape) === before && escape.defaultPrevented, "Escape mid-drag restores the captured points");
  h.host.canvas.dispatchEvent(pointer("pointermove", 300, 250));
  window.dispatchEvent(pointer("pointerup", 300, 250));
  const types = h.events.filter(([kind]) => kind === "drawing").map(([, , type]) => type);
  assert(snapshot(shape) === before && h.undo() === undo && !types.includes("points_changed"),
    "moves after Escape are ignored and release commits nothing (no points_changed, no undo entry)");
  assert(h.events.some(([kind, message]) => kind === "announce" && message === "Drag cancelled.") && h.context.selectedShapeId !== null,
    "Escape announces the cancelled drag and does not also clear the selection");
}
{
  // A held press that never left the slop has nothing to roll back: Escape keeps its normal meaning.
  const h = makeHost();
  const { shape } = await withTrend(h);
  const before = snapshot(shape);
  const undo = h.undo();
  h.events.length = 0;
  h.host.canvas.dispatchEvent(pointer("pointerdown", 202.5, 150));
  h.host.canvas.dispatchEvent(pointer("pointermove", 203.5, 151));
  assert(h.context.selectedShapeId === shape.id, "pressing a drawing selects it");
  h.host.canvas.focus();
  h.host.canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert(!h.events.some(([kind, message]) => kind === "announce" && message === "Drag cancelled."),
    "Escape during a press that never moved does not announce a cancelled drag");
  assert(h.context.selectedShapeId === null, "Escape during an unmoved press still clears the selection as usual");
  h.host.canvas.dispatchEvent(pointer("pointermove", 262.5, 210));
  window.dispatchEvent(pointer("pointerup", 262.5, 210));
  const types = h.events.filter(([kind]) => kind === "drawing").map(([, , type]) => type);
  assert(snapshot(shape) === before && h.undo() === undo && types.length === 0,
    "after Escape the press is dropped: later moves drag nothing and release fires no click, change or undo entry");

  const pan = makeHost({ range: { from: 100, to: 200 } });
  pan.host.canvas.dispatchEvent(pointer("pointerdown", 100, 150));
  pan.host.canvas.focus();
  const escape = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  pan.host.canvas.dispatchEvent(escape);
  pan.host.canvas.dispatchEvent(pointer("pointermove", 300, 150));
  window.dispatchEvent(pointer("pointerup", 300, 150));
  assert(!pan.events.some(([kind, message]) => kind === "announce" && message === "Drag cancelled.") && pan.context.visibleRange.from === 100,
    "Escape before an empty-plot press moves does not announce a cancelled pan, and later moves do not pan");
}
{
  const h = makeHost({ range: { from: 100, to: 200 } });
  h.host.canvas.dispatchEvent(pointer("pointerdown", 100, 150));
  h.host.canvas.dispatchEvent(pointer("pointermove", 200, 150));
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert(h.context.visibleRange.from === 100, "Escape cancels a pan too, restoring the start range");
  h.host.canvas.dispatchEvent(pointer("pointermove", 300, 150));
  assert(h.context.visibleRange.from === 100, "the cancelled pan ignores later moves");
  window.dispatchEvent(pointer("pointerup", 300, 150));
}

// ── draw-magnet-time-snap ──────────────────────────────────────────────────
{
  const h = makeHost({ magnet: true });
  h.context.drawingTool = "trend_line";
  // Price window 200..500 puts bar 220 (o320 h330 l310 c325) on screen: y = 500 - price.
  // x 103 is logical index 220.1; y 172 is price 328, nearest to the high.
  const bar = h.context.bars[220];
  h.host.priceMin = 200;
  h.host.priceMax = 500;
  h.host.canvas.dispatchEvent(pointer("pointerdown", 103, 172));
  window.dispatchEvent(pointer("pointerup", 103, 172));
  const point = h.host.draft.points[0];
  assert(point.time === bar.time / 1000 && point.price === bar.high, "with the magnet on, the anchor takes the snapped bar's time and nearest OHLC price");
}
{
  // The magnet only works over bars: in the right offset an anchor keeps the
  // extrapolated bar time and the raw price, so lines can project into the future.
  const h = makeHost({ magnet: true, range: { from: 250, to: 350 } });
  const { shape } = await withTrend(h);
  const last = h.context.bars.at(-1);
  // Anchor 2 (bar 260 @ 200) sits at x = (260.5 - 250) * 5 = 52.5, y = 300 - 200 = 100.
  // x = 450 is logical index 250 + 90 - 0.5 = 339.5, forty bars past the last one.
  drag(h, [52.5, 100], [450, 100]);
  assert((shape.points[1].time - T0) / 60 === 340, "with the magnet on, an anchor dragged past the last bar keeps its future bar time");
  assert(shape.points[1].price === 200 && ![last.open, last.high, last.low, last.close].includes(shape.points[1].price),
    "the magnet does not snap a future anchor's price to the last bar's OHLC");
  const early = makeHost({ magnet: true, range: { from: -50, to: 50 } });
  early.context.drawingTool = "trend_line";
  // x = 102 is logical index -50 + 20.4 - 0.5 = -30.1: thirty bars before the first one.
  early.host.canvas.dispatchEvent(pointer("pointerdown", 102, 123));
  window.dispatchEvent(pointer("pointerup", 102, 123));
  const point = early.host.draft.points[0];
  assert((point.time - T0) / 60 === -30 && point.price === 177, "before the first bar the magnet leaves the anchor on the extrapolated bar and the raw price");
}
{
  const h = makeHost();
  h.context.drawingTool = "trend_line";
  h.host.canvas.dispatchEvent(pointer("pointerdown", 104, 150));
  window.dispatchEvent(pointer("pointerup", 104, 150));
  assert(h.host.draft.points[0].time === T0 + 220 * 60, "without the magnet, anchors snap to bar centres by default");
  const free = makeHost({ options: { raze: { snap_drawings_to_bars: false } } });
  free.context.drawingTool = "trend_line";
  free.host.canvas.dispatchEvent(pointer("pointerdown", 104, 150));
  window.dispatchEvent(pointer("pointerup", 104, 150));
  assert(!Number.isInteger((free.host.draft.points[0].time - T0) / 60), "raze.snap_drawings_to_bars: false allows free placement");
}
{
  const h = makeHost();
  h.context.drawingTool = "trend_line";
  drag(h, [104, 150], [104, 150]);
  drag(h, [204, 120], [204, 120]);
  await tick();
  const [created] = h.host.shapes.list();
  assert(created?.overrides.linecolor === "#123456", "UI-created drawings use the theme's drawingDefault colour");
}

// ── draw-dblclick-fits-content ─────────────────────────────────────────────
{
  const h = makeHost({ range: { from: 150, to: 250 } });
  const { id } = await withTrend(h);
  h.context.setScaleMode({ priceRange: { min: 10, max: 290 } }, "api");
  const range = JSON.stringify(h.context.visibleRange);
  h.events.length = 0;
  const midX = (240 - 150 + 0.5) * 5; // bar 240, halfway along the line in this view
  h.host.canvas.dispatchEvent(new window.MouseEvent("dblclick", { clientX: midX, clientY: 150, bubbles: true }));
  assert(JSON.stringify(h.context.visibleRange) === range && h.context.autoScalePrice === false && h.context.priceRange?.min === 10,
    "double-clicking a drawing leaves the visible range, price range and autoscale unchanged");
  assert(!h.events.some(([kind]) => kind === "fit") && h.context.selectedShapeId === id, "double-clicking a drawing selects it instead of refitting");
  h.host.canvas.dispatchEvent(new window.MouseEvent("dblclick", { clientX: 20, clientY: 20, bubbles: true }));
  assert(h.events.some(([kind]) => kind === "fit") && h.context.autoScalePrice, "double-clicking empty plot still resets scaling and fits");
}
{
  const h = makeHost();
  h.context.drawingTool = "trend_line";
  drag(h, [104, 150], [104, 150]);
  drag(h, [204, 120], [204, 120]);
  h.host.canvas.dispatchEvent(new window.MouseEvent("dblclick", { clientX: 204, clientY: 120, bubbles: true }));
  assert(!h.events.some(([kind]) => kind === "fit"), "the double-click formed by drafting clicks does not refit the chart");
}

// ── Inline text editor (ui-text-tool-inline-editor / draw-inline-text-editing) ──
const sourceFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? sourceFiles(path) : [path];
});
const prompts = sourceFiles(join(root, "src/engine")).concat(join(root, "src/ui/InlineTextEditor.ts"))
  .filter((path) => /window\.prompt\s*\(/.test(readFileSync(path, "utf8")));
assert(prompts.length === 0, "the text tool no longer calls window.prompt");
{
  const h = makeHost();
  window.prompt = () => {
    throw new Error("prompt must not be called");
  };
  h.context.drawingTool = "text";
  h.host.canvas.dispatchEvent(pointer("pointerdown", 104, 150));
  window.dispatchEvent(pointer("pointerup", 104, 150));
  await tick();
  const editor = h.host.context.overlayHost.querySelector("textarea.raze-chart-inline-editor");
  assert(editor && document.activeElement === editor && editor.getAttribute("aria-label") === "Drawing text",
    "clicking with the Text tool opens a focused, labelled editor at the click point");
  assert(editor.style.left === "96.5px" && editor.style.top !== "", "the editor is positioned at the bar-snapped anchor");
  editor.value = "Hi";
  editor.dispatchEvent(new window.Event("input"));
  const shift = new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
  editor.dispatchEvent(shift);
  assert(!shift.defaultPrevented && editor.isConnected, "Shift+Enter keeps editing (a newline)");
  const undo = h.undo();
  const enter = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  editor.dispatchEvent(enter);
  await tick();
  const text = h.host.shapes.list().find((shape) => shape.shape === "text");
  assert(text?.text === "Hi" && text.points[0].time === T0 + 220 * 60 && !editor.isConnected, "typing Hi then Enter creates the text drawing");
  assert(h.undo() === undo + 1 && h.context.drawingTool === "cursor", "creating the label is one undo step and returns to the cursor tool");
  assert(document.activeElement === h.host.canvas, "focus returns to the chart after committing");

  h.host.shapeScreen.length = 0;
  h.host.shapeScreen.push({ shape: text, y: 150, hit: "body" });
  h.host.canvas.dispatchEvent(new window.MouseEvent("dblclick", { clientX: 104, clientY: 150, bubbles: true }));
  const reopened = activeInlineTextEditor(h.host.context.overlayHost);
  assert(reopened?.el.value === "Hi", "double-clicking the text drawing re-opens the editor with its text");
  reopened.el.value = "Hello";
  const events = h.events.length;
  reopened.el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert(text.text === "Hello" && h.undo() === undo + 2, "re-editing commits the new text as one undo step");
  assert(h.events.slice(events).some(([kind, , type]) => kind === "drawing" && type === "properties_changed"), "re-editing fires properties_changed");
  h.commands.undo();
  assert(h.host.shapes.get(text.id).text === "Hi", "undo restores the previous text");

  h.host.canvas.dispatchEvent(new window.MouseEvent("dblclick", { clientX: 104, clientY: 150, bubbles: true }));
  const blurred = activeInlineTextEditor(h.host.context.overlayHost);
  blurred.el.value = "Blur";
  h.host.canvas.focus();
  assert(h.host.shapes.get(text.id).text === "Blur" && !blurred.open, "moving focus away commits the edit");
}
{
  const h = makeHost();
  h.context.drawingTool = "text";
  h.host.canvas.dispatchEvent(pointer("pointerdown", 104, 150));
  window.dispatchEvent(pointer("pointerup", 104, 150));
  await tick();
  const editor = activeInlineTextEditor(h.host.context.overlayHost);
  editor.el.value = "Discard me";
  const escape = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  let leaked = false;
  h.host.canvas.parentNode.addEventListener("keydown", () => { leaked = true; });
  editor.el.dispatchEvent(escape);
  assert(!editor.open && h.host.shapes.list().length === 0 && !leaked, "Escape cancels a new label without creating it or leaking the key");
  assert(h.context.drawingTool === "cursor", "cancelling returns to the cursor tool");
  h.context.drawingTool = "text";
  h.host.canvas.dispatchEvent(pointer("pointerdown", 104, 150));
  window.dispatchEvent(pointer("pointerup", 104, 150));
  await tick();
  const empty = activeInlineTextEditor(h.host.context.overlayHost);
  empty.el.value = "   ";
  empty.el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert(h.host.shapes.list().length === 0, "committing an empty label creates nothing");
}
{
  // Teardown mid-edit: an open editor is discarded and a scheduled one never opens.
  const h = makeHost();
  h.context.drawingTool = "text";
  h.host.canvas.dispatchEvent(pointer("pointerdown", 104, 150));
  window.dispatchEvent(pointer("pointerup", 104, 150));
  await tick();
  const editor = activeInlineTextEditor(h.host.context.overlayHost);
  editor.el.value = "Unsaved";
  h.events.length = 0;
  h.gestures.destroy();
  editor.el.dispatchEvent(new window.Event("blur"));
  await tick();
  assert(!editor.open && !editor.el.isConnected && h.host.shapes.list().length === 0,
    "destroying the chart with the text editor open removes it without creating a drawing");
  assert(!h.events.some(([kind]) => kind === "toolDone") && h.context.drawingTool === "text",
    "a destroyed chart's editor does not reset the tool or call onToolDone");

  const pending = makeHost();
  pending.context.drawingTool = "text";
  pending.host.canvas.dispatchEvent(pointer("pointerdown", 104, 150));
  window.dispatchEvent(pointer("pointerup", 104, 150));
  pending.gestures.destroy();
  await tick();
  assert(!activeInlineTextEditor(pending.host.context.overlayHost) && !pending.events.some(([kind]) => kind === "toolDone")
    && pending.context.drawingTool === "text", "destroying the chart before the scheduled editor opens cancels it");
}

// ── Timescale-mark tooltip ────────────────────────────────────────────────
{
  const h = makeHost();
  const mark = { id: 1, time: T0 + 250 * 60, color: "red", label: "E", tooltip: ["Earnings", "Q3 beat"] };
  h.host.timescaleMarkScreen.push({ mark, x: 250, y: 345, r: 7 });
  h.host.canvas.dispatchEvent(pointer("pointermove", 252, 344));
  const tip = h.host.context.overlayHost.querySelector('[role="tooltip"]');
  assert(h.host.hoverTimescaleMark === mark && tip?.textContent === "Earnings\nQ3 beat", "hovering a timescale mark shows its tooltip lines");
  assert((h.host.canvas.getAttribute("aria-describedby") ?? "").split(" ").includes(tip.id) && h.host.canvas.style.cursor === "pointer",
    "the tooltip describes the canvas and the badge shows a pointer cursor");
  h.host.canvas.dispatchEvent(pointer("pointermove", 100, 100));
  assert(!tip.isConnected && !h.host.canvas.hasAttribute("aria-describedby") && h.host.hoverTimescaleMark === null, "moving off the badge hides the tooltip");
  h.host.canvas.dispatchEvent(pointer("pointermove", 250, 345));
  h.host.canvas.dispatchEvent(pointer("pointerleave", 250, 345));
  assert(!h.host.context.overlayHost.querySelector('[role="tooltip"]'), "leaving the canvas hides the tooltip");
}

console.warn = warn;
console.log(`\nINTERACTION: PASS (${assertions} assertions)`);
