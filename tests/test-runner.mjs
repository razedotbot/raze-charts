// Discovery test runner (scripts/run-tests.mjs): discovery rules, ordering,
// subset selection, loud failures for typos, and real exit codes.
// Run: node tests/test-runner.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NON_TEST_FILES,
  RUN_LAST,
  discoverTests,
  planRun,
  planSteps,
} from "../scripts/run-tests.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = resolve(root, "scripts/run-tests.mjs");
const sandbox = mkdtempSync(join(tmpdir(), "raze-test-runner-"));
let passed = 0;

function test(name, body) {
  body();
  passed += 1;
  console.log(`✓ ${name}`);
}

function runRunner(args, env = process.env) {
  return spawnSync(process.execPath, [runner, ...args], { cwd: root, encoding: "utf8", env });
}

try {
  const fixture = join(sandbox, "tests");
  mkdirSync(join(fixture, "helpers"), { recursive: true });
  const pass = 'console.log("fixture pass");\n';
  writeFileSync(join(fixture, "zeta.mjs"), pass);
  writeFileSync(join(fixture, "alpha.mjs"), pass);
  writeFileSync(join(fixture, "alpha-extra.mjs"), pass);
  writeFileSync(join(fixture, "package-contract.mjs"), pass);
  writeFileSync(join(fixture, "build-watch.mjs"), pass);
  writeFileSync(join(fixture, "static-server.mjs"), 'throw new Error("static-server is not a test");\n');
  writeFileSync(join(fixture, "helpers", "shared.mjs"), 'throw new Error("helpers are not tests");\n');
  writeFileSync(join(fixture, "visual.spec.ts"), "// Playwright spec\n");
  writeFileSync(join(fixture, "notes.md"), "# not a test\n");

  test("discovery finds top-level .mjs tests and skips infrastructure, helpers, and specs", () => {
    const names = discoverTests(fixture).map((entry) => entry.name);
    assert.deepEqual(names, ["alpha", "alpha-extra", "zeta", "build-watch", "package-contract"]);
    assert.ok(NON_TEST_FILES.includes("static-server.mjs"));
  });

  test("discovery order is deterministic and slow suites run last in RUN_LAST order", () => {
    assert.deepEqual(RUN_LAST, ["build-watch", "package-contract"]);
    const first = discoverTests(fixture).map((entry) => entry.name);
    const second = discoverTests(fixture).map((entry) => entry.name);
    assert.deepEqual(first, second);
    assert.deepEqual(first.slice(-2), RUN_LAST);
  });

  test("a new tests/<name>.mjs is picked up without any manifest edit", () => {
    writeFileSync(join(fixture, "middle.mjs"), pass);
    const names = discoverTests(fixture).map((entry) => entry.name);
    assert.deepEqual(names, ["alpha", "alpha-extra", "middle", "zeta", "build-watch", "package-contract"]);
    rmSync(join(fixture, "middle.mjs"));
  });

  test("every repository test file is in the full plan exactly once", () => {
    const onDisk = readdirSync(resolve(root, "tests"))
      .filter((file) => file.endsWith(".mjs") && !NON_TEST_FILES.includes(file))
      .map((file) => file.slice(0, -4))
      .sort();
    const planned = planRun([]).tests.map((entry) => entry.name);
    assert.deepEqual([...planned].sort(), onDisk);
    assert.equal(new Set(planned).size, planned.length);
    assert.ok(planned.includes("test-runner"), "the runner self-test is itself discovered");
  });

  test("a full run gates on typecheck and build, then smoke, then tests", () => {
    const plan = planRun([`--tests-dir=${fixture}`]);
    assert.equal(plan.typecheck, true);
    assert.equal(plan.build, true);
    assert.equal(plan.smoke, true);
    const labels = planSteps(plan).map((step) => step.label);
    assert.deepEqual(labels.slice(0, 4), [
      "typecheck (src)",
      "typecheck (API type tests)",
      "build",
      "examples/smoke.mjs",
    ]);
    const prerequisites = planSteps(plan).filter((step) => step.prerequisite).map((step) => step.label);
    assert.deepEqual(prerequisites, ["typecheck (src)", "typecheck (API type tests)", "build"]);
  });

  test("a subset selects exact names, paths, and wildcards in discovery order", () => {
    const byName = planRun(["zeta", "alpha", `--tests-dir=${fixture}`]);
    assert.deepEqual(byName.tests.map((entry) => entry.name), ["alpha", "zeta"], "exact name does not prefix-match");
    assert.equal(byName.typecheck, false, "subset runs skip the type gate");
    assert.equal(byName.smoke, false, "subset runs skip the widget smoke test");
    assert.equal(byName.build, true, "subset runs still build dist/");
    const byPath = planRun(["tests/alpha-extra.mjs", "tests\\zeta.mjs", `--tests-dir=${fixture}`]);
    assert.deepEqual(byPath.tests.map((entry) => entry.name), ["alpha-extra", "zeta"]);
    const byWildcard = planRun(["alpha*", `--tests-dir=${fixture}`]);
    assert.deepEqual(byWildcard.tests.map((entry) => entry.name), ["alpha", "alpha-extra"]);
    const noBuild = planRun(["alpha", "--no-build", `--tests-dir=${fixture}`]);
    assert.equal(noBuild.build, false);
  });

  test("a selector that matches nothing throws and lists the available tests", () => {
    assert.throws(
      () => planRun(["alpah", `--tests-dir=${fixture}`]),
      /No test matches "alpah"\. Available tests: alpha, alpha-extra, zeta, build-watch, package-contract\./,
    );
  });

  test("an unknown option throws with the supported options", () => {
    assert.throws(() => planRun(["--watch"]), /Unknown option "--watch"\. Supported options: .*--bail/);
    assert.throws(() => planRun([`--tests-dir=${join(sandbox, "missing")}`]), /--tests-dir does not exist/);
  });

  test("the CLI exits 0 when every selected test passes", () => {
    const result = runRunner([`--tests-dir=${fixture}`, "--no-build", "alpha", "zeta"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /pass {2}.*alpha\.mjs/);
    assert.match(result.stdout, /2 step\(s\) passed/);
  });

  test("the CLI runs every test after a failure, then exits non-zero with a summary", () => {
    writeFileSync(join(fixture, "beta.mjs"), "process.exit(3);\n");
    try {
      const result = runRunner([`--tests-dir=${fixture}`, "--no-build", "alpha", "beta", "zeta"]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /FAIL {2}.*beta\.mjs.*\(exit code 3\)/);
      assert.match(result.stdout, /pass {2}.*zeta\.mjs/, "later tests still run without --bail");
      assert.match(result.stderr, /1 of 3 step\(s\) failed/);

      const bailed = runRunner([`--tests-dir=${fixture}`, "--no-build", "--bail", "alpha", "beta", "zeta"]);
      assert.equal(bailed.status, 1);
      assert.doesNotMatch(bailed.stdout, /zeta\.mjs/, "--bail stops at the first failure");
      assert.match(bailed.stdout, /skipped 1 step\(s\) after a failure/);
    } finally {
      rmSync(join(fixture, "beta.mjs"), { force: true });
    }
  });

  test("the CLI rejects typos with exit code 2 instead of running nothing", () => {
    const result = runRunner([`--tests-dir=${fixture}`, "--no-build", "alpah"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /No test matches "alpah"/);
  });

  test("--list prints the plan without running it", () => {
    const result = runRunner([`--tests-dir=${fixture}`, "--list"]);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines[0], "typecheck (src)");
    assert.ok(lines.at(-1).endsWith("package-contract.mjs"));
    assert.doesNotMatch(result.stdout, /fixture pass/);
  });

  test("a hung test fails with a timeout instead of stalling the run", () => {
    writeFileSync(join(fixture, "hang.mjs"), "setInterval(() => {}, 1000);\n");
    try {
      const started = Date.now();
      const result = runRunner(
        [`--tests-dir=${fixture}`, "--no-build", "hang", "alpha"],
        { ...process.env, RAZE_TEST_TIMEOUT_MS: "1500" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /FAIL\s+\S*hang\.mjs.*timed out after 1\.5 s/);
      assert.match(result.stdout, /pass\s+\S*alpha\.mjs/, "later tests still run after a timeout");
      assert.ok(Date.now() - started < 30_000, "the runner did not wait for the hung test");
    } finally {
      rmSync(join(fixture, "hang.mjs"), { force: true });
    }
    const invalid = runRunner(
      [`--tests-dir=${fixture}`, "--no-build", "alpha"],
      { ...process.env, RAZE_TEST_TIMEOUT_MS: "soon" },
    );
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /RAZE_TEST_TIMEOUT_MS must be a positive number/);
  });
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

console.log(`\nTEST RUNNER: PASS (${passed} checks)`);
