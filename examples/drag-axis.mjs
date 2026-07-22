// Exercises price-axis drag-to-zoom on the example page and screenshots
// before / zoom-out / zoom-in states. Requires playwright (not a package
// dependency): npm i -D playwright && npx playwright install chromium
// Serve the repo root over http first, e.g.:
//   python3 -m http.server 8799
//   node examples/drag-axis.mjs [url] [outPrefix]

import { chromium } from "playwright";

const url = process.argv[2] || "http://localhost:8799/examples/index.html";
const prefix = process.argv[3] || "drag";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1100, height: 640 } });
await p.goto(url, { waitUntil: "domcontentloaded" });
await p.waitForSelector(".raze-chart-root canvas", { timeout: 30000 });
await p.waitForTimeout(2500);
await p.screenshot({ path: `${prefix}_before.png` });
// Price axis sits in the right ~66px. Canvas spans full width; chart area below toolbar.
// Drag down in the price-axis strip to zoom OUT (wider price range).
const box = await p.locator(".raze-chart-root canvas").boundingBox();
const axisX = box.x + box.width - 33;     // middle of the 66px price axis
const midY  = box.y + box.height * 0.45;
await p.mouse.move(axisX, midY);
await p.mouse.down();
await p.mouse.move(axisX, midY + 160, { steps: 12 });
await p.mouse.up();
await p.waitForTimeout(600);
await p.screenshot({ path: `${prefix}_after_zoomout.png` });
// Now drag UP to zoom IN.
await p.mouse.move(axisX, midY);
await p.mouse.down();
await p.mouse.move(axisX, midY - 130, { steps: 12 });
await p.mouse.up();
await p.waitForTimeout(600);
await p.screenshot({ path: `${prefix}_after_zoomin.png` });
console.log("done — screenshots:", `${prefix}_*.png`);
await b.close();
