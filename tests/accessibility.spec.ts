import { expect, test, type Page } from "@playwright/test";

async function openWidget(page: Page): Promise<void> {
  await page.goto("http://127.0.0.1:8799/examples/visual.html?case=dark", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => (window as unknown as { __razeReady?: boolean }).__razeReady === true,
    { timeout: 30_000 },
  );
}

test.describe("widget accessibility", () => {
  test("chrome uses named native controls and exposes selected state", async ({ page }) => {
    await openWidget(page);

    const toolbar = page.getByRole("toolbar", { name: "Chart toolbar" });
    const sidebar = page.getByRole("toolbar", { name: "Drawing and chart tools" });
    const scale = page.getByRole("toolbar", { name: "Price scale" });
    await expect(toolbar).toBeVisible();
    await expect(sidebar).toHaveAttribute("aria-orientation", "vertical");
    await expect(scale).toBeVisible();

    const cursor = sidebar.getByRole("button", { name: "Cursor / pan" });
    const trend = sidebar.getByRole("button", { name: "Trend line" });
    await expect(cursor).toHaveAttribute("aria-pressed", "true");
    await trend.click();
    await expect(trend).toHaveAttribute("aria-pressed", "true");
    await expect(cursor).toHaveAttribute("aria-pressed", "false");

    const oneMinute = toolbar.getByRole("button", { name: "Interval 1m" });
    const fiveMinutes = toolbar.getByRole("button", { name: "Interval 5m" });
    await expect(oneMinute).toHaveAttribute("aria-current", "true");
    await fiveMinutes.click();
    await expect(fiveMinutes).toHaveAttribute("aria-current", "true");
    await expect(oneMinute).not.toHaveAttribute("aria-current", "true");

    const percent = scale.getByRole("button", { name: "Percent scale" });
    const logarithmic = scale.getByRole("button", { name: "Logarithmic scale" });
    await logarithmic.click();
    await expect(logarithmic).toHaveAttribute("aria-pressed", "true");
    await expect(percent).toHaveAttribute("aria-pressed", "false");
  });

  test("menus support focus, arrows, toggles, Escape and focus return", async ({ page }) => {
    await openWidget(page);
    const sidebar = page.getByRole("toolbar", { name: "Drawing and chart tools" });

    const chartType = sidebar.getByRole("button", { name: "Chart type: Candles" });
    await chartType.focus();
    await chartType.press("Enter");
    const typeMenu = page.getByRole("menu", { name: "Chart type" });
    const typeItems = typeMenu.getByRole("menuitemradio");
    await expect(chartType).toHaveAttribute("aria-expanded", "true");
    await expect(typeItems.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(typeItems.nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(typeMenu).toBeHidden();
    await expect(chartType).toBeFocused();
    await expect(chartType).toHaveAttribute("aria-expanded", "false");

    const indicators = sidebar.getByRole("button", { name: "Indicators" });
    await indicators.press("Space");
    const indicatorsMenu = page.getByRole("menu", { name: "Indicators" });
    const firstPreset = indicatorsMenu.getByRole("menuitemcheckbox").first();
    await expect(firstPreset).toBeFocused();
    await expect(firstPreset).toHaveAttribute("aria-checked", "false");
    await firstPreset.press("Enter");
    await expect(indicatorsMenu.getByRole("menuitemcheckbox").first()).toBeFocused();
    await expect(indicatorsMenu.getByRole("menuitemcheckbox").first()).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(indicatorsMenu).toBeHidden();
    await expect(indicators).toBeFocused();
  });

  test("toolbars expose arrow navigation without removing normal Tab stops", async ({ page }) => {
    await openWidget(page);
    const sidebar = page.getByRole("toolbar", { name: "Drawing and chart tools" });
    const cursor = sidebar.getByRole("button", { name: "Cursor / pan" });
    const trend = sidebar.getByRole("button", { name: "Trend line" });
    await cursor.focus();
    await page.keyboard.press("ArrowDown");
    await expect(trend).toBeFocused();

    const scale = page.getByRole("toolbar", { name: "Price scale" });
    const percent = scale.getByRole("button", { name: "Percent scale" });
    const logarithmic = scale.getByRole("button", { name: "Logarithmic scale" });
    await percent.focus();
    await page.keyboard.press("ArrowRight");
    await expect(logarithmic).toBeFocused();
  });

  test("loading overlay exposes an indeterminate polite status", async ({ page }) => {
    await openWidget(page);
    const state = await page.evaluate(async () => {
      const { LoadingScreen } = await import("/dist/charting_library.esm.js");
      const loading = new LoadingScreen(undefined, "#181615");
      document.body.appendChild(loading.el);
      const before = {
        role: loading.el.getAttribute("role"),
        live: loading.el.getAttribute("aria-live"),
        busy: loading.el.getAttribute("aria-busy"),
        label: loading.el.getAttribute("aria-label"),
        spinnerHidden: loading.el.firstElementChild?.getAttribute("aria-hidden"),
      };
      loading.hide();
      const after = {
        busy: loading.el.getAttribute("aria-busy"),
        label: loading.el.getAttribute("aria-label"),
      };
      loading.destroy();
      return { before, after };
    });

    expect(state.before).toEqual({
      role: "status",
      live: "polite",
      busy: "true",
      label: "Loading chart data",
      spinnerHidden: "true",
    });
    expect(state.after).toEqual({ busy: "false", label: "Chart data loaded" });
  });
});
