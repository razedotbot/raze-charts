import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1100, height: 640 } });
await p.goto("http://localhost:8799/examples/index.html", { waitUntil:"domcontentloaded" });
await p.waitForSelector(".raze-chart-root canvas", { timeout:30000 });
await p.waitForTimeout(2500);
await p.screenshot({ path: "/tmp/drag_before.png" });
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
await p.screenshot({ path: "/tmp/drag_after_zoomout.png" });
// Now drag UP to zoom IN.
await p.mouse.move(axisX, midY);
await p.mouse.down();
await p.mouse.move(axisX, midY - 130, { steps: 12 });
await p.mouse.up();
await p.waitForTimeout(600);
await p.screenshot({ path: "/tmp/drag_after_zoomin.png" });
console.log("done");
await b.close();
