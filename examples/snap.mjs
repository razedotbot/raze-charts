import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1100, height: 620 } });
await p.goto("http://localhost:8799/examples/index.html", { waitUntil:"domcontentloaded" });
await p.waitForSelector(".raze-chart-root canvas", { timeout:30000 });
await p.waitForTimeout(2500);
// hover mid-chart to show crosshair
await p.mouse.move(550, 300);
await p.waitForTimeout(300);
await p.screenshot({ path: process.argv[2] || "/tmp/snap.png" });
await b.close();
