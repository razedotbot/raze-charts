// Screenshots the example page with the crosshair visible.
// Requires playwright (not a package dependency):
//   npm i -D playwright && npx playwright install chromium
// Serve the repo root over http first, e.g.:
//   python3 -m http.server 8799
//   node examples/snap.mjs [url] [out.png]

import { chromium } from "playwright";

const url = process.argv[2] || "http://localhost:8799/examples/index.html";
const out = process.argv[3] || "snap.png";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1100, height: 620 } });
await p.goto(url, { waitUntil: "domcontentloaded" });
await p.waitForSelector(".raze-chart-root canvas", { timeout: 30000 });
await p.waitForTimeout(2500);
// hover mid-chart to show crosshair
await p.mouse.move(550, 300);
await p.waitForTimeout(300);
await p.screenshot({ path: out });
console.log("shot:", out);
await b.close();
