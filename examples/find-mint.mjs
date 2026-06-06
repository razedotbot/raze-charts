// Extracts a real, tracked token mint from the running app's /monitor by
// reading React fiber props off a token card (mints live in props, not the
// DOM). Then opens that token's page and screenshots the chart.

import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3210";
const out = process.argv[3] ?? "/tmp/raze_real_token.png";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

await p.goto(`${base}/monitor`, { waitUntil: "domcontentloaded", timeout: 120000 });
await p.waitForSelector('[class*="card"]', { timeout: 60000 }).catch(() => {});
await p.waitForTimeout(4000);

const mint = await p.evaluate(() => {
  const isMint = (s) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && !s.startsWith("Qm");
  const fiberKey = (el) => Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  const els = [...document.querySelectorAll('[class*="card" i]')];
  for (const el of els) {
    const key = fiberKey(el);
    if (!key) continue;
    let fiber = el[key];
    let hops = 0;
    while (fiber && hops < 40) {
      const props = fiber.memoizedProps;
      if (props && typeof props === "object") {
        for (const v of Object.values(props)) {
          if (isMint(v)) return v;
          if (v && typeof v === "object") {
            for (const vv of Object.values(v)) if (isMint(vv)) return vv;
            if (isMint(v.mint_address)) return v.mint_address;
            if (isMint(v.mint)) return v.mint;
          }
        }
      }
      fiber = fiber.return;
      hops++;
    }
  }
  return null;
});

console.log("mint:", mint);
if (mint) {
  await p.goto(`${base}/token/${mint}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await p.waitForSelector(".raze-chart-root canvas", { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(9000);
  await p.screenshot({ path: out });
  console.log("shot:", out, "url:", p.url());
}
if (errs.length) console.log("errors:", errs.slice(0, 5).join(" | "));
await b.close();
