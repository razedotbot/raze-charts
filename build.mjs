// Build pipeline for @razedotbot/charts.
//
// Emits artifacts mirroring the TradingView Charting Library package layout so
// the build output can drop straight into a vendored `charting_library/`
// directory:
//   dist/charting_library.esm.js         — ESM bundle (bundler entry)
//   dist/charting_library.cjs            — CJS bundle
//   dist/charting_library.standalone.js  — IIFE that assigns window.TradingView
//   dist/charting_library.d.ts           — hand-authored drop-in types (copied verbatim)
//   dist/datafeed-api.d.ts               — alias of the above (TV layout parity)
//   dist/chart.esm.js / chart.cjs        — dashboard grammar (tree-shaken, no widget)
//   dist/react.esm.js / react.cjs        — React adapter (peer: react)
//   dist/types/**                        — tsc-generated declarations
//
// The drop-in `.d.ts` is authored by hand (src/types/charting_library.d.ts)
// rather than generated, so it stays a small, stable, structurally-compatible
// surface for consumers migrating off the TradingView library. The modular
// named exports (engine, datafeed manager, studies, utils) are typed by the
// generated declarations instead.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch as watchFs,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, "dist");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const watch = process.argv.includes("--watch");
const entry = resolve(root, "src/index.ts");

const common = {
  bundle: true,
  sourcemap: true,
  target: ["es2020"],
  logLevel: "info",
  define: { __RAZE_CHARTS_VERSION__: JSON.stringify(pkg.version) },
};

const widgetTargets = [
  { format: "esm", outfile: resolve(out, "charting_library.esm.js") },
  { format: "cjs", outfile: resolve(out, "charting_library.cjs") },
  {
    format: "iife",
    globalName: "RazeCharts",
    outfile: resolve(out, "charting_library.standalone.js"),
    footer: {
      js: "if(typeof window!=='undefined'){window.TradingView=window.TradingView||{};window.TradingView.widget=RazeCharts.widget;window.TradingView.version=RazeCharts.version;}",
    },
  },
];

const chartEntry = resolve(root, "src/chart/index.ts");
const reactEntry = resolve(root, "src/react/index.tsx");

/**
 * Keep the dashboard runtime as a single module instance when consumers mix
 * `@razedotbot/charts/chart` and `/react`. Besides reducing bytes, this keeps
 * exported functions and error constructors referentially identical.
 */
function externalChartRuntime(format) {
  const target = format === "cjs" ? "./chart.cjs" : "./chart.esm.js";
  return {
    name: `external-chart-runtime-${format}`,
    setup(buildContext) {
      buildContext.onResolve({ filter: /^\.\.\/chart$/ }, () => ({ path: target, external: true }));
    },
  };
}

const buildTargets = [
  ...widgetTargets.map((target) => ({ ...common, entryPoints: [entry], ...target })),
  ...(["esm", "cjs"]).flatMap((format) => {
    const filename = format === "cjs" ? "cjs" : "esm.js";
    return [
      {
        ...common,
        entryPoints: [chartEntry],
        format,
        outfile: resolve(out, `chart.${filename}`),
      },
      {
        ...common,
        entryPoints: [reactEntry],
        format,
        outfile: resolve(out, `react.${filename}`),
        jsx: "automatic",
        external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime"],
        plugins: [externalChartRuntime(format)],
      },
    ];
  }),
];

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
    mkdirSync(resolve(stagedTypes, "types"), { recursive: true });
    copyFileSync(
      resolve(root, "src/types/charting_library.d.ts"),
      resolve(stagedTypes, "types/charting_library.d.ts"),
    );
    rewriteDeclarationSpecifiers(stagedTypes);
    synchronizeDirectory(stagedTypes, typesOut);
    copyFileSync(
      resolve(root, "src/types/charting_library.d.ts"),
      resolve(out, "charting_library.d.ts"),
    );
    copyFileSync(
      resolve(root, "src/types/charting_library.d.ts"),
      resolve(out, "datafeed-api.d.ts"),
    );
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
  // A clean clone gets every public artifact immediately; all seven JS
  // variants then remain synchronized while source files change.
  await run();
  const { context } = await import("esbuild");
  let typeTimer;
  const scheduleTypes = () => {
    clearTimeout(typeTimer);
    typeTimer = setTimeout(() => {
      try {
        emitTypes();
      } catch {
        // tsc already prints actionable diagnostics; keep watchers alive so
        // the next edit can repair both JavaScript and declaration artifacts.
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
  void typeWatchers;
  console.log("[raze-charts] watching…");
} else {
  await run();
}
