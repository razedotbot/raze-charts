#!/usr/bin/env node
// Native renderer and mount correctness (W1B-03): bounded last-value chip
// stacking, stage-based overlay coordinates, legend toggles on both renderers,
// clamped zoom and bounded pan, category chips, structured pointer payloads,
// edge-anchored tick labels, tooltips that survive repaints, themed range
// presets, rAF-coalesced wheel and resize, the cached navigator scene, and the
// mount lifecycle (every listener, observer, and frame released on destroy
// and on a failed update).

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = await import(pathToFileURL(resolve(root, "dist/chart.esm.js")).href);
const {
  bar, compileChart, defineChart, line, mountChart, paintChartCanvas, pie, radar, svgFromCompiled,
} = chart;

let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`✗ ${name}\n  ${error?.stack ?? error}`);
  }
}

// ---------------------------------------------------------------------------
// Environment: jsdom, a manual animation-frame queue, a triggerable
// ResizeObserver, a counting canvas context, and listener bookkeeping.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.SVGElement = window.SVGElement;

const frames = new Map();
let frameSeq = 0;
globalThis.requestAnimationFrame = (callback) => {
  const id = ++frameSeq;
  frames.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  frames.delete(id);
};
function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

const observers = [];
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    this.disconnected = false;
    observers.push(this);
  }
  observe(target) { this.targets.add(target); }
  unobserve(target) { this.targets.delete(target); }
  disconnect() { this.disconnected = true; this.targets.clear(); }
  trigger() { this.callback([...this.targets].map((target) => ({ target })), this); }
};

let canvasPaints = 0;
function stubContext() {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  return new Proxy({
    globalAlpha: 1,
    clearRect: () => { canvasPaints++; },
    createLinearGradient: () => gradient,
    measureText: (text) => ({ width: String(text).length * 6 }),
    texts: [],
    fillText(text, x, y) { this.texts.push({ text, x, y, align: this.textAlign }); },
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return noop;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}
window.HTMLCanvasElement.prototype.getContext = function getContext() {
  if (!this.__context) this.__context = stubContext();
  return this.__context;
};

// Every listener added through EventTarget, so teardown can be audited.
const liveListeners = new Map();
const nativeAdd = window.EventTarget.prototype.addEventListener;
const nativeRemove = window.EventTarget.prototype.removeEventListener;
window.EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
  const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
  let entries = liveListeners.get(this);
  if (!entries) liveListeners.set(this, (entries = new Set()));
  entries.add(`${type}|${capture}|${listenerId(listener)}`);
  return nativeAdd.call(this, type, listener, options);
};
window.EventTarget.prototype.removeEventListener = function removeEventListener(type, listener, options) {
  const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
  liveListeners.get(this)?.delete(`${type}|${capture}|${listenerId(listener)}`);
  return nativeRemove.call(this, type, listener, options);
};
const listenerIds = new WeakMap();
let listenerSeq = 0;
function listenerId(listener) {
  if (!listener || (typeof listener !== "function" && typeof listener !== "object")) return String(listener);
  if (!listenerIds.has(listener)) listenerIds.set(listener, ++listenerSeq);
  return listenerIds.get(listener);
}
/** Listeners still attached to `rootNode` or any node inside it. */
function listenersWithin(rootNode) {
  let count = 0;
  for (const [target, entries] of liveListeners) {
    if (entries.size && rootNode.contains?.(target)) count += entries.size;
  }
  return count;
}
/** Listeners on window and document (a mount must not leave any behind). */
function globalListeners() {
  return (liveListeners.get(window)?.size ?? 0) + (liveListeners.get(document)?.size ?? 0);
}

function rect(box) {
  const { left = 0, top = 0, width, height } = box;
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON() {} };
}

/**
 * Mount `definition` into a fresh host. The overlay elements are looked up by
 * their fixed DOM order inside the wrap (see createMountDom).
 */
function mountFixture(definition, options = {}, layout = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = mountChart(host, definition, options);
  const wrap = host.firstElementChild;
  const [stage, hairV, hairH, chipY, chipX, cell, dot, tip, a11y, legend, presetsBar, nav, brushRect] = wrap.children;
  const wrapBox = layout.wrap ?? { width: options.width ?? 480, height: options.height ?? 280 };
  wrap.getBoundingClientRect = () => rect(wrapBox);
  if (layout.stage) stage.getBoundingClientRect = () => rect(layout.stage);
  const fire = (type, init = {}, target = wrap) => {
    const Ctor = type === "wheel" ? window.WheelEvent : window.MouseEvent;
    const event = new Ctor(type, { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  return {
    host, handle, wrap, stage, fire,
    el: { hairV, hairH, chipY, chipX, cell, dot, tip, a11y, legend, presetsBar, nav, brushRect },
    cleanup() {
      handle.destroy();
      host.remove();
    },
  };
}

const px = (value) => Number.parseFloat(value);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);

// ---------------------------------------------------------------------------
// Last-value chips

function chipTops(markup, scene) {
  const gutterX = scene.plot.x + scene.plot.w + 3;
  const tops = [];
  const pattern = new RegExp(`<rect x="${gutterX}" y="([-\\d.]+)" width="[\\d.]+" height="15"`, "g");
  for (const match of markup.matchAll(pattern)) tops.push(Number(match[1]));
  return tops.sort((a, b) => a - b);
}

await check("20 series ending at the domain minimum render quickly with non-overlapping chips", () => {
  const marks = Array.from({ length: 20 }, (_, i) => line([{ x: 0, y: 10 }, { x: 1, y: 4 + i * 0.001 }, { x: 2, y: 0 }], { x: "x", y: "y", name: `S${i}` }));
  const scene = compileChart(defineChart({ marks, legend: false }), { width: 400, height: 200 });
  let started = performance.now();
  const markup = svgFromCompiled(scene);
  const svgMs = performance.now() - started;
  started = performance.now();
  paintChartCanvas(stubContext(), scene);
  const canvasMs = performance.now() - started;
  assert(svgMs < 50, `svgFromCompiled returns within 50ms (${svgMs.toFixed(1)}ms)`);
  assert(canvasMs < 50, `paintChartCanvas returns within 50ms (${canvasMs.toFixed(1)}ms)`);
  const tops = chipTops(markup, scene);
  const { plot } = scene;
  assert(tops.length > 1, "chips are drawn");
  for (let i = 0; i < tops.length; i++) {
    assert(tops[i] >= plot.y - 1e-9 && tops[i] <= plot.y + plot.h - 15 + 1e-9, `chip ${i} stays on the value axis`);
    if (i) assert(tops[i] - tops[i - 1] >= 15, `chips ${i - 1} and ${i} do not overlap`);
  }
  const capacity = Math.floor((plot.h - 15) / 16) + 1;
  assert.equal(tops.length, Math.min(20, capacity), "as many chips as fit are drawn");
  assert.match(markup, new RegExp(`…\\+${20 - (capacity - 1)}<`), "chips that do not fit collapse into one …+N chip");
});

await check("two falling series at the bottom clamp stack upward instead of hanging", () => {
  const scene = compileChart(defineChart({
    marks: [
      line([{ x: 0, y: 5 }, { x: 1, y: 0 }], { x: "x", y: "y", name: "A" }),
      line([{ x: 0, y: 4 }, { x: 1, y: 0.1 }], { x: "x", y: "y", name: "B" }),
    ],
    legend: false,
  }), { width: 400, height: 200 });
  const tops = chipTops(svgFromCompiled(scene), scene);
  assert.equal(tops.length, 2, "both chips are drawn");
  assert(tops[1] - tops[0] >= 15, "the chips do not overlap");
  assert(tops[1] <= scene.plot.y + scene.plot.h - 15 + 1e-9, "the lower chip sits at the bottom clamp");
});

// ---------------------------------------------------------------------------
// Stage-based overlay coordinates

const revenue = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * DAY, v: 100 + 20 * Math.sin(i / 5) + i }));
const revenueDefinition = defineChart({
  marks: [line(revenue, { x: "t", y: "v", name: "Revenue" })],
  scales: { x: { type: "time" } },
  legend: false,
  ariaLabel: "Revenue",
});

function sizeStage(fixture, width, height) {
  Object.defineProperty(fixture.stage, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(fixture.stage, "clientHeight", { configurable: true, get: () => height });
}

await check("with presets and navigator the hover dot and chips map through the stage, not the wrap", () => {
  const fixture = mountFixture(revenueDefinition, { interaction: { rangePresets: true, navigator: true } }, {
    wrap: { width: 480, height: 300 },
    stage: { width: 480, height: 234 },
  });
  sizeStage(fixture, 480, 234);
  fixture.handle.update(revenueDefinition);
  const scene = fixture.handle.getScene();
  assert.equal(scene.height, 234, "the scene is compiled at the stage size");
  for (const sample of [scene.samples[5], scene.samples[30], scene.samples[55]]) {
    fixture.fire("pointermove", { clientX: sample.x, clientY: sample.y });
    assert.equal(fixture.el.dot.style.display, "block", "the hover dot is shown");
    assert(Math.abs(px(fixture.el.dot.style.left) - sample.x) <= 1, "dot x lies within 1px of the sample");
    assert(Math.abs(px(fixture.el.dot.style.top) - sample.y) <= 1, "dot y lies within 1px of the sample");
    const chipTop = px(fixture.el.chipX.style.top);
    assert(chipTop >= scene.plot.y + scene.plot.h && chipTop + 17 <= scene.height, "the X chip sits in the x-axis band, above the navigator");
  }
  fixture.cleanup();
});

await check("a letterboxed, CSS-scaled stage maps pointer and overlay with one uniform scale", () => {
  const fixture = mountFixture(revenueDefinition, { width: 480, height: 280 }, {
    wrap: { width: 960, height: 700 },
    stage: { width: 960, height: 700 },
  });
  const scene = fixture.handle.getScene();
  const sample = scene.samples[20];
  // Uniform scale 2, centred vertically: (700 - 560) / 2 = 70px letterbox.
  fixture.fire("pointermove", { clientX: sample.x * 2, clientY: 70 + sample.y * 2 });
  assert(Math.abs(px(fixture.el.dot.style.left) - sample.x * 2) <= 1, "dot x maps through the uniform scale");
  assert(Math.abs(px(fixture.el.dot.style.top) - (70 + sample.y * 2)) <= 1, "dot y includes the letterbox offset");
  fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Legend toggles

const pairDefinition = defineChart({
  marks: [
    line([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 2 }], { x: "x", y: "y", name: "Alpha" }),
    line([{ x: 0, y: 2 }, { x: 1, y: 1 }, { x: 2, y: 4 }], { x: "x", y: "y", name: "Beta" }),
  ],
});

await check("Canvas and SVG legends toggle series identically from pointer coordinates", () => {
  const results = [];
  for (const renderer of ["svg", "canvas"]) {
    const fixture = mountFixture(pairDefinition, { width: 480, height: 280, renderer });
    const scene = fixture.handle.getScene();
    // First top-legend entry: swatch at plot.x, text baseline at y=14.
    fixture.fire("pointerdown", { clientX: scene.plot.x + 12, clientY: 12 });
    fixture.fire("pointerup", { clientX: scene.plot.x + 12, clientY: 12 });
    const after = fixture.handle.getScene();
    results.push(after.samples.map((sample) => sample.series));
    assert(!after.samples.some((sample) => sample.series === "Alpha"), `${renderer}: Alpha is hidden`);
    fixture.cleanup();
  }
  assert.deepEqual(results[0], results[1], "both renderers hide the same series");
});

await check("legend entries are keyboard-reachable toggle buttons with pressed state", () => {
  const fixture = mountFixture(pairDefinition, { width: 480, height: 280, renderer: "canvas" });
  const buttons = [...fixture.el.legend.querySelectorAll("button")];
  assert.equal(buttons.length, 2, "one toggle per legend entry");
  assert.equal(fixture.el.legend.getAttribute("role"), "group", "toggles are grouped");
  assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label")), ["Alpha", "Beta"], "toggles are named by series");
  assert(buttons.every((button) => button.getAttribute("aria-pressed") === "true"), "visible series are pressed");
  assert(buttons.every((button) => button.style.cursor === "pointer"), "toggles show the pointer cursor");
  buttons[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert(!fixture.handle.getScene().samples.some((sample) => sample.series === "Beta"), "clicking a toggle hides its series");
  fixture.handle.update(pairDefinition, { hiddenSeries: [] });
  assert(fixture.handle.getScene().samples.some((sample) => sample.series === "Beta"), "hiddenSeries: [] restores it");

  // Focus follows series identity across repaints.
  const [alpha, beta] = fixture.el.legend.querySelectorAll("button");
  beta.focus();
  fixture.handle.update(pairDefinition);
  assert.equal(document.activeElement, beta, "a repaint keeps focus on the same series toggle");
  alpha.focus();
  alpha.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const remaining = [...fixture.el.legend.querySelectorAll("button")];
  assert.equal(document.activeElement, remaining[0], "when the focused entry leaves the legend, focus stays in the group");
  assert.equal(remaining[0].getAttribute("aria-label"), "Beta");
  fixture.cleanup();
});

await check("radar series toggle from the legend", () => {
  const axes = ["Speed", "Power", "Range", "Cost", "Style"];
  const definition = defineChart({
    marks: [
      radar(axes.map((axis, i) => ({ axis, v: 3 + i })), { x: "axis", y: "v", name: "Model A" }),
      radar(axes.map((axis, i) => ({ axis, v: 7 - i })), { x: "axis", y: "v", name: "Model B" }),
    ],
  });
  const fixture = mountFixture(definition, { width: 480, height: 320, renderer: "canvas" });
  const scene = fixture.handle.getScene();
  assert.equal(scene.legendPlacement, "top", "radar legends sit on top");
  fixture.fire("pointerdown", { clientX: scene.plot.x + 12, clientY: 12 });
  assert(!fixture.handle.getScene().samples.some((sample) => sample.series === "Model A"), "the radar layer is hidden");
  fixture.cleanup();
});

await check("pie legends do not pretend to be interactive", () => {
  const definition = defineChart({
    marks: [pie([{ label: "Equity", v: 5 }, { label: "Bonds", v: 3 }, { label: "Cash", v: 2 }], { valueKey: "v", labelKey: "label", name: "Mix" })],
  });
  const fixture = mountFixture(definition, { width: 480, height: 280 });
  assert.equal(fixture.el.legend.querySelectorAll("button").length, 0, "no toggle buttons for slices");
  assert.doesNotMatch(fixture.stage.innerHTML, /cursor:\s*pointer/, "the pie legend shows no pointer cursor");
  const before = fixture.handle.getScene();
  const entry = fixture.stage.querySelector("[data-series]");
  fixture.fire("pointerdown", { clientX: 400, clientY: 100 }, entry);
  assert.equal(fixture.handle.getScene(), before, "pressing a slice entry does not repaint or hide anything");
  fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Clamped zoom and bounded pan

const hundred = Array.from({ length: 100 }, (_, i) => ({ x: i, y: Math.sin(i / 7) * 10 + i / 5 }));
const hundredDefinition = defineChart({ marks: [line(hundred, { x: "x", y: "y", name: "Wave" })], legend: false });

function span(viewport) {
  return Math.abs(Number(viewport.x[1]) - Number(viewport.x[0]));
}

await check("wheel zoom stops at minSpan, and zooming out always recovers the full extent", () => {
  const fixture = mountFixture(hundredDefinition, { width: 480, height: 280 });
  const full = fixture.handle.getScene().xScale.domain.slice();
  for (let i = 0; i < 400; i++) {
    fixture.fire("wheel", { clientX: 240, clientY: 140, deltaY: -100 });
    if (i % 7 === 0) flushFrames();
  }
  flushFrames();
  const zoomed = fixture.handle.getViewport();
  assert(span(zoomed) >= 2 - 1e-9, `span never drops below three data points (${span(zoomed)})`);
  const ticks = fixture.handle.getScene().xTicks.map((tick) => tick.label);
  assert.equal(new Set(ticks).size, ticks.length, "ticks stay distinct at maximum zoom");
  for (let i = 0; i < 200; i++) {
    fixture.fire("wheel", { clientX: 240, clientY: 140, deltaY: 100 });
    if (i % 5 === 0) flushFrames();
  }
  flushFrames();
  assert.deepEqual(fixture.handle.getViewport().x.map(Number), full, "zooming out lands exactly on the full extent");
  fixture.cleanup();
});

await check("pan and zoom-out stay inside the data by default; panBounds none and zoom options are honoured", () => {
  const bounded = mountFixture(hundredDefinition, { width: 480, height: 280 });
  const full = bounded.handle.getScene().xScale.domain.slice();
  bounded.fire("pointerdown", { clientX: 200, clientY: 140 });
  bounded.fire("pointermove", { clientX: 400, clientY: 140 });
  bounded.fire("pointerup", { clientX: 400, clientY: 140 });
  assert.deepEqual(bounded.handle.getViewport().x.map(Number), full, "a full-extent chart cannot be dragged into empty space");
  bounded.handle.setViewport({ x: [10, 30] });
  bounded.fire("pointerdown", { clientX: 200, clientY: 140 });
  bounded.fire("pointermove", { clientX: 470, clientY: 140 });
  bounded.fire("pointerup", { clientX: 470, clientY: 140 });
  const panned = bounded.handle.getViewport().x.map(Number);
  assert(panned[0] >= full[0] - 1e-9, "dragging right stops at the first data point");
  assert(Math.abs(panned[1] - panned[0] - 20) < 1e-6, "a bounded pan keeps the window span");
  bounded.cleanup();

  const free = mountFixture(hundredDefinition, { width: 480, height: 280, interaction: { panBounds: "none", zoom: { minSpan: 10, maxSpan: 50 } } });
  for (let i = 0; i < 60; i++) free.fire("wheel", { clientX: 240, clientY: 140, deltaY: -100 });
  flushFrames();
  assert(Math.abs(span(free.handle.getViewport()) - 10) < 1e-9, "zoom.minSpan bounds zooming in");
  for (let i = 0; i < 60; i++) free.fire("wheel", { clientX: 240, clientY: 140, deltaY: 100 });
  flushFrames();
  assert(Math.abs(span(free.handle.getViewport()) - 50) < 1e-9, "zoom.maxSpan bounds zooming out");
  for (let drag = 0; drag < 2; drag++) {
    free.fire("pointerdown", { clientX: 200, clientY: 140 });
    free.fire("pointermove", { clientX: 470, clientY: 140 });
    free.fire("pointerup", { clientX: 470, clientY: 140 });
  }
  assert(Number(free.handle.getViewport().x[0]) < full[0], "panBounds none lets the window leave the data");
  free.cleanup();

  const host = document.createElement("div");
  document.body.appendChild(host);
  assert.throws(() => mountChart(host, hundredDefinition, { interaction: { zoom: { minSpan: -1 } } }), /minSpan must be a finite number greater than 0/);
  assert.throws(() => mountChart(host, hundredDefinition, { interaction: { zoom: { minSpan: 20, maxSpan: 5 } } }), /must not exceed maxSpan/);
  assert.throws(() => mountChart(host, hundredDefinition, { interaction: { panBounds: "anywhere" } }), /panBounds must be "data" or "none"/);
  assert.equal(host.childElementCount, 0, "rejected options leave nothing mounted");
  host.remove();
});

await check("horizontal wheel pans when panning is on and is left to the page otherwise", () => {
  const fixture = mountFixture(hundredDefinition, { width: 480, height: 280, viewport: { x: [20, 40] } });
  const event = fixture.fire("wheel", { clientX: 240, clientY: 140, deltaX: 120, deltaY: 0 });
  flushFrames();
  assert(event.defaultPrevented, "a horizontal swipe is consumed");
  const moved = fixture.handle.getViewport().x.map(Number);
  assert(moved[0] > 20 && Math.abs(moved[1] - moved[0] - 20) < 1e-9, "the window pans right, keeping its span");
  fixture.handle.update(hundredDefinition, { interaction: { pan: false } });
  const ignored = fixture.fire("wheel", { clientX: 240, clientY: 140, deltaX: 120, deltaY: 0 });
  assert(!ignored.defaultPrevented, "without pan a horizontal swipe scrolls the page");
  fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Category chips and structured payloads

await check("on thinned band axes the X chip names the hovered bar's category", () => {
  const days = Array.from({ length: 24 }, (_, i) => ({ day: `D${String(i + 1).padStart(2, "0")}`, volume: 20 + ((i * 7) % 23) }));
  const events = [];
  const fixture = mountFixture(defineChart({ marks: [bar(days, { x: "day", y: "volume", name: "Volume" })], legend: false }), {
    width: 480,
    height: 280,
    onTooltip: (event) => events.push(event),
  });
  const scene = fixture.handle.getScene();
  assert(scene.xTicks.length < days.length, "the band axis is thinned");
  const bars = scene.nodes.filter((node) => node.role === "bar");
  assert.equal(bars.length, 24, "every bar is hoverable");
  for (const node of bars) {
    fixture.fire("pointermove", { clientX: node.x + node.w / 2, clientY: node.y + node.h / 2 });
    assert.equal(fixture.el.chipX.textContent, node.datum.day, `chip names ${node.datum.day}`);
    assert(fixture.el.tip.textContent.includes(node.datum.day), "the tooltip names the same category");
    assert.equal(fixture.el.chipY.textContent, String(node.datum.volume), "the value chip shows the datum value");
    const event = events.at(-1);
    assert.equal(event.x, node.datum.day, "onTooltip.x is the category");
    assert.equal(event.y, node.datum.volume, "onTooltip.y is the datum value");
    assert.equal(event.datum, node.datum, "onTooltip.datum is the row");
  }
  fixture.cleanup();
});

await check("pointer payloads are data-space: x type follows the scale, samples carry datum and index", () => {
  const categories = ["Jan", "Feb", "Mar", "Apr"].map((m, i) => ({ m, v: 5 + i }));
  const bandEvents = [];
  const selects = [];
  const band = mountFixture(defineChart({ marks: [line(categories, { x: "m", y: "v", name: "L" })], legend: false }), {
    width: 480,
    height: 280,
    onTooltip: (event) => bandEvents.push(event),
    onSelect: (event) => selects.push(event),
  });
  const bandSample = band.handle.getScene().samples[1];
  band.fire("pointermove", { clientX: bandSample.x, clientY: bandSample.y });
  const bandEvent = bandEvents.at(-1);
  assert.equal(typeof bandEvent.x, "string", "band payload x is a category");
  assert.equal(bandEvent.x, "Feb");
  assert.equal(bandEvent.y, 6);
  assert.equal(bandEvent.datum, categories[1], "line samples carry their row");
  assert.equal(bandEvent.index, 1, "line samples carry their row index");
  assert.equal(bandEvent.markIndex, 0);
  assert.equal(bandEvent.seriesId, "mark-0");
  assert.equal(band.el.chipX.textContent, "Feb", "chips render from structured values");
  band.fire("pointerdown", { clientX: bandSample.x, clientY: bandSample.y });
  band.fire("pointerup", { clientX: bandSample.x, clientY: bandSample.y });
  assert.equal(selects.at(-1).x, "Feb", "onSelect.x is the category, never a pixel");
  band.cleanup();

  const linearEvents = [];
  const linear = mountFixture(revenueDefinition, {
    width: 480,
    height: 280,
    viewport: { x: [T0 + 10 * DAY, T0 + 30 * DAY] },
    onTooltip: (event) => linearEvents.push(event),
  });
  const sample = linear.handle.getScene().samples[4];
  linear.fire("pointermove", { clientX: sample.x, clientY: sample.y });
  const linearEvent = linearEvents.at(-1);
  assert.equal(typeof linearEvent.x, "number", "linear payload x is a number");
  const row = revenue[linearEvent.index];
  assert.equal(linearEvent.datum, row, "index points at the datum in the source rows, even inside a viewport");
  assert.equal(linearEvent.x, row.t);
  assert.equal(linearEvent.y, row.v);
  linear.cleanup();
});

// ---------------------------------------------------------------------------
// Edge tick labels

await check("first and last X tick labels are anchored inside the chart", () => {
  const scene = compileChart(defineChart({
    marks: [line(Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * DAY, v: i })), { x: "t", y: "v" })],
    scales: { x: { type: "time" } },
    margin: { left: 4 },
    legend: false,
  }), { width: 480, height: 240 });
  const labels = [...svgFromCompiled(scene).matchAll(/<text x="([-\d.]+)" y="[-\d.]+" text-anchor="(start|middle|end)" font-size="9"[^>]*>([^<]*)<\/text>/g)]
    .map(([, x, anchor, text]) => ({ x: Number(x), anchor, text }))
    .filter((label) => scene.xTicks.some((tick) => tick.label === label.text));
  assert.equal(labels.length, scene.xTicks.length, "every x tick has a label");
  for (const label of labels) {
    const width = label.text.length * 9 * 0.6;
    const left = label.anchor === "start" ? label.x : label.anchor === "end" ? label.x - width : label.x - width / 2;
    assert(left >= 0 && left + width <= scene.width, `label "${label.text}" stays inside [0, ${scene.width}]`);
  }
  if (scene.xTicks[0].px - scene.xTicks[0].label.length * 2.7 < 2) {
    assert.equal(labels[0].anchor, "start", "the first label is anchored to the left edge");
  }
  const ctx = stubContext();
  paintChartCanvas(ctx, scene);
  const first = ctx.texts.find((text) => text.text === scene.xTicks[0].label);
  assert.equal(first.align, labels[0].anchor === "start" ? "left" : "center", "Canvas anchors the first label like SVG");
});

// ---------------------------------------------------------------------------
// Tooltip survives repaints

await check("update() keeps the tooltip under a stationary pointer and shows the new value", () => {
  const events = [];
  const series = (bump) => defineChart({
    marks: [line([{ x: 0, y: 10 }, { x: 1, y: 20 + bump }, { x: 2, y: 30 }], { x: "x", y: "y", name: "Live" })],
    legend: false,
  });
  const fixture = mountFixture(series(0), { width: 480, height: 280, onTooltip: (event) => events.push(event) });
  const sample = fixture.handle.getScene().samples[1];
  fixture.fire("pointermove", { clientX: sample.x, clientY: sample.y });
  assert.equal(fixture.el.tip.style.display, "block", "the tooltip is shown");
  fixture.handle.update(series(1));
  assert.equal(fixture.el.tip.style.display, "block", "the tooltip survives update()");
  assert.match(fixture.el.tip.textContent, /21/, "the tooltip shows the updated value");
  assert.equal(events.at(-1).y, 21, "onTooltip reports the updated value");
  fixture.handle.setViewport({ x: [0, 1.5] });
  assert.equal(fixture.el.tip.style.display, "block", "the tooltip survives setViewport()");
  fixture.fire("pointerleave");
  assert.equal(events.at(-1), null, "leaving the chart reports a null tooltip");
  fixture.handle.update(series(2));
  assert.equal(fixture.el.tip.style.display, "none", "after the pointer leaves, repaints keep the tooltip hidden");
  fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Themed range presets and brush

function parseColor(value) {
  const rgb = /rgba?\(([^)]+)\)/.exec(value);
  if (rgb) {
    const [r, g, b, a = 1] = rgb[1].split(",").map((part) => Number(part.trim()));
    return { r, g, b, a };
  }
  const hex = /#([0-9a-f]{6})/i.exec(value);
  if (hex) return { r: parseInt(hex[1].slice(0, 2), 16), g: parseInt(hex[1].slice(2, 4), 16), b: parseInt(hex[1].slice(4, 6), 16), a: 1 };
  throw new Error(`cannot parse colour ${value}`);
}
function contrast(fg, bg) {
  const lum = ({ r, g, b }) => {
    const c = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  };
  const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

await check("the active range preset reaches 3:1 on light and dark themes and the brush follows the theme", () => {
  for (const theme of ["light", "dark"]) {
    const definition = defineChart({
      marks: [line(revenue, { x: "t", y: "v", name: "Revenue" })],
      scales: { x: { type: "time" } },
      legend: false,
      theme,
    });
    const fixture = mountFixture(definition, { width: 480, height: 280, interaction: { rangePresets: true } });
    const scene = fixture.handle.getScene();
    const all = [...fixture.el.presetsBar.querySelectorAll("button")].find((button) => button.textContent === "ALL");
    assert.equal(all.getAttribute("aria-pressed"), "true", `${theme}: ALL is pressed`);
    const indicator = /inset 0(?:px)? -2px 0(?:px)? (.+)$/.exec(all.style.boxShadow)?.[1];
    assert(indicator, `${theme}: the active preset has an indicator bar (${all.style.boxShadow})`);
    const ratio = contrast(parseColor(indicator), parseColor(scene.theme.background));
    assert(ratio >= 3, `${theme}: indicator contrast ${ratio.toFixed(2)} >= 3`);
    assert.doesNotMatch(all.style.background, /255,\s*255,\s*255,\s*0\.1/, `${theme}: no white-on-white fallback`);
    const other = [...fixture.el.presetsBar.querySelectorAll("button")].find((button) => button.textContent === "1W");
    assert.equal(other.getAttribute("aria-pressed"), "false");
    fixture.fire("pointerdown", { clientX: 100, clientY: 100, shiftKey: true });
    fixture.fire("pointermove", { clientX: 200, clientY: 100, shiftKey: true });
    const accent = parseColor(scene.theme.accent);
    const brush = parseColor(fixture.el.brushRect.style.background);
    assert.deepEqual([brush.r, brush.g, brush.b], [accent.r, accent.g, accent.b], `${theme}: the brush uses the theme accent`);
    assert(Math.abs(px(fixture.el.brushRect.style.top) - scene.plot.y) < 1e-6, `${theme}: the brush spans the plot`);
    fixture.fire("pointercancel");
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// rAF coalescing and the cached navigator scene

await check("50 wheel events in one tick produce one paint with the compounded zoom", () => {
  const dense = Array.from({ length: 10_000 }, (_, i) => ({ x: i, y: Math.sin(i / 50) }));
  let specCalls = 0;
  const definition = defineChart(() => {
    specCalls++;
    return { marks: [line(dense, { x: "x", y: "y", name: "Dense" })], legend: false };
  });
  const viewports = [];
  const fixture = mountFixture(definition, { width: 480, height: 280, renderer: "canvas", onViewportChange: (v) => viewports.push(v) });
  const scene = fixture.handle.getScene();
  const [lo, hi] = scene.xScale.domain;
  const clientX = scene.plot.x + scene.plot.w * 0.25;
  const paintsBefore = canvasPaints;
  const specBefore = specCalls;
  const durations = [];
  for (let i = 0; i < 50; i++) {
    const started = performance.now();
    fixture.fire("wheel", { clientX, clientY: 140, deltaY: -100 });
    durations.push(performance.now() - started);
  }
  assert.equal(canvasPaints, paintsBefore, "no paint happens inside the event handlers");
  assert.equal(viewports.length, 0, "onViewportChange waits for the frame");
  durations.sort((a, b) => a - b);
  assert(durations[25] < 1, `the wheel handler returns in under 1ms (median ${durations[25].toFixed(3)}ms)`);
  flushFrames();
  assert.equal(canvasPaints - paintsBefore, 1, "exactly one paint per frame");
  assert.equal(specCalls - specBefore, 1, "exactly one compile per frame");
  assert.equal(viewports.length, 1, "one committed viewport per frame");
  const factor = 1 / 1.12;
  const expectedSpan = (hi - lo) * factor ** 50;
  const expectedLo = lo + 0.25 * ((hi - lo) - expectedSpan);
  const [gotLo, gotHi] = fixture.handle.getViewport().x.map(Number);
  assert(Math.abs(gotHi - gotLo - expectedSpan) / expectedSpan < 1e-9, "the span equals the compounded factor");
  assert(Math.abs(gotLo - expectedLo) / (hi - lo) < 1e-9, "the zoom stays anchored under the pointer");
  fixture.cleanup();
});

await check("with the navigator on, the full-data scene compiles once per definition and size", () => {
  let specCalls = 0;
  const makeDefinition = () => defineChart(() => {
    specCalls++;
    return { marks: [line(hundred, { x: "x", y: "y", name: "Wave" })], legend: false };
  });
  const definition = makeDefinition();
  const fixture = mountFixture(definition, { width: 480, height: 280, interaction: { navigator: true } });
  fixture.handle.setViewport({ x: [10, 60] });
  const settled = specCalls;
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 10; i++) fixture.fire("wheel", { clientX: 240, clientY: 140, deltaY: -40 });
    flushFrames();
  }
  assert.equal(specCalls - settled, 3, "each frame compiles only the visible window");
  fixture.handle.update(makeDefinition());
  assert.equal(specCalls - settled, 5, "a new definition recompiles the window and the full scene once");
  fixture.cleanup();
});

await check("ResizeObserver bursts repaint once per frame", () => {
  let width = 500;
  const fixture = mountFixture(revenueDefinition, { renderer: "canvas" });
  Object.defineProperty(fixture.wrap, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(fixture.wrap, "clientHeight", { configurable: true, get: () => 300 });
  const observer = observers.at(-1);
  const paintsBefore = canvasPaints;
  width = 520;
  for (let i = 0; i < 5; i++) observer.trigger();
  assert.equal(canvasPaints, paintsBefore, "resize callbacks do not paint synchronously");
  flushFrames();
  assert.equal(canvasPaints - paintsBefore, 1, "one paint for the burst");
  assert.equal(fixture.handle.getScene().width, 520, "the paint uses the settled size");
  observer.trigger();
  flushFrames();
  assert.equal(canvasPaints - paintsBefore, 1, "an unchanged size does not repaint");
  fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Lifecycle (W1A-08 follow-up)

await check("destroy releases every listener, observer, and pending frame", () => {
  const globals = globalListeners();
  const fixture = mountFixture(revenueDefinition, {
    renderer: "canvas",
    interaction: { rangePresets: true, navigator: true, brush: true, zoom: true, pan: true },
  });
  const observer = observers.at(-1);
  assert(listenersWithin(fixture.wrap) > 0, "the mount listens while alive");
  fixture.fire("wheel", { clientX: 240, clientY: 140, deltaY: -100 });
  fixture.fire("pointerdown", { clientX: 240, clientY: 140 });
  fixture.fire("pointermove", { clientX: 200, clientY: 140 });
  observer.trigger();
  assert(frames.size > 0, "wheel, pan, and resize frames are pending");
  const wrap = fixture.wrap;
  fixture.cleanup();
  assert.equal(frames.size, 0, "destroy cancels every pending frame");
  assert.equal(listenersWithin(wrap), 0, "destroy removes every listener it added, including the preset buttons'");
  assert.equal(globalListeners(), globals, "no window or document listener is left behind");
  assert.equal(observer.disconnected, true, "destroy disconnects the ResizeObserver");
  assert.equal(fixture.host.childElementCount, 0, "destroy removes the mounted DOM");
  assert.throws(() => fixture.handle.setViewport({ x: [0, 1] }), /destroyed/, "a destroyed mount rejects setViewport");
  fixture.handle.destroy();
});

await check("a failed update leaves listeners, frames, DOM, and scene untouched", () => {
  const fixture = mountFixture(revenueDefinition, { width: 480, height: 280, interaction: { rangePresets: true } });
  const listeners = listenersWithin(fixture.wrap);
  const markup = fixture.wrap.outerHTML;
  const scene = fixture.handle.getScene();
  const pendingFrames = frames.size;
  assert.throws(() => fixture.handle.update(defineChart(() => { throw new Error("broken update"); })), /broken update/);
  assert.throws(() => fixture.handle.update(revenueDefinition, { interaction: { rangePresets: false, zoom: { minSpan: 0 } } }), /minSpan/);
  assert.equal(listenersWithin(fixture.wrap), listeners, "no listener is added or lost");
  assert.equal(frames.size, pendingFrames, "no frame is scheduled");
  assert.equal(fixture.wrap.outerHTML, markup, "the DOM is unchanged");
  assert.equal(fixture.handle.getScene(), scene, "the last good scene is kept");
  fixture.handle.update(revenueDefinition, { width: 500 });
  assert.equal(fixture.handle.getScene().width, 500, "the mount keeps working");
  fixture.cleanup();
});

await check("a failed first paint releases everything it acquired", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const observerCount = observers.length;
  const globals = globalListeners();
  assert.throws(() => mountChart(host, defineChart(() => { throw new Error("no data"); }), { width: 320, height: 180 }), /no data/);
  assert.equal(host.childElementCount, 0, "no DOM is left behind");
  assert.equal(listenersWithin(host), 0, "no listener is left behind");
  assert.equal(globalListeners(), globals, "no window or document listener is left behind");
  assert.equal(frames.size, 0, "no frame is left behind");
  for (const observer of observers.slice(observerCount)) assert.equal(observer.disconnected, true, "the observer is disconnected");
  host.remove();
});

dom.window.close();
if (failures) {
  console.error(`NATIVE MOUNT: ${failures} FAILED`);
  process.exit(1);
}
console.log("NATIVE MOUNT: PASS");
