// The input schema yields a working settings form (W1B-15): every input type
// renders an accessible kit control, groups become fieldsets, inline inputs
// share a row, edits resolve through the createStudy() rules (clamping,
// coercion, documented errors), and reset() restores the defaults.
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
  Element: window.Element,
  Node: window.Node,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
});

const dir = mkdtempSync(join(tmpdir(), "raze-study-form-"));
let checks = 0;
const ok = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};
const change = (input, value) => {
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
};
const key = (target, name) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

try {
  const result = await build({
    stdin: {
      contents: [
        'export { createStudyInputsForm } from "./src/ui/StudyInputsForm.ts";',
        'export * from "./src/studies/inputs.ts";',
        'export { STUDY_INPUT_TYPES } from "./src/studies/types.ts";',
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
  const file = join(dir, "form.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  const { createStudyInputsForm, int, float, bool, source, select, color, session, time, price, symbol, resolution, text, STUDY_INPUT_TYPES } = await import(pathToFileURL(file).href);

  const schema = {
    length: int(14, { min: 1, max: 200, tooltip: "Bars in the window" }),
    mult: float(2, { min: 0.5, max: 5, step: 0.1, group: "Bands", inline: "bands" }),
    offset: price(0, { group: "Bands", inline: "bands" }),
    src: source("close", { group: "Bands" }),
    showSignal: bool(true, { title: "Show signal line" }),
    mode: select([{ value: "sma", title: "Simple" }, { value: "ema", title: "Exponential" }], "ema"),
    lineColor: color("#2962ff"),
    namedColor: color("tomato"),
    hours: session("0930-1600"),
    anchor: time(1_700_000_000),
    compareTo: symbol("SPY"),
    timeframe: resolution("1D"),
    note: text(""),
  };
  const types = new Set(Object.values(schema).map((input) => input.type));
  ok(STUDY_INPUT_TYPES.every((type) => types.has(type)), "the fixture covers every input type");

  const changes = [];
  const form = createStudyInputsForm({
    study: "Form probe",
    schema,
    values: { length: 20, mode: "sma" },
    onChange: (values, id) => changes.push({ id, values }),
  });
  document.body.append(form.el);
  const row = (id) => form.el.querySelector(`[data-input="${id}"]`);

  // Every input renders a labelled control of the right kind.
  for (const id of Object.keys(schema)) {
    const control = row(id)?.querySelector("input, select, button");
    ok(control, `input "${id}" renders a control`);
    const label = row(id).querySelector("label");
    ok(label && label.textContent.trim().length > 0, `input "${id}" has a visible label`);
  }
  const lengthInput = row("length").querySelector("input");
  ok(lengthInput.getAttribute("role") === "spinbutton" && lengthInput.getAttribute("aria-valuemin") === "1" && lengthInput.getAttribute("aria-valuemax") === "200", "int inputs are bounded spinbuttons");
  ok(lengthInput.value === "20", "current values are shown (not only defaults)");
  ok(row("mult").querySelector("input").value === "2.0", "float precision follows the step");
  ok(row("showSignal").querySelector("input").type === "checkbox" && row("showSignal").querySelector("label").textContent === "Show signal line", "bool inputs are checkboxes with their title");
  const sourceSelect = row("src").querySelector("select");
  ok(sourceSelect.options.length === 9 && [...sourceSelect.options].some((option) => option.textContent === "(H + L + C)/3"), "source inputs list every source with readable titles");
  const modeSelect = row("mode").querySelector("select");
  ok(modeSelect.value === "sma" && [...modeSelect.options].map((option) => option.textContent).join() === "Simple,Exponential", "select inputs use option titles");
  ok(row("lineColor").querySelector("button").getAttribute("aria-haspopup") === "dialog", "hex colours use the swatch picker");
  ok(row("namedColor").querySelector("input").value === "tomato", "named colours stay editable as text");
  const anchorInput = row("anchor").querySelector("input");
  ok(anchorInput.type === "datetime-local" && anchorInput.value === "2023-11-14T22:13", "time inputs edit Unix seconds as UTC date-times");
  ok(row("anchor").querySelector("label").textContent === "Anchor (UTC)", "time labels state the zone");
  ok(row("note").querySelector("input").type === "text", "text-like inputs use text fields");
  ok(row("length").querySelector("label").textContent === "Length", "titles default to the humanised id");

  // Groups and inline rows.
  const fieldset = form.el.querySelector("fieldset.raze-study-inputs-group");
  ok(fieldset && fieldset.querySelector("legend").textContent === "Bands", "groups render as labelled fieldsets");
  ok(fieldset.contains(row("mult")) && fieldset.contains(row("src")) && !fieldset.contains(row("length")), "grouped inputs sit inside their fieldset");
  const inline = fieldset.querySelector(".raze-study-inputs-inline");
  ok(inline && inline.getAttribute("role") === "group" && inline.contains(row("mult")) && inline.contains(row("offset")), "inline inputs share one row");
  ok(inline.getAttribute("aria-label") === "Mult, Offset", "the inline row is named by its members");
  ok(!inline.contains(row("src")), "inline rows end with their key");

  // Edits resolve through the store rules.
  change(lengthInput, "500");
  const clamped = changes.at(-1);
  ok(clamped.id === "length" && clamped.values.length === 200 && form.values.length === 200, "out-of-range numbers clamp to max");
  key(lengthInput, "ArrowDown");
  ok(form.values.length === 199, "keyboard stepping commits through onChange");
  const checkbox = row("showSignal").querySelector("input");
  checkbox.checked = false;
  checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));
  ok(changes.at(-1).values.showSignal === false && typeof changes.at(-1).values.showSignal === "boolean", "checkboxes commit booleans");
  sourceSelect.value = "hlc3";
  sourceSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
  ok(form.values.src === "hlc3", "select changes commit");
  change(anchorInput, "2024-01-02T03:04");
  ok(form.values.anchor === Date.UTC(2024, 0, 2, 3, 4) / 1000, "date-times commit as Unix seconds");

  const sessionInput = row("hours").querySelector("input");
  const before = changes.length;
  change(sessionInput, "9:30 to 4");
  const alert = form.el.querySelector('[role="alert"]');
  ok(changes.length === before && form.values.hours === "0930-1600", "invalid values are not committed");
  ok(sessionInput.getAttribute("aria-invalid") === "true" && sessionInput.getAttribute("aria-errormessage") === alert.id, "invalid controls are flagged and linked to the message");
  ok(alert.textContent.includes('input "hours"') && alert.textContent.includes("0930-1600"), "the error explains the accepted format");
  change(sessionInput, "0800-1700:23456");
  ok(form.values.hours === "0800-1700:23456" && !sessionInput.hasAttribute("aria-invalid") && alert.textContent === "", "a valid value clears the error");

  // setValues() and reset().
  const count = changes.length;
  form.setValues({ length: 3, mode: "ema" });
  ok(changes.length === count && lengthInput.value === "3" && modeSelect.value === "ema", "setValues() updates controls without firing onChange");
  form.reset();
  ok(form.values.length === 14 && form.values.showSignal === true && lengthInput.value === "14" && changes.length === count + 1, "reset() restores defaults and reports once");
  form.focus();
  ok(document.activeElement === lengthInput, "focus() moves to the first control");
  form.destroy();
  ok(!form.el.isConnected, "destroy() removes the form");

  assert.throws(
    () => createStudyInputsForm({ study: "Broken", schema: { n: int(0, { min: 1 }) } }),
    (error) => error.code === "invalid-schema",
    "invalid schemas are rejected before rendering",
  );
  checks += 1;
  console.log(`STUDY INPUTS FORM: PASS (${checks} checks)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
