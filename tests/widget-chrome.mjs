// Widget chrome regressions (W1B-13): TradingView-shaped timeframe objects,
// width/height/autosize/fullscreen sizing, the canonical `timeframes_toolbar`
// featureset, interval sync across multi-chart layouts, the go-to-date
// popover that replaces window.prompt, and load() through the seam setters.
// Run after the build: node build.mjs && node tests/widget-chrome.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const assert = (condition, message) => {
  if (!condition) {
    failures += 1;
    console.error(`✗ ${message}`);
    return;
  }
  console.log(`✓ ${message}`);
};

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  KeyboardEvent: window.KeyboardEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
});
window.devicePixelRatio = 1;
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
for (const [key, value] of [["clientWidth", 640], ["clientHeight", 360]]) {
  Object.defineProperty(window.HTMLElement.prototype, key, { configurable: true, get: () => value });
}
class TestResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([]); }
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver;
window.ResizeObserver = TestResizeObserver;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
// Any prompt() call is a regression: sandboxed embeds ignore it.
let promptCalls = 0;
window.prompt = () => {
  promptCalls += 1;
  return null;
};

const warnings = [];
const errors = [];
const originalWarn = console.warn;
const originalError = console.error;
console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
console.error = (...args) => {
  const text = args.map(String).join(" ");
  if (text.startsWith("✗")) originalError(...args);
  else errors.push(text);
};

const { resolveTimeframe, widget } = await import("../dist/charting_library.esm.js");

const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));
async function until(predicate, label, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true;
    await tick();
  }
  assert(false, `timed out waiting for ${label}`);
  return false;
}

// ── Datafeed: a continuous series per resolution ────────────────────────────

const END_SEC = 1_700_000_040; // a whole minute
const STEP_SEC = { 1: 60, 5: 300, 15: 900 };
const SERIES_BARS = 4000;
function seriesFor(resolution) {
  const step = STEP_SEC[resolution] ?? 60;
  const bars = [];
  for (let i = SERIES_BARS - 1; i >= 0; i--) {
    const time = (END_SEC - i * step) * 1000;
    const base = 100 + Math.sin(i / 25) * 5;
    bars.push({ time, open: base, high: base + 1, low: base - 1, close: base + 0.5, volume: 10 });
  }
  return bars;
}
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
function makeFeed(log = []) {
  return {
    onReady(callback) { queueMicrotask(() => callback({ supported_resolutions: ["1", "5", "15"] })); },
    searchSymbols(_input, _exchange, _type, callback) { callback([]); },
    resolveSymbol(name, onResolve) { queueMicrotask(() => onResolve(symbolInfo(name))); },
    getBars(_info, resolution, params, onResult) {
      log.push({ resolution: String(resolution), ...params });
      const all = seriesFor(String(resolution));
      const inWindow = all.filter((bar) => bar.time <= params.to * 1000);
      const bars = params.firstDataRequest
        ? inWindow.slice(-Math.min(params.countBack || 1500, 1500))
        : inWindow.filter((bar) => bar.time >= params.from * 1000);
      queueMicrotask(() => onResult(bars, { noData: bars.length === 0 }));
    },
    subscribeBars() {},
    unsubscribeBars() {},
  };
}

function host() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return element;
}
const CHROMELESS = ["header_widget", "left_toolbar", "scale_bar"];

// ── resolveTimeframe: every TradingView shape, never throws ─────────────────
{
  const from = 1_700_000_000;
  const to = 1_700_086_400;
  const same = (value, label) => {
    const result = resolveTimeframe(value, to);
    assert(result?.from === from && result?.to === to && !result.all, label);
  };
  same({ from, to }, "resolveTimeframe accepts TradingView's { from, to }");
  same({ type: "time-range", from, to }, "resolveTimeframe accepts { type: 'time-range', from, to }");
  same({ type: "time-range", value: `${from},${to}` }, "resolveTimeframe keeps the legacy { type, value: 'from,to' } shape");
  same(`${from},${to}`, "resolveTimeframe accepts a comma-separated range string");
  same({ from: to, to: from }, "an inverted { from, to } is reordered");
  const back = resolveTimeframe({ type: "period-back", value: "3M" }, to);
  assert(back && back.to === to && back.to - back.from === 90 * 86_400, "{ type: 'period-back', value: '3M' } counts back 90 days");
  assert(resolveTimeframe("ALL", to)?.all === true, "ALL resolves to the whole series");
  const malformed = [
    { value: undefined, type: "period-back" },
    { type: "period-back" },
    { type: "time-range" },
    { type: "time-range", from: "soon", to },
    { from: Number.NaN, to },
    { type: "bogus", value: "3M" },
    {},
    [],
    42,
    true,
    "",
    "0D",
    "banana",
    "1,2,3",
  ];
  let threw = false;
  let allNull = true;
  for (const value of malformed) {
    try {
      if (resolveTimeframe(value, to) !== null) allNull = false;
    } catch {
      threw = true;
    }
  }
  assert(!threw && allNull, "resolveTimeframe returns null instead of throwing for malformed input");
}

// ── timeframe {from, to} loads without the error overlay ────────────────────
{
  const from = END_SEC - 300 * 60 + 17; // between bars: nearest is END - 300 min
  const to = END_SEC - 100 * 60 - 20; // nearest is END - 100 min
  errors.length = 0;
  const element = host();
  const chart = new widget({
    symbol: "RANGE",
    interval: "1",
    container: element,
    datafeed: makeFeed(),
    timeframe: { from, to },
    disabled_features: CHROMELESS,
  });
  await chart.headerReady();
  const message = element.querySelector(".raze-chart-loading-message");
  const errorShown = !!message && message.style.display !== "none" && /could not be loaded/.test(message.textContent ?? "");
  assert(!errorShown, "timeframe { from, to } loads without the error overlay");
  assert(!errors.some((text) => /failed to load symbol/.test(text)), "timeframe { from, to } does not report a failed load");
  const visible = chart.activeChart().getVisibleRange();
  assert(
    visible.from === END_SEC - 300 * 60 && visible.to === END_SEC - 100 * 60,
    `getVisibleRange() matches from/to to the nearest bar (got ${visible.from}..${visible.to})`,
  );
  chart.remove();
}
{
  const element = host();
  const chart = new widget({
    symbol: "PERIOD",
    interval: "1",
    container: element,
    datafeed: makeFeed(),
    timeframe: { type: "time-range", from: END_SEC - 50 * 60, to: END_SEC - 10 * 60 },
    disabled_features: CHROMELESS,
  });
  await chart.headerReady();
  const visible = chart.activeChart().getVisibleRange();
  assert(visible.from === END_SEC - 50 * 60 && visible.to === END_SEC - 10 * 60, "{ type: 'time-range', from, to } sets the initial window");
  chart.remove();
}
{
  warnings.length = 0;
  errors.length = 0;
  const element = host();
  const chart = new widget({
    symbol: "BAD",
    interval: "1",
    container: element,
    datafeed: makeFeed(),
    timeframe: { type: "period-back" },
    disabled_features: CHROMELESS,
  });
  await chart.headerReady();
  const message = element.querySelector(".raze-chart-loading-message");
  assert(
    !(message && message.style.display !== "none" && /could not be loaded/.test(message.textContent ?? "")),
    "a malformed timeframe never marks the load as failed",
  );
  assert(warnings.some((text) => /timeframe .* is not supported; the default range is used/.test(text)), "a malformed timeframe warns with the supported shapes");
  assert(chart.activeChart().getVisibleRange().to === END_SEC, "a malformed timeframe keeps the default view on the latest bar");
  chart.remove();
}
{
  // A timeframe whose history page fails keeps the committed bars usable.
  errors.length = 0;
  const feed = makeFeed();
  const getBars = feed.getBars;
  feed.getBars = (info, resolution, params, onResult, onError) => {
    if (!params.firstDataRequest) {
      queueMicrotask(() => onError("history offline"));
      return;
    }
    getBars(info, resolution, params, onResult, onError);
  };
  const element = host();
  const chart = new widget({
    symbol: "PAGEFAIL",
    interval: "1",
    container: element,
    datafeed: feed,
    timeframe: { from: END_SEC - 3000 * 60, to: END_SEC },
    disabled_features: CHROMELESS,
  });
  await chart.headerReady();
  const message = element.querySelector(".raze-chart-loading-message");
  assert(
    !(message && message.style.display !== "none" && /could not be loaded/.test(message.textContent ?? "")),
    "a failure while applying the timeframe never shows the load error overlay",
  );
  assert(errors.some((text) => /configured timeframe/.test(text)), "a failure while applying the timeframe is reported");
  chart.remove();
}

// ── Size options ────────────────────────────────────────────────────────────
{
  const rootOf = (element) => element.querySelector(".raze-chart-root");
  const make = (options) => {
    const element = host();
    const chart = new widget({ symbol: "SIZE", interval: "1", container: element, datafeed: makeFeed(), disabled_features: CHROMELESS, ...options });
    return { chart, root: rootOf(element) };
  };
  let { chart, root: sized } = make({ autosize: false, width: 800, height: 450 });
  assert(sized.style.width === "800px" && sized.style.height === "450px", "autosize:false with width/height sets the root size in pixels");
  assert(sized.style.flex === "0 0 auto", "a pixel-sized root is not squeezed by a flex container");
  chart.remove();

  ({ chart, root: sized } = make({ width: 800, height: 450 }));
  assert(sized.style.width === "800px" && sized.style.height === "450px", "width/height without autosize size the root in pixels");
  chart.remove();

  ({ chart, root: sized } = make({ autosize: false }));
  assert(sized.style.width === "800px" && sized.style.height === "500px", "autosize:false without dimensions uses TradingView's 800x500");
  chart.remove();

  ({ chart, root: sized } = make({ autosize: true, width: 800, height: 450 }));
  assert(sized.style.width === "100%" && sized.style.height === "100%", "autosize:true tracks the container and ignores width/height");
  chart.remove();

  ({ chart, root: sized } = make({}));
  assert(sized.style.width === "100%" && sized.style.height === "100%" && sized.dataset.size === "auto", "the default tracks the container");
  chart.remove();

  ({ chart, root: sized } = make({ fullscreen: true, width: 800, height: 450 }));
  assert(
    sized.style.position === "fixed" && sized.style.top === "0px" && sized.style.left === "0px"
      && sized.style.right === "0px" && sized.style.bottom === "0px" && sized.dataset.size === "fullscreen",
    "fullscreen:true sizes the chart to the viewport",
  );
  chart.remove();

  warnings.length = 0;
  ({ chart, root: sized } = make({ width: "wide", height: -5 }));
  assert(sized.style.width === "100%" && sized.style.height === "100%", "invalid width/height fall back to the container size");
  assert(warnings.some((text) => /width must be a positive number/.test(text)) && warnings.some((text) => /height must be a positive number/.test(text)), "invalid width/height warn instead of failing silently");
  chart.remove();

  const element = host();
  const layout = new widget({
    symbol: "SIZE",
    interval: "1",
    container: element,
    datafeed: makeFeed(),
    disabled_features: CHROMELESS,
    autosize: false,
    width: 800,
    height: 450,
    raze: { layout: "2x1" },
  });
  await layout.headerReady();
  const roots = [...element.querySelectorAll(".raze-chart-root")];
  assert(
    roots.length === 2 && roots[0].style.width === "800px" && roots[1].style.width === "100%" && roots[1].style.height === "100%",
    "layout children fill their grid cell while the parent keeps its pixel size",
  );
  layout.remove();
}

// ── timeframes_toolbar featureset ───────────────────────────────────────────
{
  const rangeButtons = (element) => element.querySelectorAll('button[aria-label^="Range "]').length;
  const make = async (options) => {
    const element = host();
    const chart = new widget({ symbol: "TF", interval: "1", container: element, datafeed: makeFeed(), disabled_features: ["left_toolbar"], ...options });
    await chart.headerReady();
    return { chart, element };
  };
  let { chart, element } = await make({});
  assert(rangeButtons(element) === 6, "the range bar renders by default");
  chart.remove();

  ({ chart, element } = await make({ disabled_features: ["left_toolbar", "timeframes_toolbar"] }));
  assert(rangeButtons(element) === 0 && !element.querySelector('button[aria-label="Go to date"]'), "disabled_features ['timeframes_toolbar'] renders no range buttons");
  chart.remove();

  warnings.length = 0;
  ({ chart, element } = await make({ disabled_features: ["left_toolbar", "time_frames_toolbar"] }));
  assert(rangeButtons(element) === 0, "the deprecated 'time_frames_toolbar' alias still disables the range bar");
  assert(!warnings.some((text) => /time_frames_toolbar/.test(text)), "the deprecated alias is quiet outside debug mode");
  chart.remove();

  ({ chart, element } = await make({ debug: true, disabled_features: ["left_toolbar", "time_frames_toolbar"] }));
  assert(warnings.some((text) => /"time_frames_toolbar" is deprecated; use "timeframes_toolbar"/.test(text)), "the deprecated alias warns in debug mode");
  chart.remove();
}

// ── Layout interval sync ────────────────────────────────────────────────────
{
  const element = host();
  const chart = new widget({
    symbol: "SYNC",
    interval: "1",
    container: element,
    datafeed: makeFeed(),
    disabled_features: ["left_toolbar"],
    raze: { layout: "2x2" },
  });
  await chart.headerReady();
  const panes = [0, 1, 2, 3].map((index) => chart.chart(index));
  await until(() => panes.every((pane) => pane.resolution() === "1"), "every layout pane to load");
  const fired = [0, 0, 0, 0];
  panes.forEach((pane, index) => pane.onIntervalChanged().subscribe(null, () => { fired[index] += 1; }));

  chart.activeChart().setResolution("5");
  await until(() => panes.every((pane) => pane.resolution() === "5"), "all panes to reach 5");
  assert(panes.map((pane) => pane.resolution()).join(",") === "5,5,5,5", "activeChart().setResolution updates all 4 panes");
  assert(fired.every((count) => count === 1), `onIntervalChanged fires once per pane (${fired.join(",")})`);

  panes[2].setResolution("15");
  await until(() => panes.every((pane) => pane.resolution() === "15"), "all panes to reach 15");
  assert(panes.map((pane) => pane.resolution()).join(",") === "15,15,15,15", "setResolution on a child pane updates every pane");

  const headerFive = element.querySelector('button[aria-label="Interval 5m"]');
  if (headerFive) {
    headerFive.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await until(() => panes.every((pane) => pane.resolution() === "5"), "the header change to reach every pane");
    assert(panes.every((pane) => pane.resolution() === "5"), "the header interval control updates every pane");
  }
  await tick();
  const settled = fired.slice();
  for (let i = 0; i < 10; i++) await tick();
  assert(settled.join(",") === fired.join(","), "interval sync settles without echo loops");
  chart.remove();
}
{
  const element = host();
  const chart = new widget({
    symbol: "NOSYNC",
    interval: "1",
    container: element,
    datafeed: makeFeed(),
    disabled_features: CHROMELESS,
    raze: { layout: "2x1", layout_sync: { interval: false } },
  });
  await chart.headerReady();
  const panes = [chart.chart(0), chart.chart(1)];
  await until(() => panes.every((pane) => pane.resolution() === "1"), "both panes to load");
  chart.activeChart().setResolution("5");
  await until(() => panes[0].resolution() === "5", "the primary pane to change");
  for (let i = 0; i < 10; i++) await tick();
  assert(panes[1].resolution() === "1", "raze.layout_sync.interval=false keeps the other panes' interval");

  warnings.length = 0;
  chart.remove();
  const other = new widget({
    symbol: "TYPO",
    interval: "1",
    container: host(),
    datafeed: makeFeed(),
    disabled_features: CHROMELESS,
    raze: { layout: "2x1", layout_sync: { intervall: false } },
  });
  await other.headerReady();
  assert(warnings.some((text) => /layout_sync\.intervall is not supported/.test(text)), "unknown layout_sync keys warn with the supported list");
  other.remove();
}

// ── Go-to-date popover ──────────────────────────────────────────────────────
{
  const element = host();
  const chart = new widget({
    symbol: "GOTO",
    interval: "1",
    container: element,
    datafeed: makeFeed(),
    disabled_features: ["left_toolbar"],
    timezone: "Etc/UTC",
  });
  await chart.headerReady();
  const dateButton = element.querySelector('button[aria-label="Go to date"]');
  assert(dateButton?.getAttribute("aria-haspopup") === "dialog" && dateButton.getAttribute("aria-keyshortcuts") === "Alt+G", "the Date control advertises its dialog and Alt+G shortcut");
  const findDialog = () => [...document.querySelectorAll('[role="dialog"]')].find((node) => node.getAttribute("aria-label") === "Go to date");

  dateButton.focus();
  dateButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  let dialog = findDialog();
  assert(!!dialog && promptCalls === 0, "Date opens a themed popover instead of window.prompt");
  assert(dateButton.getAttribute("aria-expanded") === "true", "the Date control reports the popover as expanded");
  const dateInput = dialog.querySelector('input[type="date"]');
  const timeInput = dialog.querySelector('input[type="time"]');
  assert(!!dateInput && !!timeInput, "an intraday chart offers date and time inputs");
  assert(document.activeElement === dateInput, "the date input receives focus");
  assert(dateInput.labels?.[0]?.textContent === "Date" && timeInput.labels?.[0]?.textContent === "Time", "inputs are labelled");
  assert(/Time zone: (Etc\/)?UTC/.test(dialog.textContent ?? ""), "the popover names the timezone the date is read in");

  // Missing input keeps the popover open with an accessible error. (Browsers
  // sanitise an impossible date such as 2023-02-30 to "" as well.)
  dateInput.value = "";
  dateInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await tick();
  const error = dialog.querySelector('[role="alert"]');
  assert(findDialog() && error?.textContent === "Enter a date." && dateInput.getAttribute("aria-invalid") === "true", "a missing date shows an inline error");
  assert(dateInput.getAttribute("aria-describedby")?.includes(error.id), "the error is linked to the invalid input");

  // A valid date and time centres that bar, keeping the zoom level.
  const target = END_SEC - 500 * 60; // 2023-11-14 18:34 UTC
  const iso = new Date(target * 1000).toISOString();
  const span = (() => {
    const range = chart.activeChart().getVisibleRange();
    return range.to - range.from;
  })();
  dateInput.value = iso.slice(0, 10);
  timeInput.value = iso.slice(11, 16);
  dateInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await until(() => !findDialog(), "the popover to close after navigating");
  const range = chart.activeChart().getVisibleRange();
  const centre = (range.from + range.to) / 2;
  assert(Math.abs(centre - target) <= 60, `Enter navigates to the chosen date and time (centre ${centre}, target ${target})`);
  // The initial view ends in right padding that getVisibleRange() clamps away,
  // so the full window may show up to that padding more once centred.
  const shownSpan = range.to - range.from;
  assert(shownSpan >= span && shownSpan <= span + 10 * 60, `go-to-date keeps the zoom level (${span}s before, ${shownSpan}s after)`);
  assert(document.activeElement === dateButton && dateButton.getAttribute("aria-expanded") === "false", "focus returns to the Date control");

  // Escape closes; Alt+G reopens from the chart.
  dateButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  dialog = findDialog();
  dialog.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert(!findDialog() && document.activeElement === dateButton, "Escape closes the popover and restores focus");
  const canvas = element.querySelector("canvas");
  canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "g", code: "KeyG", altKey: true, bubbles: true, cancelable: true }));
  assert(!!findDialog(), "Alt+G opens go-to-date from the chart");
  dateButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert(!findDialog(), "the Date control toggles the open popover closed");

  // Cancel closes without navigating.
  const before = chart.activeChart().getVisibleRange();
  dateButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  dialog = findDialog();
  const cancel = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
  cancel.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const after = chart.activeChart().getVisibleRange();
  assert(!findDialog() && after.from === before.from && after.to === before.to, "Cancel closes without moving the chart");

  // The popover never outlives the widget.
  dateButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  chart.remove();
  assert(!findDialog(), "remove() closes an open go-to-date popover");
  assert(promptCalls === 0, "no window.prompt call happened");
}
{
  // Daily charts pick a date only.
  const element = host();
  const feed = makeFeed();
  const chart = new widget({ symbol: "DAILY", interval: "1D", container: element, datafeed: feed, disabled_features: ["left_toolbar"] });
  await chart.headerReady();
  element.querySelector('button[aria-label="Go to date"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find((node) => node.getAttribute("aria-label") === "Go to date");
  assert(!!dialog?.querySelector('input[type="date"]') && !dialog.querySelector('input[type="time"]'), "a daily chart asks for a date without a time");
  chart.remove();
}

// ── load() through the seam setters ─────────────────────────────────────────
{
  const element = host();
  const chart = new widget({ symbol: "LOAD", interval: "1", container: element, datafeed: makeFeed(), disabled_features: CHROMELESS });
  await chart.headerReady();
  const state = chart.save();
  await chart.load({ ...state, chartStyle: "line", logScale: true, percentScale: true });
  const saved = chart.save();
  assert(saved.chartStyle === "line" && saved.percentScale && !saved.logScale, "load() applies chart type and scale mode (percent wins over log)");
  let message = "";
  try {
    await chart.load({ ...state, chartStyle: "renko" });
  } catch (error) {
    message = String(error?.message ?? error);
  }
  assert(/unknown chartStyle "renko".*Supported chart types: candles/.test(message), "load() rejects an unknown chartStyle with the supported list");
  assert(chart.save().chartStyle === "line", "a rejected snapshot leaves the chart unchanged");
  chart.remove();
}

// ── No prompt() anywhere in src/core ────────────────────────────────────────
{
  const offenders = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && /\bprompt\s*\(/.test(readFileSync(path, "utf8"))) offenders.push(path);
    }
  };
  walk(join(root, "src/core"));
  assert(offenders.length === 0, `there is no prompt() in src/core${offenders.length ? ` (${offenders.join(", ")})` : ""}`);
}

console.warn = originalWarn;
console.error = originalError;
if (failures) {
  console.error(`\n${failures} widget chrome assertion(s) failed`);
  process.exit(1);
}
console.log("\nwidget chrome: all assertions passed");
process.exit(0);
