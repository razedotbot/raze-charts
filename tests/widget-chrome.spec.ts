import { expect, test, type Frame, type Page } from "@playwright/test";

// Real-browser checks for widget sizing, TradingView timeframe objects and the
// go-to-date popover (including inside a sandboxed iframe, where
// window.prompt is ignored). The harness is examples/widget-chrome.html.

type RazeWindow = Window & {
  __razeReady?: boolean;
  __razeErrors?: string[];
  __razeChart?: { activeChart(): { getVisibleRange(): { from: number; to: number } } };
};

const VISUAL_NOW_SEC = Date.UTC(2024, 0, 15, 12, 0, 0) / 1000;

function harness(options: Record<string, unknown> = {}, fill = false): string {
  const query = new URLSearchParams({ options: JSON.stringify(options) });
  if (fill) query.set("fill", "1");
  return `/examples/widget-chrome.html?${query}`;
}

async function waitReady(target: Page | Frame): Promise<void> {
  await target.waitForFunction(() => (window as RazeWindow).__razeReady === true, undefined, { timeout: 30_000 });
}

async function open(page: Page, options: Record<string, unknown> = {}, fill = false): Promise<void> {
  await page.goto(harness(options, fill), { waitUntil: "domcontentloaded" });
  await waitReady(page);
}

test.describe("widget size options", () => {
  test("autosize:false with width 800 x height 450 measures exactly in an unsized container", async ({ page }) => {
    await open(page, { autosize: false, width: 800, height: 450 });
    const box = await page.locator(".raze-chart-root").boundingBox();
    expect(box).toEqual(expect.objectContaining({ width: 800, height: 450 }));
  });

  test("width and height without autosize size the chart in pixels", async ({ page }) => {
    await open(page, { width: 640, height: 360 });
    const box = await page.locator(".raze-chart-root").boundingBox();
    expect(box?.width).toBe(640);
    expect(box?.height).toBe(360);
  });

  test("fullscreen:true sizes the chart to the viewport", async ({ page }) => {
    await open(page, { fullscreen: true, width: 300, height: 200 });
    const box = await page.locator(".raze-chart-root").boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  });

  test("autosize (the default) tracks the container", async ({ page }) => {
    await open(page, {}, true);
    const root = page.locator(".raze-chart-root");
    const viewport = page.viewportSize()!;
    expect(await root.boundingBox()).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    await page.setViewportSize({ width: 900, height: 500 });
    await expect.poll(async () => (await root.boundingBox())?.width).toBe(900);
    expect((await root.boundingBox())?.height).toBe(500);
  });
});

test.describe("timeframe option", () => {
  test("a TradingView { from, to } timeframe loads without the error overlay", async ({ page }) => {
    const from = VISUAL_NOW_SEC - 600 * 60;
    const to = VISUAL_NOW_SEC - 200 * 60;
    await open(page, { timeframe: { from, to } }, true);
    await expect(page.locator(".raze-chart-loading-message")).toBeHidden();
    const errors = await page.evaluate(() => (window as RazeWindow).__razeErrors ?? []);
    expect(errors.filter((text) => /failed to load symbol/.test(text))).toEqual([]);
    const range = await page.evaluate(() => (window as RazeWindow).__razeChart!.activeChart().getVisibleRange());
    expect(range).toEqual({ from, to });
  });
});

test.describe("go to date", () => {
  test("a themed popover with date and time inputs replaces window.prompt", async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.dismiss();
    });
    await open(page, {}, true);
    const dateButton = page.getByRole("button", { name: "Go to date" });
    await expect(dateButton).toHaveAttribute("aria-haspopup", "dialog");
    await dateButton.focus();
    await page.keyboard.press("Enter");
    const popover = page.getByRole("dialog", { name: "Go to date" });
    await expect(popover).toBeVisible();
    const date = popover.getByLabel("Date");
    const time = popover.getByLabel("Time");
    await expect(date).toBeFocused();
    await expect(time).toBeVisible();
    // Themed from the widget tokens rather than browser defaults.
    const background = await popover.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(background).not.toBe("rgba(0, 0, 0, 0)");

    await date.fill("2024-01-14");
    await time.fill("06:30");
    await time.press("Enter");
    await expect(popover).toBeHidden();
    await expect(dateButton).toBeFocused();
    const target = Date.UTC(2024, 0, 14, 6, 30) / 1000;
    const range = await page.evaluate(() => (window as RazeWindow).__razeChart!.activeChart().getVisibleRange());
    expect(Math.abs((range.from + range.to) / 2 - target)).toBeLessThanOrEqual(60);
    expect(dialogs).toEqual([]);

    await page.keyboard.press("Alt+g");
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(dateButton).toBeFocused();
  });

  test("works inside an iframe sandboxed without allow-modals", async ({ page, baseURL }) => {
    const ignored: string[] = [];
    page.on("console", (message) => {
      if (/prompt\(\)|allow-modals/.test(message.text())) ignored.push(message.text());
    });
    await page.setContent(
      `<iframe sandbox="allow-scripts allow-same-origin" style="width:1000px;height:560px;border:0"
        src="${baseURL}${harness({}, true)}"></iframe>`,
    );
    const frameHandle = await page.locator("iframe").elementHandle();
    const frame = (await frameHandle!.contentFrame())!;
    await waitReady(frame);
    const embed = page.frameLocator("iframe");
    await embed.getByRole("button", { name: "Go to date" }).click();
    const popover = embed.getByRole("dialog", { name: "Go to date" });
    await expect(popover).toBeVisible();
    await popover.getByLabel("Date").fill("2024-01-15");
    await popover.getByLabel("Time").fill("09:00");
    await popover.getByRole("button", { name: "Go to" }).click();
    await expect(popover).toBeHidden();
    const target = Date.UTC(2024, 0, 15, 9, 0) / 1000;
    const range = await frame.evaluate(() => (window as RazeWindow).__razeChart!.activeChart().getVisibleRange());
    expect(Math.abs((range.from + range.to) / 2 - target)).toBeLessThanOrEqual(60);
    expect(ignored).toEqual([]);
  });
});
