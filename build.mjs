// Build pipeline for @raze/charts.
//
// Emits three artifacts mirroring the TradingView Charting Library package
// layout so the build output can drop straight into a vendored
// `charting_library/` directory:
//   dist/charting_library.esm.js         — ESM bundle (the app imports this)
//   dist/charting_library.cjs.js         — CJS bundle
//   dist/charting_library.standalone.js  — IIFE that assigns window.TradingView
//   dist/charting_library.d.ts           — hand-authored public types (copied verbatim)
//
// The public `.d.ts` is authored by hand (src/types/charting_library.d.ts) rather
// than generated, so it stays a small, stable, structurally-compatible surface
// matching exactly the types app.raze.bot imports.

import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, "dist");
mkdirSync(out, { recursive: true });

const watch = process.argv.includes("--watch");
const entry = resolve(root, "src/index.ts");

const common = {
  entryPoints: [entry],
  bundle: true,
  sourcemap: true,
  target: ["es2020"],
  logLevel: "info",
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
  console.log("[raze-charts] build complete →", out);
}

if (watch) {
  const ctx = await (await import("esbuild")).context({ ...common, ...targets[0] });
  await ctx.watch();
  console.log("[raze-charts] watching…");
} else {
  await run();
}
