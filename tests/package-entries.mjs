// Public entry table (scripts/entries.mjs): package.json stays generated from
// it, every entry builds real code, and /studies exposes the pure kernels.
// Run after the build: node build.mjs && node tests/package-entries.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PACKAGE_ENTRIES,
  bundleArtifacts,
  entryArtifacts,
  entryById,
  entrySpecifier,
  packageExports,
  packageManifestDrift,
  packageTypesVersions,
} from "../scripts/entries.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const require = createRequire(import.meta.url);
let passed = 0;

async function test(name, body) {
  await body();
  passed += 1;
  console.log(`✓ ${name}`);
}

await test("package.json exports, typesVersions, and root fields match the entry table", () => {
  assert.deepEqual(packageManifestDrift(pkg), []);
  assert.deepEqual(pkg.exports, packageExports());
  assert.deepEqual(pkg.typesVersions, packageTypesVersions());
});

await test("drift is reported with a specific, actionable message", () => {
  const missing = structuredClone(pkg);
  delete missing.exports["./studies"];
  assert.deepEqual(packageManifestDrift(missing), [
    '"exports" differs from scripts/entries.mjs (missing ./studies)',
  ]);
  const extra = structuredClone(pkg);
  extra.exports["./drawings"] = "./dist/drawings.esm.js";
  extra.typesVersions["*"].drawings = ["./dist/types/drawings/index.d.ts"];
  assert.deepEqual(packageManifestDrift(extra), [
    '"exports" differs from scripts/entries.mjs (unexpected ./drawings)',
    '"typesVersions" differs from scripts/entries.mjs',
  ]);
  const retargeted = structuredClone(pkg);
  retargeted.main = "dist/index.cjs";
  assert.match(packageManifestDrift(retargeted)[0], /"main" is "dist\/index\.cjs", expected "dist\/charting_library\.cjs"/);
});

await test("entry ids, subpaths, sources, and artifact names are unique and well-formed", () => {
  const unique = (values) => new Set(values).size === values.length;
  assert.ok(unique(PACKAGE_ENTRIES.map((entry) => entry.id)));
  assert.ok(unique(PACKAGE_ENTRIES.map((entry) => entry.subpath)));
  assert.ok(unique(PACKAGE_ENTRIES.map((entry) => entry.basename)));
  assert.ok(unique(bundleArtifacts()));
  assert.equal(PACKAGE_ENTRIES[0].subpath, ".", "the root entry comes first");
  for (const entry of PACKAGE_ENTRIES) {
    assert.match(entry.subpath, /^\.(?:\/[a-z0-9-]+)*$/, `${entry.id} subpath`);
    assert.ok(existsSync(resolve(root, entry.source)), `${entry.id} source ${entry.source} exists`);
    assert.equal(typeof entry.smoke, "string", `${entry.id} names a smoke export`);
    for (const target of Object.values(entry.shareRuntime ?? {})) {
      assert.doesNotThrow(() => entryById(target), `${entry.id} shares a known runtime`);
    }
  }
  assert.throws(() => entryById("drawings"), /Unknown package entry "drawings"\. Known entries: root, chart, react, studies\./);
});

await test("every entry is built as ESM, CJS, source maps, and declarations", () => {
  for (const artifact of bundleArtifacts()) {
    assert.ok(existsSync(resolve(root, "dist", artifact)), `dist/${artifact}`);
    assert.ok(existsSync(resolve(root, "dist", `${artifact}.map`)), `dist/${artifact}.map`);
  }
  for (const entry of PACKAGE_ENTRIES) {
    assert.ok(existsSync(resolve(root, "dist", entryArtifacts(entry).types)), `${entry.id} declarations`);
  }
});

await test("every entry exports real code in both module formats", async () => {
  for (const entry of PACKAGE_ENTRIES) {
    if (entry.external?.includes("react")) continue; // exercised by tests/react-adapter.mjs
    const { esm, cjs } = entryArtifacts(entry);
    const esmModule = await import(pathToFileURL(resolve(root, "dist", esm)).href);
    const cjsModule = require(resolve(root, "dist", cjs));
    assert.equal(typeof esmModule[entry.smoke], "function", `${entrySpecifier(entry, pkg.name)} ESM ${entry.smoke}`);
    assert.equal(typeof cjsModule[entry.smoke], "function", `${entrySpecifier(entry, pkg.name)} CJS ${entry.smoke}`);
    assert.deepEqual(
      Object.keys(esmModule).filter((key) => key !== "default").sort(),
      Object.keys(cjsModule).filter((key) => key !== "default" && key !== "__esModule").sort(),
      `${entry.id} ESM and CJS expose the same names`,
    );
  }
});

const studies = await import(pathToFileURL(resolve(root, "dist/studies.esm.js")).href);
const rootBundle = await import(pathToFileURL(resolve(root, "dist/charting_library.esm.js")).href);

await test("/studies exports the kernels and registry pieces, matching the root", () => {
  const expected = [
    "BUILTIN_STUDIES",
    "StudyRegistry",
    "bollinger",
    "closesFromBars",
    "ema",
    "macd",
    "rsi",
    "sma",
    "sourceValues",
    "stdev",
    "vwap",
  ];
  assert.deepEqual(Object.keys(studies).sort(), expected.sort());
  const closes = Array.from({ length: 40 }, (_, index) => 100 + Math.sin(index / 3) * 5 + index * 0.25);
  for (const kernel of ["sma", "ema", "rsi", "stdev"]) {
    assert.deepEqual(studies[kernel](closes, 14), rootBundle[kernel](closes, 14), `${kernel} matches the root export`);
  }
  assert.deepEqual(studies.bollinger(closes, 20, 2), rootBundle.bollinger(closes, 20, 2));
  assert.deepEqual(studies.macd(closes, 12, 26, 9), rootBundle.macd(closes, 12, 26, 9));
  assert.deepEqual(
    studies.BUILTIN_STUDIES.map((definition) => definition.name),
    rootBundle.BUILTIN_STUDIES.map((definition) => definition.name),
  );
});

await test("/studies kernels compute from bars without the widget", () => {
  const day = 86_400_000;
  const bars = [
    { time: 0, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { time: 60_000, open: 11, high: 13, low: 10, close: 12, volume: 300 },
    { time: day, open: 12, high: 12, low: 12, close: 12, volume: 50 },
  ];
  assert.deepEqual(studies.closesFromBars(bars), [11, 12, 12]);
  assert.deepEqual(studies.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const vwap = studies.vwap(bars);
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
  close(vwap[0], (12 + 9 + 11) / 3);
  close(vwap[1], ((32 / 3) * 100 + (35 / 3) * 300) / 400);
});

await test("/studies registry resolves built-ins and host definitions", () => {
  const registry = new studies.StudyRegistry();
  assert.equal(registry.resolve("moving average exponential")?.name, "EMA");
  const spread = {
    name: "Spread",
    pane: "pane",
    compute: (bars) => bars.map((bar) => bar.high - bar.low),
  };
  registry.register(spread);
  assert.equal(registry.resolve("spread")?.name, "Spread");
  const values = registry.resolve("rsi").compute(
    Array.from({ length: 30 }, (_, index) => ({ time: index, open: index, high: index + 1, low: index, close: index + 1 })),
    { length: 14 },
  );
  assert.equal(values.length, 30);
  assert.equal(values[29], 100, "a strictly rising series has an RSI of 100");
});

await test("/studies declarations publish the contract types", () => {
  const declarations = readFileSync(resolve(root, "dist", entryArtifacts(entryById("studies")).types), "utf8");
  for (const name of ["StudyDefinition", "StudySeries", "StudyInputs", "Bar", "StudyRegistry", "ema"]) {
    assert.match(declarations, new RegExp(`\\b${name}\\b`), `${name} is declared`);
  }
  assert.match(declarations, /from "\.\/calc\.js"/, "NodeNext-compatible specifiers");
});

console.log(`\nPACKAGE ENTRIES: PASS (${passed} checks)`);
