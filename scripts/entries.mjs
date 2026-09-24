// The single source of truth for the package's public entrypoints.
//
// Every public subpath is one row in PACKAGE_ENTRIES. The row drives:
//   - build.mjs              esbuild outputs (ESM + CJS, plus optional IIFE)
//   - package.json           `exports` / `typesVersions` (verified by
//                            tests/package-entries.mjs; regenerate with
//                            `node scripts/entries.mjs --write`)
//   - scripts/prepare.mjs    the artifact list that decides whether to rebuild
//   - tests/package-contract ESM / CJS / NodeNext resolution of the packed tarball
//   - check-bundle-size.mjs  benchmarks/budgets/<id>.json must exist per entry
//
// Adding a subpath is therefore one row here plus its budget file (the size
// gate fails loudly when the budget file is missing), followed by
// `node scripts/entries.mjs --write` to refresh package.json.
//
// Row fields:
//   id          stable identifier; also the budget file name
//   subpath     package export key ("." or "./name")
//   source      TypeScript entry module, relative to the repository root
//   basename    artifact stem: dist/<basename>.esm.js and dist/<basename>.cjs
//   compact     syntax/whitespace minification (identifiers preserved). Keep
//               it off for entries whose PURE annotations are part of the
//               downstream tree-shaking contract.
//   jsx         esbuild JSX mode for .tsx entries
//   external    bare specifiers left as imports (peer dependencies)
//   directive   module directive emitted as the first statement of the ESM
//               and CJS artifacts. "use client" marks entries that use React
//               hooks, so React Server Component bundlers (the Next.js App
//               Router) treat them as a client boundary without a user-written
//               wrapper file.
//   shareRuntime  { [relative specifier]: entry id } — imports of another
//               public entry that are rewritten to that entry's artifact so
//               consumers mixing subpaths get one module instance
//   standalone  optional IIFE build: { globalName, footer }
//   smoke       one export name that must be a function in every format

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PACKAGE_ENTRIES = Object.freeze([
  {
    id: "root",
    title: "Root financial widget",
    subpath: ".",
    source: "src/index.ts",
    basename: "charting_library",
    compact: true,
    smoke: "widget",
    standalone: {
      globalName: "RazeCharts",
      footer:
        "if(typeof window!=='undefined'){window.TradingView=window.TradingView||{};window.TradingView.widget=RazeCharts.widget;window.TradingView.version=RazeCharts.version;}",
    },
  },
  {
    id: "chart",
    title: "Native chart",
    subpath: "./chart",
    source: "src/chart/index.ts",
    basename: "chart",
    smoke: "defineChart",
  },
  {
    id: "react",
    title: "React adapter",
    subpath: "./react",
    source: "src/react/index.tsx",
    basename: "react",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime"],
    directive: "use client",
    shareRuntime: { "../chart": "chart" },
    smoke: "Chart",
  },
  {
    id: "studies",
    title: "Study kernels",
    subpath: "./studies",
    source: "src/studies/index.ts",
    basename: "studies",
    smoke: "ema",
  },
].map((entry) => Object.freeze(entry)));

/** Look up one entry by id; throws with the known ids when it does not exist. */
export function entryById(id) {
  const entry = PACKAGE_ENTRIES.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(
      `Unknown package entry "${id}". Known entries: ${PACKAGE_ENTRIES.map((e) => e.id).join(", ")}.`,
    );
  }
  return entry;
}

/** Output file names (relative to dist/) for one entry. */
export function entryArtifacts(entry) {
  const declaration = entry.source
    .replace(/^src\//, "types/")
    .replace(/\.tsx?$/, ".d.ts");
  return {
    esm: `${entry.basename}.esm.js`,
    cjs: `${entry.basename}.cjs`,
    standalone: entry.standalone ? `${entry.basename}.standalone.js` : undefined,
    types: declaration,
  };
}

/** Every generated JavaScript bundle (relative to dist/), in build order. */
export function bundleArtifacts() {
  return PACKAGE_ENTRIES.flatMap((entry) => {
    const artifacts = entryArtifacts(entry);
    return [artifacts.esm, artifacts.cjs, artifacts.standalone].filter(Boolean);
  });
}

/** The public package specifier for an entry, e.g. "@razedotbot/charts/studies". */
export function entrySpecifier(entry, packageName) {
  return entry.subpath === "." ? packageName : `${packageName}${entry.subpath.slice(1)}`;
}

/** package.json `exports`, generated from the table. */
export function packageExports() {
  const exports = {};
  for (const entry of PACKAGE_ENTRIES) {
    const artifacts = entryArtifacts(entry);
    const esm = `./dist/${artifacts.esm}`;
    const cjs = `./dist/${artifacts.cjs}`;
    exports[entry.subpath] = {
      types: `./dist/${artifacts.types}`,
      import: { browser: esm, default: esm },
      require: { browser: cjs, default: cjs },
      default: esm,
    };
  }
  exports["./package.json"] = "./package.json";
  return exports;
}

/**
 * package.json `typesVersions`. `moduleResolution: node10` consumers ignore
 * `exports`; this maps each subpath to its declaration so they still type-check.
 */
export function packageTypesVersions() {
  const map = {};
  for (const entry of PACKAGE_ENTRIES) {
    if (entry.subpath === ".") continue;
    map[entry.subpath.slice(2)] = [`./dist/${entryArtifacts(entry).types}`];
  }
  return { "*": map };
}

/** Top-level legacy fields derived from the root entry. */
export function packageRootFields() {
  const artifacts = entryArtifacts(entryById("root"));
  return {
    main: `dist/${artifacts.cjs}`,
    module: `dist/${artifacts.esm}`,
    browser: `dist/${artifacts.esm}`,
    unpkg: `dist/${artifacts.standalone}`,
    jsdelivr: `dist/${artifacts.standalone}`,
    types: `dist/${artifacts.types}`,
  };
}

/**
 * Compare a parsed package.json with the table. Returns human-readable
 * differences; an empty array means the manifest is in sync.
 */
export function packageManifestDrift(pkg) {
  const drift = [];
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  for (const [field, expected] of Object.entries(packageRootFields())) {
    if (pkg[field] !== expected) {
      drift.push(`"${field}" is ${JSON.stringify(pkg[field])}, expected ${JSON.stringify(expected)}`);
    }
  }
  if (!same(pkg.exports, packageExports())) {
    const actualKeys = Object.keys(pkg.exports ?? {});
    const expectedKeys = Object.keys(packageExports());
    const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
    const extra = actualKeys.filter((key) => !expectedKeys.includes(key));
    const detail = [
      missing.length ? `missing ${missing.join(", ")}` : "",
      extra.length ? `unexpected ${extra.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    drift.push(`"exports" differs from scripts/entries.mjs${detail ? ` (${detail})` : " (targets or order)"}`);
  }
  if (!same(pkg.typesVersions, packageTypesVersions())) {
    drift.push('"typesVersions" differs from scripts/entries.mjs');
  }
  return drift;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = resolve(root, "package.json");
  const text = readFileSync(manifestPath, "utf8");
  const pkg = JSON.parse(text);
  const supported = ["--write", "--check", "--json", "--help"];
  const args = process.argv.slice(2);
  const unknown = args.find((argument) => !supported.includes(argument));
  const modes = args.filter((argument) => argument !== "--help");
  if (unknown || new Set(modes).size > 1) {
    console.error(unknown
      ? `[raze-charts] Unknown option "${unknown}". Supported options: ${supported.join(", ")}.`
      : `[raze-charts] Choose one of ${modes.join(", ")}; they select different modes.`);
    process.exit(2);
  }
  if (process.argv.includes("--help")) {
    console.log(`Usage: node scripts/entries.mjs [--write | --check | --json]

--check  exit non-zero when package.json exports/typesVersions/root fields
         disagree with PACKAGE_ENTRIES (default)
--write  rewrite those package.json fields from PACKAGE_ENTRIES
--json   print the entry table with its derived artifacts`);
  } else if (process.argv.includes("--json")) {
    console.log(JSON.stringify(
      PACKAGE_ENTRIES.map((entry) => ({ ...entry, artifacts: entryArtifacts(entry) })),
      null,
      2,
    ));
  } else if (process.argv.includes("--write")) {
    const next = {};
    const rootFields = packageRootFields();
    // Preserve key order; replace generated fields in place.
    for (const [key, value] of Object.entries(pkg)) {
      if (Object.hasOwn(rootFields, key)) next[key] = rootFields[key];
      else if (key === "exports") next[key] = packageExports();
      else if (key === "typesVersions") next[key] = packageTypesVersions();
      else next[key] = value;
    }
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`.replace(/\n/g, eol));
    console.log("[raze-charts] package.json entry fields regenerated from scripts/entries.mjs");
  } else {
    const drift = packageManifestDrift(pkg);
    if (drift.length) {
      console.error("[raze-charts] package.json is out of sync with scripts/entries.mjs:");
      for (const line of drift) console.error(`- ${line}`);
      console.error('Run "node scripts/entries.mjs --write" to regenerate it.');
      process.exit(1);
    }
    console.log(`[raze-charts] package.json matches ${PACKAGE_ENTRIES.length} entries`);
  }
}
