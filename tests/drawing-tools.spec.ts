// Drawing tools in a real browser (W1B-11): goldens for every built-in kind in
// both themes (dashed trend and vertical lines, filled rectangles, fib, measure,
// text styles) plus pixel checks that a rectangle's configured fill is what is
// painted and that handles appear only on hover or selection.

import { test, expect, type Page } from "@playwright/test";

async function open(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.goto(`/examples/drawing-tools.html?theme=${theme}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

/** Canvas pixels matching `match`, with their mean position. */
async function pixels(page: Page, match: string): Promise<{ count: number; x: number; y: number }> {
  return page.evaluate((source) => {
    const test = new Function("r", "g", "b", `return ${source};`) as (r: number, g: number, b: number) => boolean;
    const canvas = document.querySelector(".raze-chart-root canvas") as HTMLCanvasElement;
    const { data, width } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (!test(data[i]!, data[i + 1]!, data[i + 2]!)) continue;
      count += 1;
      sx += (i / 4) % width;
      sy += Math.floor(i / 4 / width);
    }
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / canvas.width;
    return { count, x: rect.left + (sx / Math.max(1, count)) * scale, y: rect.top + (sy / Math.max(1, count)) * scale };
  }, match);
}

const MAGENTA = "r > 200 && g < 90 && b > 200";

for (const theme of ["dark", "light"] as const) {
  test(`every built-in drawing kind (${theme})`, async ({ page }) => {
    await open(page, theme);
    await expect(page.locator(".raze-chart-root")).toHaveScreenshot(`drawing-tools-${theme}.png`);
  });
}

test("a rectangle paints its configured backgroundColor", async ({ page }) => {
  await open(page, "dark");
  const fill = await pixels(page, "r === 51 && g === 85 && b === 255");
  expect(fill.count).toBeGreaterThan(400);
});

test("handles show only while a drawing is hovered or selected", async ({ page }) => {
  await open(page, "dark");
  const idle = await pixels(page, MAGENTA);
  expect(idle.count).toBeGreaterThan(50);
  // Hover the dashed trend line where it is drawn (its magenta pixels' centroid).
  await page.mouse.move(idle.x, idle.y);
  await page.waitForTimeout(100);
  const hovered = await pixels(page, MAGENTA);
  expect(hovered.count).toBeGreaterThan(idle.count + 20);
  // Somewhere empty inside the plot (leaving the canvas keeps the last hover).
  const box = (await page.locator(".raze-chart-root canvas").boundingBox())!;
  const empty = { x: box.x + 30, y: box.y + box.height * 0.5 };
  await page.mouse.move(empty.x, empty.y);
  await page.waitForTimeout(100);
  const left = await pixels(page, MAGENTA);
  expect(Math.abs(left.count - idle.count)).toBeLessThanOrEqual(4);
  await page.mouse.click(idle.x, idle.y);
  await page.mouse.move(empty.x, empty.y);
  await page.waitForTimeout(100);
  const selected = await pixels(page, MAGENTA);
  expect(selected.count).toBeGreaterThan(idle.count + 20);
});
