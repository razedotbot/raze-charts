// The DOM-sink lint passes on library source and rejects injection sinks
// outside the sanitizer allow-list (without tripping on comments/strings).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maskComments, scanPaths, scanSource } from "../scripts/check-dom-sinks.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// 1. The repository itself is clean and every allowance is still needed.
const repo = scanPaths();
assert.deepEqual(repo.findings, [], "src/ contains no unapproved DOM sinks");
assert(repo.files > 50, "the scan covers the source tree");
assert.deepEqual(repo.unusedAllowances.map((entry) => String(entry.file)), [], "no stale allow-list entries");

// 2. Every sink family is detected.
const cases = {
  innerHTML: "el.innerHTML = name;",
  "innerHTML (append)": "el.innerHTML += name;",
  outerHTML: "el.outerHTML = name;",
  insertAdjacentHTML: 'el.insertAdjacentHTML("beforeend", name);',
  "document.write": "document.write(name);",
  createContextualFragment: "range.createContextualFragment(name);",
  parseFromString: 'new DOMParser().parseFromString(name, "text/html");',
  srcdoc: "frame.srcdoc = name;",
  "event handler": 'el.setAttribute("onclick", code);',
  eval: "eval(code);",
  "new Function": "new Function(code)();",
  // eval and Function forms that a call-only pattern missed.
  "globalThis.eval": "globalThis.eval(code);",
  "window.eval": "window.eval(code);",
  "eval (bracket)": 'window["eval"](code);',
  "indirect eval": "(0, eval)(code);",
  "eval alias": "const run = eval;",
  "Function without new": "Function(code)();",
  "new window.Function": "new window.Function(code);",
  "globalThis.Function": "globalThis.Function(code)();",
  "Function (bracket)": "self['Function'](code)();",
  "Function alias": "const make = Function;",
  "Function.apply": "Function.apply(null, [code]);",
  "Function via a function's constructor": "(() => {}).constructor(code)();",
  "template event handler": "el.setAttribute(`on${type}`, code);",
  "concatenated event handler": 'el.setAttribute("on" + type, code);',
  "setAttributeNS template event handler": "el.setAttributeNS(null, `on${type}`, code);",
  "createAttribute event handler": "const attr = document.createAttribute(`on${type}`);",
  "string timer (template)": "setInterval(`tick()`, 10);",
  "string timer": 'setTimeout("run()", 10);',
  "javascript url": 'a.href = "javascript:void 0";',
  // Property-name forms that bypass a plain `.innerHTML =` match.
  "innerHTML (bracket)": 'el["innerHTML"] = name;',
  "outerHTML (bracket)": "el['outerHTML'] = name;",
  "innerHTML (Object.assign)": "Object.assign(el, { innerHTML: name });",
  "innerHTML (Reflect.set)": 'Reflect.set(el, "innerHTML", name);',
  "innerHTML (defineProperty)": 'Object.defineProperty(el, "innerHTML", { value: name });',
  "innerHTML (logical assignment)": "el.innerHTML ??= name;",
  setHTMLUnsafe: "el.setHTMLUnsafe(name);",
  "srcdoc (setAttributeNS)": 'frame.setAttributeNS(null, "srcdoc", name);',
  // Laundering a runtime string into SafeMarkup.
  "new SafeMarkup": "setMarkup(el, new SafeMarkup(name));",
  "trustedMarkup(variable)": "setMarkup(el, trustedMarkup(name));",
  "trustedMarkup(member)": "setMarkup(el, trustedMarkup(item.icon));",
  "trustedMarkup(template with interpolation)": "setMarkup(el, trustedMarkup(`<b>${name}</b>`));",
  "trustedMarkup(concatenation)": 'setMarkup(el, trustedMarkup("<b>" + name));',
  "trustedMarkup(call)": "setMarkup(el, trustedMarkup(String(name)));",
  "trustedMarkup(two arguments)": "setMarkup(el, trustedMarkup(ICON_CLOSE, name));",
  "trustedMarkup alias": 'import { trustedMarkup as tm } from "./kit/safe";',
};
for (const [label, line] of Object.entries(cases)) {
  const { findings } = scanSource(`const x = 1;\n${line}\n`, "src/ui/Example.ts");
  assert.equal(findings.length, 1, `${label} is reported`);
  assert.equal(findings[0].line, 2, `${label} reports its line`);
}

// 3. Comparisons, comments, strings and regex literals are not sinks.
const benign = [
  'if (el.innerHTML === "") {}',
  "// el.innerHTML = name;",
  "/* document.write(name) */",
  'const doc = "use el.innerHTML = x carefully";',
  'const ns = "http://www.w3.org/2000/svg"; el.textContent = name;',
  "const re = /innerHTML = /; el.textContent = name;",
  "const tpl = `${a}//${b}`; el.textContent = tpl;",
  "evaluate(x); retrieval(y);",
  // Names that merely contain eval/Function, constructors and safe attributes.
  'const isFunction = typeof x === "function"; isFunction(x); x.evaluated = medieval;',
  "const FunctionKeys = 1; const myFunction = () => 1; myFunction();",
  "class Row extends Base { constructor() { super(); this.kind = this.constructor.name; } }",
  'el.setAttribute("open", ""); el.setAttribute("autocomplete", "on"); el.setAttribute(`data-${key}`, value);',
  'el.setAttributeNS(null, "opacity", value);',
  // trustedMarkup() of library constants, and its own declaration.
  "setMarkup(el, trustedMarkup(ICON_CLOSE));",
  "setMarkup(el, trustedMarkup(ICONS.trend));",
  'setMarkup(el, trustedMarkup("<svg viewBox=\\"0 0 18 18\\"></svg>"));',
  "setMarkup(el, trustedMarkup('<svg></svg>'));",
  'setMarkup(el, trustedMarkup(`<svg><path d="M0 0"/></svg>`));',
  "setMarkup(el, trustedMarkup( /* icon */ ICON_PLUS ));",
  "export function trustedMarkup(libraryConstant: string) { return libraryConstant; }",
  'const hint = "never call trustedMarkup(name) with feed data";',
  // Reads and prose are not sinks.
  "const value = cond ? el.innerHTML : other;",
  'const label = "innerHTML is a sink";',
  'el.textContent = name; // el["innerHTML"] = name',
];
for (const line of benign) {
  assert.deepEqual(scanSource(`${line}\n`, "src/ui/Example.ts").findings, [], line);
}
assert.equal(maskComments("a // b\nc /* d */ e").replace(/ +/g, " "), "a \nc e", "comments are blanked, newlines kept");
assert.equal(maskComments('x = "//not a comment"'), 'x = "//not a comment"');

// 4. Allow-list entries are statement-specific and path-scoped.
const sanitizer = "element.innerHTML = value as string;\n";
assert.deepEqual(scanSource(sanitizer, "src/ui/kit/safe.ts").findings, []);
assert.equal(scanSource(`${sanitizer}el.innerHTML = other;\n`, "src/ui/kit/safe.ts").findings.length, 1,
  "a second sink in the sanitizer file still fails");
assert.equal(scanSource(sanitizer, "src/ui/Other.ts").findings.length, 1, "allowances do not leak to other files");
assert.deepEqual(scanSource("return new SafeMarkup(out);\n", "src/ui/kit/safe.ts").findings, [], "html`…` may mint SafeMarkup");
assert.equal(scanSource("return new SafeMarkup(name);\n", "src/ui/kit/safe.ts").findings.length, 1, "no other SafeMarkup in safe.ts");
const popupRowSink = "if (options?.trustedHtml) setMarkup(row, trustedMarkup(content));\n";
assert.deepEqual(scanSource(popupRowSink, "src/ui/popup.ts").findings, [], "the documented popupRow trustedHtml opt-in is allowed");
assert.equal(scanSource("setMarkup(row, trustedMarkup(content));\n", "src/ui/popup.ts").findings.length, 1,
  "the popupRow allowance covers only the trustedHtml statement");
assert.equal(scanSource(popupRowSink, "src/ui/ContextMenu.ts").findings.length, 1, "trustedMarkup allowances are file-scoped");
assert.deepEqual(scanSource('if (typeof icon === "string") setMarkup(b, trustedMarkup(icon));\n', "src/ui/LeftSidebar.ts").findings, []);
assert.equal(scanSource("setMarkup(icon, trustedMarkup(s.svg));\n", "src/ui/LeftSidebar.ts").findings.length, 1,
  "built-in sidebar icons are DOM-built (src/ui/icons.ts); an icon markup table is no longer allowed");
assert.equal(scanSource("setMarkup(b, trustedMarkup(item.title));\n", "src/ui/LeftSidebar.ts").findings.length, 1,
  "a new trustedMarkup() argument in the sidebar still fails");
for (const file of ["src/chart/render.ts", "src/chart/render/mount.ts"]) {
  assert.deepEqual(scanSource("stage.innerHTML = markup;\n", file).findings, [], `${file}: native SVG stage allowance survives the render split`);
}

// 5. The CLI fails with guidance on a violating file.
const dir = mkdtempSync(join(tmpdir(), "raze-sinks-"));
try {
  const bad = join(dir, "bad.ts");
  writeFileSync(bad, "export function show(el: HTMLElement, name: string) {\n  el.innerHTML = name;\n}\n");
  let failed = false;
  try {
    execFileSync(process.execPath, [resolve(root, "scripts/check-dom-sinks.mjs"), bad], { cwd: root, stdio: "pipe" });
  } catch (error) {
    failed = true;
    const stderr = String(error.stderr);
    assert.match(stderr, /bad\.ts:2:5\s+innerHTML/);
    assert.match(stderr, /setMarkup\(\)/, "the failure explains the safe alternative");
  }
  assert(failed, "the CLI exits non-zero on a sink");
  const clean = execFileSync(process.execPath, [resolve(root, "scripts/check-dom-sinks.mjs")], { cwd: root, encoding: "utf8" });
  assert.match(clean, /DOM sink check passed/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("DOM SINKS: PASS");
