// Build pipeline for @razedotbot/charts.
//
// Emits artifacts mirroring the TradingView Charting Library package layout so
// the build output can drop straight into a vendored `charting_library/`
// directory:
//   dist/charting_library.esm.js         — ESM bundle (bundler entry)
//   dist/charting_library.cjs            — CJS bundle
//   dist/charting_library.standalone.js  — IIFE that assigns window.TradingView
//   dist/charting_library.d.ts           — hand-authored drop-in types (flattened, self-contained)
//   dist/datafeed-api.d.ts               — alias of the above (TV layout parity)
//   dist/<subpath>.esm.js / <subpath>.cjs — one pair per public subpath
//   dist/types/**                        — tsc-generated declarations
//
// Public entrypoints are data, not code: scripts/entries.mjs lists every
// subpath once, and this file derives one esbuild target per output format
// from that table. Adding a subpath never requires editing this file.
//
// The drop-in `.d.ts` is authored by hand (src/types/charting_library.d.ts,
// a barrel over the src/types/tv/ domain modules) rather than generated, so it
// stays a small, stable, structurally-compatible
// surface for consumers migrating off the TradingView library. The modular
// named exports (engine, datafeed manager, studies, utils) are typed by the
// generated declarations instead.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watch as watchFs,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PACKAGE_ENTRIES, entryArtifacts, entryById } from "./scripts/entries.mjs";
import { bundleCompatibilityTypes } from "./scripts/compat-types.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, "dist");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  target: ["es2020"],
  logLevel: "info",
  define: { __RAZE_CHARTS_VERSION__: JSON.stringify(pkg.version) },
};

// The full widget needs production compaction to stay within its public size
// budget. Entries without `compact` stay unminified: their emitted PURE
// annotations are part of the downstream tree-shaking contract.
const compact = {
  minifySyntax: true,
  minifyWhitespace: true,
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Keep a shared runtime as a single module instance when consumers mix
 * subpaths (for example `@razedotbot/charts/chart` and `/react`). Besides
 * reducing bytes, this keeps exported functions and error constructors
 * referentially identical.
 */
function sharedRuntimePlugin(entry, format) {
  const rewrites = Object.entries(entry.shareRuntime ?? {}).map(([specifier, targetId]) => {
    const artifacts = entryArtifacts(entryById(targetId));
    return { specifier, path: `./${format === "cjs" ? artifacts.cjs : artifacts.esm}` };
  });
  return {
    name: `shared-runtime-${entry.id}-${format}`,
    setup(buildContext) {
      for (const { specifier, path } of rewrites) {
        const filter = new RegExp(`^${escapeRegExp(specifier)}$`);
        buildContext.onResolve({ filter }, () => ({ path, external: true }));
      }
    },
  };
}

function targetsFor(entry) {
  const artifacts = entryArtifacts(entry);
  const base = {
    ...common,
    ...(entry.compact ? compact : {}),
    entryPoints: [resolve(root, entry.source)],
    ...(entry.jsx ? { jsx: entry.jsx } : {}),
    ...(entry.external ? { external: [...entry.external] } : {}),
  };
  // A module directive such as "use client" must be the first statement of
  // the file, so it is emitted as a banner ahead of esbuild's own preamble.
  const directive = entry.directive ? { banner: { js: `${JSON.stringify(entry.directive)};` } } : {};
  const formats = [
    { format: "esm", outfile: resolve(out, artifacts.esm), ...directive },
    { format: "cjs", outfile: resolve(out, artifacts.cjs), ...directive },
  ];
  if (entry.standalone) {
    formats.push({
      format: "iife",
      globalName: entry.standalone.globalName,
      outfile: resolve(out, artifacts.standalone),
      footer: { js: entry.standalone.footer },
    });
  }
  return formats.map((target) => ({
    ...base,
    ...target,
    ...(entry.shareRuntime ? { plugins: [sharedRuntimePlugin(entry, target.format)] } : {}),
  }));
}

const buildTargets = PACKAGE_ENTRIES.flatMap(targetsFor);

function synchronizeDirectory(source, destination) {
  const present = new Set();
  const copy = (sourceDirectory, destinationDirectory, prefix = "") => {
    mkdirSync(destinationDirectory, { recursive: true });
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      present.add(relative);
      const sourcePath = resolve(sourceDirectory, entry.name);
      const destinationPath = resolve(destinationDirectory, entry.name);
      if (entry.isDirectory()) copy(sourcePath, destinationPath, relative);
      else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
    }
  };
  const prune = (directory, prefix = "") => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = resolve(directory, entry.name);
      if (!present.has(relative)) {
        rmSync(path, { recursive: entry.isDirectory(), force: true });
      } else if (entry.isDirectory()) {
        prune(path, relative);
      }
    }
  };
  copy(source, destination);
  prune(destination);
}

function emitTypes() {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve("typescript/bin/tsc");
  const typesOut = resolve(out, "types");
  // Generate away from dist, then synchronize only after tsc has completed.
  // An interrupted watch rebuild therefore leaves the last complete public
  // declaration tree available instead of exposing a temporarily empty path.
  const stagedTypes = mkdtempSync(resolve(tmpdir(), "raze-charts-types-"));
  try {
    execFileSync(process.execPath, [tsc, "--outDir", stagedTypes], {
      cwd: root,
      stdio: "inherit",
    });
    // tsc does not emit hand-authored declarations: copy the barrel and the
    // src/types/tv/ modules it re-exports next to the generated tree.
    const compatibilityTypes = bundleCompatibilityTypes(root);
    cpSync(resolve(root, "src/types"), resolve(stagedTypes, "types"), {
      recursive: true,
      filter: (source) => statSync(source).isDirectory() || source.endsWith(".d.ts"),
    });
    rewriteDeclarationSpecifiers(stagedTypes);
    synchronizeDirectory(stagedTypes, typesOut);
    writeFileSync(resolve(out, "charting_library.d.ts"), compatibilityTypes);
    writeFileSync(resolve(out, "datafeed-api.d.ts"), compatibilityTypes);
  } finally {
    rmSync(stagedTypes, { recursive: true, force: true });
  }
}

/**
 * `moduleResolution: Bundler` lets source files use extensionless relative
 * imports, but published ESM declarations are also consumed by NodeNext.
 * Rewrite generated specifiers to the concrete `.js` shape NodeNext requires;
 * TypeScript maps those paths back to the colocated `.d.ts` files.
 */
function rewriteDeclarationSpecifiers(directory) {
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
        const source = readFileSync(child, "utf8");
        const rewritten = source.replace(/(["'])(\.\.?\/[^"']+)(["'])/g, (full, open, specifier, close) => {
          const clean = specifier.split(/[?#]/, 1)[0];
          if (/\.[a-z0-9]+$/i.test(clean)) return full;
          const target = resolve(dirname(child), clean);
          if (existsSync(`${target}.d.ts`)) return `${open}${specifier}.js${close}`;
          if (existsSync(resolve(target, "index.d.ts"))) return `${open}${specifier}/index.js${close}`;
          return full;
        });
        if (rewritten !== source) writeFileSync(child, rewritten);
      }
    }
  };
  visit(directory);
}

async function run() {
  // Clean the exact generated output directory so renamed artifacts cannot be
  // packed accidentally. `out` is always `<repository>/dist`.
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const target of buildTargets) await build(target);
  emitTypes();
  console.log("[raze-charts] build complete →", out);
}

if (watch) {
  // A clean clone gets every public artifact immediately; every JS variant
  // then remains synchronized while source files change.
  await run();
  const { context } = await import("esbuild");
  let typeTimer;
  const scheduleTypes = () => {
    clearTimeout(typeTimer);
    typeTimer = setTimeout(() => {
      try {
        emitTypes();
      } catch (error) {
        // tsc already prints actionable diagnostics; keep watchers alive so
        // the next edit can repair both JavaScript and declaration artifacts.
        if (error?.name === "CompatibilityTypesError") console.error(error.message);
      }
    }, 75);
  };
  const refreshTypes = {
    name: "refresh-types",
    setup(buildContext) {
      buildContext.onEnd((result) => {
        if (result.errors.length) return;
        scheduleTypes();
      });
    },
  };
  const contexts = await Promise.all(buildTargets.map((target) => context({
    ...target,
    plugins: [...(target.plugins ?? []), refreshTypes],
  })));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  // Type-only modules and hand-authored .d.ts files never enter an esbuild
  // graph. Watch every existing source directory so they stay synchronized.
  const watchTypeDirectories = (directory) => {
    const handles = [];
    const visit = (current) => {
      handles.push(watchFs(current, { persistent: true }, (_event, filename) => {
        if (filename && /(?:\.d)?\.tsx?$/.test(String(filename))) scheduleTypes();
      }));
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(resolve(current, entry.name));
      }
    };
    visit(directory);
    return handles;
  };
  const typeWatchers = watchTypeDirectories(resolve(root, "src"));
  // Stop promptly on Ctrl+C or a supervisor's SIGTERM: close the file
  // watchers and esbuild contexts instead of leaving the process (and its
  // esbuild service) running. A shutdown that stalls is forced after 3 s.
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => {
      console.error(`[raze-charts] watch did not stop cleanly after ${signal}; exiting`);
      process.exit(1);
    }, 3000);
    clearTimeout(typeTimer);
    for (const handle of typeWatchers) handle.close();
    void Promise.allSettled(contexts.map((ctx) => ctx.dispose())).then(() => process.exit(0));
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  console.log("[raze-charts] watching…");
} else {
  await run();
}
