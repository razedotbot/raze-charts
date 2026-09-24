// UI kit in a DOM without layout: scoped stylesheet adoption (document and
// shadow roots, CSP nonce), placement math, form controls, dialog lifecycle
// and the popup bottom-sheet presentation.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dom = new JSDOM('<!doctype html><html><head><meta property="csp-nonce" nonce="n0nce"></head><body></body></html>', {
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
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
});

const dir = mkdtempSync(join(tmpdir(), "raze-kit-"));
const wait = (ms = 0) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const key = (target, name, init = {}) => {
  const event = new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

try {
  const result = await build({
    stdin: {
      contents: [
        'export * from "./src/ui/kit/index.ts";',
        'export * from "./src/ui/styles.ts";',
        'export { openPopup, popupRow, ensureBaseStyles } from "./src/ui/popup.ts";',
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
  const file = join(dir, "kit.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  const kit = await import(pathToFileURL(file).href);

  // ── Stylesheet: one element per root, idempotent, nonce-aware ──────────
  kit.ensureBaseStyles();
  kit.ensureBaseStyles();
  const docStyles = document.querySelectorAll("style[data-raze-styles]");
  assert.equal(docStyles.length, 1, "one stylesheet per document");
  assert.equal(docStyles[0].id, "raze-chart-base-css", "the historic id is kept for the document sheet");
  assert.equal(docStyles[0].nonce, "n0nce", "the csp-nonce meta tag is honoured");
  assert.match(docStyles[0].textContent, /--raze-surface:/, "design tokens are part of the base sheet");
  assert.match(docStyles[0].textContent, /\.raze-chart-focusable:focus-visible/);
  const chunk = kit.defineStyles("test-chunk", ".raze-test{color:red}");
  kit.adoptStyles(document.body, chunk);
  kit.adoptStyles(document.body, [chunk]);
  assert.equal(document.querySelectorAll("style[data-raze-styles]").length, 1, "chunks extend the same sheet");
  assert.equal(docStyles[0].textContent.split(".raze-test{").length, 2, "a chunk is added once");

  const shadowHost = document.createElement("div");
  document.body.appendChild(shadowHost);
  const shadow = shadowHost.attachShadow({ mode: "open" });
  const inner = document.createElement("div");
  shadow.appendChild(inner);
  kit.ensureBaseStyles(inner, { nonce: "shadow-nonce" });
  const shadowStyle = shadow.querySelector("style[data-raze-styles]");
  assert(shadowStyle, "shadow roots receive their own scoped sheet");
  assert.equal(shadowStyle.nonce, "shadow-nonce", "an explicit nonce wins");
  assert.equal(shadow.firstChild, shadowStyle, "shadow sheets are prepended so component CSS can override");
  assert.equal(kit.styleRootOf(inner), shadow);
  kit.configureStyles({ nonce: "configured" });
  const other = document.createElement("div").attachShadow({ mode: "open" });
  kit.adoptStyles(other, chunk);
  assert.equal(other.querySelector("style").nonce, "configured", "configureStyles() sets the default nonce");

  // ── Placement math ────────────────────────────────────────────────────
  const viewport = { width: 400, height: 300 };
  const anchor = { left: 20, top: 260, width: 60, height: 20 };
  const flipped = kit.computePosition(anchor, { width: 100, height: 120 }, viewport, { placement: "bottom-start" });
  assert.equal(flipped.side, "top", "flips above when there is no room below");
  assert.equal(flipped.top, 260 - 4 - 120);
  const shifted = kit.computePosition({ left: 380, top: 10, width: 10, height: 10 }, { width: 100, height: 50 }, viewport, { placement: "bottom-start" });
  assert.equal(shifted.left, 400 - 8 - 100, "shifts back inside the viewport margin");
  const capped = kit.computePosition({ left: 10, top: 10, width: 10, height: 10 }, { width: 100, height: 900 }, viewport, { placement: "bottom-start" });
  assert.equal(capped.maxHeight, 300 - 20 - 4 - 8, "max height is the space on the chosen side");
  const rtl = kit.computePosition({ left: 100, top: 10, width: 50, height: 10 }, { width: 80, height: 40 }, viewport, { placement: "bottom-start", direction: "rtl" });
  assert.equal(rtl.left, 100 + 50 - 80, "start alignment mirrors in RTL");

  // ── Controls ──────────────────────────────────────────────────────────
  const changes = [];
  const number = kit.numberField({ label: "Length", value: 14, min: 1, max: 20, step: 1, onChange: (value) => changes.push(value) });
  document.body.appendChild(number.el);
  const spin = number.control;
  assert.equal(spin.getAttribute("role"), "spinbutton");
  assert.equal(document.querySelector(`label[for="${spin.id}"]`).textContent, "Length", "the stepper is labelled");
  assert.equal(key(spin, "ArrowUp").defaultPrevented, true);
  assert.equal(number.value, 15);
  key(spin, "PageUp");
  assert.equal(number.value, 20, "PageUp clamps to max");
  key(spin, "Home");
  assert.equal(number.value, 1);
  spin.value = "7,5";
  spin.dispatchEvent(new window.Event("change"));
  assert.equal(number.value, 8, "comma decimals parse and round to the step precision");
  spin.value = "abc";
  spin.dispatchEvent(new window.Event("input"));
  assert.equal(spin.getAttribute("aria-invalid"), "true");
  spin.dispatchEvent(new window.Event("change"));
  assert.equal(spin.value, "8", "invalid input reverts to the last value");
  assert.deepEqual(changes, [15, 20, 1, 8]);
  assert.equal(number.el.querySelectorAll("button[aria-label]").length, 2, "stepper buttons are named");
  assert.equal(kit.parseNumberInput("−1 234.5"), -1234.5);
  assert.equal(kit.parseNumberInput("1e3"), 1000);
  assert.equal(kit.parseNumberInput("12px"), null);

  assert.throws(() => kit.selectField({ label: "Source", value: "hl3", options: [{ value: "close", label: "Close" }] }), /not one of: close/);
  const select = kit.selectField({ label: "Source", value: "close", options: [{ value: "close", label: "Close" }, { value: "open", label: "Open" }] });
  assert.equal(select.control.tagName, "SELECT");
  select.value = "open";
  assert.equal(select.value, "open");

  const styleChanges = [];
  const lineStyle = kit.lineStyleField({ label: "Line style", value: "solid", onChange: (value) => styleChanges.push(value) });
  document.body.appendChild(lineStyle.el);
  const radios = [...lineStyle.el.querySelectorAll('[role="radio"]')];
  assert.equal(lineStyle.control.getAttribute("role"), "radiogroup");
  assert(document.getElementById(lineStyle.control.getAttribute("aria-labelledby")), "the radio group is labelled");
  assert.deepEqual(radios.map((radio) => radio.tabIndex), [0, -1, -1], "roving tabindex");
  radios[0].focus();
  key(radios[0], "ArrowRight");
  assert.equal(document.activeElement, radios[1]);
  assert.equal(radios[1].getAttribute("aria-checked"), "true");
  key(radios[1], "End");
  assert.deepEqual(styleChanges, ["dashed", "dotted"]);
  const lineWidth = kit.lineWidthField({ label: "Width", value: 2 });
  assert.equal(lineWidth.el.querySelectorAll('[role="radio"][aria-checked="true"]').length, 1);

  const checkbox = kit.checkboxField({ label: "Show labels", value: true });
  assert.equal(checkbox.control.type, "checkbox");
  assert.equal(checkbox.value, true);
  const text = kit.textField({ label: "Title", value: '<b>x</b>' });
  assert.equal(text.control.value, "<b>x</b>");

  assert.deepEqual(kit.parseColor("#abc"), { color: "#aabbcc", opacity: 1 });
  assert.deepEqual(kit.parseColor("#2962ff80"), { color: "#2962ff", opacity: 0.5 });
  assert.deepEqual(kit.parseColor("rgba(41, 98, 255, 0.25)"), { color: "#2962ff", opacity: 0.25 });
  assert.equal(kit.parseColor("red"), null);
  assert.equal(kit.toCssColor({ color: "#2962ff", opacity: 0.5 }), "rgba(41,98,255,0.5)");
  assert.equal(kit.toCssColor({ color: "#2962ff", opacity: 1 }), "#2962ff");
  const color = kit.colorField({ label: "Line color", value: { color: "#2962ff", opacity: 0.8 } });
  document.body.appendChild(color.el);
  assert.equal(document.getElementById(color.control.getAttribute("aria-describedby")).textContent, "#2962ff, 80% opacity");
  assert.throws(() => kit.colorField({ label: "Bad", value: { color: "nope", opacity: 1 } }), /expects a hex or rgb/);

  // ── Dialog lifecycle ──────────────────────────────────────────────────
  const opener = document.createElement("button");
  opener.textContent = "Settings";
  document.body.appendChild(opener);
  opener.focus();
  let submitted = 0;
  let allow = false;
  const dialog = kit.openDialog({
    title: "Moving Average",
    presentation: "dialog",
    tabs: [
      { id: "inputs", label: "Inputs", render: (panel) => panel.append(kit.numberField({ label: "Length", value: 9 }).el) },
      { id: "style", label: "Style", render: (panel) => panel.append(kit.checkboxField({ label: "Visible", value: true }).el) },
    ],
    onReset() {},
    onSubmit: () => {
      submitted++;
      return allow;
    },
  });
  const el = dialog.el;
  assert.equal(el.getAttribute("role"), "dialog");
  assert.equal(el.getAttribute("aria-modal"), "true");
  assert.equal(document.getElementById(el.getAttribute("aria-labelledby")).textContent, "Moving Average");
  assert.equal(document.documentElement.style.overflow, "hidden", "the page behind is scroll-locked");
  const tabs = [...el.querySelectorAll('[role="tab"]')];
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(el.querySelectorAll('[role="tabpanel"]').length, 1, "panels render lazily");
  assert.equal(document.activeElement.getAttribute("role"), "spinbutton", "focus starts on the first control");
  key(tabs[0], "ArrowRight");
  assert.equal(tabs[1].getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement, tabs[1]);
  assert.equal(dialog.body.querySelector('input[type="checkbox"]').checked, true);
  key(tabs[1], "Home");
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(el.querySelectorAll('[role="tabpanel"]').length, 2);
  assert.equal(el.querySelectorAll('[role="tabpanel"]:not([hidden])').length, 1);
  assert.throws(() => dialog.selectTab("nope"), /no tab "nope"; expected one of: inputs, style/);
  const buttons = [...el.querySelectorAll("button")].map((button) => button.textContent || button.getAttribute("aria-label"));
  assert.deepEqual(buttons.filter((name) => ["Close", "Reset to defaults", "Cancel", "OK"].includes(name)), ["Close", "Reset to defaults", "Cancel", "OK"]);

  el.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await wait();
  assert.equal(submitted, 1);
  assert.equal(dialog.closed, false, "onSubmit returning false keeps the dialog open");
  allow = true;
  el.dispatchEvent(new window.Event("submit", { cancelable: true }));
  assert.equal(await dialog.result, "ok");
  assert.equal(document.activeElement, opener, "focus returns to the opener");
  assert.equal(document.documentElement.style.overflow, "", "scroll lock is released");
  assert.equal(document.querySelector(".raze-kit-dialog"), null);

  opener.focus();
  const reasons = [];
  const escDialog = kit.openDialog({ title: "Go to", presentation: "dialog", content: kit.textField({ label: "Date", value: "" }).el, onCancel: (reason) => reasons.push(reason) });
  key(document.activeElement, "Escape");
  assert.equal(await escDialog.result, "escape");
  assert.deepEqual(reasons, ["escape"]);
  assert.equal(document.activeElement, opener);

  const desktop = kit.openDialog({ title: "Unsaved", presentation: "dialog", content: "text" });
  document.querySelector(".raze-kit-backdrop").click();
  assert.equal(desktop.closed, false, "a stray backdrop click does not discard a desktop dialog");
  desktop.close("cancel");
  assert.equal(await desktop.result, "cancel");
  const optIn = kit.openDialog({ title: "Info", presentation: "dialog", content: "text", closeOnBackdrop: true });
  document.querySelector(".raze-kit-backdrop").click();
  assert.equal(await optIn.result, "backdrop");

  const sheetDialog = kit.openDialog({ title: "Settings", presentation: "sheet", content: "text" });
  assert.equal(sheetDialog.presentation, "sheet");
  assert(sheetDialog.el.closest(".raze-kit-sheet"), "sheet dialogs live in a bottom sheet");
  assert(document.querySelector(".raze-kit-sheet-handle[aria-label='Close']"), "the drag handle is a named control");
  document.querySelector(".raze-kit-backdrop").click();
  assert.equal(await sheetDialog.result, "backdrop");

  // ── Popup presentation ───────────────────────────────────────────────
  const menuAnchor = document.createElement("button");
  document.body.appendChild(menuAnchor);
  menuAnchor.focus();
  const anchored = kit.openPopup({ anchor: menuAnchor, fontFamily: "sans-serif", label: "Menu" });
  assert.equal(anchored.presentation, "anchored", "wide fine-pointer viewports keep anchored menus");
  assert.equal(anchored.el.parentElement, document.body);
  anchored.close();
  const sheet = kit.openPopup({ anchor: menuAnchor, fontFamily: "sans-serif", label: "Indicators", presentation: "sheet" });
  sheet.el.appendChild(kit.popupRow("EMA 9", () => {}));
  assert.equal(sheet.presentation, "sheet");
  assert(sheet.el.closest(".raze-kit-sheet"), "menu content is hosted in a sheet");
  assert(sheet.el.closest(".raze-kit-portal"), "sheets are portalled");
  assert.equal(sheet.el.getAttribute("role"), "menu");
  await wait();
  document.querySelector(".raze-kit-sheet-handle").click();
  assert.equal(document.querySelector(".raze-kit-sheet"), null, "the handle closes the sheet");
  assert.equal(document.activeElement, menuAnchor, "focus returns to the menu button");
  assert.equal(menuAnchor.getAttribute("aria-expanded"), "false");
  assert.equal(document.documentElement.style.overflow, "");

  const dialogRole = kit.openPopup({ anchor: menuAnchor, fontFamily: "sans-serif", role: "dialog" });
  assert.equal(dialogRole.presentation, "anchored", "dialog-role popups (search results) stay anchored by default");
  dialogRole.close();
  assert.equal(kit.openLayerCount(), 0, "no overlay layers leak");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("UI KIT DOM: PASS");
