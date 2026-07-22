// Vendors the built bundle into a host app's static dir, so a bundler alias
// (e.g. webpack NormalModuleReplacementPlugin — see README "Drop-in") can swap
// it in for a vendored TradingView Charting Library without touching any
// consumer imports.
//
//   node scripts/sync-to-app.mjs [appDir] [subdir]
//
//   appDir  host app root   default: $RAZE_CHARTS_APP_DIR, else the
//                           ../app.raze.bot sibling of this package
//   subdir  dir under appDir to copy into
//                           default: $RAZE_CHARTS_APP_SUBDIR, else
//                           public/static/raze_charts

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir =
  process.argv[2] ?? process.env.RAZE_CHARTS_APP_DIR ?? resolve(root, "..", "app.raze.bot");
const subdir =
  process.argv[3] ?? process.env.RAZE_CHARTS_APP_SUBDIR ?? "public/static/raze_charts";
const destDir = resolve(appDir, subdir);

const files = [
  "charting_library.esm.js",
  "charting_library.esm.js.map",
  "charting_library.d.ts",
];

if (!existsSync(appDir)) {
  console.error(
    `[sync] host app dir not found: ${appDir}\n` +
      "usage: node scripts/sync-to-app.mjs [appDir] [subdir]",
  );
  process.exit(1);
}
if (!existsSync(resolve(root, "dist/charting_library.esm.js"))) {
  console.error("[sync] dist not built — run `npm run build` first.");
  process.exit(1);
}
mkdirSync(destDir, { recursive: true });
for (const f of files) {
  const src = resolve(root, "dist", f);
  if (existsSync(src)) copyFileSync(src, resolve(destDir, f));
}
console.log("[sync] raze-charts → " + destDir);
