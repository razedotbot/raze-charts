// Build pipeline for @raze/charts.
//
// Emits artifacts mirroring the TradingView Charting Library package layout so
// the build output can drop straight into a vendored `charting_library/`
// directory:
//   dist/charting_library.esm.js         — ESM bundle (bundler entry)
//   dist/charting_library.cjs.js         — CJS bundle
//   dist/charting_library.standalone.js  — IIFE that assigns window.TradingView
//   dist/charting_library.d.ts           — hand-authored drop-in types (copied verbatim)
//   dist/datafeed-api.d.ts               — alias of the above (TV layout parity)
//   dist/types/**                        — tsc-generated declarations for the
//                                          full modular API (package `types`)
//
// The drop-in `.d.ts` is authored by hand (src/types/charting_library.d.ts)
// rather than generated, so it stays a small, stable, structurally-compatible
// surface for consumers migrating off the TradingView library. The modular
// named exports (engine, datafeed manager, studies, utils) are typed by the
// generated declarations instead.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, "dist");
mkdirSync(out, { recursive: true });

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const watch = process.argv.includes("--watch");
const entry = resolve(root, "src/index.ts");

const common = {
  entryPoints: [entry],
  bundle: true,
  sourcemap: true,
  target: ["es2020"],
  logLevel: "info",
  define: { __RAZE_CHARTS_VERSION__: JSON.stringify(pkg.version) },
};

const targets = [
  { format: "esm", outfile: resolve(out, "charting_library.esm.js") },
  { format: "cjs", outfile: resolve(out, "charting_library.cjs.js") },
  {
    format: "iife",
    globalName: "RazeCharts",
    outfile: resolve(out, "charting_library.standalone.js"),
    footer: {
      // Mirror TradingView's standalone global so existing `window.TradingView.widget`
      // call sites keep working when the standalone bundle is loaded via <script>.
      js: "if(typeof window!=='undefined'){window.TradingView=window.TradingView||{};window.TradingView.widget=RazeCharts.widget;window.TradingView.version=RazeCharts.version;}",
    },
  },
];

function emitTypes() {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve("typescript/bin/tsc");
  const typesOut = resolve(out, "types");
  // tsconfig.json has declaration + emitDeclarationOnly; only the outDir moves.
  execFileSync(process.execPath, [tsc, "--outDir", typesOut], {
    cwd: root,
    stdio: "inherit",
  });
  // Input .d.ts files are not re-emitted by tsc, but the generated declarations
  // import from "../types/charting_library" — put the hand-authored file there.
  mkdirSync(resolve(typesOut, "types"), { recursive: true });
  copyFileSync(
    resolve(root, "src/types/charting_library.d.ts"),
    resolve(typesOut, "types/charting_library.d.ts"),
  );
}

async function run() {
  for (const t of targets) {
    await build({ ...common, ...t });
  }
  copyFileSync(
    resolve(root, "src/types/charting_library.d.ts"),
    resolve(out, "charting_library.d.ts"),
  );
  // Also emit a datafeed-api.d.ts alias for parity with the TV layout (some
  // call sites import datafeed types from there).
  copyFileSync(
    resolve(root, "src/types/charting_library.d.ts"),
    resolve(out, "datafeed-api.d.ts"),
  );
  emitTypes();
  console.log("[raze-charts] build complete →", out);
}

if (watch) {
  const ctx = await (await import("esbuild")).context({ ...common, ...targets[0] });
  await ctx.watch();
  console.log("[raze-charts] watching…");
} else {
  await run();
}
