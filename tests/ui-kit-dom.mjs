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

  // Regression: a nonce given only to the public ensureBaseStyles() also
  // reaches overlays that later adopt styles into another root of the same
  // document (here a kit portal in a shadow root, <style> fallback).
  {
    const doc2 = new JSDOM("<!doctype html><html><head></head><body></body></html>").window.document;
    kit.ensureBaseStyles(doc2, { nonce: "x" });
    assert.equal(doc2.querySelector("style[data-raze-styles]").nonce, "x");
    const host2 = doc2.createElement("div");
    doc2.body.appendChild(host2);
    const shadow2 = host2.attachShadow({ mode: "open" });
    const anchor2 = doc2.createElement("button");
    shadow2.appendChild(anchor2);
    const portal2 = kit.createPortal({ anchor: anchor2 });
    assert.equal(portal2.el.parentNode, shadow2, "the portal renders in the anchor's shadow root");
    const style2 = shadow2.querySelector("style[data-raze-styles]");
    assert(style2, "the portal adopts its styles into the shadow root");
    assert.equal(style2.nonce, "x", "the document's explicit nonce is reused for other roots");
    portal2.destroy();
    const explicit = doc2.createElement("div").attachShadow({ mode: "open" });
    kit.adoptStyles(explicit, kit.defineStyles("nonce-override", ".raze-o{}"), { nonce: "y" });
    assert.equal(explicit.querySelector("style").nonce, "y", "an explicit per-call nonce still wins");
  }
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
  // Regression (axe aria-allowed-role): role="dialog" is not allowed on <form>.
  assert.equal(el.tagName, "DIV", "the dialog element is not a <form>");
  assert.equal(el.querySelector("form")?.noValidate, true, "a form inside the dialog provides Enter-to-submit");
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

  // Regression: while an async onSubmit is pending, user dismissals are
  // refused, so a half-applied submit is never reported as a cancel.
  {
    opener.focus();
    let release;
    const cancels = [];
    const busy = kit.openDialog({
      title: "Apply",
      presentation: "dialog",
      content: kit.textField({ label: "Name", value: "" }).el,
      onSubmit: () => new Promise((resolveSubmit) => {
        release = resolveSubmit;
      }),
      onCancel: (reason) => cancels.push(reason),
    });
    busy.el.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await wait();
    assert.equal(busy.el.getAttribute("aria-busy"), "true", "the dialog reports that it is busy");
    const cancelButton = [...busy.el.querySelectorAll("button")].find((candidate) => candidate.textContent === "Cancel");
    const closeButton = busy.el.querySelector('button[aria-label="Close"]');
    assert.equal(cancelButton.disabled, true, "Cancel is disabled while submitting");
    assert.equal(closeButton.disabled, true, "the close button is disabled while submitting");
    assert.equal(key(busy.el.querySelector("input"), "Escape").defaultPrevented, true, "Escape is consumed by the busy dialog");
    cancelButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(busy.closed, false, "Escape and Cancel do not close a submitting dialog");
    assert.deepEqual(cancels, []);
    release();
    assert.equal(await busy.result, "ok", "the pending submit completes as OK");
    assert.deepEqual(cancels, [], "onCancel never ran");
    assert.equal(document.activeElement, opener);

    // Sheets snap back from a refused backdrop tap and can be dismissed once
    // the submit settles (here with a veto).
    let veto;
    const sheetCancels = [];
    const busySheet = kit.openDialog({
      title: "Apply",
      presentation: "sheet",
      content: "text",
      onSubmit: () => new Promise((resolveSubmit) => {
        veto = () => resolveSubmit(false);
      }),
      onCancel: (reason) => sheetCancels.push(reason),
    });
    busySheet.el.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await wait();
    document.querySelector(".raze-kit-backdrop").click();
    assert.equal(busySheet.closed, false, "a backdrop tap does not dismiss a submitting sheet");
    veto();
    await wait();
    assert.equal(busySheet.el.hasAttribute("aria-busy"), false, "a vetoed submit clears the busy state");
    assert.equal(busySheet.closed, false, "a vetoed submit keeps the sheet open");
    document.querySelector(".raze-kit-backdrop").click();
    assert.equal(await busySheet.result, "backdrop", "the sheet accepts a dismissal after the submit settles");
    assert.deepEqual(sheetCancels, ["backdrop"]);

    // Code can always close a busy dialog.
    const forced = kit.openDialog({ title: "Apply", presentation: "dialog", content: "text", onSubmit: () => new Promise(() => {}) });
    forced.el.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await wait();
    forced.close("cancel");
    assert.equal(await forced.result, "cancel", "close() from code is the forced path");
  }

  // Regression: a content or tab render callback that throws while the
  // dialog opens used to leave the portal mounted, the page scroll-locked
  // and the focus trap and overlay layer installed until reload.
  {
    opener.focus();
    const layersBefore = kit.openLayerCount();
    const broken = [
      { title: "Broken tab", presentation: "dialog", tabs: [{ id: "a", label: "A", render() { throw new Error("tab boom"); } }] },
      { title: "Broken sheet tab", presentation: "sheet", tabs: [{ id: "a", label: "A", render() { throw new Error("tab boom"); } }] },
      { title: "Broken body", presentation: "dialog", content() { throw new Error("body boom"); } },
      {
        title: "Focus then throw",
        presentation: "dialog",
        content(body) {
          const field = kit.textField({ label: "Name", value: "" }).el;
          body.append(field);
          field.querySelector("input").focus();
          throw new TypeError("late boom");
        },
      },
    ];
    for (const options of broken) {
      assert.throws(() => kit.openDialog(options), (error) => {
        assert.match(error.message, /^\[raze-charts\] dialog content threw while opening "/, options.title);
        assert.match(error.cause?.message ?? "", /boom/, "the original error is the cause");
        return true;
      });
      assert.equal(document.documentElement.style.overflow, "", `${options.title}: the scroll lock is released`);
      assert.equal(kit.openLayerCount(), layersBefore, `${options.title}: the overlay layer is removed`);
      assert.equal(document.querySelector("[data-raze-portal]"), null, `${options.title}: the portal is removed`);
      assert.equal(document.activeElement, opener, `${options.title}: focus stays on (or returns to) the opener`);
      const free = document.createElement("button");
      document.body.appendChild(free);
      free.focus();
      assert.equal(document.activeElement, free, `${options.title}: no focus trap is left behind`);
      free.remove();
      opener.focus();
    }
    // Option errors are cleaned up the same way and keep their own message.
    assert.throws(
      () => kit.openDialog({ title: "Dupes", tabs: [{ id: "x", label: "X", render() {} }, { id: "x", label: "Y", render() {} }] }),
      /^RangeError: \[raze-charts\] duplicate dialog tab id "x"/,
    );
    assert.throws(() => kit.openDialog({ title: "Missing", tabs: [{ id: "x", label: "X", render() {} }], initialTab: "nope" }), /no tab "nope"/);
    assert.equal(document.documentElement.style.overflow, "");
    assert.equal(kit.openLayerCount(), layersBefore);
    assert.equal(document.querySelector("[data-raze-portal]"), null);

    // A tab whose render throws later leaves the selection and panels as
    // they were, and selecting it again retries the render.
    let attempts = 0;
    const tabbed = kit.openDialog({
      title: "Later",
      presentation: "dialog",
      tabs: [
        { id: "ok", label: "OK tab", render: (panel) => panel.append("fine") },
        {
          id: "flaky",
          label: "Flaky",
          render(panel) {
            attempts++;
            if (attempts === 1) throw new Error("flaky boom");
            panel.append("second try");
          },
        },
      ],
    });
    assert.throws(() => tabbed.selectTab("flaky"), /flaky boom/);
    const tabEls = [...tabbed.el.querySelectorAll('[role="tab"]')];
    assert.deepEqual(tabEls.map((tab) => tab.getAttribute("aria-selected")), ["true", "false"], "the selection is unchanged");
    assert.equal(tabbed.el.querySelectorAll('[role="tabpanel"]').length, 1, "no half-rendered panel is left");
    assert.equal(tabbed.body.textContent, "fine");
    tabbed.selectTab("flaky");
    assert.equal(tabbed.body.textContent, "second try", "selecting the tab again renders it");
    tabbed.close();
    assert.equal(await tabbed.result, "api");
  }

  // ── Sheet modality (aria-modal only on dialogs) ──────────────────────
  {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const menuSheet = kit.openPopover({ anchor, label: "Timeframes", role: "menu", presentation: "sheet", content: "1m" });
    const container = menuSheet.el.closest(".raze-kit-sheet");
    assert.equal(menuSheet.el.hasAttribute("aria-modal"), false, "a menu surface does not carry aria-modal");
    assert.equal(container.getAttribute("role"), "dialog", "the sheet is the dialog container");
    assert.equal(container.getAttribute("aria-modal"), "true");
    assert.equal(container.getAttribute("aria-label"), "Timeframes");
    menuSheet.close();
    const dialogSheet = kit.openPopover({ anchor, label: "Quick settings", presentation: "sheet", content: "Hello" });
    assert.equal(dialogSheet.el.getAttribute("aria-modal"), "true", "a dialog surface is itself modal");
    assert.equal(dialogSheet.el.closest(".raze-kit-sheet").hasAttribute("role"), false, "no nested dialog container");
    dialogSheet.close();
    const anchored = kit.openPopover({ anchor, label: "Anchored", presentation: "anchored", content: "Hi" });
    assert.equal(anchored.el.hasAttribute("aria-modal"), false, "anchored popovers are not modal");
    anchored.close();
    anchor.remove();
  }

  // ── Tooltip and toast lifecycles ─────────────────────────────────────
  {
    // Regression: a visible tooltip whose target is removed (re-render or
    // destroy fires no pointerleave/blur) hides itself and its listeners.
    const tipTarget = document.createElement("button");
    tipTarget.textContent = "Fit";
    document.body.appendChild(tipTarget);
    const tip = kit.attachTooltip(tipTarget, "Fit chart (Alt+R)");
    tip.show();
    assert(document.querySelector('[role="tooltip"]'), "the tooltip is visible");
    assert.equal(tipTarget.getAttribute("aria-describedby"), document.querySelector('[role="tooltip"]').id);
    tipTarget.remove();
    await wait(400);
    assert.equal(document.querySelector('[role="tooltip"]'), null, "a detached target's tooltip hides");
    assert.equal(document.querySelector("[data-raze-portal]"), null, "its portal is removed");
    tip.destroy();

    // Regression: a pointerleave without a prior pause must not start a
    // second timer that later closes the toast while it is hovered.
    const toast = kit.showToast("Layout saved", { duration: 150 });
    await wait(80); // the first toast in a new region is inserted after 50ms
    assert(toast.el.isConnected, "the toast is shown");
    toast.el.dispatchEvent(new window.Event("pointerleave"));
    toast.el.dispatchEvent(new window.Event("pointerenter"));
    await wait(300);
    assert(toast.el.isConnected, "a hovered toast stays open (no orphaned timer)");
    // Focus keeps it open even after the pointer leaves.
    toast.el.dispatchEvent(new window.FocusEvent("focusin"));
    toast.el.dispatchEvent(new window.Event("pointerleave"));
    await wait(300);
    assert(toast.el.isConnected, "a focused toast stays open when the pointer leaves");
    toast.el.dispatchEvent(new window.FocusEvent("focusout", { relatedTarget: null }));
    toast.close();
    assert.equal(document.querySelector(".raze-kit-toasts"), null, "the toast region is removed with its last toast");
  }

  // ── Sheet preference watcher (rotation / resize across 520px) ────────
  {
    const flips = [];
    const width = window.innerWidth;
    const stop = kit.watchSheetPreference((sheet) => flips.push(sheet), window);
    const resizeTo = (next) => {
      window.innerWidth = next;
      window.dispatchEvent(new window.Event("resize"));
    };
    resizeTo(400);
    resizeTo(390); // still narrow: no second notification
    resizeTo(1024);
    stop();
    resizeTo(300); // no longer watching
    window.innerWidth = width;
    assert.deepEqual(flips, [true, false], "only real flips are reported, until stopped");
  }

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
  // Regression: a menu sheet is modal, exposed through a dialog container
  // because aria-modal is not allowed on role="menu".
  assert.equal(sheet.el.hasAttribute("aria-modal"), false);
  assert.equal(sheet.el.closest(".raze-kit-sheet").getAttribute("role"), "dialog");
  assert.equal(sheet.el.closest(".raze-kit-sheet").getAttribute("aria-modal"), "true");
  assert.equal(sheet.el.closest(".raze-kit-sheet").getAttribute("aria-label"), "Indicators");
  await wait();
  document.querySelector(".raze-kit-sheet-handle").click();
  assert.equal(document.querySelector(".raze-kit-sheet"), null, "the handle closes the sheet");
  assert.equal(document.activeElement, menuAnchor, "focus returns to the menu button");
  assert.equal(menuAnchor.getAttribute("aria-expanded"), "false");
  assert.equal(document.documentElement.style.overflow, "");

  // A menu opened from a modal kit dialog joins the overlay stack, so the
  // dialog's focus trap lets focus into it.
  {
    const host = kit.openDialog({ title: "Settings", presentation: "dialog", content: kit.textField({ label: "Name", value: "" }).el });
    const nestedAnchor = document.createElement("button");
    host.body.appendChild(nestedAnchor);
    const nested = kit.openPopup({ anchor: nestedAnchor, fontFamily: "sans-serif", label: "Options", presentation: "anchored" });
    const nestedRow = kit.popupRow("Duplicate", () => {});
    nested.el.appendChild(nestedRow);
    nestedRow.focus();
    assert.equal(document.activeElement, nestedRow, "focus can enter a popup stacked above a modal dialog");
    nested.close();
    host.close();
    await host.result;
  }

  const dialogRole = kit.openPopup({ anchor: menuAnchor, fontFamily: "sans-serif", role: "dialog" });
  assert.equal(dialogRole.presentation, "anchored", "dialog-role popups (search results) stay anchored by default");
  assert.equal(dialogRole.el.hasAttribute("aria-modal"), false, "anchored dialog-role popups are not modal");
  dialogRole.close();
  const dialogSheetPopup = kit.openPopup({ anchor: menuAnchor, fontFamily: "sans-serif", role: "dialog", label: "Search", presentation: "sheet" });
  assert.equal(dialogSheetPopup.el.getAttribute("aria-modal"), "true", "a dialog-role sheet popup is itself modal");
  assert.equal(dialogSheetPopup.el.closest(".raze-kit-sheet").hasAttribute("role"), false);
  dialogSheetPopup.close();

  // An anchored menu stays open while focus moves between its rows and
  // closes when focus arrives anywhere else.
  {
    menuAnchor.focus();
    const menu = kit.openPopup({ anchor: menuAnchor, fontFamily: "sans-serif", label: "Menu", presentation: "anchored" });
    const rows = ["One", "Two"].map((label) => menu.el.appendChild(kit.popupRow(label, () => {})));
    await wait();
    assert.equal(document.activeElement, rows[0]);
    rows[1].focus();
    await wait();
    assert(menu.el.isConnected, "moving focus between rows keeps the menu open");
    menuAnchor.focus();
    await wait();
    assert(menu.el.isConnected, "focus on the anchor keeps the menu open");
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    await wait();
    assert.equal(menu.el.isConnected, false, "focus elsewhere closes the menu");
    assert.equal(document.activeElement, elsewhere, "without pulling focus back");

    // Only focus that was inside can leave: a popup that never took focus
    // (combobox results) or has not yet (a context menu while the chart
    // focuses its canvas) stays open when focus moves between outside nodes.
    const results = kit.openPopup({ anchor: menuAnchor, fontFamily: "sans-serif", role: "dialog", label: "Results", initialFocus: false });
    const option = results.el.appendChild(kit.popupRow("AAPL", () => {}));
    await wait();
    elsewhere.focus();
    await wait();
    assert(results.el.isConnected, "focus moving outside a popup that never had it keeps it open");
    option.focus();
    elsewhere.focus();
    await wait();
    assert.equal(results.el.isConnected, false, "once focus has been inside, leaving closes it");
    elsewhere.remove();
  }
  assert.equal(kit.openLayerCount(), 0, "no overlay layers leak");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("UI KIT DOM: PASS");
