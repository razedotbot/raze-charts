import { expect, test, type Page } from "@playwright/test";

// Real-browser acceptance for the price axis: negative series autoscale, log
// scale falls back (with one warning) on non-positive data, sub-cent prices
// with a coarse pricescale keep distinct labels, and labels honour minmov and
// the widget locale. Labels are read from the canvas by recording fillText.

const AXIS_TEXT = "#123456";

const HARNESS = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>price axis harness</title>
<style>html,body{margin:0;background:#131722}#wrap{width:900px;height:520px;position:relative}</style>
</head>
<body>
<div id="wrap"></div>
<script type="module">
  const calls = [];
  const fillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
    calls.push({ text: String(text), align: this.textAlign, style: String(this.fillStyle).toLowerCase() });
    return fillText.call(this, text, x, y, ...rest);
  };
  window.__fillText = calls;
  window.__RAZE_DEBUG = true;

  const { widget } = await import("/dist/charting_library.esm.js");
  const params = new URLSearchParams(location.search);
  const series = params.get("series");
  const pricescale = Number(params.get("pricescale") || 100);
  const minmov = Number(params.get("minmov") || 1);
  const start = Date.UTC(2026, 0, 5, 0, 0);

  function makeBars() {
    const out = [];
    for (let i = 0; i < 160; i++) {
      const phase = Math.sin(i / 9) * 0.5 + 0.5; // 0..1
      let lo, hi;
      if (series === "spread") { lo = -20; hi = 5; }
      else if (series === "tiny") { lo = 0.0000095; hi = 0.0000105; }
      else { lo = 4480; hi = 4520; }
      const mid = lo + (hi - lo) * (0.1 + 0.8 * phase);
      const span = (hi - lo) * 0.05;
      const open = mid - span / 2;
      const close = mid + (i % 2 ? span / 2 : -span / 3);
      out.push({ time: start + i * 60_000, open, high: Math.max(open, close) + span / 4, low: Math.min(open, close) - span / 4, close, volume: 100 + i });
    }
    // Pin the extremes the assertions rely on.
    if (series === "spread") {
      out[20] = { ...out[20], low: -20, open: -19.5, close: -19.8, high: -19.2 };
      out[80] = { ...out[80], high: 5, open: 4.6, close: 4.9, low: 4.4 };
    }
    return out;
  }
  const bars = makeBars();

  const datafeed = {
    onReady: (cb) => setTimeout(() => cb({ supported_resolutions: ["1"] }), 0),
    searchSymbols: (_a, _b, _c, cb) => cb([]),
    resolveSymbol: (symbol, onResolve) => setTimeout(() => onResolve({
      name: symbol, ticker: symbol, description: symbol, type: "futures", session: "24x7",
      timezone: "Etc/UTC", exchange: "Test", listed_exchange: "Test", format: "price",
      minmov, pricescale, has_intraday: true, supported_resolutions: ["1"], volume_precision: 0,
      data_status: "endofday",
    }), 0),
    getBars: (_s, _r, periodParams, onResult) => setTimeout(() => {
      onResult(periodParams.firstDataRequest ? bars : [], { noData: !periodParams.firstDataRequest });
    }, 0),
    subscribeBars: () => {},
    unsubscribeBars: () => {},
  };

  const w = new widget({
    symbol: "TEST",
    datafeed,
    interval: "1",
    container: document.getElementById("wrap"),
    library_path: "/",
    locale: params.get("locale") || "en",
    theme: "dark",
    autosize: true,
    timezone: "Etc/UTC",
    disabled_features: ["header_symbol_search", "popup_hints", "countdown"],
    overrides: { "scalesProperties.textColor": "${AXIS_TEXT}" },
  });
  w.onChartReady(() => { window.__ready = true; });
</script>
</body>
</html>`;

async function openHarness(page: Page, query: string): Promise<string[]> {
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });
  await page.route("**/__price-axis/index.html*", (route) =>
    route.fulfill({ body: HARNESS, contentType: "text/html" }),
  );
  await page.goto(`/__price-axis/index.html?${query}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, {
    timeout: 30_000,
  });
  // Let the price-axis width converge.
  await page.waitForTimeout(400);
  return warnings;
}

/** Labels of the most recent price-axis paint. */
async function axisLabels(page: Page): Promise<string[]> {
  return page.evaluate((axisText) => {
    const calls = (window as unknown as { __fillText: { text: string; align: string; style: string }[] }).__fillText;
    // Tick labels: right-aligned numbers in the axis text colour (the time-zone
    // caption shares the colour, price tags do not).
    const isAxis = (c: { text: string; align: string; style: string }): boolean =>
      c.align === "right" && c.style === axisText && /^-?[\d.,]+$/.test(c.text);
    let end = calls.length - 1;
    while (end >= 0 && !isAxis(calls[end]!)) end--;
    let begin = end;
    while (begin > 0 && isAxis(calls[begin - 1]!)) begin--;
    return end < 0 ? [] : calls.slice(begin, end + 1).map((c) => c.text);
  }, AXIS_TEXT);
}

async function chartState(page: Page): Promise<{ priceMin: number; priceMax: number }> {
  return page.evaluate(() => (window as unknown as { __razeChartState: { priceMin: number; priceMax: number } }).__razeChartState);
}

test.describe("price axis", () => {
  test("a -20..+5 series autoscales and labels negative prices", async ({ page }) => {
    const warnings = await openHarness(page, "series=spread");
    const state = await chartState(page);
    expect(state.priceMin).toBeLessThan(-20);
    expect(state.priceMin).toBeGreaterThan(-25);
    expect(state.priceMax).toBeGreaterThan(5);
    expect(state.priceMax).toBeLessThan(10);
    const labels = await axisLabels(page);
    expect(labels).toContain("0.00");
    expect(labels.some((l) => l.startsWith("-"))).toBe(true);
    expect(labels.every((l) => /^-?\d+\.\d{2}$/.test(l))).toBe(true);
    expect(warnings.filter((w) => w.includes("Log scale"))).toHaveLength(0);
  });

  test("log scale on non-positive data falls back to linear with a single warning", async ({ page }) => {
    const warnings = await openHarness(page, "series=spread");
    await page.getByRole("button", { name: "Logarithmic scale" }).click();
    await page.waitForTimeout(200);
    // Force a few more frames: the warning must still be single.
    const canvas = page.locator(".raze-chart-root canvas").first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas not laid out");
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForTimeout(200);
    const state = await chartState(page);
    expect(state.priceMin).toBeLessThan(-20);
    expect(state.priceMax).toBeGreaterThan(5);
    const labels = await axisLabels(page);
    expect(labels.some((l) => l.startsWith("-"))).toBe(true);
    const logWarnings = warnings.filter((w) => w.includes("Log scale needs prices above zero"));
    expect(logWarnings).toHaveLength(1);
  });

  test("sub-cent prices with a coarse pricescale keep distinct axis labels", async ({ page }) => {
    await openHarness(page, "series=tiny&pricescale=100");
    const labels = await axisLabels(page);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain("0.00");
    const digits = new Set(labels.map((l) => l.split(".")[1]?.length ?? 0));
    expect(digits.size).toBe(1);
  });

  test("labels sit on the minmov grid and follow the widget locale", async ({ page }) => {
    await openHarness(page, "series=es&pricescale=100&minmov=25&locale=de");
    const labels = await axisLabels(page);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    for (const label of labels) expect(label).toMatch(/^\d\.\d{3},(00|25|50|75)$/);
  });
});
