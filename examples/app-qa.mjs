// App-level QA: drive the running Next dev server (raze charts flag on),
// discover a real token mint from /monitor, open its token page, wait for the
// chart canvas, and screenshot. Captures console errors for triage.
//
//   node examples/app-qa.mjs [baseUrl] [outPrefix]

import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3210";
const prefix = process.argv[3] ?? "/tmp/raze_app";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

async function shot(name) {
  const p = `${prefix}_${name}.png`;
  await page.screenshot({ path: p });
  console.log("shot:", p);
}

try {
  // 1) Monitor page — list of tokens.
  console.log("→ /monitor");
  await page.goto(`${base}/monitor`, { waitUntil: "domcontentloaded", timeout: 120000 });
  // Token cards are client-rendered over the wire WS.
  await page.waitForSelector('[class*="card"]', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await shot("monitor");

  // Mints live in React props, not the DOM (cards navigate via onClick), so we
  // click cards (force-bypassing any overlay) until the URL becomes /token/<mint>.
  const cards = page.locator('[class*="card"]');
  const n = Math.min(await cards.count(), 8);
  let navigated = false;
  for (let i = 0; i < n && !navigated; i++) {
    await cards.nth(i).click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForURL(/\/token\//, { timeout: 4000 }).then(() => { navigated = true; }).catch(() => {});
  }
  console.log("url now:", page.url());

  if (navigated) {
    await page.waitForSelector(".raze-chart-root canvas", { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(8000);
  }
} catch (e) {
  console.error("QA error:", e.message);
} finally {
  await page.waitForTimeout(500).catch(() => {});
  await shot("token");
  if (errors.length) {
    console.log("\n--- console errors (" + errors.length + ") ---");
    for (const e of errors.slice(0, 25)) console.log(e);
  } else {
    console.log("\nno console errors");
  }
  await browser.close();
}
