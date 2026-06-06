import { chromium } from "playwright";
const mint = process.argv[2], out = process.argv[3];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
await p.goto(`http://localhost:3210/token/${mint}`, { waitUntil:"domcontentloaded", timeout:120000 });
const el = await p.waitForSelector(".raze-chart-root", { timeout:60000 }).catch(()=>null);
await p.waitForTimeout(8000);
// hover center of chart for crosshair
const bb = el && await el.boundingBox();
if (bb) await p.mouse.move(bb.x + bb.width*0.5, bb.y + bb.height*0.5);
await p.waitForTimeout(400);
if (el) await el.screenshot({ path: out }); else await p.screenshot({ path: out });
console.log("clip:", out);
await b.close();
