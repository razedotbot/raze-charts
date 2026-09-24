import { test, expect, type Page } from "@playwright/test";

// Real-browser acceptance for study pane layout and forced overlays (W1B-17):
// createStudy("RSI", true) paints a visible line on the price pane with its own
// scale while the crosshair keeps reading prices, and a short widget stacked
// with pane studies keeps a usable main plot.

type Rgb = readonly [number, number, number];
const RSI: Rgb = [0x7e, 0x57, 0xc2];

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, {
    timeout: 30_000,
  });
  await page.evaluate(() => document.fonts.ready);
  // Two frames after ready so price-axis width can converge.
  await page.waitForTimeout(400);
}

/** Pixels within `tol` of `rgb` in the chart canvas rows [fromY, toY) (fractions of its height). */
async function countColor(page: Page, rgb: Rgb, fromY = 0, toY = 1, tol = 36): Promise<number> {
  return page.evaluate(({ rgb, fromY, toY, tol }) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".raze-chart-root canvas");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) throw new Error("chart canvas missing");
    const y0 = Math.floor(canvas.height * fromY);
    const y1 = Math.ceil(canvas.height * toY);
    const data = ctx.getImageData(0, y0, canvas.width, Math.max(1, y1 - y0)).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i]! - rgb[0]) <= tol
        && Math.abs(data[i + 1]! - rgb[1]) <= tol
        && Math.abs(data[i + 2]! - rgb[2]) <= tol
      ) n += 1;
    }
    return n;
  }, { rgb, fromY, toY, tol });
}

test.describe("forced overlay studies", () => {
  test("createStudy('RSI', true) draws a visible line on the price pane", async ({ page }) => {
    await page.goto("/examples/visual.html?case=dark", { waitUntil: "domcontentloaded" });
    await ready(page);
    const before = await countColor(page, RSI);

    await page.evaluate(async () => {
      const w = (window as unknown as { __razeChart: { activeChart(): { createStudy(n: string, f: boolean): Promise<unknown> } } }).__razeChart;
      await w.activeChart().createStudy("RSI", true);
    });
    await page.waitForTimeout(300);

    const after = await countColor(page, RSI);
    expect(after - before, "RSI pixels appear on the price pane").toBeGreaterThan(300);

    const canvas = page.locator(".raze-chart-root canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas not laid out");
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.4);
    await page.waitForTimeout(200);
    await expect(page.locator(".raze-chart-root")).toHaveScreenshot("widget-force-overlay.png");
  });
});

const STACK_COLORS = ["#8ecae6", "#ffb703", "#fb8500", "#90be6d", "#f28482", "#b5838d"] as const;

function stackHarness(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Raze Charts - pane stack</title>
  <style>html, body { margin: 0; height: 100%; background: #111; } #wrap { position: absolute; inset: 0; overflow: hidden; }</style>
</head>
<body>
  <div id="wrap"></div>
  <script type="module">
    import { widget } from "../dist/charting_library.esm.js";
    import { makeMockDatafeed, VISUAL_NOW } from "./mock-datafeed.mjs";
    const colors = ${JSON.stringify(STACK_COLORS)};
    const names = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
    const custom = colors.map((color, k) => ({
      name: names[k],
      pane: "pane",
      defaults: { length: 8 + k * 3, color },
      compute: (bars, { length }) => bars.map((bar, i) => (i < length ? null : bar.close - bars[i - length].close)),
    }));
    const w = new widget({
      symbol: "MOCK",
      datafeed: makeMockDatafeed({ bars: 400, startPrice: 6400, now: VISUAL_NOW, live: false }),
      interval: "1",
      container: document.getElementById("wrap"),
      library_path: "/",
      locale: "en",
      theme: "dark",
      autosize: true,
      timezone: "Etc/UTC",
      custom_font_family: "Arial, Helvetica, sans-serif",
      disabled_features: ["header_symbol_search", "popup_hints", "countdown"],
      raze: { volume_mode: "pane", custom_studies: custom },
    });
    w.onChartReady(async () => {
      for (const def of custom) await w.activeChart().createStudy(def.name, false);
      window.__razeReady = true;
      window.__razeChart = w;
    });
  </script>
</body>
</html>`;
}

test.describe("pane layout", () => {
  test("six pane studies and a volume pane in a 442px widget keep the main plot usable", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 442 });
    await page.route("**/examples/pane-stack.html", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: stackHarness() }));
    await page.goto("/examples/pane-stack.html", { waitUntil: "domcontentloaded" });
    await ready(page);

    // Every stacked study still plots (no pane collapsed or pushed past the axis).
    for (const hex of STACK_COLORS) {
      const rgb: Rgb = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
      expect(await countColor(page, rgb, 0.4, 1, 12), `${hex} pane paints`).toBeGreaterThan(40);
    }
    await expect(page.locator(".raze-chart-root")).toHaveScreenshot("widget-pane-stack-442.png");
  });
});
