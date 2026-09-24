// Bundle budgets (scripts/check-bundle-size.mjs + benchmarks/budgets/):
// one validated budget file per public entry, consumer-scenario measurement,
// and a docs table that cannot drift from the budget files.
// Run after the build: node build.mjs && node tests/bundle-budgets.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCS_END,
  DOCS_START,
  docsDrift,
  loadBudgets,
  measure,
  renderDocsTable,
  scenarioSource,
  writeDocsTable,
} from "../scripts/check-bundle-size.mjs";
import { PACKAGE_ENTRIES, entryById } from "../scripts/entries.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const sandbox = mkdtempSync(join(tmpdir(), "raze-bundle-budgets-"));
let passed = 0;

async function test(name, body) {
  await body();
  passed += 1;
  console.log(`✓ ${name}`);
}

function budgetDir(files) {
  const directory = mkdtempSync(join(sandbox, "budgets-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(directory, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return directory;
}

const validBudget = (id) => ({
  entry: id,
  artifact: { gzipBytes: 1000 },
  scenarios: [{ name: "Only", imports: ["thing"], gzipBytes: 500 }],
});

try {
  await test("the repository has one valid budget file per public entry", () => {
    const { budgets, problems } = loadBudgets();
    assert.deepEqual(problems, []);
    assert.deepEqual(budgets.map((budget) => budget.entry.id), PACKAGE_ENTRIES.map((entry) => entry.id));
    const scenarios = budgets.flatMap((budget) => budget.scenarios.map((scenario) => scenario.name));
    assert.ok(scenarios.length >= 3, "at least three consumer scenarios are budgeted");
    for (const required of ["Widget only", "Line-only mount", "React LineChart"]) {
      assert.ok(scenarios.includes(required), `"${required}" scenario is budgeted`);
    }
  });

  await test("a missing budget file fails loudly with the file to add", () => {
    const entries = [entryById("root"), entryById("studies")];
    const { problems } = loadBudgets({ budgetsDir: budgetDir({ "root.json": validBudget("root") }), entries });
    assert.deepEqual(problems, [
      'entry "studies" (./studies) has no budget; add benchmarks/budgets/studies.json with an artifact budget and at least one scenario',
    ]);
  });

  await test("an orphan budget file and malformed fields are rejected", () => {
    const entries = [entryById("root")];
    const { problems } = loadBudgets({
      budgetsDir: budgetDir({
        "root.json": {
          entry: "chart",
          artifact: { gzipBytes: 12.5 },
          scenarios: [
            { name: "Dup", imports: ["widget"], gzipBytes: 10 },
            { name: "Dup", imports: [], gzipBytes: 0 },
          ],
        },
        "drawings.json": validBudget("drawings"),
      }),
      entries,
    });
    assert.deepEqual(problems, [
      "benchmarks/budgets/drawings.json does not match an entry in scripts/entries.mjs (known: root)",
      'benchmarks/budgets/root.json: "entry" must be "root"',
      'benchmarks/budgets/root.json: "artifact.gzipBytes" must be a positive integer',
      'benchmarks/budgets/root.json: scenarios[1] repeats the name "Dup"',
      'benchmarks/budgets/root.json: scenarios[1] needs "imports": a non-empty list of named exports of .',
      'benchmarks/budgets/root.json: scenarios[1] needs a positive integer "gzipBytes"',
    ]);
    const invalidJson = loadBudgets({ budgetsDir: budgetDir({ "root.json": "{ nope" }), entries });
    assert.match(invalidJson.problems[0], /benchmarks\/budgets\/root\.json is not valid JSON/);
    const noScenarios = loadBudgets({
      budgetsDir: budgetDir({ "root.json": { entry: "root", artifact: { gzipBytes: 1 }, scenarios: [] } }),
      entries,
    });
    assert.deepEqual(noScenarios.problems, ['benchmarks/budgets/root.json: "scenarios" must list at least one consumer scenario']);
  });

  await test("scenarios import from the public specifier, not source paths", () => {
    const source = scenarioSource(entryById("chart"), { imports: ["defineChart", "line"] }, pkg.name);
    assert.equal(
      source,
      'import { defineChart, line } from "@razedotbot/charts/chart";\nexport { defineChart, line };\n',
    );
  });

  await test("scenario sizes are tree-shaken, minified, and smaller than the artifact", async () => {
    const { budgets } = loadBudgets();
    const subset = budgets.filter((budget) => ["root", "studies"].includes(budget.entry.id));
    const { results, failures } = await measure({ budgets: subset, pkg });
    assert.deepEqual(failures, []);
    const artifact = (id) => results.find((result) => result.entry === id && result.kind === "artifact");
    const scenario = (name) => results.find((result) => result.kind === "scenario" && result.name === name);
    assert.ok(scenario("Widget only").gzipBytes < artifact("root").gzipBytes, "minified widget scenario is below the artifact");
    assert.ok(
      scenario("Single kernel").gzipBytes * 4 < artifact("studies").gzipBytes,
      "one kernel tree-shakes away the registry and the other kernels",
    );
  });

  await test("a scenario over budget or importing a missing export fails with guidance", async () => {
    const studies = entryById("studies");
    const { failures } = await measure({
      pkg,
      budgets: [{
        entry: studies,
        artifact: { gzipBytes: 1_000_000 },
        scenarios: [
          { name: "Too small", imports: ["StudyRegistry"], gzipBytes: 10 },
          { name: "Typo", imports: ["emaa"], gzipBytes: 1_000 },
        ],
      }],
    });
    assert.equal(failures.length, 2);
    assert.match(failures[0], /Study kernels scenario "Too small" ships \d+ gzip bytes, above its 10-byte budget; largest inputs: dist\/studies\.esm\.js/);
    assert.match(failures[1], /Study kernels scenario "Typo" could not be bundled: .*emaa/);
  });

  await test("an artifact over budget fails", async () => {
    const { failures } = await measure({
      pkg,
      budgets: [{ entry: entryById("studies"), artifact: { gzipBytes: 10 }, scenarios: [] }],
    });
    assert.match(failures[0], /Study kernels artifact \(dist\/studies\.esm\.js\) is \d+ gzip bytes, above its 10-byte budget/);
  });

  await test("the docs table is generated from the budget files", () => {
    const { budgets } = loadBudgets();
    const table = renderDocsTable(budgets, pkg.name);
    assert.ok(table.startsWith(DOCS_START) && table.endsWith(DOCS_END));
    const rootKiB = budgets.find((budget) => budget.entry.id === "root").artifact.gzipBytes / 1024;
    assert.ok(Number.isInteger(rootKiB), "the root artifact budget is a whole number of KiB");
    assert.ok(
      table.includes(`| Root financial widget (\`@razedotbot/charts\`) | Published artifact | \`charting_library.esm.js\` | ${rootKiB} KiB |`),
      "the root artifact row shows benchmarks/budgets/root.json",
    );
    assert.match(table, /\| \| Scenario: Line-only mount \| `import \{ defineChart, line, mountChart \}` \| \d+(?:\.\d+)? KiB \|/);
    const docs = readFileSync(resolve(root, "docs/performance.md"), "utf8");
    assert.equal(docsDrift(docs, budgets, pkg.name), null, "docs/performance.md is in sync");
  });

  await test("a docs table that disagrees with the budgets is detected and rewritten", () => {
    const { budgets } = loadBudgets();
    const docs = readFileSync(resolve(root, "docs/performance.md"), "utf8");
    const rootKiB = budgets.find((budget) => budget.entry.id === "root").artifact.gzipBytes / 1024;
    const stale = docs.replace(`| ${rootKiB} KiB |`, `| ${rootKiB - 3} KiB |`);
    assert.notEqual(stale, docs);
    assert.match(docsDrift(stale, budgets, pkg.name), /disagrees with benchmarks\/budgets\/\*\.json; run "node scripts\/check-bundle-size\.mjs --write-docs"/);
    assert.equal(writeDocsTable(stale, budgets, pkg.name), docs);
    assert.match(docsDrift("# Performance\n", budgets, pkg.name), /has no generated budget table/);
    assert.equal(writeDocsTable("# Performance\n", budgets, pkg.name), null);
  });

  await test("npm run check:docs includes the budget table check", () => {
    assert.match(pkg.scripts["check:docs"], /check-bundle-size\.mjs --check-docs/);
    const result = spawnSync(process.execPath, ["scripts/check-bundle-size.mjs", "--check-docs"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

console.log(`\nBUNDLE BUDGETS: PASS (${passed} checks)`);
