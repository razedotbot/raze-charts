#!/usr/bin/env node
// Discovery test runner behind `npm test`.
//
// A full run is: typecheck -> build -> examples/smoke.mjs -> every
// tests/*.mjs file. Test files are discovered, so adding a regression is
// "drop tests/<name>.mjs" with no package.json edit. A test file is a
// self-executing Node script that exits non-zero on failure.
//
//   node scripts/run-tests.mjs                   full run
//   node scripts/run-tests.mjs chart data-manager  build, then only those tests
//   node scripts/run-tests.mjs "chart*"          `*` wildcards select by name
//   node scripts/run-tests.mjs --list            print the plan without running
//
// Not tests: tests/static-server.mjs (the Playwright web server) and anything
// under tests/helpers/ (shared modules). Playwright specs (*.spec.ts) run
// through `npx playwright test`.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files in the tests directory that are infrastructure, not tests. */
export const NON_TEST_FILES = Object.freeze(["static-server.mjs"]);

/**
 * Slow end-to-end suites run last, in this order, so fast feedback arrives
 * first. build-watch rebuilds dist/ in watch mode; package-contract packs and
 * installs the tarball, which must therefore see a settled dist/.
 */
export const RUN_LAST = Object.freeze(["build-watch", "package-contract"]);

/**
 * Discover test files: top-level `*.mjs` in `testsDir`, minus helpers and
 * infrastructure, sorted by name with RUN_LAST suites moved to the end.
 * Returns `{ name, file }` records where `name` is the basename without `.mjs`.
 */
export function discoverTests(testsDir) {
  if (!existsSync(testsDir)) return [];
  const names = readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => entry.name)
    .filter((file) => !NON_TEST_FILES.includes(file))
    .map((file) => file.slice(0, -".mjs".length))
    // Code-unit order is locale-independent, so every machine agrees.
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const rank = (name) => {
    const index = RUN_LAST.indexOf(name);
    return index === -1 ? -1 : index;
  };
  const ordered = [
    ...names.filter((name) => rank(name) === -1),
    ...names.filter((name) => rank(name) !== -1).sort((left, right) => rank(left) - rank(right)),
  ];
  return ordered.map((name) => ({ name, file: resolve(testsDir, `${name}.mjs`) }));
}

function wildcard(pattern) {
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`);
}

/** Normalise a CLI selector: "tests/chart.mjs", "chart.mjs" and "chart" all mean "chart". */
function selectorName(selector) {
  return selector.replaceAll("\\", "/").replace(/^(?:\.\/)?tests\//, "").replace(/\.mjs$/, "");
}

/**
 * Parse CLI arguments into a run plan. Throws with guidance for unknown flags
 * or selectors that match no test, so a typo never silently runs nothing.
 */
export function planRun(argv, { testsDir = resolve(repositoryRoot, "tests") } = {}) {
  const flags = new Set();
  const selectors = [];
  const knownFlags = ["--list", "--bail", "--no-build", "--no-typecheck", "--no-smoke", "--help", "--tests-dir=<path>"];
  for (const argument of argv) {
    if (argument.startsWith("--tests-dir=")) {
      testsDir = resolve(argument.slice("--tests-dir=".length));
      if (!existsSync(testsDir)) throw new Error(`--tests-dir does not exist: ${testsDir}`);
    } else if (argument.startsWith("--")) {
      if (!knownFlags.includes(argument)) {
        throw new Error(`Unknown option "${argument}". Supported options: ${knownFlags.join(", ")}.`);
      }
      flags.add(argument);
    } else {
      selectors.push(argument);
    }
  }
  const available = discoverTests(testsDir);
  let tests = available;
  if (selectors.length) {
    const chosen = new Set();
    for (const selector of selectors) {
      const matcher = wildcard(selectorName(selector));
      const matches = available.filter((test) => matcher.test(test.name));
      if (!matches.length) {
        throw new Error(
          `No test matches "${selector}". Available tests: ${available.map((test) => test.name).join(", ")}.`,
        );
      }
      for (const test of matches) chosen.add(test.name);
    }
    // Keep discovery order regardless of argument order.
    tests = available.filter((test) => chosen.has(test.name));
  }
  const subset = selectors.length > 0;
  return {
    help: flags.has("--help"),
    list: flags.has("--list"),
    bail: flags.has("--bail"),
    // A subset run is for quick iteration: it still builds (tests import dist/)
    // but leaves the type gate and the widget smoke test to the full run.
    typecheck: !subset && !flags.has("--no-typecheck"),
    build: !flags.has("--no-build"),
    smoke: !subset && !flags.has("--no-smoke"),
    tests,
  };
}

function displayPath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

/** Build the ordered list of steps (commands) for a plan. */
export function planSteps(plan) {
  const node = process.execPath;
  const steps = [];
  if (plan.typecheck) {
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    steps.push({ label: "typecheck (src)", command: node, args: [tsc, "--noEmit"], prerequisite: true });
    steps.push({
      label: "typecheck (API type tests)",
      command: node,
      args: [tsc, "-p", "tsconfig.type-tests.json"],
      prerequisite: true,
    });
  }
  if (plan.build) {
    steps.push({ label: "build", command: node, args: ["build.mjs"], prerequisite: true });
  }
  if (plan.smoke) {
    steps.push({ label: "examples/smoke.mjs", command: node, args: ["examples/smoke.mjs"] });
  }
  for (const test of plan.tests) {
    steps.push({ label: displayPath(test.file), command: node, args: [test.file] });
  }
  return steps;
}

function formatDuration(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const usage = `Usage: node scripts/run-tests.mjs [options] [test ...]

With no test names: typecheck, build, examples/smoke.mjs, then every
tests/*.mjs (build-watch and package-contract last).
With test names (basename, "tests/<name>.mjs", or a * wildcard): build, then
only the matching tests.

Options:
  --list          print the plan and exit
  --bail          stop at the first failing test (prerequisites always stop)
  --no-build      reuse the existing dist/
  --no-typecheck  skip the TypeScript gate on a full run
  --no-smoke      skip examples/smoke.mjs on a full run
  --tests-dir=<path>  discover tests in another directory (runner self-test)
  --help          show this message`;

function main(argv) {
  let plan;
  try {
    plan = planRun(argv);
  } catch (error) {
    console.error(`[raze-charts] ${error.message}`);
    return 2;
  }
  if (plan.help) {
    console.log(usage);
    return 0;
  }
  const steps = planSteps(plan);
  if (plan.list) {
    for (const step of steps) console.log(step.label);
    return 0;
  }

  const results = [];
  const started = performance.now();
  for (const step of steps) {
    console.log(`\n[raze-charts] ▶ ${step.label}`);
    const stepStarted = performance.now();
    const result = spawnSync(step.command, step.args, { cwd: repositoryRoot, stdio: "inherit" });
    const duration = performance.now() - stepStarted;
    const ok = result.status === 0;
    const reason = ok
      ? ""
      : result.error
        ? result.error.message
        : result.signal
          ? `killed by ${result.signal}`
          : `exit code ${result.status}`;
    results.push({ label: step.label, ok, duration, reason });
    if (!ok && (step.prerequisite || plan.bail)) break;
  }

  const failed = results.filter((result) => !result.ok);
  const skipped = steps.length - results.length;
  console.log("\n[raze-charts] test summary");
  for (const result of results) {
    const status = result.ok ? "pass" : "FAIL";
    const detail = result.ok ? "" : `  (${result.reason})`;
    console.log(`  ${status}  ${result.label.padEnd(36)} ${formatDuration(result.duration).padStart(8)}${detail}`);
  }
  if (skipped) console.log(`  skipped ${skipped} step(s) after a failure`);
  const total = formatDuration(performance.now() - started);
  if (failed.length) {
    console.error(`\n[raze-charts] ${failed.length} of ${results.length} step(s) failed in ${total}`);
    return 1;
  }
  console.log(`\n[raze-charts] ${results.length} step(s) passed in ${total}`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exitCode = main(process.argv.slice(2));
