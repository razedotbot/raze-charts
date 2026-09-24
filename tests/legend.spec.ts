import { expect, test, type Page } from "@playwright/test";

// DOM legend (W1B-16) in a real browser: title row, definition-built labels,
// every plot value, clipping at narrow widths (pixel check), "+N" collapse,
// hover/keyboard removal with undo, symbol changes and Heikin-Ashi values.

interface LegendCase {
  studies?: string[];
  pricescale?: number;
  style?: string;
  overrides?: Record<string, unknown>;
}

async function openLegend(page: Page, options: LegendCase = {}): Promise<void> {
  const params = new URLSearchParams();
  if (options.studies?.length) params.set("studies", options.studies.join(";"));
  if (options.style) params.set("style", options.style);
  if (options.pricescale) params.set("pricescale", String(options.pricescale));
  if (options.overrides) params.set("overrides", JSON.stringify(options.overrides));
  await page.goto(`/examples/legend.html?${params}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, {
    timeout: 30_000,
  });
  await page.evaluate(() => document.fonts.ready);
  // Let the price-axis width converge and the loading screen fade out.
  await page.waitForTimeout(400);
}

/** Let queued animation frames (and therefore legend renders) run. */
async function nextFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate((n) => new Promise<void>((resolve) => {
    const step = (left: number): void => {
      if (left === 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(n);
  }), count);
}

const EIGHT_STUDIES = [
  'EMA:{"length":9}',
  'EMA:{"length":21}',
  'SMA:{"length":50}',
  "VWAP",
  'Bollinger Bands:{"length":20}',
  "HL2",
  "MACD",
  'RSI:{"length":14}',
];

const labels = (page: Page) => page.locator(".raze-legend-row:not([hidden]) .raze-legend-label").allTextContents();

test.describe("DOM legend", () => {
  test("title row names the symbol and interval left of the OHLC values", async ({ page }) => {
    await openLegend(page);
    const legend = page.getByRole("group", { name: "Chart legend" });
    await expect(legend).toBeVisible();
    await expect(legend.locator(".raze-legend-symbol")).toHaveText("MOCK");
    // The mock's description equals the symbol, so it is not repeated.
    await expect(legend.locator(".raze-legend-meta")).toHaveText(" · 1m · Mock");
    await expect(legend.getByRole("img", { name: "Market open" })).toBeVisible();
    const symbol = await legend.locator(".raze-legend-symbol").boundingBox();
    const open = await legend.locator(".raze-legend-ohlc > span").first().boundingBox();
    expect(symbol && open).toBeTruthy();
    expect(symbol!.x + symbol!.width).toBeLessThan(open!.x);
    expect(Math.abs(symbol!.y - open!.y)).toBeLessThan(4);
    await expect(legend.locator(".raze-legend-ohlc")).toContainText("O");
    await expect(legend.locator(".raze-legend-ohlc")).toContainText("C");
  });

  test("labels are built from the definition and every plot value is coloured", async ({ page }) => {
    await openLegend(page, { studies: ['EMA:{"length":9}', "VWAP", "HL2", "MACD", 'Bollinger Bands:{"length":20}'] });
    expect(await labels(page)).toEqual(["EMA 9", "VWAP", "HL2", "MACD 12 26 9", "BB 20 2"]);
    for (const label of ["MACD 12 26 9", "BB 20 2"]) {
      const row = page.locator(".raze-legend-row", { has: page.locator(".raze-legend-label", { hasText: label }) });
      const values = row.locator(".raze-legend-values > span");
      await expect(values).toHaveCount(3);
      for (const value of await values.all()) await expect(value).toBeVisible();
      const colors = await values.evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
      expect(colors.every((color) => /^rgb\(/.test(color)), `${label} values are opaque`).toBe(true);
      if (label.startsWith("MACD")) expect(new Set(colors).size).toBe(3);
    }
  });

  for (const width of [390, 480, 600]) {
    test(`8 studies at ${width}px stay clear of the price axis`, async ({ page }) => {
      await page.setViewportSize({ width, height: 620 });
      await openLegend(page, { studies: EIGHT_STUDIES });
      const canvas = await page.locator(".raze-chart-canvas").boundingBox();
      const legend = page.locator(".raze-legend");
      // Geometry: the price axis is at least 56px wide, plus the 4px gutter.
      const right = await legend.evaluate((el) => Math.max(
        ...[el, ...el.querySelectorAll("*")].map((node) => node.getBoundingClientRect().right),
      ));
      expect(right).toBeLessThanOrEqual(canvas!.x + canvas!.width - 56 - 4);

      // Pixels: the price-axis strip is identical with and without the legend.
      const box = await legend.boundingBox();
      const clip = { x: canvas!.x + canvas!.width - 56, y: box!.y, width: 56, height: box!.height };
      const withLegend = await page.screenshot({ clip });
      await legend.evaluate((el) => { (el as HTMLElement).style.visibility = "hidden"; });
      const withoutLegend = await page.screenshot({ clip });
      await legend.evaluate((el) => { (el as HTMLElement).style.visibility = ""; });
      expect(withLegend.equals(withoutLegend)).toBe(true);

      // Every study is visible or counted in "+N".
      const visible = await page.locator(".raze-legend-row:not([hidden])").count();
      const toggle = page.locator(".raze-legend-toggle");
      const text = (await toggle.textContent()) ?? "";
      const hidden = /^\+(\d+)$/.test(text) ? Number(text.slice(1)) : 0;
      expect(visible + hidden).toBe(8);
    });
  }

  test("+N expands and collapses the study rows", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 420 });
    await openLegend(page, { studies: EIGHT_STUDIES });
    const toggle = page.locator(".raze-legend-toggle");
    await expect(toggle).toHaveText(/^\+\d+$/);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const hidden = Number(((await toggle.textContent()) ?? "+0").slice(1));
    await expect(toggle).toHaveAccessibleName(`Show all indicators (${hidden} hidden)`);
    await toggle.click();
    await expect(page.locator(".raze-legend-row:not([hidden])")).toHaveCount(8);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveAccessibleName("Hide indicators");
    await toggle.click();
    await expect(page.locator(".raze-legend-row:not([hidden])")).toHaveCount(0);
    await expect(toggle).toHaveText("+8");
  });

  test("hovering a row reveals remove; removal is undoable", async ({ page }) => {
    await openLegend(page, { studies: ['EMA:{"length":9}', "VWAP", "MACD"] });
    const row = page.locator(".raze-legend-row", { has: page.locator(".raze-legend-label", { hasText: "EMA 9" }) });
    const remove = row.getByRole("button", { name: "Remove EMA 9" });
    const actions = row.locator(".raze-legend-actions");
    await expect(actions).toHaveCSS("opacity", "0");
    const box = await row.boundingBox();
    // The legend ignores the pointer: the chart's crosshair drives the hover.
    await page.mouse.move(box!.x + 12, box!.y + box!.height / 2);
    await expect(row).toHaveAttribute("data-hover", "");
    await expect(actions).toHaveCSS("opacity", "1");
    await remove.click();
    await expect.poll(() => labels(page)).toEqual(["VWAP", "MACD 12 26 9"]);
    await expect(page.locator(".raze-chart-a11y-status")).toHaveText("EMA 9 removed. Press Ctrl+Z to undo.");
    await page.keyboard.press("Control+z");
    await expect.poll(() => labels(page)).toEqual(["EMA 9", "VWAP", "MACD 12 26 9"]);
  });

  test("keyboard: Tab reaches row actions and focus survives removal", async ({ page }) => {
    await openLegend(page, { studies: ['EMA:{"length":9}', "VWAP", "MACD"] });
    await page.locator(".raze-chart-canvas").focus();
    await page.keyboard.press("Tab");
    const first = page.getByRole("button", { name: "Remove EMA 9" });
    await expect(first).toBeFocused();
    await expect(page.locator(".raze-legend-actions").first()).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    await nextFrames(page);
    await expect(page.getByRole("button", { name: "Remove VWAP" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Remove MACD 12 26 9" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".raze-chart-canvas")).toBeFocused();

    // Every legend control is a named button; no title attributes.
    const unnamed = await page.locator(".raze-legend button").evaluateAll((buttons) =>
      buttons.filter((b) => !(b.getAttribute("aria-label") || b.textContent || "").trim()).length);
    expect(unnamed).toBe(0);
    expect(await page.locator(".raze-legend [title]").count()).toBe(0);
  });

  test("the title follows setSymbol within a frame", async ({ page }) => {
    await openLegend(page);
    const symbol = await page.evaluate(() => new Promise<string>((resolve) => {
      const w = (window as unknown as { __razeChart: { activeChart(): { setSymbol(s: string, cb: () => void): void } } }).__razeChart;
      w.activeChart().setSymbol("BTCUSD", () => {
        requestAnimationFrame(() => resolve(document.querySelector(".raze-legend-symbol")?.textContent ?? ""));
      });
    }));
    expect(symbol).toBe("BTCUSD");
  });

  test("Heikin-Ashi shows the transformed OHLC; last price follows haStyle.showRealLastPrice", async ({ page }) => {
    const ohlc = (): Promise<string[]> => page.locator(".raze-legend-ohlc > span").allTextContents();
    // Two decimals so the HA and real closes format differently.
    await openLegend(page, { pricescale: 100 });
    const real = await ohlc();
    await openLegend(page, { pricescale: 100, style: "heikin_ashi" });
    const ha = await ohlc();
    expect(ha).toHaveLength(4);
    expect(ha[0]).not.toBe(real[0]);
    expect(ha[3]).not.toBe(real[3]);
    await page.mouse.move(0, 0);
    // The HA close is both in the legend and on the last-price tag.
    const tag = ha[3]!.replace(/^C/, "");
    expect(await page.locator(".raze-legend").textContent()).toContain(tag);
    await expect(page.locator(".raze-chart-root")).toHaveScreenshot("legend-heikin-ashi.png");
    await openLegend(page, {
      pricescale: 100,
      style: "heikin_ashi",
      overrides: { "mainSeriesProperties.haStyle.showRealLastPrice": true },
    });
    await page.mouse.move(0, 0);
    await expect(page.locator(".raze-chart-root")).toHaveScreenshot("legend-heikin-ashi-real-price.png");
  });
});
