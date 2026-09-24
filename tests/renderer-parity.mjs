import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import {
  compileChart,
  bar,
  defineChart,
  hitTestCompiled,
  line,
  mountChart,
  paintChartCanvas,
  point,
  scaleBand,
  svgFromCompiled,
} from "../dist/chart.esm.js";

function recordingContext() {
  const operations = [];
  const gradients = [];
  const context = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineJoin: "miter",
    lineCap: "butt",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    save: () => operations.push(["save"]),
    restore: () => operations.push(["restore"]),
    beginPath: () => operations.push(["beginPath"]),
    closePath: () => operations.push(["closePath"]),
    moveTo: (...args) => operations.push(["moveTo", ...args]),
    lineTo: (...args) => operations.push(["lineTo", ...args]),
    bezierCurveTo: (...args) => operations.push(["bezierCurveTo", ...args]),
    quadraticCurveTo: (...args) => operations.push(["quadraticCurveTo", ...args]),
    arc: (...args) => operations.push(["arc", ...args]),
    rect: (...args) => operations.push(["rect", ...args]),
    clip: () => operations.push(["clip"]),
    fill: () => operations.push(["fill"]),
    stroke: () => operations.push(["stroke"]),
    fillRect: (...args) => operations.push(["fillRect", ...args]),
    clearRect: (...args) => operations.push(["clearRect", ...args]),
    fillText: (...args) => operations.push(["fillText", ...args]),
    setTransform: (...args) => operations.push(["setTransform", ...args]),
    setLineDash: (...args) => operations.push(["setLineDash", ...args]),
    createLinearGradient: (...args) => {
      const stops = [];
      gradients.push({ args, stops });
      return { addColorStop: (...stop) => stops.push(stop) };
    },
  };
  return { context, operations, gradients };
}

const base = compileChart(
  defineChart(() => ({ marks: [], ariaLabel: "Renderer parity" })),
  { width: 480, height: 280 },
);

const allNodes = [
  { type: "line", points: [{ x: 20, y: 90 }, { x: 80, y: 30 }, { x: 140, y: 70 }], stroke: "#55aaff", strokeWidth: 2, series: "Line" },
  { type: "area", points: [{ x: 20, y: 160 }, { x: 20, y: 100 }, { x: 80, y: 70 }, { x: 140, y: 110 }, { x: 140, y: 160 }], fill: "#55aaff", fillOpacity: 0.35, stroke: "#224466", series: "Area" },
  { type: "rect", x: 160, y: 70, w: 24, h: 90, fill: "#66d89e", corner: "top", series: "Bar" },
  { type: "circle", x: 210, y: 90, r: 6, fill: "#d7a856", stroke: "#ffffff", fillOpacity: 0.8, series: "Point" },
  { type: "rule", x: 15, y: 170, x2: 240, y2: 170, stroke: "#999999", dashed: true, series: "Rule" },
  { type: "arc", x: 300, y: 100, r: 42, innerR: 20, startAngle: 0, endAngle: Math.PI * 1.5, fill: "#cc6688", stroke: "#ffffff", series: "Arc" },
  { type: "polygon", points: [{ x: 260, y: 190 }, { x: 310, y: 150 }, { x: 360, y: 195 }], fill: "#8866cc", fillOpacity: 0.4, stroke: "#aa88ee", series: "Polygon" },
  { type: "text", x: 300, y: 220, label: "Outside annotation", fill: "#ffffff", anchor: "middle", fontSize: 12, clip: false },
];
const completeScene = {
  ...base,
  nodes: allNodes,
  grid: true,
  legend: [{ name: "Line", color: "#55aaff", detail: "42" }],
  legendPlacement: "top",
  lastValues: [{ y: 90, label: "42.0", color: "#55aaff", dash: true }],
};
const canvas = recordingContext();
paintChartCanvas(canvas.context, completeScene);

const opNames = new Set(canvas.operations.map(([name]) => name));
for (const operation of ["clearRect", "bezierCurveTo", "quadraticCurveTo", "arc", "rect", "clip", "fill", "stroke", "fillText"]) {
  assert(opNames.has(operation), `Canvas paints ${operation}`);
}
assert(canvas.gradients.length >= 2, "Canvas applies area and bar gradients");
const canvasLabels = canvas.operations.filter(([name]) => name === "fillText").map(([, label]) => label);
assert(canvasLabels.includes("Outside annotation"), "Canvas paints clip:false text overlays");
assert(canvasLabels.some((label) => String(label).includes("Line")), "Canvas paints legends");
assert(canvasLabels.includes("42.0"), "Canvas paints last-value chips");

const negativeBarDefinition = defineChart({
  marks: [bar([{ x: "negative", y: -5 }], { x: "x", y: "y", name: "Loss" })],
  legend: false,
});
const negativeBarScene = compileChart(negativeBarDefinition, { width: 320, height: 200 });
const negativeBarNode = negativeBarScene.nodes.find((node) => node.type === "rect" && node.role === "bar");
assert(negativeBarNode, "negative-bar fixture emits a bar node");
const negativeBarBottom = negativeBarNode.y + negativeBarNode.h;

const negativeBarSvg = svgFromCompiled(negativeBarScene, { idPrefix: "negative-bar" });
const negativeBarPath = negativeBarSvg.match(/<path d="([^"]+)"[^>]*data-role="bar"/)?.[1] ?? "";
const svgBottom = negativeBarBottom.toFixed(2);
assert(
  negativeBarPath.includes(`Q${(negativeBarNode.x + negativeBarNode.w).toFixed(2)} ${svgBottom}`)
    && negativeBarPath.includes(`Q${negativeBarNode.x.toFixed(2)} ${svgBottom}`),
  "SVG consumes corner:bottom by rounding the negative value edge",
);

const negativeBarCanvas = recordingContext();
paintChartCanvas(negativeBarCanvas.context, negativeBarScene);
const negativeBarCurves = negativeBarCanvas.operations.filter(([name]) => name === "quadraticCurveTo");
assert.equal(negativeBarCurves.length, 2, "Canvas emits both rounded corners for a negative bar");
assert(
  negativeBarCurves.every(([, , controlY]) => controlY === negativeBarBottom),
  "Canvas consumes corner:bottom at the negative value edge",
);

const fullSlice = {
  type: "arc",
  x: 210,
  y: 130,
  r: 80,
  innerR: 24,
  startAngle: -Math.PI / 2,
  endAngle: -Math.PI / 2 + Math.PI * 2,
  fill: "#55aaff",
  series: "Everything",
  role: "slice",
  idx: 0,
};
const pieScene = { ...base, width: 420, height: 260, polar: true, nodes: [fullSlice] };
const pieSvg = svgFromCompiled(pieScene, { idPrefix: "full-arc" });
const slicePath = pieSvg.match(/<path d="([^"]+)"[^>]*data-role="slice"/)?.[1] ?? "";
assert((slicePath.match(/ A /g) ?? []).length >= 4, "SVG emits two arcs per ring for a complete donut");
assert(pieSvg.includes('data-role="slice"'), "SVG retains semantic scene roles");

const slice = pieScene.nodes.find((node) => node.role === "slice");
assert(slice, "single-slice pie compiles");
assert.equal(hitTestCompiled(pieScene, slice.x + slice.r * 0.8, slice.y), slice, "full-circle arcs hit-test across the seam");

const largeDomain = Array.from({ length: 50_000 }, (_, i) => `category-${i}`);
const band = scaleBand({ domain: largeDomain, range: [0, 1000] });
const bandStart = performance.now();
let checksum = 0;
for (let i = 0; i < largeDomain.length; i++) checksum += band.start(largeDomain[i]);
const bandElapsed = performance.now() - bandStart;
assert(Number.isFinite(checksum) && checksum > 0, "large band scale resolves every category");
assert(bandElapsed < 1_500, `band lookup stays indexed (${bandElapsed.toFixed(1)}ms)`);
const mutableBand = scaleBand({ domain: ["first", "second"], range: [0, 100] });
mutableBand.domain.unshift("inserted");
assert(mutableBand.start("first") > mutableBand.start("inserted"), "indexed bands stay correct after in-place domain mutation");
mutableBand.domain.reverse();
assert(mutableBand.start("inserted") > mutableBand.start("first"), "indexed bands stay correct after bulk domain mutation");

const denseNodes = Array.from({ length: 30_000 }, (_, i) => ({
  type: "circle",
  x: (i % 300) * 3,
  y: Math.floor(i / 300) * 3,
  r: 1,
  fill: "#ffffff",
  datum: i,
}));
const denseScene = { ...base, nodes: denseNodes, samples: [] };
const target = denseNodes[denseNodes.length - 1];
const hitStart = performance.now();
for (let i = 0; i < 2_000; i++) {
  const hit = hitTestCompiled(denseScene, target.x, target.y);
  assert(hit, "dense hit index finds a point");
}
const hitElapsed = performance.now() - hitStart;
assert(hitElapsed < 1_500, `repeated dense hit-tests use the spatial cache (${hitElapsed.toFixed(1)}ms)`);

const dom = new JSDOM("<!doctype html><html><body><div id='chart'></div></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
const resizeObservers = [];
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    resizeObservers.push(this);
  }
  observe(target) { this.target = target; }
  disconnect() { this.disconnected = true; }
  trigger() { this.callback([{ target: this.target }], this); }
};
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return recordingContext().context;
};

const negativeHost = document.createElement("div");
document.body.appendChild(negativeHost);
const negativeMount = mountChart(negativeHost, negativeBarDefinition, { width: 320, height: 200 });
const mountedNegativeScene = negativeMount.getScene();
const mountedNegativeBar = mountedNegativeScene?.nodes.find((node) => node.type === "rect" && node.role === "bar");
assert(mountedNegativeBar, "mounted negative-bar fixture exposes its scene node");
const negativeWrapper = negativeHost.firstElementChild;
negativeWrapper.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 200, width: 320, height: 200, toJSON() {} });
negativeWrapper.dispatchEvent(new dom.window.MouseEvent("pointermove", {
  bubbles: true,
  clientX: mountedNegativeBar.x + mountedNegativeBar.w / 2,
  clientY: mountedNegativeBar.y + mountedNegativeBar.h / 2,
}));
const negativeHorizontalHair = [...negativeWrapper.children].find((element) => element.style.borderTopStyle === "dashed");
assert.equal(negativeHorizontalHair?.style.display, "block", "negative-bar pointermove displays the horizontal crosshair");
assert.equal(
  negativeHorizontalHair?.style.top,
  `${Math.round(mountedNegativeBar.valueY)}px`,
  "negative-bar pointermove anchors the crosshair to valueY instead of zero",
);
negativeMount.destroy();
negativeHost.remove();

const hoverDefinition = defineChart(() => ({
  marks: [
    line([{ x: "A", y: 10 }, { x: "B", y: 20 }, { x: "C", y: 30 }], { x: "x", y: "y", name: "Low" }),
    line([{ x: "A", y: 80 }, { x: "B", y: 70 }, { x: "C", y: 60 }], { x: "x", y: "y", name: "High" }),
  ],
  tooltip: true,
  legend: false,
}));
const host = document.getElementById("chart");
const mounted = mountChart(host, hoverDefinition, { width: 480, height: 280, idPrefix: "hover-index" });
const hoverScene = mounted.getScene();
const expectedSample = hoverScene.samples.find((sample) => sample.series === "High" && sample.tip.includes("B"));
assert(expectedSample, "hover fixture exposes the expected sample");
const wrapper = host.firstElementChild;
wrapper.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 480, bottom: 280, width: 480, height: 280, toJSON() {} });
wrapper.dispatchEvent(new dom.window.MouseEvent("pointermove", {
  bubbles: true,
  clientX: expectedSample.x,
  clientY: expectedSample.y,
}));
const tooltip = [...wrapper.children].find((element) => element.style.zIndex === "5");
assert.equal(tooltip?.textContent, expectedSample.tip, "indexed nearest-sample lookup preserves tooltip selection");
assert.equal(tooltip?.style.display, "block", "indexed tooltip remains visible at a matching sample");
assert.equal(wrapper.style.userSelect, "none", "mounted charts disable text selection during pan");

wrapper.dispatchEvent(new dom.window.MouseEvent("pointerleave", { bubbles: true }));
wrapper.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 960, bottom: 560, width: 960, height: 560, toJSON() {} });
wrapper.dispatchEvent(new dom.window.MouseEvent("pointermove", {
  bubbles: true,
  clientX: expectedSample.x * 2,
  clientY: expectedSample.y * 2,
}));
const hoverDot = [...wrapper.children].find((element) => element.style.borderRadius === "50%");
assert.equal(tooltip?.textContent, expectedSample.tip, "CSS-scaled charts map pointer coordinates back into scene space");
assert.equal(hoverDot?.style.left, `${expectedSample.x * 2}px`, "interaction overlays scale back into CSS space");

const previousScene = mounted.getScene();
const previousSvg = wrapper.querySelector("svg")?.outerHTML;
let updateFailure;
try {
  mounted.update(defineChart(() => { throw new Error("invalid update"); }));
} catch (error) {
  updateFailure = error;
}
assert.match(updateFailure?.message ?? "", /invalid update/, "invalid updates surface their compile failure");
assert.equal(mounted.getScene(), previousScene, "a failed update preserves the last valid scene transactionally");
assert.equal(wrapper.querySelector("svg")?.outerHTML, previousSvg, "a failed update preserves the last valid DOM");
mounted.update(hoverDefinition, { width: 481, height: 280 });
assert.equal(mounted.getScene()?.width, 481, "a mount remains usable after a rejected update");
mounted.destroy();
assert.equal(resizeObservers[0]?.disconnected, true, "destroy disconnects the mount observer");
let destroyedUpdate;
try { mounted.update(hoverDefinition); } catch (error) { destroyedUpdate = error; }
assert.match(destroyedUpdate?.message ?? "", /destroyed/, "updates after destroy fail explicitly");

const failedHost = document.createElement("div");
document.body.appendChild(failedHost);
let initialFailure;
try {
  mountChart(failedHost, defineChart(() => { throw new Error("initial compile failed"); }), { width: 320, height: 180 });
} catch (error) {
  initialFailure = error;
}
assert.match(initialFailure?.message ?? "", /initial compile failed/, "initial compile errors are surfaced");
assert.equal(failedHost.childElementCount, 0, "failed initial mounts roll back all inserted DOM");
assert.equal(resizeObservers.at(-1)?.disconnected, true, "failed initial mounts disconnect their observer");
failedHost.remove();

const canvasHost = document.createElement("div");
document.body.appendChild(canvasHost);
const fixedSceneDefinition = defineChart({ width: 800, height: 400, marks: [], ariaLabel: "Fixed scene" });
const canvasMount = mountChart(canvasHost, fixedSceneDefinition, { width: 400, height: 200, renderer: "canvas" });
const mountedCanvas = canvasHost.querySelector("canvas");
assert.equal(mountedCanvas?.width, 800 * Math.max(1, window.devicePixelRatio || 1), "Canvas backing width follows compiled scene dimensions");
assert.equal(mountedCanvas?.height, 400 * Math.max(1, window.devicePixelRatio || 1), "Canvas backing height follows compiled scene dimensions");
assert.equal(mountedCanvas?.style.width, "100%", "Canvas scales through CSS like the SVG renderer");
canvasMount.update(fixedSceneDefinition, { width: 400, height: 200, renderer: "canvas" });
assert.equal(canvasHost.querySelector("canvas"), mountedCanvas, "canvas paints reuse the backing surface");
canvasMount.destroy();
canvasHost.remove();

const mixedHost = document.createElement("div");
document.body.appendChild(mixedHost);
const mixedDefinition = defineChart({
  marks: [
    line([{ x: "A", y: 10 }, { x: "B", y: 10 }], { x: "x", y: "y", name: "Trend" }),
    point([{ x: "B", y: 80 }], { x: "x", y: "y", name: "Scatter", r: 7 }),
  ],
  tooltip: true,
  legend: false,
});
const mixedMount = mountChart(mixedHost, mixedDefinition, { width: 480, height: 280 });
const mixedScene = mixedMount.getScene();
const scatterSample = mixedScene?.samples.find((sample) => sample.kind === "point" && sample.series === "Scatter");
const mixedWrapper = mixedHost.firstElementChild;
mixedWrapper.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 480, bottom: 280, width: 480, height: 280, toJSON() {} });
mixedWrapper.dispatchEvent(new dom.window.MouseEvent("pointermove", {
  bubbles: true,
  clientX: scatterSample.x,
  clientY: scatterSample.y,
}));
const mixedTooltip = [...mixedWrapper.children].find((element) => element.style.zIndex === "5");
assert.equal(mixedTooltip?.textContent, scatterSample.tip, "an exact scatter hit wins over a distant line sample in composed charts");
mixedMount.destroy();
mixedHost.remove();

const panHost = document.createElement("div");
document.body.appendChild(panHost);
const panDefinition = defineChart({
  marks: [line(Array.from({ length: 24 }, (_, i) => ({ t: i * 86_400_000, v: 50 + i })), { x: "t", y: "v", name: "Sales" })],
  scales: { x: { type: "time" } },
  legend: false,
  ariaLabel: "Revenue",
});
const panSelections = [];
const panViewportChanges = [];
const panMount = mountChart(panHost, panDefinition, {
  width: 400,
  height: 200,
  onSelect: (event) => panSelections.push(event),
  onViewportChange: (viewport) => panViewportChanges.push(viewport),
});
const panWrap = panHost.firstElementChild;
const panBox = { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON() {} };
panWrap.getBoundingClientRect = () => panBox;
panWrap.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 220, clientY: 80 }));
panWrap.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 222, clientY: 82 }));
panWrap.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 222, clientY: 82 }));
assert.equal(panSelections.length, 1, "a sub-threshold pointer gesture selects with default pan enabled");
assert.equal(panMount.getViewport(), null, "a sub-threshold pointer gesture does not create a pan viewport");
assert.equal(panViewportChanges.length, 0, "a sub-threshold pointer gesture does not emit a viewport change");
// Pans stay inside the data by default, so start from a zoomed-in window.
panMount.setViewport({ x: [0, 12 * 86_400_000] });
panWrap.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 220, clientY: 80 }));
panWrap.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 160, clientY: 80 }));
const panPlot = panWrap.querySelector("[data-role='plot']");
const panLabels = panWrap.querySelector("[data-role='x-labels']");
assert.match(panPlot?.getAttribute("transform") ?? "", /translate\(-60/, "svg pan translates plot geometry with the pointer");
assert.equal(panPlot?.getAttribute("transform"), panLabels?.getAttribute("transform"), "svg pan keeps x labels locked to the plot");
const livePan = panMount.getViewport()?.x;
assert(Array.isArray(livePan) && livePan.length === 2, "svg pan updates the live viewport while dragging");
assert(Number(livePan[0]) > 0, "dragging left shifts the window toward later values");
assert.equal(panViewportChanges.length, 0, "pan previews do not publish a viewport before commit");
const panSvgBeforeCommit = panWrap.querySelector("svg");
panWrap.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 160, clientY: 80 }));
assert.equal(panWrap.querySelector("[data-role='plot']")?.getAttribute("transform"), null, "svg pan clears the preview transform after commit");
assert.notEqual(panWrap.querySelector("svg"), panSvgBeforeCommit, "svg pan commits by rewriting the scene once");
assert.equal(panWrap.style.cursor, "", "svg pan restores the cursor after release");
assert.equal(panViewportChanges.length, 1, "a completed pan publishes exactly one committed viewport");
const committedPan = panMount.getViewport();
panWrap.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 220, clientY: 80 }));
panWrap.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 120, clientY: 80 }));
assert.notDeepEqual(panMount.getViewport(), committedPan, "a second pan exposes its in-progress preview");
panWrap.dispatchEvent(new dom.window.MouseEvent("pointercancel", { bubbles: true, clientX: 120, clientY: 80 }));
assert.deepEqual(panMount.getViewport(), committedPan, "pointercancel rolls a pan back to its pre-drag viewport");
assert.equal(panViewportChanges.length, 1, "pointercancel does not publish a pan commit");
assert.equal(panWrap.querySelector("[data-role='plot']")?.getAttribute("transform"), null, "pointercancel clears the pan preview transform");
panWrap.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, shiftKey: true, clientX: 100, clientY: 80 }));
panWrap.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, shiftKey: true, clientX: 260, clientY: 80 }));
panWrap.dispatchEvent(new dom.window.MouseEvent("pointercancel", { bubbles: true, shiftKey: true, clientX: 260, clientY: 80 }));
assert.deepEqual(panMount.getViewport(), committedPan, "pointercancel discards an in-progress brush");
assert.equal(panViewportChanges.length, 1, "pointercancel does not publish a brush commit");
panMount.destroy();
panHost.remove();

const staticHost = document.createElement("div");
document.body.appendChild(staticHost);
const staticMount = mountChart(staticHost, panDefinition, { width: 400, height: 200, interaction: false });
const staticWrap = staticHost.firstElementChild;
assert.notEqual(staticWrap.style.touchAction, "none", "interaction:false leaves native touch actions available");
staticMount.update(panDefinition, { interaction: true });
assert.equal(staticWrap.style.touchAction, "none", "enabling interaction opts the mount into gesture-owned touch handling");
staticMount.destroy();
staticHost.remove();

const rangeHost = document.createElement("div");
document.body.appendChild(rangeHost);
const t0 = Date.UTC(2026, 7, 1);
const rangeDefinition = defineChart({
  marks: [line(Array.from({ length: 48 }, (_, i) => ({ t: t0 + i * 86_400_000, v: 50 + i })), { x: "t", y: "v", name: "Sales" })],
  scales: { x: { type: "time" } },
  legend: false,
  ariaLabel: "Revenue",
});
const rangeMount = mountChart(rangeHost, rangeDefinition, {
  width: 400,
  height: 200,
  interaction: { pan: true, rangePresets: true },
});
const rangeWrap = rangeHost.firstElementChild;
const rangeBox = { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON() {} };
rangeWrap.getBoundingClientRect = () => rangeBox;
const presetButtons = [...rangeWrap.querySelectorAll("button")];
const byLabel = Object.fromEntries(presetButtons.map((btn) => [btn.textContent, btn]));
assert.equal(Boolean(byLabel["1D"] && byLabel.ALL), true, "range preset bar renders named buttons");
assert.equal(byLabel["3M"]?.hidden, true, "3M hides when it cannot zoom the series");
assert.equal(byLabel.YTD?.hidden, true, "YTD hides when it cannot zoom the series");
// Daily rows: 1D is narrower than the three-point minimum zoom span, so it is not offered.
assert.equal(byLabel["1D"]?.hidden, true, "1D hides when it is narrower than the zoom minimum");
byLabel["1W"].dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 24, clientY: 190 }));
assert.equal(rangeWrap.style.cursor, "", "clicking a range preset does not start a pan");
byLabel["1W"].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
const weekView = rangeMount.getViewport()?.x;
assert(Array.isArray(weekView) && weekView.length === 2, "1W preset writes a viewport");
assert(Math.abs(Number(weekView[1]) - Number(weekView[0]) - 7 * 86_400_000) <= 86_400_000 * 0.05, "1W preset windows about one week");
assert.equal(byLabel["1W"].getAttribute("aria-pressed"), "true", "the active range preset is pressed");
byLabel.ALL.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
assert.equal(byLabel.ALL.getAttribute("aria-pressed"), "true", "ALL restores the full window");

const futureT0 = Date.UTC(2027, 7, 1);
const futureRangeDefinition = defineChart({
  marks: [line(Array.from({ length: 48 }, (_, i) => ({ t: futureT0 + i * 86_400_000, v: 80 + i })), { x: "t", y: "v", name: "Sales" })],
  scales: { x: { type: "time" } },
  legend: false,
  ariaLabel: "Future revenue",
});
rangeMount.update(futureRangeDefinition);
byLabel.ALL.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
const futureAll = rangeMount.getViewport()?.x;
assert(Number(futureAll?.[0]) > t0 + 180 * 86_400_000, "changing definitions resets the cached full-domain extent");
byLabel["1D"].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
const futureDay = rangeMount.getViewport();
let failedRangeUpdate;
try {
  rangeMount.update(defineChart(() => { throw new Error("invalid range update"); }), {
    viewport: { x: [t0, t0 + 86_400_000] },
    hiddenSeries: ["Sales"],
  });
} catch (error) {
  failedRangeUpdate = error;
}
assert.match(failedRangeUpdate?.message ?? "", /invalid range update/, "failed range updates surface their compile error");
assert.deepEqual(rangeMount.getViewport(), futureDay, "failed updates restore the prior live viewport");
byLabel.ALL.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
const restoredFutureAll = rangeMount.getViewport()?.x;
assert(Number(restoredFutureAll?.[1]) - Number(restoredFutureAll?.[0]) > 40 * 86_400_000, "failed updates restore the cached full-domain extent");
assert(rangeMount.getScene()?.samples.some((sample) => sample.series === "Sales"), "failed updates restore the hidden-series set");
rangeMount.destroy();
rangeHost.remove();
dom.window.close();

console.log(`RENDERER PARITY: PASS (band ${bandElapsed.toFixed(1)}ms, dense hit ${hitElapsed.toFixed(1)}ms)`);
