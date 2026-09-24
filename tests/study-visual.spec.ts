import { test, expect, type Page } from "@playwright/test";

// Study goldens (Bollinger Bands, MACD, several panes, a sub-cent token) and
// real-browser checks of study names and pane value precision.

type ChartWindow = Window & {
  __razeReady?: boolean;
  __razeChart?: {
    activeChart(): { createStudy(name: string, forceOverlay?: boolean, lock?: boolean, inputs?: Record<string, unknown>): Promise<unknown> };
    save(): { studies: Record<string, unknown>[] } & Record<string, unknown>;
    load(state: Record<string, unknown>): Promise<void>;
  };
  __drawnText?: string[];
};

async function openCase(page: Page, name: string): Promise<void> {
  await page.goto(`/examples/visual.html?case=${name}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as ChartWindow).__razeReady === true, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  // Two frames after ready so price-axis width can converge.
  await page.waitForTimeout(400);
}

/** Record every string painted on a canvas, so assertions can read the legend and axis tags. */
async function recordCanvasText(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const drawn: string[] = [];
    (window as ChartWindow).__drawnText = drawn;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function patched(text: string, x: number, y: number, maxWidth?: number) {
      drawn.push(String(text));
      return maxWidth === undefined ? fillText.call(this, text, x, y) : fillText.call(this, text, x, y, maxWidth);
    };
  });
}

const drawnSince = async (page: Page, from: number): Promise<string[]> =>
  page.evaluate((start) => ((window as ChartWindow).__drawnText ?? []).slice(start), from);

/**
 * First value of the DOM legend row whose label matches `label` (W1B-16's
 * legend renders rows as text: label, then one span per plot value).
 */
async function domLegendValue(page: Page, label: RegExp): Promise<string> {
  return page.evaluate((source) => {
    const pattern = new RegExp(source);
    for (const row of document.querySelectorAll(".raze-chart-root .raze-legend-row")) {
      if (!pattern.test(row.querySelector(".raze-legend-label")?.textContent ?? "")) continue;
      return row.querySelector(".raze-legend-values > span")?.lastChild?.textContent ?? "";
    }
    return "";
  }, label.source);
}

/** At least two significant digits after any leading "0.000…". */
const hasSignificantDigits = (text: string): boolean => /^-?0\.0*[1-9]\d/.test(text) || /^-?[1-9]\d*\.\d{2}$/.test(text);

test.describe("study visual goldens", () => {
  for (const name of ["bb", "macd", "panes", "lowprice"] as const) {
    test(name, async ({ page }) => {
      await openCase(page, name);
      await expect(page.locator(".raze-chart-root")).toHaveScreenshot(`widget-${name}.png`);
    });
  }
});

test.describe("study behaviour in the browser", () => {
  test("MACD on a pricescale 1e8 token shows significant digits in the legend and crosshair tag", async ({ page }) => {
    await recordCanvasText(page);
    await openCase(page, "lowprice");
    const canvas = page.locator(".raze-chart-root canvas").first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas not laid out");
    const before = (await drawnSince(page, 0)).length;
    // The MACD pane sits directly above the time axis (22% of the height).
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.84);
    await page.waitForTimeout(250);
    const texts = await drawnSince(page, before);
    // Canvas legend: the value follows its "MACD 12 26 9"-style label. A DOM
    // legend renders the same pair as text in the chart root.
    const label = texts.findIndex((text) => /^MACD\s?\d/.test(text));
    const legendValue = label >= 0 ? texts[label + 1] ?? "" : await domLegendValue(page, /^MACD\s?\d/);
    expect(hasSignificantDigits(legendValue), `legend value "${legendValue}" in ${texts.join(" | ")}`).toBe(true);
    expect(texts).not.toContain("0.0");
    expect(texts).not.toContain("-0.0");
    // The sub-pane crosshair tag uses the same formatter: a tiny value with significant digits.
    const tags = texts.filter((text) => /^-?0\.0000\d*[1-9]\d/.test(text) && text !== legendValue);
    expect(tags.length, `crosshair tag drawn: ${texts.join(" | ")}`).toBeGreaterThan(0);
  });

  test("RSI keeps one decimal in the legend and its pane's crosshair tag next to MACD", async ({ page }) => {
    await recordCanvasText(page);
    await openCase(page, "panes");
    const canvas = page.locator(".raze-chart-root canvas").first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas not laid out");
    const before = (await drawnSince(page, 0)).length;
    // The RSI pane sits between the price pane and the MACD pane (about 55-75% of the height).
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.64);
    await page.waitForTimeout(250);
    const texts = await drawnSince(page, before);
    const label = texts.findIndex((text) => /^RSI\s?\d/.test(text));
    const legendValue = label >= 0 ? texts[label + 1] ?? "" : await domLegendValue(page, /^RSI\s?\d/);
    expect(legendValue, `RSI legend value in ${texts.join(" | ")}`).toMatch(/^\d{1,3}\.\d$/);
    // The RSI pane's crosshair tag: a 0-100 value with exactly one decimal
    // (legend values, which follow their "RSI14" label on every frame, excluded).
    const tags = texts.filter((text, index) => !/^RSI\s?\d/.test(texts[index - 1] ?? "") && /^\d{1,3}\.\d$/.test(text));
    expect(tags.length, `RSI crosshair tag drawn: ${texts.join(" | ")}`).toBeGreaterThan(0);
    for (const tag of tags) expect(Number(tag)).toBeLessThanOrEqual(100);
  });

  test("createStudy rejects TradingView names Raze does not implement", async ({ page }) => {
    await openCase(page, "dark");
    const outcome = await page.evaluate(async () => {
      const chart = (window as ChartWindow).__razeChart!.activeChart();
      const results: Record<string, string> = {};
      for (const name of ["Double Exponential Moving Average", "Bollinger Bands %B", "Anchored VWAP", "Moving Average Exponential"]) {
        try {
          await chart.createStudy(name);
          results[name] = "created";
        } catch (error) {
          results[name] = (error as Error).message;
        }
      }
      return results;
    });
    expect(outcome["Double Exponential Moving Average"]).toMatch(/unknown study: Double Exponential Moving Average\. Available studies: EMA, SMA, RSI, VWAP, Bollinger Bands, MACD/);
    expect(outcome["Bollinger Bands %B"]).toMatch(/unknown study/);
    expect(outcome["Anchored VWAP"]).toMatch(/unknown study/);
    expect(outcome["Moving Average Exponential"]).toBe("created");

    // load() resolves names the same way and rejects with the same guidance.
    const loaded = await page.evaluate(async () => {
      const widget = (window as ChartWindow).__razeChart!;
      const state = widget.save();
      try {
        await widget.load({
          ...state,
          studies: [...state.studies, { name: "Double Exponential Moving Average", length: 9, color: "#2962ff", inputs: {} }],
        });
        return "loaded";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(loaded).toMatch(/unknown study: Double Exponential Moving Average\. Available studies: EMA, SMA, RSI, VWAP, Bollinger Bands, MACD/);
  });
});
