// Repository scripts fail loudly on typos (W1A-01 follow-ups):
// - the test runner derives its type gate from package.json scripts.typecheck,
// - every maintained CLI rejects unknown flags with exit code 2 and the list
//   of supported options, instead of silently running a default mode.
// Run: node tests/tooling-cli.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planRun, planSteps, typecheckCommands } from "../scripts/run-tests.mjs";
import { SUPPORTED_FLAGS, argumentProblem } from "../scripts/check-bundle-size.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
let passed = 0;
const test = (name, body) => {
  body();
  passed += 1;
  console.log(`✓ ${name}`);
};

test("the runner's type gate is exactly package.json scripts.typecheck", () => {
  const steps = planSteps(planRun([])).filter((step) => step.label.startsWith("typecheck"));
  const commands = typecheckCommands(pkg.scripts.typecheck);
  assert.equal(steps.length, commands.length);
  const asScript = steps.map((step) => ["tsc", ...step.args.slice(1)].join(" ")).join(" && ");
  assert.equal(asScript, pkg.scripts.typecheck.trim().replace(/\s+/g, " "));
  assert.ok(steps.every((step) => step.prerequisite), "type steps gate the run");
});

test("type steps keep readable labels for the known projects", () => {
  assert.deepEqual(
    typecheckCommands("tsc --noEmit && tsc -p tsconfig.type-tests.json").map((command) => command.label),
    ["typecheck (src)", "typecheck (API type tests)"],
  );
  assert.deepEqual(typecheckCommands("tsc -p ./tsconfig.extra.json").map((command) => command.label), ["typecheck (tsconfig.extra.json)"]);
});

test("a changed typecheck script changes the runner plan", () => {
  const steps = planSteps(planRun([]), { typecheckScript: "tsc --noEmit && tsc -p tsconfig.a.json && tsc -p tsconfig.b.json" });
  assert.deepEqual(
    steps.filter((step) => step.label.startsWith("typecheck")).map((step) => step.args.slice(1)),
    [["--noEmit"], ["-p", "tsconfig.a.json"], ["-p", "tsconfig.b.json"]],
  );
});

test("a typecheck script the runner cannot mirror fails with guidance", () => {
  assert.throws(() => typecheckCommands("vue-tsc --noEmit"), /must be tsc commands joined by "&&"/);
  assert.throws(() => typecheckCommands("tsc --noEmit | tee log"), /must be tsc commands/);
  assert.throws(() => typecheckCommands(undefined), /no "typecheck" script/);
  assert.throws(() => typecheckCommands("tsc -p"), /needs a project path/);
});

test("check-bundle-size validates its arguments", () => {
  assert.equal(argumentProblem([]), null);
  assert.equal(argumentProblem(["--json"]), null);
  assert.match(argumentProblem(["--chek-docs"]), new RegExp(`Unknown option "--chek-docs"\\. Supported options: ${SUPPORTED_FLAGS.join(", ")}`));
  assert.match(argumentProblem(["--json", "--write-docs"]), /Choose one of/);
});

const run = (script, args) => spawnSync(process.execPath, [resolve(root, script), ...args], { cwd: root, encoding: "utf8" });

for (const [script, flag, supported] of [
  ["scripts/check-bundle-size.mjs", "--check-doc", "--check-docs"],
  ["scripts/entries.mjs", "--wrte", "--write"],
  ["scripts/check-docs.mjs", "--fix", "--write"],
  ["scripts/check-doc-snippets.mjs", "--verbose", "--list"],
  ["scripts/check-dom-sinks.mjs", "--jsn", "--json"],
  ["scripts/run-tests.mjs", "--bial", "--bail"],
]) {
  test(`${script} exits 2 on an unknown flag and lists the supported ones`, () => {
    const result = run(script, [flag]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(`Unknown option "${flag}"`));
    assert.ok(result.stderr.includes(supported), result.stderr);
  });
}

test("entries.mjs rejects conflicting modes", () => {
  const result = run("scripts/entries.mjs", ["--write", "--check"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Choose one of --write, --check/);
});

console.log(`TOOLING CLI: PASS (${passed} checks)`);
