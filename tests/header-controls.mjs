// Header controls & class-based styling (W1B-22): interval list precedence
// (symbol → onReady configuration → favorites) with has_* filtering and the
// overflow menu, ScaleBar state from the scaleChanged seam, reduced-motion
// header scrolling, per-root stylesheet adoption (LoadingScreen keyframes in
// every shadow root and after a remount), and a ratchet that keeps inline
// presentation and JS hover out of the header modules.
//
// The style helpers are internal, so this test bundles the modules from
// source with esbuild (no build step needed): node tests/header-controls.mjs

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
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));

// ── DOM environment ─────────────────────────────────────────────────────────
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
let reducedMotion = false;
window.matchMedia = (query) => ({
  matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  ShadowRoot: window.ShadowRoot,
  getComputedStyle: window.getComputedStyle.bind(window),
});

// A ResizeObserver stand-in the test drives by hand.
const observers = [];
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    observers.push(this);
  }
  observe(target) { this.targets.add(target); }
  unobserve(target) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); this.disconnected = true; }
  trigger() { this.callback([...this.targets].map((target) => ({ target })), this); }
};
window.ResizeObserver = globalThis.ResizeObserver;

// ── Bundle the modules under test from source ───────────────────────────────
const entry = [
  'export { IntervalSelector, DEFAULT_INTERVAL_FAVORITES } from "./src/ui/IntervalSelector";',
  'export { ScaleBar } from "./src/ui/ScaleBar";',
  'export { Toolbar, HEADER_STYLES } from "./src/ui/Toolbar";',
  'export { TimeframeBar } from "./src/ui/TimeframeBar";',
  'export { LoadingScreen } from "./src/ui/LoadingScreen";',
  'export { adoptStyles, adoptStylesOnConnect, configureStyles, defineStyles } from "./src/ui/styles";',
  'export { createChartContext } from "./src/core/context";',
  'export { Delegate } from "./src/util/delegate";',
].join("\n");
const bundled = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts", sourcefile: "header-controls-entry.ts" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  write: false,
  logLevel: "silent",
  define: { __RAZE_CHARTS_VERSION__: JSON.stringify("test") },
});
const scratch = mkdtempSync(join(tmpdir(), "raze-header-"));
const bundlePath = join(scratch, "header.mjs");
writeFileSync(bundlePath, bundled.outputFiles[0].text);
const {
  IntervalSelector,
  ScaleBar,
  Toolbar,
  TimeframeBar,
  LoadingScreen,
  adoptStylesOnConnect,
  configureStyles,
  defineStyles,
  createChartContext,
  Delegate,
} = await import(pathToFileURL(bundlePath).href);
rmSync(scratch, { recursive: true, force: true });

// jsdom has no constructable stylesheets, so every root gets a <style>.
configureStyles({ strategy: "style-element" });

// ── Interval list: precedence, favorites order, warnings, filtering ─────────
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));

const SEVEN = ["1S", "5S", "1", "5", "15", "60", "1D"];
function mountIntervals({ symbolInfo = null, favorites, configuration, resolution = "1" } = {}) {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const selected = [];
  const selector = new IntervalSelector(
    { resolution, fontFamily: "sans-serif", symbol: "TEST", symbolInfo },
    mount,
    (res) => selected.push(res),
    favorites,
    configuration,
  );
  const labels = () => [...mount.querySelectorAll('[aria-label^="Interval "]')].map((b) => b.textContent);
  const pressed = () => [...mount.querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent);
  const more = () => mount.querySelector('[aria-label="More intervals"]');
  return { mount, selector, selected, labels, pressed, more };
}

{
  const view = mountIntervals({
    symbolInfo: { name: "TEST", has_seconds: true, supported_resolutions: SEVEN },
    favorites: ["1", "5", "15"],
  });
  assert(view.labels().join(",") === "1m,5m,15m", "favorites [1,5,15] with seven supported resolutions render exactly three buttons");
  assert(view.pressed().join(",") === "1m", "the active interval is the only pressed button");
  assert(view.more()?.getAttribute("aria-haspopup") === "menu", "the other resolutions sit behind a More intervals menu button");
  assert(view.more()?.textContent === "" && view.more()?.getAttribute("aria-label") === "More intervals", "the overflow chevron is CSS-drawn; the button is named");
  assert(
    [...view.mount.querySelectorAll("button")].every((b) => b.className.includes("raze-chart-header-btn") && !b.getAttribute("style")),
    "interval buttons are class-styled with no inline style",
  );
  view.more().click();
  const rows = [...document.querySelectorAll('.raze-chart-interval-menu [role="menuitemradio"]')];
  assert(rows.map((row) => row.textContent).join(",") === "1s,5s,1m,5m,15m,1h,1D", "the menu lists every supported interval by duration");
  assert(rows.find((row) => row.getAttribute("aria-checked") === "true")?.textContent === "1m", "the menu checks the active interval");
  rows[5].click();
  assert(view.selected.join(",") === "60", "choosing a menu row selects that resolution");
  assert(view.labels().join(",") === "1m,5m,15m,1h" && view.pressed().join(",") === "1h", "a non-favorite active interval gets its own pressed button");
  view.selector.setActive("5");
  assert(view.labels().join(",") === "1m,5m,15m" && view.pressed().join(",") === "5m", "returning to a favorite drops the temporary button");
  assert(warnings.length === 0, "supported favorites do not warn");
  view.selector.destroy();
  view.mount.remove();
}

{
  const view = mountIntervals({
    symbolInfo: { name: "TEST", has_seconds: true, supported_resolutions: SEVEN },
    favorites: ["15", "1", "240", "5", "1"],
  });
  assert(view.labels().join(",") === "15m,1m,5m", "buttons follow favorites order; duplicates collapse");
  assert(
    warnings.length === 1 && warnings[0].includes('"240"') && warnings[0].includes("TEST"),
    "an unsupported favorite is dropped with one console warning naming it",
  );
  view.selector.refresh();
  assert(warnings.length === 1, "the warning is not repeated on re-render");
  view.selector.destroy();
  view.mount.remove();
  warnings.length = 0;
}

{
  // TradingView allows resolutions declared only in onReady.
  const view = mountIntervals({
    symbolInfo: { name: "TEST", has_intraday: true },
    configuration: () => ({ supported_resolutions: ["5", "15"] }),
    resolution: "5",
  });
  assert(view.labels().join(",") === "5m,15m", "configuration.supported_resolutions applies when the symbol declares none (exactly 5m and 15m)");
  assert(view.more() === null, "no overflow menu when every resolution is a button");
  view.selector.destroy();
  view.mount.remove();
}

{
  const view = mountIntervals({
    symbolInfo: { name: "TEST", supported_resolutions: ["1", "D"] },
    configuration: { supported_resolutions: ["5", "15", "60"] },
    favorites: ["1", "1D"],
  });
  assert(view.labels().join(",") === "1m,1D", "symbol resolutions win over the configuration; D equals 1D");
  view.selector.destroy();
  view.mount.remove();
}

{
  const view = mountIntervals({ symbolInfo: { name: "TEST" } });
  assert(!view.labels().includes("1s"), "default favorites do not invent seconds for a symbol without has_seconds");
  assert(view.labels().join(",") === "1m,5m,15m,1h,4h,1D", "without declared resolutions the default favorites are shown");
  view.selector.destroy();
  view.mount.remove();
}

{
  const noSeconds = mountIntervals({
    symbolInfo: { name: "TEST", has_seconds: false, supported_resolutions: SEVEN },
    favorites: ["1S", "1", "5"],
  });
  assert(noSeconds.labels().join(",") === "1m,5m", "has_seconds: false removes seconds even when listed");
  assert(warnings.some((warning) => warning.includes('"1S"')), "the removed seconds favorite is reported");
  noSeconds.selector.destroy();
  noSeconds.mount.remove();
  warnings.length = 0;
  const daily = mountIntervals({
    symbolInfo: { name: "TEST", has_intraday: false, supported_resolutions: SEVEN },
    resolution: "1D",
  });
  assert(daily.labels().join(",") === "1D", "has_intraday: false removes intraday resolutions");
  assert(daily.more() === null, "nothing intraday is left for the menu");
  daily.selector.destroy();
  daily.mount.remove();
}

{
  const view = mountIntervals({
    symbolInfo: { name: "TEST", supported_resolutions: ["1", "bogus", "5", ""] },
    favorites: ["1", "5"],
  });
  assert(view.labels().join(",") === "1m,5m", "malformed resolutions are ignored instead of breaking the row");
  view.selector.destroy();
  view.mount.remove();
}
console.warn = originalWarn;

// ── Range presets: toggles vs the go-to-date action ─────────────────────────
{
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const presets = [];
  let dates = 0;
  const bar = new TimeframeBar({ fontFamily: "sans-serif" }, mount, (preset) => presets.push(preset), () => { dates += 1; });
  const buttons = [...mount.querySelectorAll("button")];
  const date = buttons.at(-1);
  assert(date.getAttribute("aria-label") === "Go to date" && !date.hasAttribute("aria-pressed"), "Go to date is the last button and an action, not a toggle");
  buttons[0].click();
  assert(presets.length === 1 && buttons[0].getAttribute("aria-pressed") === "true", "a preset click marks it pressed");
  date.click();
  assert(dates === 1 && !date.hasAttribute("aria-pressed"), "the date action never gains a pressed state");
  bar.setActive(null);
  assert(buttons.every((button) => button.getAttribute("aria-pressed") !== "true"), "setActive(null) clears the presets");
  bar.destroy();
  mount.remove();
}

// ── ScaleBar follows the scaleChanged seam ──────────────────────────────────
function makeContext() {
  return createChartContext({
    options: {},
    datafeed: {},
    locale: "en",
    fontFamily: "sans-serif",
    symbol: "TEST",
    resolution: "1",
    symbolInfo: null,
    theme: { scaleBackground: "#101010", scaleText: "#a0a0a0" },
    features: new Set(),
    formatPrice: String,
    bars: [],
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
  });
}

{
  const context = makeContext();
  const reasons = [];
  context.scaleChanged.subscribe(null, (change) => reasons.push(change.reason));
  const chrome = document.createElement("div");
  chrome.className = "raze-chart-root";
  document.body.appendChild(chrome);
  let changes = 0;
  const bar = new ScaleBar(context, () => { changes += 1; });
  chrome.appendChild(bar.el);
  await tick();
  const button = (name) => bar.el.querySelector(`[aria-label^="${name}"]`);
  const state = () => ["Percent", "Logarithmic", "Auto"].map((name) => button(name).getAttribute("aria-pressed")).join(",");
  assert(state() === "false,false,true", "initial state: auto on");
  assert(!button("Percent").hasAttribute("title"), "toggles use kit tooltips instead of title attributes");
  assert(bar.el.style.getPropertyValue("--raze-scale-bar-background") === "#101010", "the bar takes the axis background from the theme");

  button("Logarithmic").click();
  assert(context.logScale && reasons.at(-1) === "scale-bar" && changes === 1, "a toggle writes through setScaleMode with the scale-bar reason");
  assert(state() === "false,true,true", "log pressed after its click");
  button("Percent").click();
  assert(context.percentScale && !context.logScale && state() === "true,false,true", "percent and log are exclusive");

  context.setScaleMode({ priceRange: { min: 1, max: 2 } }, "axis-drag");
  assert(state() === "true,false,false", "an axis drag releases auto");
  context.setScaleMode({ autoScale: true }, "axis-reset");
  assert(state() === "true,false,true", "a double-click reset presses auto again");
  context.setScaleMode({ mode: "log" }, "load");
  assert(state() === "false,true,true", "load() (setScaleMode 'load') updates the pressed state");
  context.setScaleMode({ mode: "normal" }, "api");
  assert(state() === "false,false,true", "API calls update the pressed state");

  // A legacy writer that still assigns the fields directly is reconciled
  // after the next chart interaction or data change.
  context.autoScalePrice = false;
  context.priceRange = { min: 3, max: 4 };
  chrome.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
  await tick();
  assert(state() === "false,false,false", "direct writes are reconciled after an interaction");
  context.percentScale = true;
  context.dataChanged.fire();
  await tick();
  assert(state() === "true,false,false", "direct writes are reconciled after a data change");

  bar.destroy();
  assert(!bar.el.isConnected, "destroy removes the bar");
  context.setScaleMode({ mode: "log" }, "api");
  assert(button("Logarithmic").getAttribute("aria-pressed") === "false", "a destroyed bar no longer listens");
  chrome.remove();
}

// ── Reduced motion: header reveal scrolls instantly ─────────────────────────
{
  const toolbar = new Toolbar({ fontFamily: "sans-serif" });
  document.body.appendChild(toolbar.el);
  const button = toolbar.createButton({ title: "Action" });
  const behaviours = [];
  button.scrollIntoView = (options) => behaviours.push(options.behavior);
  button.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  reducedMotion = true;
  button.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  reducedMotion = false;
  assert(behaviours.join(",") === "smooth,auto", "revealing a focused header control is smooth, or instant under reduced motion");
  assert(button.className.includes("raze-chart-toolbar-btn") && !button.getAttribute("style"), "createButton carries its reset as a class, not inline style");
  const plain = toolbar.createButton({ useTradingViewStyle: false });
  assert(!plain.className.includes("raze-chart-header-btn"), "useTradingViewStyle: false returns only the neutral reset");
  const css = [...document.querySelectorAll("style[data-raze-styles]")].map((style) => style.textContent).join("\n");
  const reset = css.match(/:where\(\.raze-chart-toolbar-btn\)\{([^}]*)\}/)?.[1] ?? "";
  assert(
    ["appearance:none", "background:none", "border:0", "font:inherit", "color:inherit"].every((rule) => reset.includes(rule)),
    "the button reset lives in the adopted stylesheet",
  );
  assert(css.includes("@media (pointer:coarse)") && css.includes("@media (hover:hover)"), "touch sizing and hover come from media queries");
  toolbar.destroy();
}

// ── Stylesheets follow the element into every root ─────────────────────────
function keyframesIn(rootNode) {
  return [...rootNode.querySelectorAll("style[data-raze-styles]")].some((style) => style.textContent.includes("@keyframes raze-chart-spin"));
}

{
  // A web component that builds the chart before its host is attached.
  const hostA = document.createElement("div");
  const shadowA = hostA.attachShadow({ mode: "open" });
  const screenA = new LoadingScreen(undefined, "#000");
  shadowA.appendChild(screenA.el);
  await tick();
  assert(keyframesIn(shadowA), "keyframes reach a shadow root whose host is not attached yet");

  // A second widget in another shadow root, mounted after a delay.
  const hostB = document.createElement("div");
  document.body.appendChild(hostB);
  const shadowB = hostB.attachShadow({ mode: "open" });
  const screenB = new LoadingScreen(undefined, "#000");
  await tick();
  shadowB.appendChild(screenB.el);
  assert(!keyframesIn(shadowB), "(precondition) appended after construction");
  for (const observer of observers) observer.trigger();
  assert(keyframesIn(shadowB), "keyframes reach a second shadow root joined after construction");

  // Remount into a third root, then show a message.
  const hostC = document.createElement("div");
  document.body.appendChild(hostC);
  const shadowC = hostC.attachShadow({ mode: "open" });
  screenB.el.remove();
  shadowC.appendChild(screenB.el);
  screenB.showEmpty();
  assert(keyframesIn(shadowC), "a remounted screen adopts its keyframes in the new root");
  screenA.destroy();
  screenB.destroy();
  hostB.remove();
  hostC.remove();
}

{
  const chunk = defineStyles("w1b22-probe", ".probe{color:inherit}");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const el = document.createElement("div");
  const stop = adoptStylesOnConnect(el, chunk);
  shadow.appendChild(el);
  stop();
  for (const observer of observers) observer.trigger();
  const probed = [...shadow.querySelectorAll("style[data-raze-styles]")].some((style) => style.textContent.includes(".probe"));
  assert(!probed, "a stopped watcher adopts nothing further");
  host.remove();
}

// ── Ratchet: header modules carry no inline presentation or JS hover ───────
for (const file of ["Toolbar", "IntervalSelector", "TimeframeBar", "SymbolSearch", "ScaleBar"]) {
  const source = readFileSync(join(root, "src", "ui", `${file}.ts`), "utf8");
  assert(!/mouseenter|mouseleave/.test(source), `${file}.ts has no mouseenter/mouseleave listeners`);
  assert(!/\.style\.cssText\s*=|\.style\.(background|color|fontWeight|fontSize|fontFamily|height|padding)\s*=/.test(source), `${file}.ts sets no inline presentation`);
  assert(!/isCoarsePointer/.test(source), `${file}.ts sizes touch targets with @media (pointer: coarse), not a one-off check`);
}

console.log(`HEADER CONTROLS: PASS (${passed} assertions)`);
