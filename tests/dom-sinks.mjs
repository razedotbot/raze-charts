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
  "string timer": 'setTimeout("run()", 10);',
  "javascript url": 'a.href = "javascript:void 0";',
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
];
for (const line of benign) {
  assert.deepEqual(scanSource(`${line}\n`, "src/ui/Example.ts").findings, [], line);
}
assert.equal(maskComments("a // b\nc /* d */ e").replace(/ +/g, " "), "a \nc e", "comments are blanked, newlines kept");
assert.equal(maskComments('x = "//not a comment"'), 'x = "//not a comment"');

// 4. Allow-list entries are statement-specific and path-scoped.
const sanitizer = "(element as { innerHTML: unknown }).innerHTML = value;\n";
assert.deepEqual(scanSource(sanitizer, "src/ui/kit/safe.ts").findings, []);
assert.equal(scanSource(`${sanitizer}el.innerHTML = other;\n`, "src/ui/kit/safe.ts").findings.length, 1,
  "a second sink in the sanitizer file still fails");
assert.equal(scanSource(sanitizer, "src/ui/Other.ts").findings.length, 1, "allowances do not leak to other files");
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
