import { test, expect, type Page } from "@playwright/test";

const CASES = ["dark", "light", "rsi", "drawings", "trading", "compact"] as const;

async function openCase(page: Page, name: string): Promise<void> {
  await page.goto(`http://127.0.0.1:8799/examples/visual.html?case=${name}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, {
    timeout: 30_000,
  });
  await page.evaluate(() => document.fonts.ready);
  // Two frames after ready so price-axis width can converge.
  await page.waitForTimeout(400);
}

async function openNativeDashboard(page: Page): Promise<void> {
  await page.goto("http://127.0.0.1:8799/examples/dashboard.html", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => (window as unknown as { __razeDashboardReady?: boolean }).__razeDashboardReady === true,
    { timeout: 30_000 },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

test.describe("widget visual freeze", () => {
  for (const name of CASES) {
    test(name, async ({ page }) => {
      await openCase(page, name);
      if (name === "compact") {
        await expect(page.locator(".raze-chart-left-sidebar")).toBeHidden();
      }
      const root = page.locator(".raze-chart-root");
      await expect(root).toHaveScreenshot(`widget-${name}.png`);
    });
  }

  test("crosshair", async ({ page }) => {
    await openCase(page, "dark");
    const canvas = page.locator(".raze-chart-root canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas not laid out");
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.4);
    await page.waitForTimeout(200);
    await expect(page.locator(".raze-chart-root")).toHaveScreenshot("widget-crosshair.png");
  });
});

test.describe("native dashboard visual freeze", () => {
  test("all built-in chart families", async ({ page }) => {
    await openNativeDashboard(page);
    await expect(page.locator(".desk")).toHaveScreenshot("native-dashboard.png");
  });
});
