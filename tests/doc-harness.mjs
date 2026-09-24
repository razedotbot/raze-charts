// Documentation gates (W1B-24): the fence harness type-checks snippets with
// preludes and opt-outs, the React prop table cannot drift from the adapter,
// and shipped docs only link files the npm package ships.
// Run: node tests/doc-harness.mjs (after a build: snippets check dist/types).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRELUDES,
  checkDocSnippets,
  extractFences,
  typecheckSnippets,
} from "../scripts/check-doc-snippets.mjs";
import {
  REACT_PROPS_END,
  REACT_PROPS_START,
  isPackaged,
  reactPropTableDrift,
  readReactPropSurface,
  renderReactPropTable,
} from "../scripts/check-docs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const test = (name, body) => {
  body();
  passed += 1;
  console.log(`✓ ${name}`);
};

// ── Fence extraction and directives ────────────────────────────────────────

test("extractFences reports the Markdown line of the first code line and the language", () => {
  const { fences, problems } = extractFences("# T\n\n```ts\nconst a = 1;\n```\n\n```bash\nnpm test\n```\n", "doc.md");
  assert.deepEqual(problems, []);
  assert.equal(fences.length, 2);
  assert.deepEqual([fences[0].line, fences[0].lang, fences[0].code], [4, "ts", "const a = 1;"]);
  assert.equal(fences[1].lang, "bash");
});

test("directives directly above a fence (blank lines allowed) are parsed", () => {
  const markdown = "<!-- prelude: financial, trading-host -->\n\n```ts\nfinancialChart.remove();\n```\n\n<!-- no-check: pseudo-code -->\n```tsx\n<Foo />\n```\n";
  const { fences, problems } = extractFences(markdown, "doc.md");
  assert.deepEqual(problems, []);
  assert.deepEqual(fences[0].directives.preludes.sort(), ["financial", "trading-host"]);
  assert.equal(fences[1].directives.noCheck, "pseudo-code");
});

test("a directive separated by prose does not apply", () => {
  const { fences } = extractFences("<!-- no-check: x -->\nSome prose.\n\n```ts\nconst a = 1;\n```\n", "doc.md");
  assert.equal(fences[0].directives.noCheck, null);
});

test("no-check without a reason, unknown preludes, and unterminated fences are problems", () => {
  const { problems } = extractFences(
    "<!-- no-check -->\n```ts\nx\n```\n\n<!-- prelude: nope -->\n```ts\ny\n```\n\n```ts\nnever closed\n",
    "doc.md",
  );
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.match(problems[0], /doc\.md:1: .*needs a reason/);
  assert.match(problems[1], /unknown prelude "nope"\. Known preludes: /);
  assert.match(problems[2], /unterminated/);
});

test("fences indented inside list items are de-indented", () => {
  const { fences } = extractFences("- step\n\n  ```ts\n  const a: number = 1;\n  ```\n", "doc.md");
  assert.equal(fences[0].code, "const a: number = 1;");
});

// ── Type-checking ──────────────────────────────────────────────────────────

const snippet = (code, extra = {}) => ({
  file: "doc.md",
  line: 10,
  lang: "ts",
  code,
  directives: { preludes: [], noCheck: null },
  ...extra,
});

test("a valid snippet against the public package passes in Bundler and NodeNext", () => {
  const failures = typecheckSnippets([
    snippet('import { defineChart, line } from "@razedotbot/charts/chart";\nconst chart = defineChart({ marks: [line([{ x: 1, y: 2 }], { x: "x", y: "y" })] });\nvoid chart;'),
  ], { root });
  assert.deepEqual(failures, []);
});

test("errors map to the Markdown line and column, once per resolution mode", () => {
  const failures = typecheckSnippets([
    snippet('import { widget } from "@razedotbot/charts";\nnew widget({\n  container: document.querySelector("#chart")!,\n  symbol: "X",\n} as never);\nconst n: number = "not a number";'),
  ], { root });
  assert.equal(failures.length, 2, failures.join("\n"));
  assert.match(failures[0], /^doc\.md:15:7 \[bundler\] TS2322 /);
  assert.match(failures[1], /^doc\.md:15:7 \[nodenext\] TS2322 /);
});

test("the pre-fix README financial snippet (container: querySelector) is caught", () => {
  const failures = typecheckSnippets([
    snippet('import { widget, type IBasicDataFeed, type ResolutionString } from "@razedotbot/charts";\ndeclare const datafeed: IBasicDataFeed;\nnew widget({\n  container: document.querySelector("#chart")!,\n  symbol: "X",\n  interval: "1" as ResolutionString,\n  datafeed,\n});'),
  ], { root });
  assert.ok(failures.some((failure) => /doc\.md:13:\d+ \[bundler\] TS2322/.test(failure)), failures.join("\n"));
});

test("undeclared names fail without a prelude and pass with one", () => {
  const code = "financialChart.onChartReady(() => financialChart.remove());";
  assert.ok(typecheckSnippets([snippet(code)], { root }).some((failure) => failure.includes("TS2304")));
  assert.deepEqual(typecheckSnippets([snippet(code, { directives: { preludes: ["financial"], noCheck: null } })], { root }), []);
});

test("preludes are isolated: a snippet without the prelude cannot see another snippet's prelude", () => {
  const failures = typecheckSnippets([
    snippet("financialChart.remove();", { directives: { preludes: ["financial"], noCheck: null } }),
    snippet("financialChart.remove();", { line: 40 }),
  ], { root });
  assert.ok(failures.length > 0 && failures.every((failure) => failure.startsWith("doc.md:40:")), failures.join("\n"));
});

test("top-level names never collide across snippets (each is a module)", () => {
  assert.deepEqual(typecheckSnippets([snippet("const shared = 1;"), snippet("const shared = 'two';", { line: 30 })], { root }), []);
});

test("no-check snippets are skipped", () => {
  assert.deepEqual(typecheckSnippets([snippet("this is not TypeScript", { directives: { preludes: [], noCheck: "prose" } })], { root }), []);
});

test("tsx snippets type-check against the React adapter's declarations", () => {
  const failures = typecheckSnippets([
    snippet('import { LineChart, Line } from "@razedotbot/charts/react";\nexport const view = <LineChart data={[{ name: "a", value: 1 }]}><Line dataKey="value" strok="red" /></LineChart>;', { lang: "tsx" }),
  ], { root });
  assert.ok(failures.some((failure) => failure.includes("TS2322") && failure.includes("strok")), failures.join("\n"));
});

test("every prelude compiles on its own", () => {
  for (const name of Object.keys(PRELUDES)) {
    assert.deepEqual(typecheckSnippets([snippet("export {};", { directives: { preludes: [name], noCheck: null } })], { root }), [], name);
  }
});

test("every documentation fence in the repository type-checks", () => {
  const result = checkDocSnippets({ root });
  assert.deepEqual(result.failures, []);
  assert.ok(result.checked >= 15, `checked ${result.checked} fences`);
});

// ── React prop table ───────────────────────────────────────────────────────

const reactSource = readFileSync(resolve(root, "src/react/index.tsx"), "utf8");
const surface = readReactPropSurface(reactSource);

test("the prop surface is read from SUPPORTED_PROPS and the public interfaces", () => {
  const byName = Object.fromEntries(surface.descriptors.map(({ component, props }) => [component, props]));
  assert.deepEqual(byName.ReferenceLine, ["y", "x", "stroke", "strokeWidth", "name"]);
  assert.deepEqual(byName.Brush, ["dataKey", "height", "startIndex", "endIndex"]);
  assert.deepEqual(byName.Tooltip, []);
  assert.ok(surface.containers.includes("LineChart") && surface.containers.includes("ComposedChart"));
  assert.ok(surface.containerProps.includes("syncId") && surface.chartProps.includes("viewportGroup"));
});

test("docs/migration.md carries the generated table", () => {
  const doc = readFileSync(resolve(root, "docs/migration.md"), "utf8");
  assert.equal(reactPropTableDrift(doc, surface), null);
  assert.ok(doc.replace(/\r\n/g, "\n").includes(renderReactPropTable(surface)));
});

test("a documented table that omits a supported prop fails", () => {
  const doc = readFileSync(resolve(root, "docs/migration.md"), "utf8").replace(/\r\n/g, "\n");
  const drifted = doc.replace("| `ReferenceLine` | `y`, `x`, `stroke`", "| `ReferenceLine` | `y`, `stroke`");
  assert.notEqual(drifted, doc);
  assert.match(reactPropTableDrift(drifted, surface), /React prop table disagrees/);
});

test("a new SUPPORTED_PROPS entry without a doc update fails", () => {
  const doc = readFileSync(resolve(root, "docs/migration.md"), "utf8");
  const changed = readReactPropSurface(reactSource.replace('brush: ["dataKey", "height",', 'brush: ["dataKey", "height", "travellerWidth",'));
  assert.match(reactPropTableDrift(doc, changed), /disagrees/);
});

test("a document without the markers is reported with the regeneration command", () => {
  assert.match(reactPropTableDrift("# Nothing here", surface), new RegExp(`${REACT_PROPS_START}.*${REACT_PROPS_END}.*--write`));
});

// ── Shipped links ──────────────────────────────────────────────────────────

test("only files in package.json \"files\" (plus npm's defaults) count as shipped", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(isPackaged(resolve(root, "docs/performance.md"), pkg), true);
  assert.equal(isPackaged(resolve(root, "benchmarks/budgets/root.json"), pkg), true);
  assert.equal(isPackaged(resolve(root, "README.md"), pkg), true);
  assert.equal(isPackaged(resolve(root, "examples/benchmark.html"), pkg), false);
  assert.equal(isPackaged(resolve(root, "playwright.perf.config.ts"), pkg), false);
  assert.equal(isPackaged(resolve(root, "docsx/file.md"), pkg), false);
});

console.log(`DOC HARNESS: PASS (${passed} checks)`);
