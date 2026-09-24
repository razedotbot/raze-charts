// Regression tests for the widget browser benchmark harness: statistics,
// budget evaluation, baseline recording, the checked-in baseline itself, the
// runner's argument contract, and the separation from the default Playwright
// suites. Needs no browser.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUDGET_POLICY,
  DEFAULT_SIZES,
  SCENARIOS,
  SCENARIO_IDS,
  evaluateBudgets,
  formatTable,
  parseSizes,
  percentile,
  portableBudget,
  recordBaseline,
  summarize,
} from "../scripts/widget-benchmark-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = resolve(root, "scripts/benchmark-widget.mjs");

function run(label, fn) {
  fn();
  console.log(`✓ ${label}`);
}

run("percentile uses nearest rank and never reads outside the samples", () => {
  const values = [5, 1, 4, 2, 3];
  assert.equal(percentile(values, 0.5), 3);
  assert.equal(percentile(values, 0.95), 5);
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile([7], 0.95), 7);
  assert.ok(Number.isNaN(percentile([], 0.5)));
  assert.deepEqual(values, [5, 1, 4, 2, 3], "input order is preserved");
});

run("summarize reports median, p95 and per-component medians", () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    ms: i + 1,
    scriptMs: i + 0.5,
    rasterMs: 0.5,
    frames: 1,
  }));
  const summary = summarize(samples);
  assert.equal(summary.samples, 20);
  assert.equal(summary.median, 10);
  assert.equal(summary.p95, 19);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 20);
  assert.equal(summary.scriptMedian, 9.5);
  assert.equal(summary.rasterMedian, 0.5);
  assert.equal(summary.framesMedian, 1);

  const heap = summarize([12.3456]);
  assert.equal(heap.median, 12.346);
  assert.equal(heap.scriptMedian, undefined, "plain numbers carry no component breakdown");
});

run("summarize rejects empty and non-finite samples instead of reporting zeros", () => {
  assert.throws(() => summarize([]), /no samples/);
  assert.throws(() => summarize([1, Number.NaN]), /finite/);
  assert.throws(() => summarize([{ ms: -1 }]), /finite non-negative/);
});

run("parseSizes accepts plain and k-suffixed sizes and rejects ambiguous input", () => {
  assert.deepEqual(parseSizes(undefined), DEFAULT_SIZES);
  assert.deepEqual(parseSizes(""), DEFAULT_SIZES);
  assert.deepEqual(parseSizes("100k,1k,1000,10_000"), [1_000, 10_000, 100_000]);
  assert.deepEqual(parseSizes("1.5k"), [1_500]);
  assert.throws(() => parseSizes("abc"), /invalid benchmark size "abc"/);
  assert.throws(() => parseSizes("100"), /at least 200 bars/);
  assert.throws(() => parseSizes("1.2345k"), /integer/);
  assert.throws(() => parseSizes(","), /at least one size/);
});

run("the catalogue covers >= 10 time scenarios plus heap, all with unique ids", () => {
  assert.equal(new Set(SCENARIO_IDS).size, SCENARIO_IDS.length);
  assert.ok(SCENARIOS.filter((scenario) => scenario.kind === "time").length >= 10);
  for (const required of ["frame-default", "pan", "wheel-zoom", "crosshair-move", "tick-replace", "tick-append", "heap"]) {
    assert.ok(SCENARIO_IDS.includes(required), `${required} is measured`);
  }
  assert.deepEqual(DEFAULT_SIZES, [1_000, 10_000, 100_000, 500_000]);
});

run("portable budgets are generous, floored and rounded to coarse steps", () => {
  assert.equal(portableBudget("time", 0.2), BUDGET_POLICY.time.floor);
  assert.equal(portableBudget("time", 1.49), 10, "1.49 ms x6 rounds up to 10");
  assert.equal(portableBudget("time", 1.66), 10, "neighbouring sizes share one limit");
  assert.equal(portableBudget("time", 3.2), 20);
  assert.equal(portableBudget("time", 3.77), 30, "above 20 ms budgets move in 10 ms steps");
  assert.equal(portableBudget("time", 22.49), 140);
  assert.equal(portableBudget("time", 1384.41), 8500);
  assert.equal(portableBudget("heap", 0.4), BUDGET_POLICY.heap.floor);
  assert.equal(portableBudget("heap", 51.8), 110);
  assert.throws(() => portableBudget("time", Number.NaN), /cannot derive/);
  assert.throws(() => portableBudget("fps", 1), /unknown benchmark value kind/);
});

const baselineFixture = {
  suite: "fixture",
  scenarios: {
    "frame-default": { sizes: { "1000": { baseline: 1.5, budget: 10, target: 2 } } },
    heap: { sizes: { "1000": { baseline: 0.4, budget: 16 } } },
  },
};

run("evaluateBudgets passes medians at the budget and fails medians above it", () => {
  const ok = evaluateBudgets({
    scenarios: {
      "frame-default": { "1000": { median: 10 } },
      heap: { "1000": { median: 3 } },
    },
  }, baselineFixture);
  assert.deepEqual(ok, { failures: [], missing: [] });

  const over = evaluateBudgets({ scenarios: { "frame-default": { "1000": { median: 10.01 } } } }, baselineFixture);
  assert.deepEqual(over.failures, [{
    scenario: "frame-default",
    size: 1000,
    median: 10.01,
    limit: 10,
    unit: "ms",
    limitKind: "budget",
  }]);
});

run("evaluateBudgets reports measurements without a budget instead of skipping them", () => {
  const result = evaluateBudgets({
    scenarios: {
      "frame-default": { "10000": { median: 1 } },
      pan: { "1000": { median: 1 } },
    },
  }, baselineFixture);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.missing, [
    { scenario: "frame-default", size: 10000 },
    { scenario: "pan", size: 1000 },
  ]);
  assert.throws(
    () => evaluateBudgets({ scenarios: { "frame-typo": { "1000": { median: 1 } } } }, baselineFixture),
    /unknown benchmark scenario "frame-typo"/,
  );
});

run("strict mode enforces aspirational targets where they exist", () => {
  const results = {
    scenarios: {
      "frame-default": { "1000": { median: 3 } },
      heap: { "1000": { median: 3 } },
    },
  };
  assert.deepEqual(evaluateBudgets(results, baselineFixture).failures, []);
  const strict = evaluateBudgets(results, baselineFixture, { strict: true });
  assert.equal(strict.failures.length, 1);
  assert.equal(strict.failures[0].limitKind, "target");
  assert.equal(strict.failures[0].limit, 2);
});

run("recordBaseline keeps budgets and targets, adds budgets only for new entries", () => {
  const next = recordBaseline(baselineFixture, {
    scenarios: {
      "frame-default": {
        "1000": { median: 5.555, p95: 6.1 },
        "10000": { median: 1.2, p95: 1.4 },
      },
      load: { "1000": { median: 30, p95: 33 } },
    },
  }, { captured: "2026-01-01" });

  assert.deepEqual(next.reference, { captured: "2026-01-01" });
  assert.deepEqual(next.scenarios["frame-default"].sizes["1000"], {
    baseline: 5.56,
    p95: 6.1,
    budget: 10,
    target: 2,
  }, "a recorded slowdown never loosens the checked-in budget");
  assert.equal(next.scenarios["frame-default"].sizes["10000"].budget, 10);
  assert.equal(next.scenarios.load.sizes["1000"].budget, 180);
  assert.equal(next.scenarios.load.unit, "ms");
  assert.equal(next.scenarios.heap.unit, "MB");
  assert.deepEqual(next.scenarios.heap.sizes["1000"], { baseline: 0.4, budget: 16 }, "unmeasured entries survive");
  assert.deepEqual(
    Object.keys(next.scenarios),
    SCENARIO_IDS.filter((id) => ["load", "frame-default", "heap"].includes(id)),
    "scenarios are written in catalogue order",
  );
  assert.equal(baselineFixture.scenarios["frame-default"].sizes["1000"].baseline, 1.5, "input is not mutated");
});

run("formatTable prints every measured scenario and size with units", () => {
  const table = formatTable({
    scenarios: {
      "frame-default": { "1000": { samples: 40, median: 1.5, p95: 1.8 } },
      heap: { "500000": { samples: 1, median: 51.8, p95: 51.8 } },
    },
  }, baselineFixture);
  const lines = table.split("\n");
  assert.match(lines[0], /^scenario\s+bars\s+runs\s+median\s+p95\s+baseline\s+budget\s+unit$/);
  assert.match(table, /frame-default\s+1k\s+40\s+1\.50\s+1\.80\s+1\.50\s+10\s+ms/, "budgets print as decisions, not measurements");
  assert.match(table, /heap\s+500k\s+1\s+51\.8\s+51\.8\s+-\s+-\s+MB/);
});

run("the checked-in baseline has a sane budget for every scenario and default size", () => {
  const baseline = JSON.parse(readFileSync(resolve(root, "benchmarks/widget-baseline.json"), "utf8"));
  assert.equal(baseline.version, 1);
  assert.ok(baseline.reference?.captured, "the reference machine and date are recorded");
  assert.equal(typeof baseline.reference.rasterIncluded, "boolean");
  for (const id of SCENARIO_IDS) {
    for (const size of DEFAULT_SIZES) {
      const entry = baseline.scenarios?.[id]?.sizes?.[String(size)];
      assert.ok(entry, `${id} at ${size} bars has a baseline entry`);
      assert.ok(Number.isFinite(entry.baseline) && entry.baseline >= 0, `${id}@${size} baseline`);
      assert.ok(Number.isFinite(entry.budget), `${id}@${size} budget`);
      assert.ok(
        entry.budget >= entry.baseline * 1.5,
        `${id}@${size}: a budget of ${entry.budget} is too tight for a ${entry.baseline} reference to be portable`,
      );
      if (entry.target !== undefined) {
        assert.ok(entry.target <= entry.budget, `${id}@${size}: target must not exceed the budget`);
      }
    }
  }
  const unknown = Object.keys(baseline.scenarios).filter((id) => !SCENARIO_IDS.includes(id));
  assert.deepEqual(unknown, [], "baseline only lists catalogued scenarios");
});

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", ...options });
}

run("the runner documents its options and rejects unknown or inconsistent flags", () => {
  const help = runNode([runner, "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--check/);
  assert.match(help.stdout, /--record/);
  assert.match(help.stdout, /PW_PORT/);

  const unknown = runNode([runner, "--chek"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option "--chek"/);

  const strict = runNode([runner, "--strict"]);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /--strict only applies together with --check/);

  const sizes = runNode([runner, "--sizes=lots"]);
  assert.equal(sizes.status, 1);
  assert.match(sizes.stderr, /invalid benchmark size "lots"/);
});

run("benchmarks run only under playwright.perf.config.ts, never in the default suites", () => {
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  const env = { ...process.env, RAZE_BENCH_SIZES: "" };
  const visual = runNode([cli, "test", "--list"], { env });
  assert.equal(visual.status, 0, visual.stderr);
  assert.doesNotMatch(visual.stdout, /bench/i, "the default config must not discover benchmark files");

  const perf = runNode([cli, "test", "--list", "--config", "playwright.perf.config.ts"], { env });
  assert.equal(perf.status, 0, perf.stderr);
  for (const size of ["1,000", "10,000", "100,000", "500,000"]) {
    assert.match(perf.stdout, new RegExp(`financial widget at ${size} bars`));
  }
  assert.doesNotMatch(perf.stdout, /visual\.spec|accessibility\.spec/, "the perf config runs only benchmarks");
});

console.log("WIDGET BENCHMARK HARNESS: PASS");
