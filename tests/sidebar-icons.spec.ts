import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

// W1B-23 in a real browser: the icon set renders (candle wicks visible, fit
// and fullscreen distinct), menu labels align whether or not a row is
// checked, kit tooltips replace title attributes (500ms hover, keyboard
// focus, Escape, touch long-press, placed right of the sidebar), and the
// muted "Clear all" text meets WCAG AA contrast on dark and light popups.

async function openCase(page: Page, name: "dark" | "light" = "dark"): Promise<void> {
  await page.goto(`/examples/visual.html?case=${name}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

const sidebarOf = (page: Page) => page.getByRole("toolbar", { name: "Drawing and chart tools" });

/** Left edges of every row label in the open menu, split by checked state. */
async function labelEdges(page: Page, menuName: string): Promise<{ checked: number[]; unchecked: number[] }> {
  return page.getByRole("menu", { name: menuName }).evaluate((menu) => {
    const out = { checked: [] as number[], unchecked: [] as number[] };
    for (const row of menu.querySelectorAll('[role^="menuitem"]')) {
      const label = row.querySelector(".raze-menu-label");
      if (!label) throw new Error(`row without a label slot: ${row.textContent}`);
      (row.getAttribute("aria-checked") === "true" ? out.checked : out.unchecked).push(label.getBoundingClientRect().left);
    }
    return out;
  });
}

function expectAligned(edges: { checked: number[]; unchecked: number[] }): void {
  expect(edges.checked.length).toBeGreaterThan(0);
  expect(edges.unchecked.length).toBeGreaterThan(0);
  const all = [...edges.checked, ...edges.unchecked];
  for (const left of all) expect(left).toBeCloseTo(all[0]!, 1);
}

/** WCAG contrast of an element's text against the menu surface behind it. */
async function menuTextContrast(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const parse = (value: string): number[] => {
      const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)/.exec(value);
      if (srgb) return [1, 2, 3].map((index) => Number(srgb[index]) * 255);
      const rgb = /^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/.exec(value);
      if (rgb) return [1, 2, 3].map((index) => Number(rgb[index]));
      throw new Error(`unparsed colour ${value}`);
    };
    const luminance = ([r, g, b]: number[]): number => {
      const channel = (value: number): number => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    let surface: Element | null = el;
    while (surface && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(surface).backgroundColor)) surface = surface.parentElement;
    const fg = luminance(parse(getComputedStyle(el).color));
    const bg = luminance(parse(getComputedStyle(surface ?? document.body).backgroundColor));
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
}

test.describe("icon set", () => {
  test("the candles icon renders visible wicks above and below both bodies", async ({ page }) => {
    await openCase(page);
    const alpha = await sidebarOf(page).getByRole("button", { name: /Chart type/ }).evaluate(async (button) => {
      const svg = button.querySelector("svg")!;
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      await image.decode();
      const scale = 4;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 18 * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const at = (x: number, y: number): number => ctx.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data[3]!;
      return {
        leftAbove: at(5.5, 4), leftBelow: at(5.5, 14.2),
        rightAbove: at(12.5, 3.1), rightBelow: at(12.5, 12.8),
        besideLeftWick: at(4, 4), besideRightWick: at(14, 13),
      };
    });
    expect(alpha.leftAbove).toBeGreaterThan(200);
    expect(alpha.leftBelow).toBeGreaterThan(200);
    expect(alpha.rightAbove).toBeGreaterThan(200);
    expect(alpha.rightBelow).toBeGreaterThan(200);
    expect(alpha.besideLeftWick).toBe(0);
    expect(alpha.besideRightWick).toBe(0);
  });

  test("every built-in icon shares the 18px / 1.5 stroke grid; fit and fullscreen differ", async ({ page }) => {
    await openCase(page);
    const sidebar = sidebarOf(page);
    const strokes = await sidebar.locator("button svg").evaluateAll((svgs) =>
      svgs.map((svg) => `${svg.getAttribute("viewBox")} ${svg.getAttribute("stroke-width")} ${svg.getBoundingClientRect().width}`));
    expect(strokes.length).toBe(16);
    for (const stroke of strokes) expect(stroke).toBe("0 0 18 18 1.5 18");
    const fit = await sidebar.getByRole("button", { name: "Fit content" }).screenshot();
    const fullscreen = await sidebar.getByRole("button", { name: "Fullscreen" }).screenshot();
    expect(fit.equals(fullscreen)).toBe(false);
  });

  test.describe("zoomed", () => {
    test.use({ deviceScaleFactor: 3 });
    test("sidebar icon strip golden at 3x device pixels", async ({ page }, testInfo) => {
      await openCase(page);
      await page.mouse.move(600, 300);
      const sidebar = page.locator(".raze-chart-left-sidebar");
      const { width } = (await sidebar.boundingBox())!;
      // scale "device" keeps every 3x pixel (the default "css" scale would
      // downsample to 1x), and the budget is absolute, not a ratio: the strip
      // is ~220k pixels, so even 1% would hide a redrawn icon. Measured
      // against this golden: dropping one candle-wick stub changes 22
      // pixels, dropping every wick 77, drawing Fit as Fullscreen 404.
      // Repeated runs differ by 0, so 8 leaves room only for stray
      // anti-aliasing (the default per-pixel threshold absorbs the rest).
      await expect(sidebar).toHaveScreenshot("sidebar-icons.png", { scale: "device", maxDiffPixels: 8 });
      // The committed golden itself is the zoomed image (PNG IHDR width).
      const golden = readFileSync(testInfo.snapshotPath("sidebar-icons.png", { kind: "screenshot" }));
      expect(golden.readUInt32BE(16)).toBe(Math.round(width * 3));
    });
  });
});

test.describe("menus", () => {
  test("labels start at the same x whether or not a row is checked", async ({ page }) => {
    await openCase(page);
    const sidebar = sidebarOf(page);

    await sidebar.getByRole("button", { name: /Chart type/ }).click();
    await expect(page.getByRole("menu", { name: "Chart type" })).toBeVisible();
    expectAligned(await labelEdges(page, "Chart type"));
    expect(await page.getByRole("menu", { name: "Chart type" }).textContent()).not.toContain("✓");
    await page.keyboard.press("Escape");

    await sidebar.getByRole("button", { name: "Indicators" }).click();
    const indicators = page.getByRole("menu", { name: "Indicators" });
    await indicators.getByRole("menuitemcheckbox", { name: "EMA 21" }).click();
    await expect(indicators.getByRole("menuitemcheckbox", { name: "EMA 21" })).toHaveAttribute("aria-checked", "true");
    expectAligned(await labelEdges(page, "Indicators"));
    await page.keyboard.press("Escape");

    await sidebar.getByRole("button", { name: "Objects tree" }).click();
    const tree = page.getByRole("menu", { name: "Objects tree" });
    await tree.getByRole("menuitemcheckbox", { name: "Magnet OHLC" }).click();
    await expect(tree.getByRole("menuitemcheckbox", { name: "Magnet OHLC" })).toHaveAttribute("aria-checked", "true");
    expectAligned(await labelEdges(page, "Objects tree"));
    await page.keyboard.press("Escape");
  });

  for (const theme of ["dark", "light"] as const) {
    test(`the muted "Clear all" row meets AA contrast (${theme})`, async ({ page }) => {
      await openCase(page, theme);
      await sidebarOf(page).getByRole("button", { name: "Indicators" }).click();
      const clear = page.getByRole("menuitem", { name: "Clear all indicators" });
      await expect(clear).toBeVisible();
      expect(await menuTextContrast(page, ".raze-chart-indicators-menu .raze-menu-muted.raze-menu-label")).toBeGreaterThanOrEqual(4.5);
      // Still visibly secondary: not the primary menu text colour.
      const [muted, primary] = await clear.evaluate((row) => [
        getComputedStyle(row.querySelector(".raze-menu-label")!).color,
        getComputedStyle(row.closest('[role="menu"]')!).color,
      ]);
      expect(muted).not.toBe(primary);
    });
  }
});

test.describe("tooltips", () => {
  test("hover shows a themed tooltip after 500ms, right of the sidebar; Escape hides it", async ({ page }) => {
    await openCase(page);
    const sidebar = sidebarOf(page);
    const trend = sidebar.getByRole("button", { name: "Trend line" });
    const tooltip = page.getByRole("tooltip");
    await trend.hover();
    await page.waitForTimeout(300);
    await expect(tooltip).toHaveCount(0);
    await expect(tooltip).toHaveText("Trend line", { timeout: 1_000 });
    const [tip, bar] = [await tooltip.boundingBox(), await sidebar.boundingBox()];
    expect(tip!.x).toBeGreaterThanOrEqual(bar!.x + bar!.width);
    const trendBox = (await trend.boundingBox())!;
    expect(Math.abs(tip!.y + tip!.height / 2 - (trendBox.y + trendBox.height / 2))).toBeLessThan(2);
    // Themed by the kit tooltip tokens, not the browser's native title bubble.
    expect(await tooltip.evaluate((el) => el.className)).toContain("raze-kit-tooltip");
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    expect(await page.locator(".raze-chart-left-sidebar [title], .raze-chart-left-sidebar[title]").count()).toBe(0);
  });

  test("keyboard focus shows the tooltip with its shortcut hint and a description", async ({ page }) => {
    await openCase(page);
    const sidebar = sidebarOf(page);
    await sidebar.getByRole("button", { name: "Cursor / pan" }).focus();
    await page.keyboard.press("ArrowDown");
    const trend = sidebar.getByRole("button", { name: "Trend line" });
    await expect(trend).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveText("Trend line");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    const fit = sidebar.getByRole("button", { name: "Fit content" });
    await fit.focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await expect(fit).toBeFocused();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveText("Fit content\u2003F");
    const id = await tooltip.getAttribute("id");
    await expect(fit).toHaveAttribute("aria-describedby", id!);
    // The key is exposed semantically too, and the button has a stable,
    // locale-independent hook now that it has no title.
    await expect(fit).toHaveAttribute("aria-keyshortcuts", "F");
    await expect(page.locator('.raze-chart-left-sidebar [data-raze-item="fit"]')).toHaveAccessibleName("Fit content");
  });

  test.describe("touch", () => {
    test.use({ hasTouch: true });
    test("a long-press shows the tooltip without activating the tool; a tap still activates", async ({ page }) => {
      await openCase(page);
      const sidebar = sidebarOf(page);
      const trend = sidebar.getByRole("button", { name: "Trend line" });
      const box = (await trend.boundingBox())!;
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await expect(page.getByRole("tooltip")).toHaveText("Trend line", { timeout: 1_500 });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(100);
      await expect(trend).toHaveAttribute("aria-pressed", "false");
      await expect(sidebar.getByRole("button", { name: "Cursor / pan" })).toHaveAttribute("aria-pressed", "true");

      await trend.tap();
      await expect(trend).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("tooltip")).toHaveCount(0);
    });
  });
});
