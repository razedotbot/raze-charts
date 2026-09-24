// Popup menus without layout (jsdom): TradingView context-menu conventions
// ("-" separators, "-Label" removals, position groups), row and separator
// semantics, class-based row styling, the deprecated padding override,
// tooltip teardown, and the container error for shadow-root mounts.
// Real-browser behaviour (focus, fullscreen, placement) is in popups.spec.ts.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true });
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

const wait = (ms = 0) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const key = (target, name) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
const warnings = [];
const errors = [];
const originalWarn = console.warn;
const originalError = console.error;
console.warn = (...args) => warnings.push(args.map(String).join(" "));
console.error = (...args) => errors.push(args.map(String).join(" "));

const dir = mkdtempSync(join(tmpdir(), "raze-popups-"));
try {
  const result = await build({
    stdin: {
      contents: [
        'export { openPopup, popupRow, popupSeparator, ensureBaseStyles, POPUP_STYLES } from "./src/ui/popup.ts";',
        'export { showContextMenu, closeContextMenu, resolveContextMenuEntries } from "./src/ui/ContextMenu.ts";',
        'export { attachTooltip } from "./src/ui/kit/Tooltip.ts";',
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const file = join(dir, "popups.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  const kit = await import(pathToFileURL(file).href);

  // ── Entry resolution (TradingView semantics) ───────────────────────────
  const noop = () => {};
  const labels = (entries) => entries.map((entry) => entry.kind === "separator" ? "-" : entry.item.text);
  const defaults = [
    { position: "top", text: "Reset chart view", click: noop },
    { position: "top", text: "Settings…", click: noop },
  ];
  assert.deepEqual(
    labels(kit.resolveContextMenuEntries([{ text: "A", click: noop }, { text: "-" }, { text: "B", click: noop }])),
    ["A", "-", "B"],
    '"-" is a separator between items',
  );
  assert.deepEqual(
    labels(kit.resolveContextMenuEntries([
      { position: "bottom", text: "Last", click: noop },
      { position: "top", text: "First", click: noop },
      { position: "top", text: "-" },
      { text: "-Reset chart view" },
    ], defaults)),
    ["First", "-", "Settings…", "Last"],
    '"-Label" removes the default item; top items precede the defaults and bottom items follow them',
  );
  assert.equal(warnings.length, 0, "a removal that matches a default item does not warn");
  assert.deepEqual(
    labels(kit.resolveContextMenuEntries([{ text: "-" }, { text: "-" }, { text: "A", click: noop }, { text: " - " }, { text: "-" }, { text: "B", click: noop }, { text: "-" }])),
    ["A", "-", "B"],
    "leading, trailing and doubled separators are dropped",
  );
  assert.deepEqual(labels(kit.resolveContextMenuEntries([{ text: "-Reset chart view" }])), [], "removals never render as rows");
  assert(warnings.some((line) => line.includes('"-Reset chart view" removes a default item') && line.includes("no default items")), "a removal with nothing to remove warns");
  warnings.length = 0;
  assert.deepEqual(labels(kit.resolveContextMenuEntries([null, 42, { text: 7 }, { text: "Ok", click: noop }])), ["Ok"], "malformed entries are skipped");
  assert.equal(warnings.filter((line) => line.includes("was skipped")).length, 1, "malformed entries warn once");
  warnings.length = 0;

  // ── Rendered context menu ──────────────────────────────────────────────
  const chart = document.createElement("div");
  chart.className = "raze-chart-root";
  chart.style.setProperty("--tv-color-popup-background", "#fafafa");
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  chart.appendChild(canvas);
  document.body.appendChild(chart);
  canvas.focus();
  const clicked = [];
  kit.showContextMenu(40, 50, [
    { position: "top", text: "Add alert here", click: () => clicked.push("alert") },
    { position: "top", text: "-" },
    { position: "top", text: "Reset chart", click: () => clicked.push("reset") },
    { position: "bottom", text: "Label only" },
    { position: "bottom", text: "Explodes", click: () => { throw new Error("boom"); } },
  ], "sans-serif", chart);
  let menu = document.querySelector(".raze-chart-context-menu");
  assert(menu, "the context menu opens");
  assert.equal(menu.getAttribute("role"), "menu");
  assert.equal(menu.getAttribute("aria-label"), "Chart context menu");
  assert(menu.classList.contains("raze-chart-popup"));
  const portal = menu.closest("[data-raze-portal]");
  assert(portal, "the context menu renders in a kit portal");
  assert.equal(portal.style.getPropertyValue("--tv-color-popup-background"), "#fafafa", "the portal mirrors the chart theme");
  assert.equal(menu.style.left, "40px");
  assert.equal(menu.style.top, "50px");
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  const separators = [...menu.querySelectorAll('[role="separator"]')];
  assert.deepEqual(items.map((item) => item.textContent), ["Add alert here", "Reset chart", "Label only", "Explodes"]);
  assert.equal(separators.length, 1, '"-" renders one separator');
  assert(separators[0].classList.contains("raze-chart-popup-separator"));
  assert.equal(separators[0].previousElementSibling, items[0]);
  assert.deepEqual(items.map((item) => [item.getAttribute("aria-posinset"), item.getAttribute("aria-setsize")]), [["1", "4"], ["2", "4"], ["3", "4"], ["4", "4"]], "separators are not counted in the set");
  assert.equal(items[2].getAttribute("aria-disabled"), "true", "an item without click is disabled");
  assert.equal(items[2].tabIndex, -1);
  assert(warnings.some((line) => line.includes('"Label only" has no click function')), "and warns");
  await wait();
  assert.equal(document.activeElement, items[0], "the first item takes focus");
  key(items[0], "ArrowDown");
  assert.equal(document.activeElement, items[1], "ArrowDown skips the separator");
  key(items[1], "ArrowDown");
  assert.equal(document.activeElement, items[3], "ArrowDown skips the disabled item");
  key(items[3], "ArrowUp");
  key(items[1], "ArrowUp");
  assert.equal(document.activeElement, items[0], "ArrowUp skips the separator");
  items[2].click();
  assert(menu.isConnected, "clicking a disabled item does nothing");
  items[3].click();
  assert.equal(menu.isConnected, false, "a throwing handler still closes the menu");
  assert(errors.some((line) => line.includes('context menu item "Explodes" threw')), "and is reported, not swallowed");
  assert.equal(document.activeElement, canvas, "focus returns to the chart");

  kit.showContextMenu(10, 10, [{ text: "-" }, { text: "-Reset chart view" }], "sans-serif", chart);
  assert.equal(document.querySelector(".raze-chart-context-menu"), null, "a menu with no items does not open");
  kit.showContextMenu(10, 10, [{ text: "Reset chart", click: () => clicked.push("reset") }], "sans-serif", chart);
  menu = document.querySelector(".raze-chart-context-menu");
  menu.querySelector('[role="menuitem"]').click();
  assert.deepEqual(clicked, ["reset"]);
  assert.equal(document.querySelector("[data-raze-portal]"), null, "closing removes the portal");

  // ── Rows are styled by classes, with no JS hover ───────────────────────
  const row = kit.popupRow("Row", noop);
  assert.equal(row.className, "raze-chart-popup-row");
  assert.equal(row.getAttribute("style"), null, "rows carry no inline styles");
  row.dispatchEvent(new window.MouseEvent("mouseenter"));
  assert.equal(row.style.background, "", "hover is a CSS state, not a mouseenter handler");
  const css = kit.POPUP_STYLES.css;
  for (const rule of [
    ".raze-chart-popup-row:focus",
    ".raze-chart-popup-row[aria-selected=true]",
    ":not(:focus-within) .raze-chart-popup-row:not([aria-disabled=true]):hover",
    "padding:var(--raze-popup-inset,4px)",
    "overscroll-behavior:contain",
    "@media (prefers-reduced-motion:reduce){.raze-chart-popup[data-presentation]{animation:none",
    "@keyframes raze-chart-popup-in",
  ]) assert(css.includes(rule), `popup stylesheet contains ${rule}`);
  const separator = kit.popupSeparator();
  assert.equal(separator.getAttribute("role"), "separator");

  kit.ensureBaseStyles();
  const sheet = document.querySelector("style[data-raze-styles]");
  assert(sheet?.textContent.includes(".raze-chart-popup-row"), "ensureBaseStyles installs the popup rules with the chrome sheet");

  // ── Anchored popups: portal, deprecated padding, anchor removal ────────
  const anchor = document.createElement("button");
  chart.appendChild(anchor);
  const popup = kit.openPopup({ anchor, fontFamily: "sans-serif", presentation: "anchored", minWidth: 200, padding: "2px 0" });
  assert.equal(popup.el.style.minWidth, "200px");
  assert.equal(popup.el.style.padding, "2px 0px", "an explicit padding still overrides the inset");
  assert.equal(popup.el.getAttribute("aria-label"), "Chart menu");
  assert.equal(anchor.getAttribute("aria-controls"), popup.el.id);
  anchor.remove();
  popup.reposition();
  assert.equal(popup.el.isConnected, false, "a popup whose anchor left the DOM closes on its next placement");
  assert.equal(anchor.getAttribute("aria-expanded"), "false");

  // ── Tab leaves a menu (menu-button pattern) ────────────────────────────
  chart.appendChild(anchor);
  anchor.focus();
  const tabbed = kit.openPopup({ anchor, fontFamily: "sans-serif", presentation: "anchored", label: "Tabbed" });
  const tabRow = tabbed.el.appendChild(kit.popupRow("One", noop));
  await wait();
  assert.equal(document.activeElement, tabRow);
  key(tabRow, "Tab");
  assert.equal(tabbed.el.isConnected, false, "Tab closes the menu");
  assert.equal(document.activeElement, anchor, "and hands focus to the opener before the browser moves on");

  // ── A re-render that removes the focused row keeps the menu ────────────
  const rerender = kit.openPopup({ anchor, fontFamily: "sans-serif", presentation: "anchored", label: "Rerender" });
  const first = rerender.el.appendChild(kit.popupRow("First", noop));
  rerender.el.appendChild(kit.popupRow("Second", noop));
  await wait();
  assert.equal(document.activeElement, first);
  first.remove(); // jsdom does not blur on removal; dispatch what browsers do
  first.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  await wait(5);
  assert(rerender.el.isConnected, "a removed focused row does not close the menu");
  assert.equal(document.activeElement?.textContent, "Second", "focus moves back into the menu");
  rerender.close();

  // ── Tooltip teardown restores what it replaced ─────────────────────────
  const titled = document.createElement("button");
  titled.setAttribute("title", "Native hint");
  titled.textContent = "Save";
  document.body.appendChild(titled);
  const tip = kit.attachTooltip(titled, "Save layout");
  assert.equal(titled.hasAttribute("title"), false, "the tooltip replaces the title");
  tip.destroy();
  assert.equal(titled.getAttribute("title"), "Native hint", "destroy() restores the replaced title");

  const iconOnly = document.createElement("button");
  document.body.appendChild(iconOnly);
  const iconTip = kit.attachTooltip(iconOnly, "Fit chart");
  assert.equal(iconOnly.getAttribute("aria-label"), "Fit chart", "an unnamed target is labelled by its tooltip");
  iconTip.update("Fit content");
  assert.equal(iconOnly.getAttribute("aria-label"), "Fit content");
  iconTip.destroy();
  assert.equal(iconOnly.hasAttribute("aria-label"), false, "destroy() removes the label only the tooltip provided");

  const relabelled = document.createElement("button");
  document.body.appendChild(relabelled);
  const relabelTip = kit.attachTooltip(relabelled, "Zoom");
  relabelled.setAttribute("aria-label", "Zoom in");
  relabelTip.destroy();
  assert.equal(relabelled.getAttribute("aria-label"), "Zoom in", "a label the host changed afterwards is kept");
} finally {
  console.warn = originalWarn;
  console.error = originalError;
  rmSync(dir, { recursive: true, force: true });
}

// ── A string container is resolved in the document only ─────────────────
{
  const { widget } = await import("../dist/charting_library.esm.js");
  assert.throws(
    () => new widget({ container: "missing-chart", symbol: "X", interval: "1", datafeed: {} }),
    /"#missing-chart" not found in the document.*inside a shadow root, pass the element itself/,
    "a missing string container explains how to mount inside a shadow root",
  );
}

console.log("POPUP MENUS: PASS");
