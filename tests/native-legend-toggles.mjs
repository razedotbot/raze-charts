#!/usr/bin/env node
// Mounted native legend: one pointer path and one interactive element per
// entry, on both renderers. The toggle buttons over the entries serve the
// keyboard and screen readers and take no pointer events; pointers hit the
// painted entry, which shows the pointer cursor and toggles without also
// selecting a datum. The `+N more` summary goes through t("chart.legend.more").
// The browser half (real hit-testing, mouse, touch, keyboard) is
// tests/native-legend-toggle.spec.ts. Bundled from source with esbuild so the
// compiler and the test share one i18n runtime.

import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function importSource() {
  const bundled = await build({
    stdin: {
      contents: [
        'export { compileChart, defineChart, line, mountChart, pie, svgFromCompiled } from "./src/chart/index";',
        'export { registerMessages, setLocale } from "./src/i18n";',
        'export { estimateTextWidth, TOP_LEGEND } from "./src/chart/compile/legend";',
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
      sourcefile: "native-legend-toggles-internals.ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const scratch = mkdtempSync(join(tmpdir(), "raze-native-legend-"));
  try {
    const file = join(scratch, "internals.mjs");
    writeFileSync(file, bundled.outputFiles[0].text);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const {
  TOP_LEGEND, compileChart, defineChart, estimateTextWidth, line, mountChart, pie, registerMessages, setLocale, svgFromCompiled,
} = await importSource();

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.SVGElement = window.SVGElement;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLCanvasElement.prototype.getContext = function getContext() {
  const noop = () => {};
  return new Proxy({ globalAlpha: 1, measureText: (text) => ({ width: String(text).length * 6 }) }, {
    get: (target, key) => (key in target ? target[key] : noop),
    set: (target, key, value) => { target[key] = value; return true; },
  });
};

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

const pair = defineChart({
  marks: [
    line([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 2 }], { x: "x", y: "y", name: "Alpha" }),
    line([{ x: 0, y: 2 }, { x: 1, y: 1 }, { x: 2, y: 4 }], { x: "x", y: "y", name: "Beta" }),
  ],
});

/** Mount into a fresh host; jsdom has no layout, so client and scene pixels coincide. */
function mount(definition, options) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = mountChart(host, definition, options);
  const wrap = host.firstElementChild;
  const [stage] = wrap.children;
  const fire = (type, init = {}, target = wrap) => {
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  };
  const centre = (id) => {
    const box = handle.getScene().legendLayout.rows.find((row) => row.id === id).box;
    return { clientX: box.x + box.w / 2, clientY: box.y + box.h / 2 };
  };
  return { host, handle, wrap, stage, fire, centre, cleanup() { handle.destroy(); host.remove(); } };
}

const hiddenIds = (handle) => handle.getScene().legendLayout.rows.filter((row) => row.hidden).map((row) => row.id);

for (const renderer of ["svg", "canvas"]) {
  await check(`${renderer}: toggle buttons are keyboard controls that never take pointer events`, () => {
    const m = mount(pair, { width: 480, height: 280, renderer });
    const buttons = [...m.wrap.querySelectorAll("button[data-series]")];
    assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label")), ["Alpha", "Beta"], "one named toggle per entry");
    assert(buttons.every((button) => button.style.pointerEvents === "none"), "no button is stacked over its entry as a second hit target");
    assert(buttons.every((button) => button.style.cursor === ""), "the cursor belongs to the painted entry, not the button");
    // Only the buttons are interactive; the painted rows are static.
    assert.equal(m.stage.querySelectorAll("[tabindex], [role='button']").length, 0, "painted rows add no second control");
    // The keyboard path: Enter/Space on a button dispatch click.
    buttons[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.deepEqual(hiddenIds(m.handle), ["mark-1"]);
    assert.equal(m.wrap.querySelector('button[data-series="mark-1"]').getAttribute("aria-pressed"), "false");
    m.cleanup();
  });

  await check(`${renderer}: a legend press toggles once and does not also select a datum`, () => {
    const selections = [];
    const m = mount(pair, { width: 480, height: 280, renderer, onSelect: (event) => selections.push(event) });
    const at = m.centre("mark-0");
    m.fire("pointerdown", at);
    m.fire("pointerup", at);
    m.fire("click", at);
    assert.deepEqual(hiddenIds(m.handle), ["mark-0"], "one press hides the series once");
    assert.equal(selections.length, 0, "the release after a legend toggle is not an onSelect");
    m.fire("pointerdown", at);
    m.fire("pointercancel", at);
    assert.deepEqual(hiddenIds(m.handle), [], "a second press shows it again");
    // A plot click after the legend still selects.
    const { plot } = m.handle.getScene();
    const inPlot = { clientX: plot.x + plot.w / 2, clientY: plot.y + plot.h / 2 };
    m.fire("pointerdown", inPlot);
    m.fire("pointerup", inPlot);
    assert.equal(selections.length, 1, "plot clicks still select");
    m.cleanup();
  });

  await check(`${renderer}: the painted entry shows the pointer cursor, the plot and static markup do not`, () => {
    const m = mount(pair, { width: 480, height: 280, renderer });
    m.fire("pointermove", m.centre("mark-1"));
    assert.equal(m.stage.style.cursor, "pointer", "over an entry");
    const { plot } = m.handle.getScene();
    m.fire("pointermove", { clientX: plot.x + plot.w / 2, clientY: plot.y + plot.h / 2 });
    assert.equal(m.stage.style.cursor, "", "over the plot");
    m.fire("pointermove", m.centre("mark-0"));
    m.fire("pointerleave", {});
    assert.equal(m.stage.style.cursor, "", "after leaving the chart");
    assert.doesNotMatch(m.stage.innerHTML, /cursor:\s*pointer/, "the static legend markup carries no cursor");
    m.cleanup();
  });
}

await check("the +N more summary is translated through chart.legend.more and measured as painted", async () => {
  const slices = Array.from({ length: 12 }, (_, i) => ({ name: `Segment ${i + 1}`, value: 30 - i * 2 }));
  const definition = defineChart({ marks: [pie(slices, { valueKey: "value", labelKey: "name" })] });
  const size = { width: 480, height: 200 };
  const english = compileChart(definition, size).legendLayout.more;
  assert.ok(english, "12 slices at 480x200 overflow the pie legend");
  assert.match(english.label, /^\+\d+ more$/, "the English default");
  const hidden = english.names.length;

  const series = defineChart({
    marks: Array.from({ length: 40 }, (_, s) => line([{ x: 0, y: s }, { x: 1, y: s + 1 }], { x: "x", y: "y", name: `Portfolio number ${s + 1}` })),
  });
  registerMessages("de", { "chart.legend.more": "+{count} weitere Reihen" });
  await setLocale("de");
  try {
    const pieMore = compileChart(definition, size).legendLayout.more;
    assert.equal(pieMore.label, `+${hidden} weitere Reihen`, "the side legend uses the translation");
    const top = compileChart(series, size);
    const more = top.legendLayout.more;
    assert.ok(more, "40 series overflow the top legend");
    assert.equal(more.label, `+${more.names.length} weitere Reihen`, "the top legend uses the translation");
    assert.equal(more.box.w, estimateTextWidth(more.label, TOP_LEGEND.fontSize, top.theme.font), "its box is measured from the translated label");
    assert.ok(more.box.x + more.box.w <= size.width, "and still fits the chart");
    assert.ok(svgFromCompiled(top).includes(`>+${more.names.length} weitere Reihen</text>`), "the renderer paints it");
  } finally {
    await setLocale("en");
  }
  assert.equal(compileChart(definition, size).legendLayout.more.label, `+${hidden} more`, "back to English");
});

dom.window.close();
if (failures) {
  console.error(`${failures} native legend toggle check(s) failed`);
  process.exit(1);
}
