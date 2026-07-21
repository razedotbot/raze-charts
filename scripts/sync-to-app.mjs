// Copies the built raze-charts ESM bundle into app.raze.bot's public dir so the
// Next webpack alias (NEXT_PUBLIC_CHART_ENGINE=raze) can swap it in for the
// vendored TradingView library without touching any consumer imports.
//
//   node scripts/sync-to-app.mjs [/path/to/app.raze.bot]
//
// Default app path: /home/debian/raze/app.raze.bot (sibling of this package).

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = process.argv[2] ?? "/home/debian/raze/app.raze.bot";
const destDir = resolve(appDir, "public/static/raze_charts");

const files = [
  "charting_library.esm.js",
  "charting_library.esm.js.map",
  "charting_library.d.ts",
];

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
