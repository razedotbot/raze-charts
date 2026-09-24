import { expect, test, type Locator, type Page } from "@playwright/test";
import { build } from "esbuild";

// Real-browser acceptance for the shared popup (src/ui/popup.ts) and the
// context menu: mouse activation of non-focused rows, fullscreen and shadow
// roots, viewport-capped scrolling, separators, CSS row states, motion,
// flip placement and following the anchor, strict-CSP nonces, the keyboard
// model (focus ring, disabled rows, Tab), and the kit dialog adapting its
// presentation while open.

type RazeWindow = Window & {
  __razeReady?: boolean;
  __razeChart?: any;
  __clicked: string[];
  __warnings: string[];
  __violations: string[];
};

// ── Widget harness ─────────────────────────────────────────────────────────
// The financial widget with an Indicators panel that offers RSI, MACD and
// Bollinger Bands, and a context menu using TradingView's "-" conventions.
// `?shadow` mounts it inside an open shadow root; `?nonce=` passes a CSP
// nonce through `raze.style_nonce`.
const NONCE = "r4zeN0nce";
const WIDGET_HARNESS = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Popups</title>
<style nonce="${NONCE}">html,body{margin:0;height:100%;background:#111}#host{position:absolute;inset:0}</style>
</head>
<body>
<div id="host"></div>
<script type="module" nonce="${NONCE}">
  import { widget } from "/dist/charting_library.esm.js";
  import { makeMockDatafeed, VISUAL_NOW } from "/examples/mock-datafeed.mjs";
  const params = new URLSearchParams(location.search);
  window.__clicked = [];
  window.__warnings = window.__warnings || [];
  const warn = console.warn.bind(console);
  console.warn = (...args) => { window.__warnings.push(args.map(String).join(" ")); warn(...args); };
  const host = document.getElementById("host");
  let container = host;
  if (params.has("shadow")) {
    const shadow = host.attachShadow({ mode: "open" });
    container = document.createElement("div");
    container.id = "shadow-wrap";
    container.style.position = "absolute";
    container.style.inset = "0";
    shadow.appendChild(container);
  }
  const w = new widget({
    symbol: "MOCK",
    datafeed: makeMockDatafeed({ bars: 400, startPrice: 6400, now: VISUAL_NOW, live: false }),
    interval: "1",
    container,
    library_path: "/",
    locale: "en",
    theme: "dark",
    autosize: true,
    timezone: "Etc/UTC",
    custom_font_family: "Arial, Helvetica, sans-serif",
    disabled_features: ["header_symbol_search", "popup_hints", "countdown"],
    raze: {
      compact_breakpoint: 0,
      style_nonce: params.get("nonce") || undefined,
      indicator_presets: [
        { name: "EMA", length: 9 },
        { name: "SMA", length: 20 },
        { name: "RSI", length: 14, label: "RSI 14" },
        { name: "MACD", label: "MACD" },
        { name: "Bollinger Bands", length: 20, label: "Bollinger 20" },
      ],
    },
  });
  w.onContextMenu(() => [
    { position: "top", text: "Add alert here", click: () => window.__clicked.push("alert") },
    { position: "top", text: "-" },
    { position: "top", text: "Reset chart", click: () => window.__clicked.push("reset") },
    { position: "top", text: "-" },
    { position: "top", text: "-Reset chart view" },
  ]);
  w.onChartReady(() => {
    window.__razeChart = w;
    window.__razeReady = true;
  });
</script>
</body>
</html>`;

async function openWidget(page: Page, query = "", headers: Record<string, string> = {}): Promise<void> {
  await page.route("**/__popups/index.html*", (route) => route.fulfill({ body: WIDGET_HARNESS, contentType: "text/html", headers }));
  await page.goto(`/__popups/index.html${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as RazeWindow).__razeReady === true, { timeout: 30_000 });
}

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
}

const sidebar = (page: Page): Locator => page.getByRole("toolbar", { name: "Drawing and chart tools" });

const studyNames = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as RazeWindow).__razeChart.save().studies.map((study: { name: string }) => study.name));

async function openContextMenu(page: Page): Promise<Locator> {
  const canvas = page.locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3, { button: "right" });
  const menu = page.getByRole("menu", { name: "Chart context menu" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  return menu;
}

/** Whether the top-most element at the centre of `row` is that row (or inside it). */
const hitsItself = (row: Locator): Promise<boolean> => row.evaluate((el) => {
  const box = el.getBoundingClientRect();
  const root = el.getRootNode() as Document | ShadowRoot;
  const hit = root.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return !!hit && (hit === el || el.contains(hit));
});

test.describe("Indicators menu", () => {
  test("mouse-clicking RSI, MACD and Bollinger adds all three and keeps the panel open", async ({ page }) => {
    await openWidget(page);
    const button = sidebar(page).getByRole("button", { name: "Indicators" });
    await button.click();
    const menu = page.getByRole("menu", { name: "Indicators" });
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
    // Regression: the first press on any row except the focused one closed
    // the panel before the row's click ran, so nothing was added.
    for (const label of ["RSI 14", "MACD", "Bollinger 20"]) {
      const row = menu.getByRole("menuitemcheckbox", { name: label });
      await row.click();
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitemcheckbox", { name: label })).toHaveAttribute("aria-checked", "true");
      await expect(menu.getByRole("menuitemcheckbox", { name: label })).toBeFocused();
    }
    expect((await studyNames(page)).sort()).toEqual(["Bollinger Bands", "MACD", "RSI"]);
    await expect(menu.getByRole("menuitemcheckbox", { name: "EMA 9" })).toHaveAttribute("aria-checked", "false");

    // A press outside still closes it.
    await page.mouse.click(700, 300);
    await expect(menu).toHaveCount(0);

    // Tabbing out still closes it, and Tab moves on from the opener (the
    // menu-button pattern; rows are walked with the arrow keys).
    await button.click();
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);
    const next = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    expect(next).toBeTruthy();
    expect(next).not.toBe("Indicators");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(menu).toHaveCount(0);
    await expect(button).not.toBeFocused();
  });

  test("a press that does not move focus (WebKit buttons) still activates the row", async ({ page }) => {
    await openWidget(page);
    await sidebar(page).getByRole("button", { name: "Indicators" }).click();
    const menu = page.getByRole("menu", { name: "Indicators" });
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
    // Emulate an engine where pressing a <button> does not focus it: focus
    // drops to <body> on mousedown, and the click follows a task later.
    const added = await menu.getByRole("menuitemcheckbox", { name: "MACD" }).evaluate(async (row) => {
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true, button: 0 });
      row.dispatchEvent(down);
      if (!down.defaultPrevented) (document.activeElement as HTMLElement | null)?.blur();
      await new Promise((resolve) => setTimeout(resolve, 20));
      row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true, button: 0 }));
      (row as HTMLElement).click();
      return (window as unknown as RazeWindow).__razeChart.save().studies.map((study: { name: string }) => study.name);
    });
    expect(added).toEqual(["MACD"]);
    await expect(menu).toBeVisible();
  });
});

test.describe("row states", () => {
  test("one highlight follows the keyboard and then the mouse, with one 4px inset for every menu", async ({ page }) => {
    await openWidget(page);
    await sidebar(page).getByRole("button", { name: "Indicators" }).click();
    const menu = page.getByRole("menu", { name: "Indicators" });
    const rows = menu.getByRole("menuitemcheckbox");
    await expect(rows.first()).toBeFocused();
    await settle(page);
    const lit = (): Promise<number[]> => menu.evaluate((el) => [...el.querySelectorAll("[role^=menuitem]")]
      .flatMap((row, index) => getComputedStyle(row).backgroundColor === "rgba(0, 0, 0, 0)" ? [] : [index]));
    // Rows drawing a focus ring (keyboard focus only).
    const ringed = (): Promise<number[]> => menu.evaluate((el) => [...el.querySelectorAll("[role^=menuitem]")]
      .flatMap((row, index) => getComputedStyle(row).outlineStyle === "none" ? [] : [index]));
    // Opened with the mouse: the first row is lit but not ringed.
    expect(await ringed()).toEqual([]);

    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    expect(await lit()).toEqual([1]);
    expect(await ringed()).toEqual([1]);
    const ring = await rows.nth(1).evaluate((row) => {
      const style = getComputedStyle(row);
      return { width: style.outlineWidth, offset: style.outlineOffset, color: style.outlineColor };
    });
    expect(ring.width).toBe("2px");
    expect(ring.offset).toBe("-2px");
    expect(ring.color).not.toBe("rgba(0, 0, 0, 0)");
    const hover = await rows.nth(1).evaluate((row) => getComputedStyle(row).backgroundColor);
    const box = (await rows.nth(3).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(rows.nth(3)).toBeFocused();
    expect(await lit()).toEqual([3]);
    // Focus the pointer moved draws no ring (Chromium still matches
    // :focus-visible there, because the previous focus came from a key).
    expect(await ringed()).toEqual([]);
    expect(await rows.nth(3).evaluate((row) => getComputedStyle(row).backgroundColor)).toBe(hover);
    await page.keyboard.press("ArrowUp");
    await expect(rows.nth(2)).toBeFocused();
    expect(await lit()).toEqual([2]);
    expect(await ringed()).toEqual([2]);
    await page.keyboard.press("Escape");

    // Inset: the first row starts 4px inside the border on every menu.
    const inset = (popup: Locator): Promise<number[]> => popup.evaluate((el) => {
      const row = el.querySelector("[role^=menuitem]")!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return [Math.round(row.left - box.left - el.clientLeft), Math.round(box.right - el.clientLeft - row.right - (el.offsetWidth - el.clientWidth - 2 * el.clientLeft))];
    });
    const menus: Array<[string, () => Promise<Locator>]> = [
      ["Indicators", async () => {
        await sidebar(page).getByRole("button", { name: "Indicators" }).click();
        return page.getByRole("menu", { name: "Indicators" });
      }],
      ["Chart type", async () => {
        await sidebar(page).getByRole("button", { name: /Chart type/ }).click();
        return page.getByRole("menu", { name: "Chart type" });
      }],
      ["Objects tree", async () => {
        await sidebar(page).getByRole("button", { name: "Objects tree" }).click();
        return page.getByRole("menu", { name: "Objects tree" });
      }],
      ["Context menu", () => openContextMenu(page)],
    ];
    for (const [name, open] of menus) {
      const popup = await open();
      await expect(popup.locator("[role^=menuitem]").first()).toBeFocused();
      await settle(page);
      expect(await inset(popup), name).toEqual([4, 4]);
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
    }
  });
});

test.describe("context menu", () => {
  test('"-" renders a separator that the arrow keys skip; "-Label" never renders', async ({ page }) => {
    await openWidget(page);
    const menu = await openContextMenu(page);
    await settle(page);
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
    await expect(menu.getByRole("separator")).toHaveCount(1);
    const divider = await menu.getByRole("separator").evaluate((el) => {
      const style = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, background: style.backgroundColor };
    });
    expect(divider.height).toBe(1);
    expect(divider.background).not.toBe("rgba(0, 0, 0, 0)");
    await expect(menu.getByRole("menuitem", { name: "-Reset chart view" })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as RazeWindow).__warnings.some((line) => line.includes('"-Reset chart view" removes a default item')))).toBe(true);

    await expect(menu.getByRole("menuitem", { name: "Add alert here" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Reset chart" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Add alert here" })).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as RazeWindow).__clicked)).toEqual(["reset"]);
  });

  test("opens above and before the cursor when it lacks room below and after it", async ({ page }) => {
    await openWidget(page);
    const viewport = page.viewportSize()!;
    await page.mouse.click(viewport.width - 20, viewport.height - 20, { button: "right" });
    const menu = page.getByRole("menu", { name: "Chart context menu" });
    await expect(menu).toBeVisible();
    await settle(page);
    const box = (await menu.boundingBox())!;
    expect(Math.round(box.x + box.width)).toBe(viewport.width - 20);
    expect(Math.round(box.y + box.height)).toBe(viewport.height - 20);
  });
});

test.describe("long popups", () => {
  test("a 60-row objects tree scrolls inside the viewport and End reveals the last row", async ({ page }) => {
    await openWidget(page);
    await page.evaluate(async () => {
      const chart = (window as unknown as RazeWindow).__razeChart.activeChart();
      const t0 = Math.floor(Date.UTC(2024, 0, 15, 12, 0, 0) / 1000);
      for (let index = 0; index < 29; index++) {
        await chart.createShape({ time: t0 - index * 600, price: 6000 + index * 10 }, { shape: "horizontal_line" });
      }
    });
    await sidebar(page).getByRole("button", { name: "Objects tree" }).click();
    const menu = page.getByRole("menu", { name: "Objects tree" });
    await expect(menu.locator("[role^=menuitem]").first()).toBeFocused();
    await settle(page);
    const metrics = await menu.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { rows: el.querySelectorAll("[role^=menuitem]").length, top: box.top, bottom: box.bottom, height: box.height, scroll: el.scrollHeight, client: el.clientHeight, vh: innerHeight };
    });
    expect(metrics.rows).toBeGreaterThanOrEqual(60);
    expect(metrics.height).toBeLessThanOrEqual(metrics.vh - 16);
    expect(metrics.top).toBeGreaterThanOrEqual(8);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.vh - 8);
    expect(metrics.scroll).toBeGreaterThan(metrics.client);

    await page.keyboard.press("End");
    const last = menu.locator("[role^=menuitem]").last();
    await expect(last).toBeFocused();
    const visible = await last.evaluate((row) => {
      const box = row.getBoundingClientRect();
      const frame = row.parentElement!.getBoundingClientRect();
      return box.top >= frame.top && box.bottom <= frame.bottom;
    });
    expect(visible).toBe(true);
    await page.keyboard.press("Home");
    await expect(menu.locator("[role^=menuitem]").first()).toBeFocused();
    expect(await menu.evaluate((el) => el.scrollTop)).toBe(0);

    // The wheel scrolls the list and never reaches the chart.
    const range = () => page.evaluate(() => JSON.stringify((window as unknown as RazeWindow).__razeChart.activeChart().getVisibleRange()));
    const before = await range();
    const box = (await menu.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await range()).toBe(before);
    await expect(menu).toBeVisible();
  });
});

test.describe("fullscreen", () => {
  test("every menu opens inside the fullscreen chart and works by mouse and keyboard", async ({ page }) => {
    await openWidget(page);
    await sidebar(page).getByRole("button", { name: "Fullscreen" }).click();
    await page.waitForFunction(() => document.fullscreenElement?.classList.contains("raze-chart-root") === true);
    const insideFullscreen = (popup: Locator): Promise<boolean> =>
      popup.evaluate((el) => !!document.fullscreenElement && document.fullscreenElement.contains(el));

    // Indicators: mouse on a non-focused row, then keyboard.
    await sidebar(page).getByRole("button", { name: "Indicators" }).click();
    const indicators = page.getByRole("menu", { name: "Indicators" });
    await expect(indicators.getByRole("menuitemcheckbox").first()).toBeFocused();
    await settle(page);
    expect(await insideFullscreen(indicators)).toBe(true);
    expect(await hitsItself(indicators.getByRole("menuitemcheckbox").first())).toBe(true);
    await indicators.getByRole("menuitemcheckbox", { name: "RSI 14" }).click();
    await expect(indicators.getByRole("menuitemcheckbox", { name: "RSI 14" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(indicators.getByRole("menuitemcheckbox", { name: "MACD" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(indicators).toHaveCount(0);
    expect((await studyNames(page)).sort()).toEqual(["MACD", "RSI"]);

    // Chart type: keyboard, then mouse.
    const typeButton = sidebar(page).getByRole("button", { name: /Chart type/ });
    await typeButton.click();
    const types = page.getByRole("menu", { name: "Chart type" });
    await expect(types.getByRole("menuitemradio").first()).toBeFocused();
    await settle(page);
    expect(await insideFullscreen(types)).toBe(true);
    expect(await hitsItself(types.getByRole("menuitemradio").first())).toBe(true);
    await page.keyboard.press("ArrowDown");
    const second = (await types.getByRole("menuitemradio").nth(1).getAttribute("aria-label"))!;
    await page.keyboard.press("Enter");
    await expect(types).toHaveCount(0);
    await expect(sidebar(page).getByRole("button", { name: `Chart type: ${second}` })).toBeVisible();
    await sidebar(page).getByRole("button", { name: /Chart type/ }).click();
    await expect(types.getByRole("menuitemradio").first()).toBeFocused();
    const first = (await types.getByRole("menuitemradio").first().getAttribute("aria-label"))!;
    await types.getByRole("menuitemradio").first().click();
    await expect(sidebar(page).getByRole("button", { name: `Chart type: ${first}` })).toBeVisible();

    // Objects tree.
    await sidebar(page).getByRole("button", { name: "Objects tree" }).click();
    const tree = page.getByRole("menu", { name: "Objects tree" });
    await expect(tree.locator("[role^=menuitem]").first()).toBeFocused();
    await settle(page);
    expect(await insideFullscreen(tree)).toBe(true);
    expect(await hitsItself(tree.locator("[role^=menuitem]").first())).toBe(true);
    await tree.getByRole("menuitemcheckbox", { name: "Stay in drawing mode" }).click();
    await expect(tree.getByRole("menuitemcheckbox", { name: "Stay in drawing mode" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(tree.getByRole("menuitemcheckbox", { name: "Magnet OHLC" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(tree).toHaveCount(0);

    // Context menu: mouse, then keyboard.
    let context = await openContextMenu(page);
    await settle(page);
    expect(await insideFullscreen(context)).toBe(true);
    expect(await hitsItself(context.getByRole("menuitem").first())).toBe(true);
    await context.getByRole("menuitem", { name: "Reset chart" }).click();
    await expect(context).toHaveCount(0);
    context = await openContextMenu(page);
    await page.keyboard.press("Enter");
    await expect(context).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as RazeWindow).__clicked)).toEqual(["reset", "alert"]);

    // A menu open while leaving fullscreen follows the chart back out.
    await sidebar(page).getByRole("button", { name: "Indicators" }).click();
    await expect(indicators.getByRole("menuitemcheckbox").first()).toBeFocused();
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement);
    await expect(indicators).toBeVisible();
    // (fullscreenchange fires on the next frame after fullscreenElement clears)
    await expect.poll(() => indicators.evaluate((el) => el.closest("[data-raze-portal]")?.parentElement === document.body)).toBe(true);
    await settle(page);
    expect(await hitsItself(indicators.getByRole("menuitemcheckbox").first())).toBe(true);
  });

  for (const [mount, query] of [["light DOM", ""], ["shadow root", "?shadow"]] as const) {
    test(`a menu open when the chart enters fullscreen moves into it and keeps focus (${mount})`, async ({ page }) => {
      await openWidget(page, query);
      await sidebar(page).getByRole("button", { name: "Indicators" }).click();
      const menu = page.getByRole("menu", { name: "Indicators" });
      const rows = menu.getByRole("menuitemcheckbox");
      await expect(rows.first()).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(rows.nth(1)).toBeFocused();
      // Host-driven fullscreen (a host button, a shortcut) while the menu is
      // open. Regression: Chromium blurs the focused row, which sat outside
      // the new fullscreen element, a frame before fullscreenchange, and the
      // menu closed.
      await page.evaluate(async () => {
        const shadow = document.getElementById("host")!.shadowRoot;
        await (shadow ?? document).querySelector<HTMLElement>(".raze-chart-root")!.requestFullscreen();
      });
      await page.waitForFunction(() => !!document.fullscreenElement);
      await expect.poll(() => menu.evaluate((el) => {
        const fullscreen = (el.getRootNode() as Document | ShadowRoot).fullscreenElement;
        return !!fullscreen && fullscreen.classList.contains("raze-chart-root") && fullscreen.contains(el);
      })).toBe(true);
      await expect(menu).toBeVisible();
      await expect(rows.nth(1)).toBeFocused();
      await settle(page);
      expect(await hitsItself(rows.first())).toBe(true);
      await menu.getByRole("menuitemcheckbox", { name: "MACD" }).click();
      await expect(menu.getByRole("menuitemcheckbox", { name: "MACD" })).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(menu.getByRole("menuitemcheckbox", { name: "Bollinger 20" })).toHaveAttribute("aria-checked", "true");
      await expect(menu).toBeVisible();
      expect((await studyNames(page)).sort()).toEqual(["Bollinger Bands", "MACD"]);
    });
  }

  test("another element going fullscreen closes the chart's menu", async ({ page }) => {
    await openWidget(page);
    await sidebar(page).getByRole("button", { name: "Indicators" }).click();
    const menu = page.getByRole("menu", { name: "Indicators" });
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
    await page.evaluate(async () => {
      const other = document.createElement("div");
      other.id = "other";
      other.textContent = "Video";
      document.body.appendChild(other);
      await other.requestFullscreen();
    });
    await page.waitForFunction(() => document.fullscreenElement?.id === "other");
    await expect(menu).toHaveCount(0);
    await expect(page.locator("#other [role=menu]")).toHaveCount(0);
  });
});

test.describe("shadow root", () => {
  test("chrome styles apply inside the shadow root and menus open there", async ({ page }) => {
    await openWidget(page, "?shadow");
    const inShadow = await page.evaluate(() => {
      const shadow = document.getElementById("host")!.shadowRoot!;
      const bar = shadow.querySelector(".raze-chart-left-sidebar")!;
      return { rootInShadow: !!shadow.querySelector(".raze-chart-root"), scrollbar: getComputedStyle(bar).scrollbarWidth };
    });
    // The base rule `.raze-chart-left-sidebar{scrollbar-width:none}` reaches the shadow tree.
    expect(inShadow).toEqual({ rootInShadow: true, scrollbar: "none" });

    await sidebar(page).getByRole("button", { name: "Indicators" }).click();
    const menu = page.getByRole("menu", { name: "Indicators" });
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
    expect(await menu.evaluate((el) => el.getRootNode() === document.getElementById("host")!.shadowRoot)).toBe(true);
    const styled = await menu.evaluate((el) => ({ position: getComputedStyle(el).position, overflowY: getComputedStyle(el).overflowY }));
    expect(styled).toEqual({ position: "fixed", overflowY: "auto" });
    await menu.getByRole("menuitemcheckbox", { name: "Bollinger 20" }).click();
    await menu.getByRole("menuitemcheckbox", { name: "RSI 14" }).click();
    expect((await studyNames(page)).sort()).toEqual(["Bollinger Bands", "RSI"]);
    // Focus moving to another control of the same shadow tree closes it
    // (that focusin never reaches the document).
    await sidebar(page).getByRole("button", { name: "Objects tree" }).focus();
    await expect(menu).toHaveCount(0);
    await expect(sidebar(page).getByRole("button", { name: "Objects tree" })).toBeFocused();

    const context = await openContextMenu(page);
    expect(await context.evaluate((el) => el.getRootNode() === document.getElementById("host")!.shadowRoot)).toBe(true);
    await context.getByRole("menuitem", { name: "Add alert here" }).click();
    expect(await page.evaluate(() => (window as unknown as RazeWindow).__clicked)).toEqual(["alert"]);
  });

  test("raze.style_nonce lets fallback <style> elements through a strict CSP", async ({ page }) => {
    // Force the <style> fallback used by browsers without constructable
    // stylesheets, and record CSP violations.
    await page.addInitScript(() => {
      const w = window as unknown as RazeWindow;
      w.__violations = [];
      document.addEventListener("securitypolicyviolation", (event) => w.__violations.push(`${event.violatedDirective}: ${event.sample || event.blockedURI}`));
      delete (CSSStyleSheet.prototype as unknown as { replaceSync?: unknown }).replaceSync;
    });
    await openWidget(page, `?shadow&nonce=${NONCE}`, {
      "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${NONCE}'; style-src 'self' 'nonce-${NONCE}'`,
    });
    const styles = await page.evaluate(() => {
      const shadow = document.getElementById("host")!.shadowRoot!;
      const nonces = (root: Document | ShadowRoot) => [...root.querySelectorAll<HTMLStyleElement>("style[data-raze-styles]")].map((style) => style.nonce);
      return { document: nonces(document), shadow: nonces(shadow), adopted: shadow.adoptedStyleSheets.length };
    });
    expect(styles.adopted).toBe(0);
    expect(styles.shadow.length).toBeGreaterThan(0);
    expect(new Set([...styles.shadow, ...styles.document])).toEqual(new Set([NONCE]));

    await sidebar(page).getByRole("button", { name: "Indicators" }).click();
    const menu = page.getByRole("menu", { name: "Indicators" });
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
    expect(await menu.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
    await menu.getByRole("menuitemcheckbox", { name: "MACD" }).click();
    expect(await studyNames(page)).toEqual(["MACD"]);
    expect(await page.evaluate(() => (window as unknown as RazeWindow).__violations)).toEqual([]);
  });
});

// ── Kit harness ────────────────────────────────────────────────────────────
// openPopup() and openDialog() bundled from source, with anchors pinned to
// the viewport edges so placement, flipping and following can be measured.
let bundle = "";
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: [
        'export * from "./src/ui/kit/index.ts";',
        'export { openPopup, popupRow, popupSeparator } from "./src/ui/popup.ts";',
      ].join("\n"),
      resolveDir: process.cwd(),
      sourcefile: "popups-harness.ts",
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    globalName: "RazeKit",
    target: "es2020",
    write: false,
    logLevel: "silent",
  });
  bundle = result.outputFiles[0]!.text;
});

const KIT_HARNESS = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Popup kit</title></head>
<body style="margin:0;height:100vh">
  <div class="raze-chart-root" id="chart" style="position:fixed;inset:0">
    <button id="bottom-anchor" type="button" style="position:fixed;right:40px;bottom:12px;width:160px;height:28px">Symbol</button>
    <button id="side-anchor" type="button" style="position:fixed;right:4px;top:30%;width:32px;height:32px">Tools</button>
  </div>
  <script src="/__popup-kit/kit.js"></script>
</body>
</html>`;

async function openKit(page: Page): Promise<void> {
  await page.route("**/__popup-kit/kit.js", (route) => route.fulfill({ body: bundle, contentType: "text/javascript" }));
  await page.route("**/__popup-kit/index.html", (route) => route.fulfill({ body: KIT_HARNESS, contentType: "text/html" }));
  await page.goto("/__popup-kit/index.html");
  await page.waitForFunction(() => !!(window as any).RazeKit);
}

/** Open a 5-row menu on `anchorId` and return nothing; the handle is window.__popup. */
async function openKitMenu(page: Page, anchorId: string, place: "right-start" | "below-start"): Promise<void> {
  await page.evaluate(([id, where]) => {
    const kit = (window as any).RazeKit;
    const anchor = document.getElementById(id!)!;
    const popup = kit.openPopup({ anchor, fontFamily: "sans-serif", label: "Kit menu", place: where, presentation: "anchored", minWidth: 180 });
    for (const label of ["One", "Two", "Three", "Four", "Five"]) popup.el.appendChild(kit.popupRow(label, () => {}));
    popup.reposition();
    (window as any).__popup = popup;
  }, [anchorId, place]);
}

const rects = (page: Page, anchorId: string) => page.evaluate((id) => {
  const anchor = document.getElementById(id)!.getBoundingClientRect();
  const popup = (window as any).__popup.el.getBoundingClientRect();
  return { anchor: { left: anchor.left, top: anchor.top, right: anchor.right, bottom: anchor.bottom }, popup: { left: popup.left, top: popup.top, right: popup.right, bottom: popup.bottom } };
}, anchorId);

test.describe("placement and motion", () => {
  test("below-start flips above an anchor near the bottom instead of covering it", async ({ page }) => {
    await openKit(page);
    await openKitMenu(page, "bottom-anchor", "below-start");
    await settle(page);
    const { anchor, popup } = await rects(page, "bottom-anchor");
    expect(Math.round(popup.bottom)).toBe(Math.round(anchor.top - 4));
    expect(Math.round(popup.left)).toBe(Math.round(anchor.left));
    expect(await page.evaluate(() => (window as any).__popup.el.dataset.side)).toBe("top");
  });

  test("right-start flips to the left of an anchor at the right edge", async ({ page }) => {
    await openKit(page);
    await openKitMenu(page, "side-anchor", "right-start");
    await settle(page);
    const { anchor, popup } = await rects(page, "side-anchor");
    expect(Math.round(popup.right)).toBe(Math.round(anchor.left - 6));
    expect(Math.round(popup.top)).toBe(Math.round(anchor.top));
  });

  test("an open popup stays attached to its anchor while the viewport resizes", async ({ page }) => {
    await openKit(page);
    await openKitMenu(page, "bottom-anchor", "below-start");
    await settle(page);
    for (const size of [{ width: 900, height: 500 }, { width: 700, height: 640 }]) {
      await page.setViewportSize(size);
      await expect.poll(async () => {
        const { anchor, popup } = await rects(page, "bottom-anchor");
        return [Math.round(popup.left - anchor.left), Math.round(anchor.top - popup.bottom)];
      }).toEqual([0, 4]);
    }
  });

  test("popups fade and scale in, and not at all under reduced motion", async ({ page }) => {
    await openKit(page);
    await openKitMenu(page, "side-anchor", "right-start");
    const motion = () => page.evaluate(() => {
      const style = getComputedStyle((window as any).__popup.el);
      return { name: style.animationName, duration: style.animationDuration, transition: style.transitionDuration };
    });
    expect(await motion()).toEqual({ name: "raze-chart-popup-in", duration: "0.12s", transition: "0s" });
    await page.evaluate(() => (window as any).__popup.close());
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openKitMenu(page, "side-anchor", "right-start");
    expect(await motion()).toEqual({ name: "none", duration: "0s", transition: "0s" });
  });

  test("separators from popupSeparator() are skipped by the arrow keys", async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => {
      const kit = (window as any).RazeKit;
      const popup = kit.openPopup({ anchor: document.getElementById("side-anchor"), fontFamily: "sans-serif", label: "Kit menu", presentation: "anchored" });
      popup.el.append(kit.popupRow("A", () => {}), kit.popupSeparator(), kit.popupRow("B", () => {}));
    });
    const menu = page.getByRole("menu", { name: "Kit menu" });
    await expect(menu.getByRole("menuitem", { name: "A" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "B" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "A" })).toBeFocused();
  });
});

test.describe("menu keyboard model", () => {
  test("disabled rows are reached by the arrow keys but never run, and ignore the pointer", async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => {
      const kit = (window as any).RazeKit;
      (window as any).__ran = [];
      const popup = kit.openPopup({ anchor: document.getElementById("side-anchor"), fontFamily: "sans-serif", label: "Kit menu", presentation: "anchored" });
      for (const label of ["Off", "A", "B", "C"]) {
        const row = kit.popupRow(label, () => (window as any).__ran.push(label));
        if (label === "Off" || label === "B") row.setAttribute("aria-disabled", "true");
        popup.el.appendChild(row);
      }
    });
    const menu = page.getByRole("menu", { name: "Kit menu" });
    const row = (name: string) => menu.getByRole("menuitem", { name, exact: true });
    // The menu opens on its first enabled row.
    await expect(row("A")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(row("B")).toBeFocused();
    await expect(row("B")).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Enter");
    await page.keyboard.press(" ");
    await expect(menu).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(row("C")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(row("Off")).toBeFocused();

    // The pointer never moves focus onto a disabled row, and pressing one
    // leaves focus where it was.
    await row("C").hover();
    await expect(row("C")).toBeFocused();
    await row("B").hover();
    await expect(row("C")).toBeFocused();
    await row("B").click({ force: true }); // Playwright waits for aria-disabled rows to enable
    await expect(row("C")).toBeFocused();
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => (window as any).__ran)).toEqual([]);
    await row("C").click();
    expect(await page.evaluate(() => (window as any).__ran)).toEqual(["C"]);
  });

  test("Tab from a field inside a menu moves within it; Tab from a row leaves", async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => {
      const kit = (window as any).RazeKit;
      const popup = kit.openPopup({ anchor: document.getElementById("side-anchor"), fontFamily: "sans-serif", label: "Kit menu", presentation: "anchored" });
      const field = document.createElement("input");
      field.setAttribute("aria-label", "Filter");
      popup.el.append(field, kit.popupRow("Apply", () => {}));
    });
    const menu = page.getByRole("menu", { name: "Kit menu" });
    await expect(menu.getByRole("menuitem", { name: "Apply" })).toBeFocused();
    await menu.getByRole("textbox", { name: "Filter" }).focus();
    await page.keyboard.press("Tab");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Apply" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);
  });
});

test.describe("kit dialog", () => {
  test("an auto dialog becomes a sheet and back as the viewport crosses 520px, keeping focus and input", async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => {
      const kit = (window as any).RazeKit;
      const field = kit.textField({ label: "Name", value: "" });
      (window as any).__dialog = kit.openDialog({ title: "Rename", content: field.el, anchor: document.getElementById("side-anchor") });
    });
    const dialog = page.getByRole("dialog", { name: "Rename" });
    const field = dialog.getByRole("textbox", { name: "Name" });
    await expect(field).toBeFocused();
    await field.fill("Alpha");
    const presentation = () => page.evaluate(() => (window as any).__dialog.presentation);
    expect(await presentation()).toBe("dialog");

    await page.setViewportSize({ width: 480, height: 700 });
    await expect.poll(presentation).toBe("sheet");
    await expect(dialog).toHaveAttribute("data-presentation", "sheet");
    expect(await dialog.evaluate((el) => !!el.closest(".raze-kit-sheet"))).toBe(true);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Alpha");
    await expect(page.locator(".raze-kit-backdrop")).toHaveCount(1);

    await page.setViewportSize({ width: 1100, height: 620 });
    await expect.poll(presentation).toBe("dialog");
    await expect(dialog).toHaveAttribute("data-presentation", "dialog");
    expect(await dialog.evaluate((el) => !!el.closest(".raze-kit-sheet"))).toBe(false);
    await expect(field).toBeFocused();
    await expect(page.locator(".raze-kit-backdrop")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
});
