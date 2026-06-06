// Opens /monitor, real-mouse-clicks the first token card by coordinates
// (bypasses Playwright actionability churn on the live-updating list), waits
// for the /token/ navigation + chart canvas, and screenshots.

import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3210";
const out = process.argv[3] ?? "/tmp/raze_clicked_token.png";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

await p.goto(`${base}/monitor`, { waitUntil: "domcontentloaded", timeout: 120000 });
await p.waitForSelector('[class*="card"]', { timeout: 60000 }).catch(() => {});
await p.waitForTimeout(4000);

// Sweep real clicks down the first monitor column until one lands on a token
// row and the URL becomes /token/<mint>. Robust to the app's CSS-module names.
const cols = [430, 700, 950];
outer:
for (const x of cols) {
  for (let y = 120; y <= 520; y += 34) {
    await p.mouse.click(x, y);
    try {
      await p.waitForURL(/\/token\//, { timeout: 2500 });
      break outer;
    } catch { /* not a token row — keep sweeping */ }
    if (/\/token\//.test(p.url())) break outer;
  }
}
console.log("url:", p.url());

if (/\/token\//.test(p.url())) {
  await p.waitForSelector(".raze-chart-root canvas", { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(9000);
  await p.screenshot({ path: out });
  console.log("shot:", out);
}
if (errs.length) console.log("errors:", errs.slice(0, 5).join(" | "));
await b.close();
