// Guards added to the widget browser benchmark by W1B-07: the heap budgets
// guard every data size, crosshair moves are budgeted as overlay-only frames,
// and the harness fails (instead of passing silently) on failed studies,
// library warnings, idle samples and failed raster readbacks. Needs no browser.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGET_POLICY, DEFAULT_SIZES, SCENARIO_IDS, portableBudget } from "../scripts/widget-benchmark-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const baseline = JSON.parse(read("benchmarks/widget-baseline.json"));

function run(label, fn) {
  fn();
  console.log(`✓ ${label}`);
}

run("the heap floor no longer leaves small series unguarded", () => {
  assert.ok(BUDGET_POLICY.heap.floor <= 2, "a heap floor of 16 MB hid 10x regressions at 1k and 10k bars");
  assert.equal(portableBudget("heap", 0.4), 2);
  assert.equal(portableBudget("heap", 1.43), 3, "small heaps round to 1 MB steps");
  assert.equal(portableBudget("heap", 51.8), 110, "large heaps keep the coarse steps");
  for (const id of ["heap", "heap-studies"]) {
    for (const size of DEFAULT_SIZES) {
      const entry = baseline.scenarios[id].sizes[String(size)];
      assert.ok(
        entry.budget <= Math.max(BUDGET_POLICY.heap.floor, entry.baseline * 3),
        `${id}@${size}: a ${entry.budget} MB budget over a ${entry.baseline} MB reference does not guard the size`,
      );
    }
  }
  assert.match(baseline.budgetPolicy.heap, /max\(2 MB/);
});

run("crosshair moves are budgeted as overlay-only frames at every size", () => {
  for (const id of ["overlay-frame", "overlay-frame-all"]) assert.ok(SCENARIO_IDS.includes(id), `${id} is catalogued`);
  for (const size of DEFAULT_SIZES) {
    const key = String(size);
    for (const id of ["crosshair-move", "crosshair-move-all"]) {
      assert.ok(baseline.scenarios[id].sizes[key].budget <= 20, `${id}@${size} no longer scales with the visible span`);
    }
    for (const id of ["overlay-frame", "overlay-frame-all"]) {
      const entry = baseline.scenarios[id].sizes[key];
      assert.equal(entry.target, 0.5, `${id}@${size} targets 0.5 ms`);
      assert.ok(entry.budget <= 5, `${id}@${size} has a tight portable budget`);
    }
  }
});

run("the benchmark page fails loudly instead of measuring the wrong thing", () => {
  const page = read("examples/benchmark.html");
  assert.match(page, /try \{\s*const ctx = canvas\.getContext\("2d"\);[\s\S]*?getImageData[\s\S]*?\} catch/, "flushCanvases guards getContext and the readback");
  assert.match(page, /the raster readback failed/, "a failed readback fails the sample");
  assert.match(page, /createStudy failed for/, "addStudies fails when a study cannot be created");
  assert.match(page, /spyLayer\("canvas\.raze-chart-layer-main"\)/, "crosshair samples count main-layer paints");
  const bench = read("tests/perf/widget.bench.ts");
  assert.match(bench, /includes\("\[raze-charts\]"\)/, "library warnings fail the run");
  assert.match(bench, /samples painted no frame/, "every sample must paint, not just one");
  assert.match(bench, /a crosshair move repainted the main layer/, "a main-layer paint during a crosshair move fails the run");
  assert.match(bench, /checkOverlayScaleFree\(size\);/, "every size checks that the overlay frame is independent of span and history");
  assert.match(bench, /grows with the visible span/, "an overlay frame that scales with the visible span fails the run");
  assert.match(bench, /grows with the history length/, "an overlay frame that scales with the history length fails the run");
  assert.match(bench, /every reference study was created/, "the study count is asserted");
});

console.log("WIDGET BENCHMARK GUARDS: PASS");
