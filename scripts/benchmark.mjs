#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(root, "benchmarks/dashboard-baseline.json");
const bundlePath = resolve(root, "dist/chart.esm.js");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const check = args.has("--check");

if (args.has("--help")) {
  console.log(`Usage: node scripts/benchmark.mjs [--check] [--json]

Build the package first. The benchmark compiles deterministic native line
charts at 1k, 10k, 100k, and 1M points. --check exits non-zero when a median
exceeds the portable budget in benchmarks/dashboard-baseline.json.`);
  process.exit(0);
}

let chartModule;
try {
  chartModule = await import(pathToFileURL(bundlePath).href);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[raze-charts] Cannot load ${bundlePath}. Run "npm run build" first.\n${detail}`);
  process.exit(1);
}

const { compileChart, defineChart, line } = chartModule;
if (typeof compileChart !== "function" || typeof defineChart !== "function" || typeof line !== "function") {
  console.error("[raze-charts] dist/chart.esm.js does not expose the native chart compiler.");
  process.exit(1);
}

const sizes = [1_000, 10_000, 100_000, 1_000_000];

function makeRows(size) {
  const rows = new Array(size);
  let value = 100;
  for (let index = 0; index < size; index += 1) {
    // Deterministic and intentionally cheap: data creation is outside timing.
    value += ((index * 17) % 23 - 11) * 0.0025;
    rows[index] = { x: index, y: value };
  }
  return rows;
}

function iterationCount(size) {
  if (size >= 1_000_000) return 3;
  if (size >= 100_000) return 5;
  if (size >= 10_000) return 9;
  return 15;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function compileAndValidate(definition, size) {
  const compiled = compileChart(definition, { width: 1280, height: 720 });
  const polyline = compiled.nodes.find((node) => node.type === "line" && node.role === "line");
  const renderedPoints = polyline?.points?.length ?? 0;
  if (!polyline || renderedPoints <= 0 || renderedPoints > size) {
    throw new Error(`Compiler produced ${renderedPoints} points for a ${size}-point input.`);
  }
  if (compiled.diagnostics?.sourceRows !== size) {
    throw new Error(`Compiler diagnostics reported ${compiled.diagnostics?.sourceRows ?? 0} of ${size} source rows.`);
  }
  if (size >= 10_000 && !(compiled.diagnostics.decimatedPoints > 0)) {
    throw new Error(`Expected automatic decimation for ${size} source points.`);
  }
  return compiled.nodes.length + renderedPoints + compiled.diagnostics.hoverSamples;
}

const results = [];
let checksum = 0;

for (const size of sizes) {
  let rows = makeRows(size);
  const definition = defineChart({
    marks: [
      line(rows, {
        x: "x",
        y: "y",
        name: "Benchmark",
        lastValue: false,
      }),
    ],
    grid: false,
    legend: false,
    tooltip: true,
    ariaLabel: "Benchmark chart",
  });

  // Smaller cases warm the shared compiler before the million-point case.
  const warmups = size < 1_000_000 ? 2 : 0;
  for (let index = 0; index < warmups; index += 1) {
    checksum += compileAndValidate(definition, size);
  }

  const samples = [];
  const iterations = iterationCount(size);
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    checksum += compileAndValidate(definition, size);
    samples.push(performance.now() - start);
  }

  const configured = baseline.sizes[String(size)];
  results.push({
    points: size,
    iterations,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    minMs: Math.min(...samples),
    baselineMs: configured.baselineMs,
    budgetMs: configured.budgetMs,
  });

  // Make the intended lifetime obvious to the collector between cases.
  rows = null;
}

const metadata = {
  scenario: baseline.scenario,
  node: process.version,
  platform: `${platform()} ${release()} ${process.arch}`,
  cpu: cpus()[0]?.model ?? "unknown",
  checksum,
  results,
};

if (json) {
  console.log(JSON.stringify(metadata, null, 2));
} else {
  console.log(`[raze-charts] ${baseline.scenario}`);
  console.log(`Node ${metadata.node} | ${metadata.platform} | ${metadata.cpu}`);
  console.log("Data generation and rendering are excluded; values are compiler wall time.");
  console.log("");
  console.log("points      runs    median       p95        baseline     budget");
  for (const result of results) {
    console.log(
      `${String(result.points).padEnd(11)}` +
      `${String(result.iterations).padEnd(8)}` +
      `${result.medianMs.toFixed(2).padStart(7)} ms  ` +
      `${result.p95Ms.toFixed(2).padStart(7)} ms  ` +
      `${result.baselineMs.toFixed(2).padStart(7)} ms  ` +
      `${result.budgetMs.toFixed(0).padStart(7)} ms`,
    );
  }
}

if (check) {
  const failures = results.filter((result) => result.medianMs > result.budgetMs);
  if (failures.length) {
    for (const failure of failures) {
      console.error(
        `[raze-charts] ${failure.points} points: median ${failure.medianMs.toFixed(2)} ms ` +
        `exceeds ${failure.budgetMs.toFixed(0)} ms budget.`,
      );
    }
    process.exitCode = 1;
  } else if (!json) {
    console.log("\n[raze-charts] performance budgets passed");
  }
}
