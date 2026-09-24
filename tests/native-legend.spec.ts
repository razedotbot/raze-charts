import { expect, test, type Page } from "@playwright/test";

// W1B-02: the native legend wraps, compacts, and keeps hidden series listed.
// 12 series and 12 pie slices at 480x300, in both renderers.

async function openLegend(page: Page, query: string): Promise<void> {
  await page.goto(`/tests/fixtures/native-legend.html?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __razeLegendReady?: boolean }).__razeLegendReady === true);
  await page.evaluate(() => document.fonts.ready);
}

interface Box { x: number; y: number; width: number; height: number }

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
}

test.describe("native legend", () => {
  test("12 series wrap into rows that stay inside the chart", async ({ page }) => {
    await openLegend(page, "case=series");
    const host = page.locator("#host");
    const hostBox = (await host.boundingBox())!;
    const entries = page.locator("#host svg [data-series]");
    await expect(entries).toHaveCount(12);
    const boxes = await entries.evaluateAll((nodes) => nodes.map((node) => {
      const rect = (node as SVGGraphicsElement).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
    expect(new Set(boxes.map((box) => Math.round(box.y))).size).toBeGreaterThanOrEqual(2);
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(hostBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(hostBox.x + hostBox.width);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
    }
    await expect(host).toHaveScreenshot("native-legend-12-series.png");
    // The legend band on its own, so a legend regression is not averaged away by the plot.
    await expect(page).toHaveScreenshot("native-legend-12-series-band.png", { clip: { x: hostBox.x, y: hostBox.y, width: 480, height: 64 } });
  });

  test("a legend click hides a series and a second click restores it", async ({ page }) => {
    await openLegend(page, "case=series");
    const sceneKey = () => page.evaluate(() => {
      const scene = (window as unknown as { __razeHandle: { getScene(): { nodes: unknown[]; legend: unknown[] } } }).__razeHandle.getScene();
      return JSON.stringify([scene.nodes, scene.legend]);
    });
    const original = await sceneKey();
    const first = page.locator('#host svg [data-series="mark-0"]');
    await first.click();
    await expect(page.locator('#host svg [data-series="mark-0"]')).toHaveAttribute("data-hidden", "true");
    await page.locator('#host svg [data-series="mark-0"]').click();
    await expect(page.locator('#host svg [data-series="mark-0"]')).not.toHaveAttribute("data-hidden", "true");
    expect(await sceneKey()).toBe(original);
  });

  test("a series hidden through mount options comes back on the first click", async ({ page }) => {
    await openLegend(page, "case=hidden");
    const row = (id: string) => page.locator(`#host svg [data-series="${id}"]`);
    const seriesCount = () => page.evaluate(() => {
      const scene = (window as unknown as { __razeHandle: { getScene(): { nodes: { role?: string }[] } } }).__razeHandle.getScene();
      return scene.nodes.filter((node) => node.role === "line").length;
    });
    await expect(row("mark-1")).toHaveAttribute("data-hidden", "true");
    await expect(row("mark-4")).toHaveAttribute("data-hidden", "true");
    expect(await seriesCount()).toBe(10);
    await row("mark-1").click();
    await expect(row("mark-1")).not.toHaveAttribute("data-hidden", "true");
    await expect(row("mark-4")).toHaveAttribute("data-hidden", "true");
    expect(await seriesCount()).toBe(11);
    await row("mark-1").click();
    await expect(row("mark-1")).toHaveAttribute("data-hidden", "true");
    expect(await seriesCount()).toBe(10);
  });

  test("12 pie slices compact into one readable column", async ({ page }) => {
    await openLegend(page, "case=pie");
    const host = page.locator("#host");
    const hostBox = (await host.boundingBox())!;
    const entries = page.locator("#host svg [data-series]");
    await expect(entries).toHaveCount(12);
    const boxes = await entries.evaluateAll((nodes) => nodes.map((node) => {
      const rect = (node as SVGGraphicsElement).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
    for (const box of boxes) {
      expect(box.y).toBeGreaterThanOrEqual(hostBox.y);
      expect(box.y + box.height).toBeLessThanOrEqual(hostBox.y + hostBox.height);
      expect(box.x + box.width).toBeLessThanOrEqual(hostBox.x + hostBox.width);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
    }
    await expect(host).toHaveScreenshot("native-legend-12-slices.png");
    await expect(page).toHaveScreenshot("native-legend-12-slices-column.png", { clip: { x: hostBox.x + 320, y: hostBox.y, width: 160, height: 300 } });
  });

  test("Canvas paints hidden series dimmed in the wrapped legend", async ({ page }) => {
    await openLegend(page, "case=hidden&renderer=canvas");
    const hostBox = (await page.locator("#host").boundingBox())!;
    await expect(page.locator("#host")).toHaveScreenshot("native-legend-hidden-canvas.png");
    await expect(page).toHaveScreenshot("native-legend-hidden-canvas-band.png", { clip: { x: hostBox.x, y: hostBox.y, width: 480, height: 64 } });
  });
});
