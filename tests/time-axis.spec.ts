import { expect, test, type Page } from "@playwright/test";

// Real-browser checks for the synced layout crosshair and the volume-pane
// readout (W1B-05). Painted pixels are compared before and after hovering, so
// the checks hold whether the crosshair shares the main canvas or gets its own
// overlay layer.

async function openFixture(page: Page, testCase: "layout" | "volume" | "single", tz?: string): Promise<void> {
  const zone = tz ? `&tz=${encodeURIComponent(tz)}` : "";
  await page.goto(`/tests/fixtures/time-axis.html?case=${testCase}${zone}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
}

interface Changes {
  width: number;
  height: number;
  /** Changed pixels per column and per row since the baseline. */
  columns: number[];
  rows: number[];
  /** Changed pixels per row within the right-most `axisWidth` columns. */
  axisRows: number[];
}

/**
 * Composite every canvas inside each `selector` cell (top-most last). The
 * first call stores a baseline in the page; `diff` returns, per cell, how
 * many pixels changed in each column and row since that baseline.
 */
async function canvasChanges(page: Page, selector: string, mode: "baseline" | "diff", axisWidth = 56): Promise<Changes[]> {
  return page.evaluate(({ sel, mode: m, axisWidth: axis }) => {
    const store = window as unknown as { __timeAxisBaseline?: ImageData[] };
    const images = [...document.querySelectorAll(sel)].map((cell) => {
      const canvases = [...cell.querySelectorAll("canvas")].filter((c) => c.width > 0 && c.height > 0);
      const out = document.createElement("canvas");
      out.width = Math.max(...canvases.map((c) => c.width));
      out.height = Math.max(...canvases.map((c) => c.height));
      const ctx = out.getContext("2d")!;
      for (const c of canvases) ctx.drawImage(c, 0, 0);
      return ctx.getImageData(0, 0, out.width, out.height);
    });
    if (m === "baseline") {
      store.__timeAxisBaseline = images;
      return [];
    }
    return images.map((after, index) => {
      const before = store.__timeAxisBaseline![index]!;
      const { width, height } = after;
      const columns = new Array<number>(width).fill(0);
      const rows = new Array<number>(height).fill(0);
      const axisRows = new Array<number>(height).fill(0);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const diff = Math.abs(before.data[i]! - after.data[i]!) + Math.abs(before.data[i + 1]! - after.data[i + 1]!) + Math.abs(before.data[i + 2]! - after.data[i + 2]!);
          if (diff <= 24) continue;
          columns[x]!++;
          rows[y]!++;
          if (x >= width - axis) axisRows[y]!++;
        }
      }
      return { width, height, columns, rows, axisRows };
    });
  }, { sel: selector, mode, axisWidth });
}

test.describe("time axis and crosshair", () => {
  test("a 2x2 layout of four symbols shows four vertical crosshair lines", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await openFixture(page, "layout");
    const cells = page.locator(".raze-chart-layout-pane");
    await expect(cells).toHaveCount(4);
    await canvasChanges(page, ".raze-chart-layout-pane", "baseline");

    const box = await cells.nth(0).boundingBox();
    if (!box) throw new Error("layout cell not laid out");
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.4);
    await page.waitForTimeout(400);
    const changes = await canvasChanges(page, ".raze-chart-layout-pane", "diff");

    // A dashed [4, 4] line changes about half the pixels along its length.
    const verticals = changes.map((c) => c.columns.filter((n) => n > c.height * 0.3).length);
    const horizontals = changes.map((c) => c.rows.some((n) => n > c.width * 0.3));
    for (let i = 0; i < 4; i++) {
      expect(verticals[i], `pane ${i} draws a vertical crosshair line`).toBeGreaterThanOrEqual(1);
      expect(verticals[i], `pane ${i} draws one line, not a smear`).toBeLessThanOrEqual(3);
    }
    expect(horizontals[0], "the hovered pane shows its horizontal line").toBe(true);
    expect(horizontals.slice(1), "panes of other symbols show no horizontal line").toEqual([false, false, false]);
  });

  test("hovering the volume pane draws a horizontal line and a volume label", async ({ page }) => {
    await openFixture(page, "volume");
    const canvas = page.locator(".raze-chart-root canvas").first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas not laid out");
    await canvasChanges(page, ".raze-chart-root", "baseline");

    // Volume pane geometry (src/engine/layout.ts): the band of 16% of the
    // canvas height directly above the 22 px time axis.
    const height = Math.round(box.height);
    const volumeH = Math.max(36, Math.floor(height * 0.16));
    const bandTop = height - 22 - volumeH;
    const localY = Math.round(bandTop + volumeH / 2);
    await page.mouse.move(box.x + box.width * 0.4, box.y + localY);
    await page.waitForTimeout(300);
    const [change] = await canvasChanges(page, ".raze-chart-root", "diff");
    if (!change) throw new Error("no canvas in the widget root");

    const line = change.rows.findIndex((n, row) => Math.abs(row - localY) <= 1 && n > change.width * 0.3);
    expect(line, "a horizontal crosshair line crosses the volume pane").toBeGreaterThanOrEqual(0);

    // The readout pill sits on the price axis, inside the volume band.
    const pillRows = change.axisRows.map((n, row) => (n > 10 && row < height - 22 ? row : -1)).filter((row) => row >= 0);
    expect(pillRows.length, "a label pill is drawn on the axis").toBeGreaterThanOrEqual(10);
    expect(Math.min(...pillRows), "the pill stays inside the volume band").toBeGreaterThanOrEqual(bandTop);
    expect(Math.max(...pillRows), "the pill stays inside the volume band").toBeLessThanOrEqual(bandTop + volumeH);
  });

  // The same bars in two zones: New York labels its own local times (00:20 to
  // 07:00 on 15 Jan) where UTC shows 05:20 to 12:00.
  for (const [name, zone] of [["utc", "Etc/UTC"], ["new-york", "America/New_York"]] as const) {
    test(`time axis golden in ${zone}`, async ({ page }) => {
      await openFixture(page, "single", zone);
      const box = await page.locator(".raze-chart-root canvas").first().boundingBox();
      if (!box) throw new Error("canvas not laid out");
      // Only the 22 px time-axis strip, so the labels dominate the comparison.
      const clip = { x: box.x, y: box.y + box.height - 22, width: box.width, height: 22 };
      await expect(page).toHaveScreenshot(`time-axis-${name}.png`, { clip, maxDiffPixelRatio: 0.01 });
    });
  }
});
