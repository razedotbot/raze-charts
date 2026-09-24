// Sidebar, menus and the icon set (W1B-23), in a DOM without layout: one
// 18px / 1.5-stroke icon family from src/ui/icons.ts, candle wicks drawn as
// strokes, distinct fit and fullscreen icons, fixed check slots instead of
// "✓ " label prefixes, kit tooltips instead of title attributes (500ms hover,
// keyboard focus, Escape), class-based styles, and the muted-text token on
// the Indicators "Clear all" row. Real-browser geometry, contrast and touch
// long-press live in tests/sidebar-icons.spec.ts.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
});

const wait = (ms = 0) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const dir = mkdtempSync(join(tmpdir(), "raze-sidebar-"));

try {
  const result = await build({
    stdin: {
      contents: [
        'export * from "./src/ui/icons.ts";',
        'export { LeftSidebar, DEFAULT_SIDEBAR_ITEMS, SIDEBAR_STYLES } from "./src/ui/LeftSidebar.ts";',
        'export { IndicatorsMenu } from "./src/ui/IndicatorsMenu.ts";',
        'export { ObjectsTree } from "./src/ui/ObjectsTree.ts";',
        'export { TOKEN_STYLES } from "./src/ui/styles.ts";',
        'export { registerMessages, setLocale } from "./src/i18n/index.ts";',
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
  const file = join(dir, "sidebar.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  const ui = await import(pathToFileURL(file).href);

  // ── The icon set ──────────────────────────────────────────────────────
  const icons = Object.entries(ui).filter(([name]) => /^ICON_[A-Z_]+$/.test(name) && name !== "ICON_STROKE");
  assert(icons.length >= 30, "the set covers tools, actions, chart types and menu glyphs");
  for (const [name, def] of icons) {
    const svg = ui.createIcon(def);
    assert.equal(svg.namespaceURI, "http://www.w3.org/2000/svg", `${name}: a real SVG element`);
    assert.equal(svg.getAttribute("viewBox"), "0 0 18 18", `${name}: 18px grid`);
    assert.equal(svg.getAttribute("width"), "18");
    assert.equal(svg.getAttribute("stroke-width"), "1.5", `${name}: 1.5 stroke`);
    assert.equal(svg.getAttribute("stroke-linecap"), "round", `${name}: round caps`);
    assert.equal(svg.getAttribute("stroke-linejoin"), "round", `${name}: round joins`);
    assert.equal(svg.getAttribute("stroke"), "currentColor", `${name}: inherits the control colour`);
    assert.equal(svg.getAttribute("aria-hidden"), "true", `${name}: decorative`);
    assert(svg.querySelector("path"), `${name}: has geometry`);
    for (const path of svg.querySelectorAll("path")) {
      assert.equal(path.hasAttribute("stroke-width"), false, `${name}: no per-path stroke widths`);
      assert.match(path.getAttribute("d"), /^M[\d.]/, `${name}: path data starts with a move`);
    }
    // Every coordinate stays inside the 18px box.
    const numbers = [...Object.values(def).join(" ").matchAll(/-?\d*\.?\d+/g)].map((match) => Number(match[0]));
    assert(numbers.every((value) => Math.abs(value) <= 18), `${name}: coordinates fit the grid`);
  }
  assert.notDeepEqual(ui.ICON_FIT, ui.ICON_FULLSCREEN, "fit and fullscreen are different icons");
  // Candle wicks are stroked (visible), bodies are filled; the old icon drew
  // its wicks as zero-area subpaths of a fill-only path.
  const candles = ui.createIcon(ui.ICON_CANDLES);
  const [wicks, bodies] = candles.querySelectorAll("path");
  assert.equal(wicks.getAttribute("fill"), null, "wicks are strokes, not fills");
  assert.match(wicks.getAttribute("d"), /^M5\.5 3v12M12\.5 2\.5v11$/, "one wick per candle, top to bottom");
  assert.equal(bodies.getAttribute("fill"), "currentColor", "bodies are solid");

  // ── Sidebar: icons, tooltips, class-based styles ──────────────────────
  const context = { fontFamily: "sans-serif", magnet: false, stayInDrawingMode: false, volumeMode: "overlay", requestPaint() {} };
  const calls = [];
  const sidebar = new ui.LeftSidebar(context, {
    onTool: (tool) => calls.push(`tool:${tool}`),
    onIndicatorsClick() {},
    onObjectsTreeClick() {},
    onFit: () => calls.push("fit"),
    onScreenshot() {},
    onFullscreen: () => calls.push("fullscreen"),
    onChartType: (style) => calls.push(`style:${style}`),
  });
  document.body.appendChild(sidebar.el);
  await wait();
  assert.equal(sidebar.el.getAttribute("style"), null, "the sidebar has no inline styles");
  assert.equal(document.querySelectorAll("[title]").length, 0, "no title attributes on built-in controls");
  const buttons = [...sidebar.el.querySelectorAll("button")];
  assert.equal(buttons.length, 16);
  for (const button of buttons) {
    assert.equal(button.getAttribute("style"), null, `${button.getAttribute("aria-label")}: class-based styling`);
    assert(button.classList.contains("raze-chart-sidebar-button"));
    const svg = button.querySelector("svg");
    assert.equal(svg?.getAttribute("stroke-width"), "1.5", `${button.getAttribute("aria-label")}: icon from the shared set`);
  }
  // Locale-independent hooks, and the shortcut exposed semantically.
  assert.deepEqual(
    buttons.map((button) => button.dataset.razeItem),
    ui.DEFAULT_SIDEBAR_ITEMS.filter((item) => item !== "separator"),
    "every built-in button carries its item id in data-raze-item",
  );
  for (const button of buttons) {
    const expected = button.dataset.razeItem === "fit" ? "F" : null;
    assert.equal(button.getAttribute("aria-keyshortcuts"), expected, `${button.dataset.razeItem}: aria-keyshortcuts`);
  }
  for (const separator of sidebar.el.querySelectorAll('[role="separator"]')) {
    assert.equal(separator.getAttribute("style"), null, "separators are class-styled");
  }
  const sheet = [...document.querySelectorAll("style[data-raze-styles]")].map((style) => style.textContent).join("\n");
  assert.match(sheet, /\.raze-chart-sidebar-button\{/, "the sidebar stylesheet is adopted");
  assert.match(sheet, /\.raze-chart-sidebar-button\[aria-pressed=true\]/, "pressed state is styled from ARIA state");
  const byName = (name) => sidebar.el.querySelector(`button[aria-label="${name}"]`);
  const pathsOf = (button) => [...button.querySelectorAll("path")].map((path) => path.getAttribute("d")).join("|");
  assert.notEqual(pathsOf(byName("Fit content")), pathsOf(byName("Fullscreen")), "fit and fullscreen buttons differ");
  assert.equal(byName("Cursor / pan").getAttribute("aria-pressed"), "true");
  byName("Trend line").click();
  assert.equal(byName("Trend line").getAttribute("aria-pressed"), "true", "pressed state follows the active tool");
  assert.equal(byName("Cursor / pan").getAttribute("aria-pressed"), "false");
  assert.deepEqual(calls, ["tool:trend_line"]);

  // Tooltip: 500ms hover delay, placed right of the sidebar, Escape hides.
  const trend = byName("Trend line");
  trend.dispatchEvent(new window.Event("pointerenter"));
  await wait(420);
  assert.equal(document.querySelector('[role="tooltip"]'), null, "no tooltip before 500ms of hover");
  await wait(150);
  const tooltip = document.querySelector('[role="tooltip"]');
  assert.equal(tooltip?.textContent, "Trend line", "the tooltip shows after 500ms of hover");
  // The name already says it: no redundant description.
  assert.equal(trend.getAttribute("aria-describedby"), null);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(document.querySelector('[role="tooltip"]'), null, "Escape hides the tooltip");
  trend.dispatchEvent(new window.Event("pointerleave"));
  await wait(450); // leave the kit's warm window

  // Shortcut hints are part of the tooltip and exposed as a description.
  const fit = byName("Fit content");
  fit.dispatchEvent(new window.Event("pointerenter"));
  await wait(550);
  const fitTip = document.querySelector('[role="tooltip"]');
  assert.equal(fitTip?.textContent, "Fit content\u2003F", "tooltip carries the keyboard shortcut");
  assert.equal(fit.getAttribute("aria-describedby"), fitTip.id, "aria-describedby links the hint");
  fit.dispatchEvent(new window.Event("pointerleave"));
  await wait(150);
  assert.equal(document.querySelector('[role="tooltip"]'), null);

  // No tooltip over a button whose menu is open.
  const indicatorsButton = byName("Indicators");
  indicatorsButton.setAttribute("aria-expanded", "true");
  indicatorsButton.dispatchEvent(new window.Event("pointerenter"));
  await wait(600);
  assert.equal(document.querySelector('[role="tooltip"]'), null, "an open menu is not covered by its button's tooltip");
  indicatorsButton.setAttribute("aria-expanded", "false");
  indicatorsButton.dispatchEvent(new window.Event("pointerleave"));

  // The chart-type menu: aligned check slots, icons, no "✓ " text.
  const chartType = byName("Chart type: Candles");
  assert(chartType, "the chart-type button names the current style");
  assert(chartType.querySelector("svg path[fill]"), "the chart-type button shows the candles icon");
  chartType.click();
  await wait();
  const styleMenu = document.querySelector(".raze-chart-style-menu");
  const styleRows = [...styleMenu.querySelectorAll('[role="menuitemradio"]')];
  assert.equal(styleRows.length, 8);
  for (const row of styleRows) {
    const [check, icon, label] = row.children;
    assert(check.classList.contains("raze-menu-check"), "every row starts with the check slot");
    assert(icon.classList.contains("raze-menu-icon"));
    assert(label.classList.contains("raze-menu-label"));
    assert.equal(!!check.querySelector("svg"), row.getAttribute("aria-checked") === "true", "the check icon marks only the checked row");
    assert.doesNotMatch(row.textContent, /✓/, "no check glyph in label text");
    assert.equal(row.textContent, row.getAttribute("aria-label"));
  }
  styleRows[1].click();
  assert.deepEqual(calls.slice(-1), ["style:line"]);
  assert(byName("Chart type: Line"), "the button follows the chosen style");
  sidebar.destroy();
  await wait();
  assert.equal(document.querySelector('[role="tooltip"]'), null);

  // ── Indicators menu: check slots and the muted "Clear all" row ─────────
  const studies = [];
  const store = {
    list: () => studies,
    add: (study) => studies.push({ id: `s${studies.length}`, ...study }),
    remove: (id) => studies.splice(studies.findIndex((study) => study.id === id), 1),
    clear: () => studies.splice(0),
  };
  const presets = [
    { label: "EMA 9", name: "EMA", length: 9, color: "#f5a623" },
    { label: "EMA 21", name: "EMA", length: 21, color: "#26a69a" },
  ];
  const menu = new ui.IndicatorsMenu(context, store, presets);
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  menu.open(anchor);
  await wait();
  let panel = document.querySelector(".raze-chart-indicators-menu");
  panel.querySelectorAll('[role="menuitemcheckbox"]')[1].click();
  panel = document.querySelector(".raze-chart-indicators-menu");
  const presetRows = [...panel.querySelectorAll('[role="menuitemcheckbox"]')];
  assert.deepEqual(presetRows.map((row) => row.getAttribute("aria-checked")), ["false", "true"]);
  assert.deepEqual(presetRows.map((row) => row.textContent), ["EMA 9", "EMA 21"], "checked labels are not prefixed");
  for (const row of presetRows) {
    assert.equal(row.style.fontWeight, "", "no bold toggle that reflows the label");
    assert(row.children[0].classList.contains("raze-menu-check"));
    assert(row.querySelector(".raze-menu-swatch"), "the colour swatch sits in the icon slot");
  }
  assert(panel.querySelector('[role="separator"]'), "Clear all is separated by a menu separator");
  const clear = panel.querySelector('[role="menuitem"]');
  assert.equal(clear.getAttribute("aria-label"), "Clear all indicators");
  assert(clear.querySelector(".raze-menu-label.raze-menu-muted"), "Clear all uses the muted text token");
  assert.doesNotMatch(clear.getAttribute("style") ?? "", /#8b887e/i, "no low-contrast literal colour");
  const tokens = ui.TOKEN_STYLES.css;
  assert.match(tokens, /--raze-text-muted:color-mix\(in srgb,var\(--raze-text\) 72%,var\(--raze-surface\)\)/, "muted text is a design token");
  menu.destroy();

  // ── Objects tree: icons and stable checkbox labels ─────────────────────
  const shapes = [{ id: "shape-1", shape: "trend_line", hidden: false, showInObjectsTree: true }];
  const shapeStore = {
    list: () => shapes,
    setHidden: (id, hidden) => { shapes.find((shape) => shape.id === id).hidden = hidden; },
    remove: (id) => shapes.splice(shapes.findIndex((shape) => shape.id === id), 1),
  };
  const tree = new ui.ObjectsTree(context, shapeStore, store);
  tree.open(anchor);
  await wait();
  panel = document.querySelector(".raze-chart-objects-tree");
  panel.querySelector('[role="menuitemcheckbox"]').click(); // magnet on
  panel = document.querySelector(".raze-chart-objects-tree");
  const treeRows = [...panel.querySelectorAll('[role^="menuitem"]')];
  assert.deepEqual(treeRows.map((row) => row.textContent), [
    "Magnet OHLC",
    "Stay in drawing mode",
    "Volume: overlay",
    "Show trend line",
    "Delete trend line",
    "Remove EMA 21",
  ]);
  for (const row of treeRows) {
    assert(row.children[0].classList.contains("raze-menu-check"), `${row.textContent}: check slot`);
    assert.equal(row.children[1].querySelector("svg")?.getAttribute("stroke-width"), "1.5", `${row.textContent}: icon from the set`);
    assert.equal(row.getAttribute("aria-label"), row.textContent, `${row.textContent}: name matches the visible label`);
  }
  assert.equal(treeRows[0].getAttribute("aria-checked"), "true");
  assert(treeRows[0].querySelector(".raze-menu-check svg"), "checked rows show the check icon");
  assert.equal(treeRows[3].getAttribute("aria-checked"), "true", "a visible drawing is a checked 'Show' row");
  treeRows[3].click();
  panel = document.querySelector(".raze-chart-objects-tree");
  const hiddenRow = panel.querySelectorAll('[role="menuitemcheckbox"]')[2];
  assert.equal(hiddenRow.textContent, "Show trend line", "the checkbox keeps its name when toggled");
  assert.equal(hiddenRow.getAttribute("aria-checked"), "false");
  assert.equal(document.querySelectorAll("[title]").length, 0, "menus use no title attributes");
  tree.destroy();

  // ── Translated names: data-raze-item still finds built-in buttons ──────
  // Accessible names follow the locale, so code that needs a built-in button
  // (executeActionById("objects_tree"), host tests) selects it by item id.
  ui.registerMessages("de", { "sidebar.objectsTree": "Objektbaum", "sidebar.fit": "Inhalt einpassen" });
  await ui.setLocale("de");
  try {
    const localized = new ui.LeftSidebar(context, {
      onTool() {}, onIndicatorsClick() {}, onFit() {}, onScreenshot() {}, onFullscreen() {}, onChartType() {},
    });
    document.body.appendChild(localized.el);
    const treeButton = localized.el.querySelector('[data-raze-item="objects_tree"]');
    assert.equal(treeButton?.getAttribute("aria-label"), "Objektbaum", "the name is translated");
    assert.equal(localized.el.querySelector('[aria-label="Objects tree"]'), null, "the English name is no selector");
    const fitButton = localized.el.querySelector('[data-raze-item="fit"]');
    assert.equal(fitButton?.getAttribute("aria-label"), "Inhalt einpassen");
    assert.equal(fitButton?.getAttribute("aria-keyshortcuts"), "F", "the shortcut does not depend on the locale");
    localized.destroy();
  } finally {
    await ui.setLocale("en");
  }

  // ── Sources: no title attributes or check glyphs remain ────────────────
  for (const path of ["src/ui/LeftSidebar.ts", "src/ui/IndicatorsMenu.ts", "src/ui/ObjectsTree.ts"]) {
    const source = readFileSync(resolve(root, path), "utf8");
    assert.doesNotMatch(source, /\.title\s*=|setAttribute\("title"/, `${path}: no title attributes`);
    assert.doesNotMatch(source, /✓/, `${path}: no check glyph prefixes`);
    assert.doesNotMatch(source, /<svg/, `${path}: icons come from src/ui/icons.ts`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("SIDEBAR ICONS: PASS");
