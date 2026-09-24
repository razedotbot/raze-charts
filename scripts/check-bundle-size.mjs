#!/usr/bin/env node
// Bundle-size gate.
//
// Two measurements per public entry, both gzip level 9, source maps excluded:
//
//   artifact  the published ESM file (dist/<entry>.esm.js) as shipped. Guards
//             accidental growth of the distributable, but over-states what a
//             consumer pays: /chart and /react are intentionally unminified so
//             their PURE annotations survive for downstream tree shaking.
//   scenario  what a consumer ships: a browser bundle of a realistic import
//             from the published package, tree-shaken and minified by esbuild,
//             peers such as React left external.
//
// Budgets are one file per entry, benchmarks/budgets/<entry id>.json, keyed by
// the ids in scripts/entries.mjs. Every entry must have a budget file and
// every budget file must name an entry; the gate fails loudly otherwise.
//
// The budget table in docs/performance.md is generated from the same files:
// `--write-docs` rewrites it and `--check-docs` (run by `npm run check:docs`)
// fails when it drifts.

import { build } from "esbuild";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { PACKAGE_ENTRIES, entryArtifacts, entrySpecifier } from "./entries.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const COMPRESSION = "gzip level 9";
export const DOCS_START = "<!-- bundle-budgets:start -->";
export const DOCS_END = "<!-- bundle-budgets:end -->";
const DOCS_NOTE =
  "<!-- Generated from benchmarks/budgets/*.json by `node scripts/check-bundle-size.mjs --write-docs`. Do not edit by hand. -->";

const gzipBytes = (buffer) => gzipSync(buffer, { level: 9 }).byteLength;

// ── Budget files ─────────────────────────────────────────────────────────────

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Load and validate benchmarks/budgets/*.json against the entry table.
 * Returns `{ budgets, problems }`; `budgets` is in entry-table order.
 */
export function loadBudgets({
  budgetsDir = resolve(repositoryRoot, "benchmarks/budgets"),
  entries = PACKAGE_ENTRIES,
} = {}) {
  const problems = [];
  const budgets = [];
  const files = existsSync(budgetsDir)
    ? readdirSync(budgetsDir).filter((file) => file.endsWith(".json"))
    : [];
  const knownIds = new Set(entries.map((entry) => entry.id));
  for (const file of files) {
    const id = file.slice(0, -".json".length);
    if (!knownIds.has(id)) {
      problems.push(
        `benchmarks/budgets/${file} does not match an entry in scripts/entries.mjs (known: ${[...knownIds].join(", ")})`,
      );
    }
  }
  for (const entry of entries) {
    const file = `${entry.id}.json`;
    const path = resolve(budgetsDir, file);
    if (!files.includes(file)) {
      problems.push(
        `entry "${entry.id}" (${entry.subpath}) has no budget; add benchmarks/budgets/${file} with an artifact budget and at least one scenario`,
      );
      continue;
    }
    let budget;
    try {
      budget = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      problems.push(`benchmarks/budgets/${file} is not valid JSON: ${error.message}`);
      continue;
    }
    const where = `benchmarks/budgets/${file}`;
    if (budget.entry !== entry.id) {
      problems.push(`${where}: "entry" must be "${entry.id}"`);
    }
    if (!isPositiveInteger(budget.artifact?.gzipBytes)) {
      problems.push(`${where}: "artifact.gzipBytes" must be a positive integer`);
    }
    if (!Array.isArray(budget.scenarios) || budget.scenarios.length === 0) {
      problems.push(`${where}: "scenarios" must list at least one consumer scenario`);
    }
    const names = new Set();
    for (const [index, scenario] of (Array.isArray(budget.scenarios) ? budget.scenarios : []).entries()) {
      const label = `${where}: scenarios[${index}]`;
      if (typeof scenario?.name !== "string" || !scenario.name.trim()) {
        problems.push(`${label} needs a "name"`);
      } else if (names.has(scenario.name)) {
        problems.push(`${label} repeats the name "${scenario.name}"`);
      } else {
        names.add(scenario.name);
      }
      if (
        !Array.isArray(scenario?.imports) ||
        scenario.imports.length === 0 ||
        !scenario.imports.every((name) => typeof name === "string" && /^[A-Za-z_$][\w$]*$/.test(name))
      ) {
        problems.push(`${label} needs "imports": a non-empty list of named exports of ${entry.subpath}`);
      }
      if (!isPositiveInteger(scenario?.gzipBytes)) {
        problems.push(`${label} needs a positive integer "gzipBytes"`);
      }
    }
    budgets.push({ ...budget, entry });
  }
  return { budgets, problems };
}

// ── Measurement ──────────────────────────────────────────────────────────────

/**
 * Resolve `@razedotbot/charts[/subpath]` through package.json `exports` with
 * the browser + import conditions, exactly as a consumer bundler would.
 */
function packageResolver(pkg) {
  const escaped = pkg.name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return {
    name: "raze-charts-package",
    setup(buildContext) {
      buildContext.onResolve({ filter: new RegExp(`^${escaped}(?:/.*)?$`) }, (args) => {
        const key = args.path === pkg.name ? "." : `.${args.path.slice(pkg.name.length)}`;
        const target = pkg.exports?.[key];
        if (!target) {
          return { errors: [{ text: `"${args.path}" is not exported by package.json` }] };
        }
        const file = typeof target === "string" ? target : target.import?.browser ?? target.import?.default ?? target.default;
        return { path: resolve(repositoryRoot, file) };
      });
    },
  };
}

export function scenarioSource(entry, scenario, packageName) {
  const names = scenario.imports.join(", ");
  return `import { ${names} } from ${JSON.stringify(entrySpecifier(entry, packageName))};\nexport { ${names} };\n`;
}

async function measureScenario(entry, scenario, pkg) {
  const result = await build({
    stdin: {
      contents: scenarioSource(entry, scenario, pkg.name),
      resolveDir: repositoryRoot,
      sourcefile: `scenario-${entry.id}.mjs`,
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    treeShaking: true,
    metafile: true,
    logLevel: "silent",
    external: [...(entry.external ?? [])],
    plugins: [packageResolver(pkg)],
  });
  const output = result.outputFiles[0].contents;
  const meta = Object.values(result.metafile.outputs)[0];
  const largestInputs = Object.entries(meta.inputs)
    .sort(([, left], [, right]) => right.bytesInOutput - left.bytesInOutput)
    .slice(0, 5)
    .map(([path, detail]) => `${path.replaceAll("\\", "/")}: ${detail.bytesInOutput}`);
  return { rawBytes: output.byteLength, gzipBytes: gzipBytes(output), largestInputs };
}

export async function measure({ budgets, pkg }) {
  const failures = [];
  const results = [];
  for (const budget of budgets) {
    const { entry } = budget;
    const artifactPath = `dist/${entryArtifacts(entry).esm}`;
    const absolute = resolve(repositoryRoot, artifactPath);
    if (!existsSync(absolute)) {
      failures.push(`${artifactPath} is missing; run "npm run build" first`);
      continue;
    }
    const source = readFileSync(absolute);
    const artifactGzip = gzipBytes(source);
    results.push({
      entry: entry.id,
      kind: "artifact",
      name: `${entry.title} artifact`,
      path: artifactPath,
      rawBytes: source.byteLength,
      gzipBytes: artifactGzip,
      budgetGzipBytes: budget.artifact.gzipBytes,
      remainingBytes: budget.artifact.gzipBytes - artifactGzip,
    });
    if (artifactGzip > budget.artifact.gzipBytes) {
      failures.push(
        `${entry.title} artifact (${artifactPath}) is ${artifactGzip} gzip bytes, above its ${budget.artifact.gzipBytes}-byte budget`,
      );
    }
    for (const external of entry.external ?? []) {
      // Peers must stay imports; a bundled peer would ship a second copy.
      if (external.includes("/")) continue;
      const escaped = external.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`from\\s*["']${escaped}(?:\\/[^"']*)?["']`).test(source.toString("utf8"))) {
        failures.push(`${entry.title} artifact no longer imports external peer "${external}"`);
      }
    }
    for (const scenario of budget.scenarios) {
      let measured;
      try {
        measured = await measureScenario(entry, scenario, pkg);
      } catch (error) {
        const detail = error.errors?.map((item) => item.text).join("; ") ?? error.message;
        failures.push(`${entry.title} scenario "${scenario.name}" could not be bundled: ${detail}`);
        continue;
      }
      results.push({
        entry: entry.id,
        kind: "scenario",
        name: scenario.name,
        imports: scenario.imports,
        rawBytes: measured.rawBytes,
        gzipBytes: measured.gzipBytes,
        budgetGzipBytes: scenario.gzipBytes,
        remainingBytes: scenario.gzipBytes - measured.gzipBytes,
        largestInputs: measured.largestInputs,
      });
      if (measured.gzipBytes > scenario.gzipBytes) {
        failures.push(
          `${entry.title} scenario "${scenario.name}" ships ${measured.gzipBytes} gzip bytes, above its ${scenario.gzipBytes}-byte budget; largest inputs: ${measured.largestInputs.join(", ")}`,
        );
      }
    }
  }
  return { results, failures };
}

// ── Documentation table ──────────────────────────────────────────────────────

function formatKiB(bytes) {
  const kib = bytes / 1024;
  const text = Number.isInteger(kib) ? String(kib) : kib.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${text} KiB`;
}

/** Markdown table (with markers) generated from the budget files. */
export function renderDocsTable(budgets, packageName = "@razedotbot/charts") {
  const rows = [
    "| Entrypoint | Measurement | Contents | Gzip budget |",
    "| --- | --- | --- | ---: |",
  ];
  for (const budget of budgets) {
    const { entry } = budget;
    const label = `${entry.title} (\`${entrySpecifier(entry, packageName)}\`)`;
    rows.push(
      `| ${label} | Published artifact | \`${entryArtifacts(entry).esm}\` | ${formatKiB(budget.artifact.gzipBytes)} |`,
    );
    for (const scenario of budget.scenarios) {
      rows.push(
        `| | Scenario: ${scenario.name} | \`import { ${scenario.imports.join(", ")} }\` | ${formatKiB(scenario.gzipBytes)} |`,
      );
    }
  }
  return [DOCS_START, DOCS_NOTE, "", ...rows, "", DOCS_END].join("\n");
}

/** Extract the generated region from a document, or null when markers are absent. */
function docsRegion(text) {
  const start = text.indexOf(DOCS_START);
  const end = text.indexOf(DOCS_END);
  if (start === -1 || end === -1 || end < start) return null;
  return { start, end: end + DOCS_END.length };
}

/** Returns a problem string when the docs table disagrees with the budgets, else null. */
export function docsDrift(text, budgets, packageName) {
  const region = docsRegion(text);
  if (!region) {
    return `docs/performance.md has no generated budget table; add the ${DOCS_START} / ${DOCS_END} markers and run "node scripts/check-bundle-size.mjs --write-docs"`;
  }
  const current = text.slice(region.start, region.end).replace(/\r\n/g, "\n");
  if (current !== renderDocsTable(budgets, packageName)) {
    return 'docs/performance.md budget table disagrees with benchmarks/budgets/*.json; run "node scripts/check-bundle-size.mjs --write-docs"';
  }
  return null;
}

export function writeDocsTable(text, budgets, packageName) {
  const region = docsRegion(text);
  if (!region) return null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return text.slice(0, region.start) + renderDocsTable(budgets, packageName).replace(/\n/g, eol) + text.slice(region.end);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const usage = `Usage: node scripts/check-bundle-size.mjs [--json | --check-docs | --write-docs]

Build the package first. Measures every public entry in scripts/entries.mjs
(${COMPRESSION}, source maps excluded):
  artifact  the published dist/<entry>.esm.js
  scenario  a consumer browser bundle of named imports, tree-shaken and minified
and exits non-zero when a measurement exceeds benchmarks/budgets/<entry>.json.

--json        machine-readable results
--check-docs  verify the docs/performance.md table matches the budget files
--write-docs  regenerate that table`;

function kibCell(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

async function main(argv) {
  if (argv.includes("--help")) {
    console.log(usage);
    return 0;
  }
  const pkg = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
  const { budgets, problems } = loadBudgets();
  if (problems.length) {
    for (const problem of problems) console.error(`[raze-charts] ${problem}`);
    return 1;
  }

  const docsPath = resolve(repositoryRoot, "docs/performance.md");
  if (argv.includes("--check-docs") || argv.includes("--write-docs")) {
    const text = readFileSync(docsPath, "utf8");
    if (argv.includes("--write-docs")) {
      const next = writeDocsTable(text, budgets, pkg.name);
      if (next == null) {
        console.error(`[raze-charts] docs/performance.md is missing the ${DOCS_START} / ${DOCS_END} markers`);
        return 1;
      }
      if (next !== text) writeFileSync(docsPath, next);
      console.log("[raze-charts] docs/performance.md budget table regenerated");
      return 0;
    }
    const drift = docsDrift(text, budgets, pkg.name);
    if (drift) {
      console.error(`[raze-charts] ${drift}`);
      return 1;
    }
    console.log(`[raze-charts] budget documentation matches ${budgets.length} budget files`);
    return 0;
  }

  const { results, failures } = await measure({ budgets, pkg });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ compression: COMPRESSION, results, failures }, null, 2));
  } else {
    console.log(`[raze-charts] bundle sizes (${COMPRESSION}; scenarios are tree-shaken + minified consumer bundles)`);
    console.log(`${"measurement".padEnd(48)}${"raw".padStart(12)}${"gzip".padStart(12)}${"budget".padStart(12)}${"remaining".padStart(12)}`);
    for (const result of results) {
      const label = result.kind === "artifact"
        ? `${result.name}`
        : `  scenario: ${result.name}`;
      console.log(
        `${label.padEnd(48)}` +
        `${kibCell(result.rawBytes).padStart(12)}` +
        `${kibCell(result.gzipBytes).padStart(12)}` +
        `${kibCell(result.budgetGzipBytes).padStart(12)}` +
        `${kibCell(result.remainingBytes).padStart(12)}`,
      );
    }
    for (const failure of failures) console.error(`[raze-charts] ${failure}`);
  }
  if (failures.length) return 1;
  if (!argv.includes("--json")) console.log("\n[raze-charts] bundle budgets passed");
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exitCode = await main(process.argv.slice(2));
