// React adapter update discipline (W1B-24):
// - inline callback / interaction / viewport literals never recompile,
// - a real update is one compile; a controlled viewport keeps the mount's
//   full-data cache, so a resize does not rebuild it,
// - Recharts-shaped JSX memoizes on structure, not on children identity,
// - viewportGroup / syncId synchronize charts and leave on unmount,
// - ResponsiveContainer accepts wrapper components and render functions.
// Run: node tests/react-rerender.mjs (after a build).

import { JSDOM } from "jsdom";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  Chart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  createViewportGroup,
  defineChart,
  line,
} from "../dist/react.esm.js";

let passed = 0;
const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.PointerEvent = dom.window.PointerEvent ?? dom.window.MouseEvent;
globalThis.MutationObserver = dom.window.MutationObserver;
// The navigator paints a Canvas sparkline; jsdom has no 2D context, so record nothing.
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return new Proxy({}, { get: () => () => ({ addColorStop() {} }), set: () => true });
};
const resizeObservers = [];
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    resizeObservers.push(this);
  }
  observe(target) { this.target = target; this.observing = true; }
  disconnect() { this.observing = false; }
  emit(width, height) { this.callback([{ target: this.target, contentRect: { width, height } }], this); }
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    return this.state.error
      ? createElement("div", { "data-test-error": "" }, this.state.error.message)
      : this.props.children;
  }
}

/** Mount a fresh React root; returns helpers bound to it. */
function scene() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    render: (element) => act(async () => { root.render(element); }),
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

/** Give a mounted chart a real-looking box so wheel zoom has geometry. */
function sizeWrap(container, width, height) {
  const wrap = container.querySelector("[data-raze-chart-host]")?.firstElementChild;
  wrap.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {},
  });
  return wrap;
}

function wheel(wrap, x, y) {
  wrap.dispatchEvent(new window.WheelEvent("wheel", {
    bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: -1,
  }));
}

/** MutationObserver whose records are kept until takeRecords(), even after delivery. */
function recorder() {
  const seen = [];
  const observer = new MutationObserver((records) => seen.push(...records));
  return {
    observe: (target, options) => observer.observe(target, options),
    takeRecords: () => seen.splice(0).concat(observer.takeRecords()),
    disconnect: () => observer.disconnect(),
  };
}

async function withSilencedErrors(body) {
  const original = console.error;
  console.error = () => {};
  try {
    await body();
  } finally {
    console.error = original;
  }
}

// ── 1. Inline callbacks, interaction and viewport literals ─────────────────

{
  let compiles = 0;
  const definition = defineChart(() => {
    compiles += 1;
    return {
      marks: [line([{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 4 }], { x: "x", y: "y" })],
    };
  });
  const calls = [];
  const view = scene();
  const renderWith = (generation) => view.render(createElement(Chart, {
    definition,
    width: 320,
    height: 180,
    onSelect: () => calls.push(`select:${generation}`),
    onViewportChange: () => calls.push(`viewport:${generation}`),
    interaction: { zoom: true },
  }));
  await renderWith(0);
  const afterMount = compiles;
  const host = view.container.querySelector("[data-raze-chart-host]");
  const observer = recorder();
  observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
  for (let generation = 1; generation <= 5; generation += 1) await renderWith(generation);
  assert(compiles === afterMount, "5 re-renders with inline onSelect/onViewportChange/interaction literals add 0 compiles");
  assert(observer.takeRecords().length === 0, "those re-renders cause 0 DOM mutations in the chart host");
  const wrap = sizeWrap(view.container, 320, 180);
  wheel(wrap, 160, 80);
  assert(calls.at(-1) === "viewport:5", "the latest onViewportChange runs after inline re-renders");
  wrap.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, clientX: 160, clientY: 80 }));
  assert(calls.at(-1) === "select:5", "the latest onSelect runs after inline re-renders");
  assert(!calls.some((call) => /:(0|1|2|3|4)$/.test(call)), "superseded callbacks are never invoked");

  // The wheel above zoomed this uncontrolled mount. An update() without a
  // viewport may carry rows mutated in place, so the mount bumps its content
  // revision and compiles twice: the zoomed scene, plus the full-data scene
  // behind the zoom limits. Anything more is a regression.
  const beforeInteractionChange = compiles;
  await view.render(createElement(Chart, { definition, width: 320, height: 180, interaction: { zoom: false } }));
  assert(
    compiles === beforeInteractionChange + 2,
    "a real interaction change on a zoomed mount costs exactly the zoomed scene plus one full-data rebuild",
  );
  observer.disconnect();
  await view.unmount();
}

{
  let compiles = 0;
  const definition = defineChart(() => {
    compiles += 1;
    return { marks: [line([{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }], { x: "x", y: "y" })] };
  });
  const view = scene();
  const renderWith = (zoom) => view.render(createElement(Chart, { definition, width: 320, height: 180, interaction: { zoom } }));
  await renderWith(true);
  const afterMount = compiles;
  await renderWith(false);
  assert(compiles === afterMount + 1, "a real interaction change reaches an unzoomed mount exactly once");
  await renderWith(false);
  assert(compiles === afterMount + 1, "an equal interaction literal after the change adds 0 compiles");
  await view.unmount();
}

{
  let compiles = 0;
  const definition = defineChart(() => {
    compiles += 1;
    return { marks: [line([{ x: 0, y: 1 }, { x: 5, y: 2 }], { x: "x", y: "y" })] };
  });
  const view = scene();
  const renderWith = (viewport) => view.render(createElement(Chart, { definition, width: 320, height: 180, viewport }));
  await renderWith({ x: [1, 3] });
  const afterMount = compiles;
  for (let index = 0; index < 5; index += 1) await renderWith({ x: [1, 3] });
  assert(compiles === afterMount, "an inline controlled viewport literal with equal values adds 0 compiles");
  await renderWith({ x: [new Date(1), new Date(3)] });
  const afterDates = compiles;
  await renderWith({ x: [new Date(1), new Date(3)] });
  assert(compiles === afterDates, "controlled Date viewports compare by time value");
  await renderWith({ x: [2, 4] });
  assert(compiles > afterDates, "a changed controlled viewport still recompiles");
  await view.unmount();
}

{
  // A controlled viewport rides along with every update(), so the mount
  // treats a resize or an option change as navigation and keeps its cached
  // full-data scene: one compile per update, never an extra rebuild over
  // every row (ResponsiveContainer resizes on every observed frame).
  let compiles = 0;
  const rows = Array.from({ length: 50 }, (_, index) => ({ x: index, y: Math.sin(index) }));
  const definition = defineChart(() => {
    compiles += 1;
    return { marks: [line(rows, { x: "x", y: "y" })] };
  });
  const view = scene();
  let handle;
  const renderWith = (props) => view.render(createElement(Chart, {
    definition, width: 300, height: 180, viewport: { x: [5, 20] }, onReady: (h) => { handle = h; }, ...props,
  }));
  await renderWith({});
  let before = compiles;
  await renderWith({ width: 320 });
  assert(compiles === before + 1, "a width change with a controlled viewport costs exactly one compile");
  before = compiles;
  await renderWith({ width: 340 });
  assert(compiles === before + 1, "a second width change with a controlled viewport costs exactly one compile");
  before = compiles;
  await renderWith({ width: 340, height: 200 });
  assert(compiles === before + 1, "a height change with a controlled viewport costs exactly one compile");
  before = compiles;
  await renderWith({ width: 340, height: 200, idPrefix: "renamed" });
  assert(compiles === before + 1, "an idPrefix change with a controlled viewport costs exactly one compile");
  before = compiles;
  await renderWith({ width: 340, height: 200, idPrefix: "renamed", viewport: { x: [5, 20] } });
  assert(compiles === before, "re-rendering the same controlled viewport literal is still free");
  await renderWith({ width: 340, height: 200, idPrefix: "renamed", viewport: undefined });
  assert(handle.getViewport() === null, "dropping the controlled viewport still resets the mount to the full domain");
  await view.unmount();
}

{
  // The same with a navigator: its sparkline is the cached full-data scene.
  let compiles = 0;
  const rows = Array.from({ length: 50 }, (_, index) => ({ x: index, y: Math.cos(index) }));
  const definition = defineChart(() => {
    compiles += 1;
    return { marks: [line(rows, { x: "x", y: "y" })] };
  });
  const view = scene();
  const renderWith = (props) => view.render(createElement(Chart, {
    definition, width: 300, height: 180, viewport: { x: [5, 20] }, interaction: { navigator: true }, ...props,
  }));
  await renderWith({});
  assert(
    view.container.querySelector("[data-raze-chart-host] canvas[aria-hidden='true']") !== null,
    "the navigator paints its sparkline next to the SVG scene",
  );
  let before = compiles;
  await renderWith({ height: 200 });
  assert(compiles === before + 1, "a height change with a navigator and a controlled viewport costs exactly one compile");
  before = compiles;
  await renderWith({ height: 200, interaction: { navigator: true, zoom: true } });
  assert(compiles === before + 1, "an interaction change with a navigator and a controlled viewport costs exactly one compile");
  before = compiles;
  // A new width also resizes the navigator, whose sparkline is compiled once at
  // the new size (jsdom reports no layout, so the navigator follows the width).
  await renderWith({ width: 320, height: 200, interaction: { navigator: true, zoom: true } });
  assert(compiles === before + 2, "a width change with a navigator costs the scene plus one resized sparkline");
  await view.unmount();
}

// ── 2. Recharts-shaped JSX memoizes on structure ───────────────────────────

{
  const data = [{ name: "a", v: 1 }, { name: "b", v: 3 }, { name: "c", v: 2 }];
  const view = scene();
  let handle;
  const renderWith = (stroke) => view.render(createElement(
    LineChart,
    { data, width: 320, height: 180, onReady: (h) => { handle = h; } },
    createElement(Line, { dataKey: "v", stroke }),
    createElement(XAxis, { dataKey: "name" }),
    createElement(Tooltip),
  ));
  await renderWith(undefined);
  const host = view.container.querySelector("[data-raze-chart-host]");
  const stage = host.firstElementChild.firstElementChild;
  const observer = recorder();
  observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
  for (let index = 0; index < 5; index += 1) await renderWith(undefined);
  assert(observer.takeRecords().length === 0, "5 re-renders of the same data and JSX cause 0 DOM mutations");
  await renderWith("#ff0000");
  const repaints = observer.takeRecords().filter((record) => record.type === "childList" && record.target === stage);
  assert(repaints.length === 1, "changing Line stroke repaints exactly once");
  assert(host.innerHTML.includes("#ff0000"), "the new stroke reaches the rendered scene");
  assert(handle.getSnapshot()?.nodes.length > 0, "the JSX chart still exposes its scene");
  await renderWith("#ff0000");
  assert(observer.takeRecords().length === 0, "re-rendering the new stroke is again a no-op");
  await view.render(createElement(
    LineChart,
    { data: [...data], width: 320, height: 180 },
    createElement(Line, { dataKey: "v", stroke: "#ff0000" }),
    createElement(XAxis, { dataKey: "name" }),
    createElement(Tooltip),
  ));
  assert(
    observer.takeRecords().some((record) => record.type === "childList" && record.target === stage),
    "a new data array identity still recompiles",
  );
  observer.disconnect();
  await view.unmount();
}

// ── 3. Viewport groups ─────────────────────────────────────────────────────

const series = Array.from({ length: 20 }, (_, index) => ({ t: index, v: Math.sin(index) }));

{
  const group = createViewportGroup();
  const handles = {};
  const viewportCalls = [];
  const view = scene();
  const pair = (withSecond = true) => view.render(createElement(
    React.Fragment,
    null,
    createElement(
      LineChart,
      {
        data: series,
        width: 400,
        height: 200,
        viewportGroup: group,
        idPrefix: "first",
        onReady: (handle) => { handles.first = handle; },
        onViewportChange: (viewport) => viewportCalls.push(viewport),
      },
      createElement(Line, { dataKey: "v" }),
      createElement(XAxis, { dataKey: "t" }),
    ),
    withSecond
      ? createElement(
        LineChart,
        {
          data: series,
          width: 400,
          height: 200,
          viewportGroup: group,
          idPrefix: "second",
          onReady: (handle) => { handles.second = handle; },
        },
        createElement(Line, { dataKey: "v" }),
        createElement(XAxis, { dataKey: "t" }),
      )
      : null,
  ));
  await pair();
  const [firstHost] = view.container.querySelectorAll("[data-raze-chart-host]");
  const firstWrap = firstHost.firstElementChild;
  firstWrap.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON() {},
  });
  wheel(firstWrap, 200, 100);
  const firstX = handles.first.getSnapshot()?.viewport?.x;
  const secondX = handles.second.getSnapshot()?.viewport?.x;
  assert(Array.isArray(firstX) && firstX.length === 2, "wheel zoom narrows the first chart's viewport");
  assert(JSON.stringify(secondX) === JSON.stringify(firstX), "a wheel zoom on one grouped chart moves the other to the same x window");
  assert(JSON.stringify(group.getViewport()?.x) === JSON.stringify(firstX), "the group records the shared window");
  assert(viewportCalls.length === 1, "onViewportChange still fires once for the chart the user zoomed");
  assert(JSON.stringify(handles.second.getViewport()?.x) === JSON.stringify(firstX), "getViewport returns the synchronized window");
  const detached = handles.second.getViewport();
  detached.x[0] = -999;
  assert(handles.second.getViewport()?.x[0] !== -999, "getViewport returns a detached copy");

  group.setViewport({ x: [2, 5] });
  assert(
    JSON.stringify(handles.first.getSnapshot()?.viewport?.x) === "[2,5]"
      && JSON.stringify(handles.second.getSnapshot()?.viewport?.x) === "[2,5]",
    "group.setViewport drives every mounted member",
  );

  const unmountedSecond = handles.second;
  await pair(false);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    group.setViewport({ x: [3, 6] });
    assert(warnings.length === 0, "an unmounted chart left the group (no stale member is driven)");
    unmountedSecond.setViewport({ x: [1, 2] });
    unmountedSecond.setViewport({ x: [1, 2] });
    assert(
      warnings.length === 1 && warnings[0].includes("unmounted chart"),
      "setViewport on an unmounted handle warns once instead of throwing or silently ignoring",
    );
  } finally {
    console.warn = originalWarn;
  }
  assert(JSON.stringify(handles.first.getSnapshot()?.viewport?.x) === "[3,6]", "the remaining member still follows the group");
  assert(unmountedSecond.getViewport() === null, "an unmounted handle reports no viewport");
  await view.unmount();
}

{
  // Membership bookkeeping through a spy group.
  const members = new Set();
  let adds = 0;
  const spyGroup = {
    add(handle) {
      adds += 1;
      members.add(handle);
      return () => members.delete(handle);
    },
    setViewport(viewport) { for (const member of members) member.setViewport(viewport); },
    getViewport() { return null; },
  };
  const view = scene();
  const definition = defineChart({ marks: [line(series, { x: "t", y: "v" })] });
  await view.render(createElement(Chart, { definition, width: 300, height: 150, viewportGroup: spyGroup }));
  assert(members.size === 1 && adds === 1, "a chart with viewportGroup joins the group once on mount");
  await view.render(createElement(Chart, { definition, width: 300, height: 150, viewportGroup: spyGroup }));
  assert(members.size === 1 && adds === 1, "re-rendering with the same group does not re-join");
  await view.render(createElement(Chart, { definition, width: 300, height: 150 }));
  assert(members.size === 0, "removing the viewportGroup prop leaves the group");
  await view.render(createElement(Chart, { definition, width: 300, height: 150, viewportGroup: spyGroup }));
  assert(members.size === 1, "adding the prop back joins again");
  await view.unmount();
  assert(members.size === 0, "unmounting removes the chart from its group");
}

{
  // A group that already has a window pulls a new member into it on mount.
  const group = createViewportGroup();
  group.setViewport({ x: [4, 9] });
  let handle;
  const view = scene();
  await view.render(createElement(Chart, {
    definition: defineChart({ marks: [line(series, { x: "t", y: "v" })] }),
    width: 300,
    height: 150,
    viewportGroup: group,
    onReady: (h) => { handle = h; },
  }));
  assert(JSON.stringify(handle.getSnapshot()?.viewport?.x) === "[4,9]", "a chart joining a group adopts its current window");
  await view.unmount();
}

{
  // The documented handle path: onReady={(handle) => group.add(handle)}.
  const group = createViewportGroup();
  let handle;
  let leave;
  const view = scene();
  await view.render(createElement(Chart, {
    definition: defineChart({ marks: [line(series, { x: "t", y: "v" })] }),
    width: 300,
    height: 150,
    onReady: (h) => { handle = h; leave = group.add(h); },
  }));
  group.setViewport({ x: [1, 4] });
  assert(JSON.stringify(handle.getSnapshot()?.viewport?.x) === "[1,4]", "group.add(handle) from onReady synchronizes the chart");
  handle.setViewport(null);
  assert(handle.getSnapshot()?.viewport == null, "handle.setViewport(null) resets to the full domain");
  leave();
  await view.unmount();
}

{
  // syncId: charts with the same id share a group, different ids do not.
  const handles = {};
  const view = scene();
  const chart = (id, syncId) => createElement(
    LineChart,
    { data: series, width: 400, height: 200, syncId, idPrefix: id, onReady: (h) => { handles[id] = h; } },
    createElement(Line, { dataKey: "v" }),
    createElement(XAxis, { dataKey: "t" }),
  );
  await view.render(createElement(React.Fragment, null, chart("a", "dash"), chart("b", "dash"), chart("c", "other")));
  const wrapA = view.container.querySelectorAll("[data-raze-chart-host]")[0].firstElementChild;
  wrapA.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON() {},
  });
  wheel(wrapA, 200, 100);
  const windowA = JSON.stringify(handles.a.getSnapshot()?.viewport?.x);
  assert(windowA && JSON.stringify(handles.b.getSnapshot()?.viewport?.x) === windowA, "charts sharing a syncId follow each other");
  assert(handles.c.getSnapshot()?.viewport == null, "a chart with a different syncId is unaffected");
  await view.unmount();

  // After every member unmounted, the id starts fresh (no stale window).
  const again = scene();
  await again.render(chart("d", "dash"));
  assert(handles.d.getSnapshot()?.viewport == null, "a syncId group is released when its last chart unmounts");
  await again.unmount();
}

{
  const view = scene();
  await withSilencedErrors(() => view.render(createElement(
    ErrorBoundary,
    null,
    createElement(Chart, {
      definition: defineChart({ marks: [line(series, { x: "t", y: "v" })] }),
      viewportGroup: createViewportGroup(),
      syncId: "both",
    }),
  )));
  assert(
    view.container.querySelector("[data-test-error]")?.textContent.includes("either viewportGroup or syncId"),
    "passing both viewportGroup and syncId fails with guidance",
  );
  await view.unmount();
}

// ── 4. ResponsiveContainer accepts any component child ─────────────────────

{
  const data = [{ name: "a", value: 1 }, { name: "b", value: 2 }];
  let handle;
  function RevenueChart({ width, height }) {
    return createElement(
      LineChart,
      { data, width, height, onReady: (h) => { handle = h; } },
      createElement(Line, { dataKey: "value" }),
    );
  }
  const view = scene();
  await view.render(createElement(ResponsiveContainer, { height: 200 }, createElement(RevenueChart)));
  const box = view.container.querySelector("[data-raze-responsive-container]");
  const observer = resizeObservers.find((candidate) => candidate.observing && candidate.target === box);
  assert(observer, "a percentage-width container observes its box for a wrapper child");
  await act(async () => { observer.emit(512, 200); });
  assert(handle.getSnapshot()?.width === 512, "a user wrapper component renders at the measured width");
  assert(handle.getSnapshot()?.height === 200, "a user wrapper component receives the container height");
  await view.unmount();
}

{
  const sizes = [];
  const view = scene();
  await view.render(createElement(ResponsiveContainer, { height: 150 }, (size) => {
    sizes.push(size);
    return createElement("p", { "data-size": "" }, `${size.width}x${size.height}`);
  }));
  assert(sizes.length === 0, "a render function waits until both dimensions are measured");
  const box = view.container.querySelector("[data-raze-responsive-container]");
  const observer = resizeObservers.find((candidate) => candidate.observing && candidate.target === box);
  await act(async () => { observer.emit(333, 150); });
  const last = sizes.at(-1);
  assert(
    typeof last?.width === "number" && typeof last?.height === "number" && last.width === 333 && last.height === 150,
    "a render-prop child receives numeric { width, height }",
  );
  assert(view.container.querySelector("[data-size]")?.textContent === "333x150", "the render-prop output is rendered");
  await view.unmount();
}

for (const [label, child, expected] of [
  ["a host element", createElement("div"), "received <div>"],
  ["two children", [createElement(Chart, { key: 1, definition: defineChart({ marks: [] }) }), createElement("span", { key: 2 })], "received 2 children"],
  // Descriptors render nothing outside a chart container; cloning size into
  // one would leave an empty responsive box with no error (a silent no-op).
  ["a series descriptor", createElement(Line, { dataKey: "v" }), "received <Line>, a series descriptor; wrap it in a chart container such as <LineChart>"],
  ["a chart descriptor", createElement(Tooltip), "received <Tooltip>, a chart descriptor; wrap it in a chart container"],
  ["an axis descriptor", createElement(XAxis, { dataKey: "t" }), "received <XAxis>, a chart descriptor"],
]) {
  const view = scene();
  await withSilencedErrors(() => view.render(createElement(
    ErrorBoundary,
    null,
    createElement(ResponsiveContainer, { width: 300, height: 100 }, child),
  )));
  const text = view.container.querySelector("[data-test-error]")?.textContent ?? "";
  assert(text.includes("render function child") && text.includes(expected), `ResponsiveContainer rejects ${label} with guidance`);
  await view.unmount();
}

dom.window.close();
console.log(`REACT RERENDER: PASS (${passed} assertions)`);
