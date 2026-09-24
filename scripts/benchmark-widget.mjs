#!/usr/bin/env node

// Financial widget browser benchmark runner. Drives Chromium through
// playwright.perf.config.ts, prints median/p95 per scenario and data size, and
// optionally enforces or records the portable budgets in
// benchmarks/widget-baseline.json.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCENARIO_IDS,
  evaluateBudgets,
  formatTable,
  parseSizes,
  recordBaseline,
} from "./widget-benchmark-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(root, "benchmarks/widget-baseline.json");
const bundlePath = resolve(root, "dist/charting_library.esm.js");

const USAGE = `Usage: node scripts/benchmark-widget.mjs [options]

Measures the financial widget in headless Chromium (1100x620, DPR 1) at
1k, 10k, 100k and 500k bars: load, repaint at three zoom levels, crosshair
moves, pan, wheel zoom, six-study repaint, live ticks, and retained heap.
Build first (node build.mjs). Time values are main-thread milliseconds for
the input handler plus every animation frame it causes, rasterisation included.

Options:
  --check          Exit non-zero when a median exceeds its portable budget, or
                   when a measured scenario has no budget.
  --strict         With --check, enforce the aspirational "target" values
                   (where defined) instead of the portable budgets.
  --json           Print machine-readable results on stdout (Playwright
                   progress goes to stderr).
  --record         Write the measured medians into
                   benchmarks/widget-baseline.json. Existing budgets and
                   targets are kept; new entries get a portable budget.
  --sizes=LIST     Comma-separated bar counts, e.g. --sizes=1k,100k.
  --no-raster      Skip the per-frame canvas readback (script time only).
  --help           Show this message.

Environment: PW_PORT selects the static server port (default 8798).`;

const KNOWN_FLAGS = new Set(["--check", "--strict", "--json", "--record", "--no-raster", "--help"]);

function parseArgs(argv) {
  const flags = new Set();
  let sizes;
  for (const arg of argv) {
    if (arg.startsWith("--sizes=")) {
      sizes = arg.slice("--sizes=".length);
    } else if (KNOWN_FLAGS.has(arg)) {
      flags.add(arg);
    } else {
      throw new Error(`[raze-charts] unknown option "${arg}". Run with --help for the supported options.`);
    }
  }
  if (flags.has("--strict") && !flags.has("--check")) {
    throw new Error("[raze-charts] --strict only applies together with --check.");
  }
  return { flags, sizes: parseSizes(sizes) };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const { flags, sizes } = options;

if (flags.has("--help")) {
  console.log(USAGE);
  process.exit(0);
}

if (!existsSync(bundlePath)) {
  fail(`[raze-charts] Cannot find ${bundlePath}. Run "node build.mjs" first.`);
}

let playwrightCli;
try {
  playwrightCli = createRequire(import.meta.url).resolve("@playwright/test/cli");
} catch {
  fail('[raze-charts] @playwright/test is not installed. Run "npm ci" and "npx playwright install chromium".');
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const json = flags.has("--json");
const workDir = mkdtempSync(join(tmpdir(), "raze-widget-bench-"));
const outPath = join(workDir, "results.json");

// Invoke the CLI through the current Node binary: portable across Windows,
// macOS and Linux without a shell or an npx shim.
const run = spawnSync(
  process.execPath,
  [playwrightCli, "test", "--config", resolve(root, "playwright.perf.config.ts")],
  {
    cwd: root,
    env: {
      ...process.env,
      RAZE_BENCH_SIZES: sizes.join(","),
      RAZE_BENCH_OUT: outPath,
      RAZE_BENCH_RASTER: flags.has("--no-raster") ? "0" : "1",
      // Budgets are evaluated here so the report and the verdict agree.
      RAZE_BENCH_CHECK: "0",
    },
    // Keep stdout clean for --json consumers.
    stdio: ["ignore", json ? process.stderr : "inherit", "inherit"],
  },
);

if (run.error) {
  rmSync(workDir, { recursive: true, force: true });
  fail(`[raze-charts] Could not start Playwright: ${run.error.message}`);
}

if (!existsSync(outPath)) {
  rmSync(workDir, { recursive: true, force: true });
  fail(`[raze-charts] The browser benchmark produced no results (Playwright exit code ${run.status}).`);
}

const results = JSON.parse(readFileSync(outPath, "utf8"));
rmSync(workDir, { recursive: true, force: true });

const incomplete = sizes.flatMap((size) => SCENARIO_IDS
  .filter((id) => !results.scenarios?.[id]?.[String(size)])
  .map((id) => `${id} @ ${size}`));

const metadata = {
  suite: baseline.suite,
  node: process.version,
  platform: `${platform()} ${release()} ${process.arch}`,
  cpu: cpus()[0]?.model?.trim() ?? "unknown",
  ...results.environment,
};

if (json) {
  console.log(JSON.stringify({ metadata, scenarios: results.scenarios, incomplete }, null, 2));
} else {
  console.log("");
  console.log(`[raze-charts] ${baseline.suite}: ${baseline.description}`);
  console.log(`${metadata.browser} | ${metadata.platform} | ${metadata.cpu}`);
  console.log(
    `Viewport ${metadata.viewport}; raster ${metadata.rasterFlush ? "included" : "excluded"}; `
    + `timer resolution ${metadata.crossOriginIsolated ? "5 µs (cross-origin isolated)" : "100 µs (not isolated)"}.`,
  );
  console.log("");
  console.log(formatTable(results, baseline));
}

if (!metadata.crossOriginIsolated) {
  console.warn(
    "\n[raze-charts] warning: the benchmark page was not cross-origin isolated, so timers are "
    + "coarsened to 100 µs. Start it through playwright.perf.config.ts (CROSS_ORIGIN_ISOLATED=1).",
  );
}

let exitCode = run.status === 0 ? 0 : 1;
if (run.status !== 0) {
  console.error(`\n[raze-charts] Playwright exited with code ${run.status}; see the output above.`);
}
if (incomplete.length) {
  console.error(`\n[raze-charts] missing measurements: ${incomplete.join(", ")}`);
  exitCode = 1;
}

if (flags.has("--record")) {
  if (exitCode !== 0) {
    console.error("[raze-charts] not recording a baseline from an incomplete or failed run.");
  } else {
    const reference = {
      browser: metadata.browser,
      platform: metadata.platform,
      cpu: metadata.cpu,
      node: metadata.node,
      rasterIncluded: Boolean(metadata.rasterFlush),
      captured: new Date().toISOString().slice(0, 10),
      note: baseline.reference?.note
        ?? "Maintainer workstation reference; compare trends, not machines. --check enforces the portable budget only.",
    };
    const next = recordBaseline(baseline, results, reference);
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    if (!json) console.log(`\n[raze-charts] recorded reference medians in ${baselinePath}`);
  }
}

if (flags.has("--check")) {
  if (Boolean(baseline.reference?.rasterIncluded) !== Boolean(metadata.rasterFlush)) {
    console.warn(
      "[raze-charts] warning: this run and the checked-in reference differ in raster inclusion; "
      + "compare like with like.",
    );
  }
  const { failures, missing } = evaluateBudgets(results, baseline, { strict: flags.has("--strict") });
  for (const item of missing) {
    console.error(
      `[raze-charts] ${item.scenario} at ${item.size} bars has no budget in benchmarks/widget-baseline.json; `
      + "run with --record to add one.",
    );
  }
  for (const failure of failures) {
    console.error(
      `[raze-charts] ${failure.scenario} at ${failure.size} bars: median ${failure.median} ${failure.unit} `
      + `exceeds the ${failure.limit} ${failure.unit} ${failure.limitKind}.`,
    );
  }
  if (failures.length || missing.length) exitCode = 1;
  else if (!json && exitCode === 0) console.log(`\n[raze-charts] widget performance ${flags.has("--strict") ? "targets" : "budgets"} passed`);
}

process.exitCode = exitCode;
