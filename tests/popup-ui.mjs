import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { LeftSidebar, ObjectsTree, openPopup, popupRow } from "../dist/charting_library.esm.js";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  pretendToBeVisual: true,
});
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  Element: window.Element,
  Node: window.Node,
  getComputedStyle: window.getComputedStyle.bind(window),
});

const wait = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const themedRoot = document.createElement("div");
themedRoot.className = "raze-chart-root";
themedRoot.style.setProperty("--tv-color-popup-background", "#ffffff");
themedRoot.style.setProperty("--tv-color-popup-element-text", "#2a2e39");
const themedAnchor = document.createElement("button");
themedRoot.appendChild(themedAnchor);
document.body.appendChild(themedRoot);
const themedPopup = openPopup({
  anchor: themedAnchor,
  fontFamily: "sans-serif",
  initialFocus: false,
});
assert.equal(
  themedPopup.el.closest("[data-raze-portal]").style.getPropertyValue("--tv-color-popup-background"),
  "#ffffff",
  "body-portalled popups retain their widget theme variables",
);
themedPopup.close({ restoreFocus: false });
themedRoot.remove();

const unsafe = '<img src="x" onerror="globalThis.__razePopupXss=1">';
const safeRow = popupRow(unsafe, () => {});
assert.equal(safeRow.querySelector("img"), null, "popup rows treat content as text by default");
assert.equal(safeRow.textContent, unsafe);

const trustedRow = popupRow(
  '<span class="trusted-icon"><svg></svg></span>Chart type',
  () => {},
  { trustedHtml: true },
);
assert(trustedRow.querySelector(".trusted-icon svg"), "trusted library markup can be opted into explicitly");
assert.equal(trustedRow.querySelector("svg")?.getAttribute("aria-hidden"), "true");

const context = {
  fontFamily: "sans-serif",
  magnet: false,
  stayInDrawingMode: false,
  volumeMode: "overlay",
  requestPaint() {},
};

const sidebar = new LeftSidebar(context, {
  onTool() {},
  onIndicatorsClick() {},
  onFit() {},
  onScreenshot() {},
  onFullscreen() {},
  onChartType() {},
}, ["chart_type"]);
document.body.appendChild(sidebar.el);
const chartTypeButton = sidebar.el.querySelector("button");
assert(chartTypeButton, "chart-type control is rendered");
chartTypeButton.click();
await wait();
const styleMenu = document.querySelector(".raze-chart-style-menu");
assert(styleMenu?.querySelector("svg"), "chart-style menu keeps its library-owned SVG icons");
sidebar.destroy();

const anchor = document.createElement("button");
document.body.appendChild(anchor);
const shapes = [{
  id: "shape-1",
  shape: "rectangle",
  hidden: false,
  showInObjectsTree: true,
}];
const studies = [{
  id: "study-1",
  name: unsafe,
  length: 14,
}];
const shapeStore = {
  list: () => shapes,
  setHidden(id, hidden) {
    const shape = shapes.find((item) => item.id === id);
    if (shape) shape.hidden = hidden;
  },
  remove(id) {
    const index = shapes.findIndex((item) => item.id === id);
    if (index >= 0) shapes.splice(index, 1);
  },
};
const studyStore = {
  list: () => studies,
  remove(id) {
    const index = studies.findIndex((item) => item.id === id);
    if (index >= 0) studies.splice(index, 1);
  },
};

const tree = new ObjectsTree(context, shapeStore, studyStore);
tree.open(anchor);
await wait();
let panel = document.querySelector(".raze-chart-objects-tree");
assert(panel, "objects tree opens");
assert.equal(panel.querySelector("img, [onerror]"), null, "study names cannot inject markup into the objects tree");
assert.match(panel.textContent, /<img src="x" onerror=/, "unsafe study names remain visible as literal text");

let rows = [...panel.querySelectorAll("button")];
assert.equal(rows.length, 6, "objects tree exposes only actionable rows");
rows[0].focus();
rows[0].click();
panel = document.querySelector(".raze-chart-objects-tree");
rows = [...panel.querySelectorAll("button")];
assert.equal(document.activeElement, rows[0], "toggle rerenders preserve keyboard focus");
assert.equal(rows[0].getAttribute("aria-checked"), "true");
rows[0].dispatchEvent(new window.KeyboardEvent("keydown", {
  key: "ArrowDown",
  bubbles: true,
  cancelable: true,
}));
assert.equal(document.activeElement, rows[1], "arrow navigation continues after a rerender");

rows[3].focus();
rows[3].click();
panel = document.querySelector(".raze-chart-objects-tree");
rows = [...panel.querySelectorAll("button")];
assert.equal(document.activeElement, rows[3], "object visibility rerenders preserve keyboard focus");
assert.match(rows[3].textContent, /^Show /);

rows[4].focus();
rows[4].click();
panel = document.querySelector(".raze-chart-objects-tree");
rows = [...panel.querySelectorAll("button")];
assert.equal(document.activeElement, rows[3], "deleting an item moves focus to the nearest remaining action");

rows[3].click();
panel = document.querySelector(".raze-chart-objects-tree");
rows = [...panel.querySelectorAll("button")];
assert.equal(rows.length, 3, "empty objects tree contains no inert menu button");
assert.equal(panel.querySelector('[role="status"]')?.textContent, "No objects");
assert.equal(document.activeElement, rows[2], "focus falls back to the nearest base action when the list becomes empty");

tree.destroy();
anchor.remove();
assert.equal(document.querySelector(".raze-chart-objects-tree"), null);

console.log("POPUP UI: PASS");
