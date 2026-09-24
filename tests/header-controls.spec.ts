import { expect, test, type Page } from "@playwright/test";

// Real-browser acceptance for the header controls (W1B-22): favourite
// intervals and the overflow menu, pressed state that follows the scale seam
// after axis drags and double-clicks, the ScaleBar kept out of the plot and
// the price labels (and its single 24px touch target and menu), class-based
// styling that page-wide resets cannot reach but host classes and tokens can
// override, reduced-motion header scrolling and per-root keyframes.

const HARNESS = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Header controls</title>
<style>html,body{margin:0;height:100%;background:#111}#wrap{position:absolute;inset:0}</style></head>
<body>
  <div id="wrap"></div>
  <script type="module">
    import { widget, LoadingScreen } from "/dist/charting_library.esm.js";
    import { makeMockDatafeed, VISUAL_NOW } from "/examples/mock-datafeed.mjs";
    window.LoadingScreen = LoadingScreen;
    window.mountChart = (extra = {}) => new Promise((resolve) => {
      const w = new widget({
        symbol: "MOCK",
        datafeed: makeMockDatafeed({ bars: 400, startPrice: 6400, now: VISUAL_NOW, live: false }),
        interval: "1",
        container: document.getElementById("wrap"),
        library_path: "/",
        locale: "en",
        theme: "dark",
        autosize: true,
        timezone: "Etc/UTC",
        custom_font_family: "Arial, Helvetica, sans-serif",
        disabled_features: ["popup_hints", "countdown"],
        raze: { compact_breakpoint: 0 },
        ...extra,
      });
      window.__w = w;
      w.onChartReady(() => resolve(true));
    });
    window.__harness = true;
  </script>
</body>
</html>`;

async function openHarness(page: Page, options: Record<string, unknown> = {}): Promise<void> {
  await page.route("**/__header/index.html", (route) => route.fulfill({ body: HARNESS, contentType: "text/html" }));
  await page.goto("/__header/index.html");
  await page.waitForFunction(() => (window as unknown as { __harness?: boolean }).__harness === true);
  await page.evaluate((extra) => (window as unknown as { mountChart: (o: unknown) => Promise<boolean> }).mountChart(extra), options);
}

interface Box { left: number; top: number; right: number; bottom: number }
const intersects = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test.describe("header controls", () => {
  test("favorite intervals are the header buttons; the rest live in the menu", async ({ page }) => {
    await openHarness(page, { favorites: { intervals: ["1", "5", "15"] } });
    const group = page.getByRole("group", { name: "Chart interval" });
    const intervals = group.getByRole("button", { name: /^Interval / });
    await expect(intervals).toHaveText(["1m", "5m", "15m"]);
    await expect(group.getByRole("button", { name: "Interval 1m" })).toHaveAttribute("aria-pressed", "true");

    const more = group.getByRole("button", { name: "More intervals" });
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByRole("menu", { name: "Intervals" });
    await expect(menu.getByRole("menuitemradio")).toHaveText(["1s", "5s", "1m", "5m", "15m", "1h", "1D"]);
    await expect(menu.getByRole("menuitemradio", { name: "Interval 1m" })).toBeFocused();
    await menu.getByRole("menuitemradio", { name: "Interval 1h" }).click();
    await expect(menu).toHaveCount(0);
    await expect(group.getByRole("button", { name: "Interval 1h" })).toHaveAttribute("aria-pressed", "true");
    await expect(group.getByRole("button", { name: "Interval 1m" })).toHaveAttribute("aria-pressed", "false");
    await expect(intervals).toHaveText(["1m", "5m", "15m", "1h"]);

    // Keyboard: ArrowDown on the overflow button opens the menu on the current interval.
    await more.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: "Interval 1h" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
  });

  test("scale toggles report the real scale after drags, resets and clicks", async ({ page }) => {
    await openHarness(page);
    const scale = page.getByRole("toolbar", { name: "Price scale" });
    const percent = scale.getByRole("button", { name: "Percent scale" });
    const log = scale.getByRole("button", { name: "Logarithmic scale" });
    const auto = scale.getByRole("button", { name: /^Auto-scale/ });
    await expect(auto).toHaveAttribute("aria-pressed", "true");

    const box = (await page.locator("canvas.raze-chart-canvas").first().boundingBox())!;
    const axisX = box.x + box.width - 24;
    const axisY = box.y + box.height * 0.4;
    await page.mouse.move(axisX, axisY);
    await page.mouse.down();
    await page.mouse.move(axisX, axisY + 60, { steps: 4 });
    await page.mouse.up();
    await expect(auto).toHaveAttribute("aria-pressed", "false");

    await page.mouse.dblclick(axisX, axisY);
    await expect(auto).toHaveAttribute("aria-pressed", "true");

    await log.click();
    await expect(log).toHaveAttribute("aria-pressed", "true");
    await percent.click();
    await expect(percent).toHaveAttribute("aria-pressed", "true");
    await expect(log).toHaveAttribute("aria-pressed", "false");
    await percent.click();
    await expect(percent).toHaveAttribute("aria-pressed", "false");

    // Keyboard: arrow navigation inside the toolbar, Enter toggles.
    await percent.focus();
    await page.keyboard.press("ArrowRight");
    await expect(log).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(log).toHaveAttribute("aria-pressed", "true");
  });

  test("load() restores the pressed scale state", async ({ page }) => {
    // load() writes the scale through setScaleMode("load") once W1B-13's
    // routing lands; before that the legacy direct write fires no event.
    test.fixme(true, "enable on the merged wave-1B tree (W1B-13 routes load() through setScaleMode)");
    await openHarness(page);
    const saved = await page.evaluate(() => new Promise((resolve) => {
      (window as unknown as { __w: { save(cb: (s: unknown) => void): void } }).__w.save(resolve);
    }));
    await page.evaluate((state) => {
      const snapshot = { ...(state as Record<string, unknown>), logScale: true, percentScale: false };
      return (window as unknown as { __w: { load(s: unknown): Promise<void> } }).__w.load(snapshot);
    }, saved);
    const scale = page.getByRole("toolbar", { name: "Price scale" });
    await expect(scale.getByRole("button", { name: "Logarithmic scale" })).toHaveAttribute("aria-pressed", "true");
  });

  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    test(`the scale bar stays out of the plot and the price labels at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openHarness(page, { favorites: { intervals: ["1", "5", "15"] } });
      const geometry = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>("canvas.raze-chart-canvas")!.getBoundingClientRect();
        const bar = document.querySelector<HTMLElement>(".raze-chart-scale-bar")!;
        const buttons = [...bar.querySelectorAll("button")].map((button) => {
          const r = button.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        });
        return {
          canvas: { left: canvas.left, top: canvas.top, right: canvas.right, bottom: canvas.bottom },
          buttons,
          background: getComputedStyle(bar).backgroundColor,
          touchTarget: getComputedStyle(bar.querySelector(".raze-chart-scale-hit")!).display,
        };
      });
      const { canvas } = geometry;
      // The largest the plot can be: the narrowest price axis (56px) and the
      // 22px time axis. Price labels sit in the axis column and are painted no
      // lower than 2px above the plot bottom (11px text, centred).
      const plot = { left: canvas.left, top: canvas.top, right: canvas.right - 56, bottom: canvas.bottom - 22 };
      const priceLabels = { left: canvas.right - 128, top: canvas.top, right: canvas.right, bottom: plot.bottom + 3.5 };
      expect(geometry.buttons).toHaveLength(3);
      for (const button of geometry.buttons) {
        expect(intersects(button, plot)).toBe(false);
        expect(intersects(button, priceLabels)).toBe(false);
        expect(button.right).toBeLessThanOrEqual(canvas.right);
        expect(button.bottom).toBeLessThanOrEqual(canvas.bottom);
      }
      expect(geometry.background).toMatch(/^rgb\(/); // opaque axis background
      expect(geometry.touchTarget).toBe("none"); // a mouse gets the three direct toggles
      await expect(page.getByRole("button", { name: /^Auto-scale/ })).toHaveAttribute("aria-pressed", "true");
    });
  }

  test("createButton stays unstyled after the host replaces cssText", async ({ page }) => {
    await openHarness(page);
    const styles = await page.evaluate(() => {
      const w = (window as unknown as { __w: { createButton(o?: unknown): HTMLElement } }).__w;
      const read = (el: HTMLElement) => {
        const style = getComputedStyle(el);
        return { tag: el.tagName, background: style.backgroundColor, border: style.borderTopWidth, appearance: style.appearance, color: style.color };
      };
      const styled = w.createButton({ title: "Styled" });
      styled.style.cssText = "color:red";
      const plain = w.createButton({ useTradingViewStyle: false });
      plain.style.cssText = "cursor:pointer;padding:0 8px;color:#f4eee1;";
      plain.textContent = "MarketCap/Price";
      return { styled: read(styled), plain: read(plain) };
    });
    for (const style of [styles.styled, styles.plain]) {
      expect(style.tag).toBe("BUTTON");
      expect(style.background).toBe("rgba(0, 0, 0, 0)");
      expect(style.border).toBe("0px");
      expect(style.appearance).toBe("none");
    }
    expect(styles.styled.color).toBe("rgb(255, 0, 0)");
  });

  test("page-wide button resets leave library controls alone; host classes still override", async ({ page }) => {
    await openHarness(page, { favorites: { intervals: ["1", "5", "15"] } });
    // Bootstrap-reboot / Tailwind-preflight style element rules, added after mount.
    await page.addStyleTag({
      content: "button{padding:0;border:1px solid red;background:#eee;border-radius:0;box-shadow:0 0 0 2px red;text-transform:uppercase}" +
        "input{padding:0;border-radius:0;background:#eee}",
    });
    const read = (locator: ReturnType<Page["locator"]>) => locator.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        padding: `${style.paddingLeft}/${style.paddingRight}`,
        radius: style.borderTopLeftRadius,
        border: style.borderTopWidth,
        background: style.backgroundColor,
        shadow: style.boxShadow,
        transform: style.textTransform,
      };
    });
    const idle = { radius: "4px", border: "0px", background: "rgba(0, 0, 0, 0)", shadow: "none", transform: "none" };
    expect(await read(page.getByRole("button", { name: "Interval 5m" }))).toEqual({ ...idle, padding: "7px/7px" });
    expect(await read(page.getByRole("button", { name: "Range 1D" }))).toEqual({ ...idle, padding: "7px/7px" });
    expect(await read(page.getByRole("button", { name: "Percent scale" }))).toEqual({ ...idle, padding: "3px/3px" });
    const search = await read(page.getByRole("combobox", { name: "Search symbols" }));
    expect({ padding: search.padding, radius: search.radius, background: search.background }).toEqual({ padding: "8px/8px", radius: "4px", background: "rgba(0, 0, 0, 0)" });

    // createButton's reset beats element selectors; a host class on the host's
    // own button wins, and one more class restyles a library control.
    const custom = await page.evaluate(() => {
      const w = (window as unknown as { __w: { createButton(o?: unknown): HTMLElement } }).__w;
      const plain = w.createButton({ useTradingViewStyle: false });
      plain.textContent = "Plain";
      const classed = w.createButton({ useTradingViewStyle: false });
      classed.className += " host-btn";
      classed.textContent = "Classed";
      const style = document.createElement("style");
      style.textContent = ".host-btn{background:rgb(1, 2, 3);padding:0 9px}.raze-chart-root .raze-chart-header-btn{padding:0 11px}";
      document.head.appendChild(style);
      const read = (el: Element) => ({ background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopWidth, padding: getComputedStyle(el).paddingLeft });
      return { plain: read(plain), classed: read(classed), interval: read(document.querySelector('[aria-label="Interval 5m"]')!) };
    });
    expect(custom.plain).toEqual({ background: "rgba(0, 0, 0, 0)", border: "0px", padding: "0px" });
    expect(custom.classed).toEqual({ background: "rgb(1, 2, 3)", border: "0px", padding: "9px" });
    expect(custom.interval.padding).toBe("11px");
  });

  test("hover, pressed and tokens come from CSS a host can override", async ({ page }) => {
    await openHarness(page, { favorites: { intervals: ["1", "5", "15"] } });
    const pressed = page.getByRole("button", { name: "Interval 1m" });
    const idle = page.getByRole("button", { name: "Interval 5m" });
    const idleBackground = await idle.evaluate((el) => getComputedStyle(el).backgroundColor);
    await idle.hover();
    await expect.poll(() => idle.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(idleBackground);

    const bar = page.getByRole("toolbar", { name: "Price scale" });
    const axisBackground = await bar.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(axisBackground).toBe("rgb(19, 23, 34)"); // the theme's price-axis colour
    await page.addStyleTag({ content: ".raze-chart-root{--raze-accent:red;--raze-scale-bar-background:rgb(1, 2, 3)}" });
    await expect.poll(() => pressed.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 0, 0)");
    // The library never sets the public scale-bar tokens, so the host's win.
    await expect.poll(() => bar.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(1, 2, 3)");
    const auto = page.getByRole("button", { name: /^Auto-scale/ });
    await expect.poll(() => auto.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 0, 0)");
    await page.getByRole("button", { name: "Range 1D" }).click();
    await expect.poll(() => page.getByRole("button", { name: "Range 1D" }).evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 0, 0)");

    // One size for every header control.
    const sizes = await page.locator(".raze-chart-toolbar .raze-chart-header-btn").evaluateAll((buttons) =>
      [...new Set(buttons.map((button) => `${getComputedStyle(button).fontSize}/${button.getBoundingClientRect().height}`))]);
    expect(sizes).toEqual(["12px/26"]);
  });

  test("touch pointers get larger header controls from a media query", async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await openHarness(page);
    const heights = await page.locator(".raze-chart-toolbar .raze-chart-header-btn").evaluateAll((buttons) =>
      [...new Set(buttons.map((button) => button.getBoundingClientRect().height))]);
    expect(heights).toEqual([32]);
    await context.close();
  });

  test("on touch the scale toggles are one 24px target that opens a menu", async ({ browser }) => {
    // The corner cell is 22px tall and its top 4px belong to the lowest price
    // label, so no toggle can be 24px tall there. Under pointer:coarse the
    // whole bar is one target: at least 24x24, reaching up into the label
    // clearance but never into the plot.
    const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await openHarness(page, { favorites: { intervals: ["1", "5", "15"] } });
    const geometry = await page.evaluate(() => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const canvas = box(document.querySelector("canvas.raze-chart-canvas")!);
      const hit = document.querySelector(".raze-chart-scale-hit")!;
      const toggles = [...document.querySelectorAll<HTMLElement>(".raze-chart-scale-btn")];
      // The target really receives taps: over every toggle, and at each corner
      // of its box (nothing else sits on top of it).
      const h = box(hit);
      const points = [
        ...toggles.map((toggle) => {
          const r = toggle.getBoundingClientRect();
          return [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
        }),
        [h.left + 1, h.top + 1], [h.right - 1, h.top + 1], [h.left + 1, h.bottom - 1], [h.right - 1, h.bottom - 1],
      ];
      const lands = points.map(([x, y]) => document.elementFromPoint(x!, y!) === hit);
      return { canvas, hit: h, hidden: hit.getAttribute("aria-hidden"), tabbable: hit.matches("button,[tabindex]"), toggles: toggles.map(box), lands };
    });
    const { canvas, hit } = geometry;
    expect(hit.right - hit.left).toBeGreaterThanOrEqual(24);
    expect(hit.bottom - hit.top).toBeGreaterThanOrEqual(24);
    expect(geometry.lands).toEqual(Array(7).fill(true));
    const plot = { left: canvas.left, top: canvas.top, right: canvas.right - 56, bottom: canvas.bottom - 22 };
    expect(intersects(hit, plot)).toBe(false);
    // The visible toggles still clear the plot and the price labels.
    const priceLabels = { left: canvas.right - 128, top: canvas.top, right: canvas.right, bottom: plot.bottom + 3.5 };
    for (const toggle of geometry.toggles) {
      expect(intersects(toggle, plot)).toBe(false);
      expect(intersects(toggle, priceLabels)).toBe(false);
    }
    // Pointer-only: keyboard and screen readers use the toggles themselves.
    expect(geometry).toMatchObject({ hidden: "true", tabbable: false });

    await page.locator(".raze-chart-scale-hit").tap();
    const menu = page.getByRole("menu", { name: "Price scale" });
    const rows = menu.getByRole("menuitemcheckbox");
    await expect(rows).toHaveText(["Percent scale", "Logarithmic scale", "Auto-scale price"]);
    await expect(rows.nth(2)).toHaveAttribute("aria-checked", "true");
    const rowHeights = await rows.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    for (const height of rowHeights) expect(height).toBeGreaterThanOrEqual(44);
    await menu.getByRole("menuitemcheckbox", { name: "Logarithmic scale" }).tap();
    await expect(menu).toHaveCount(0);
    const scale = page.getByRole("toolbar", { name: "Price scale" });
    await expect(scale.getByRole("button", { name: "Logarithmic scale" })).toHaveAttribute("aria-pressed", "true");
    await page.locator(".raze-chart-scale-hit").tap();
    await expect(page.getByRole("menuitemcheckbox", { name: "Logarithmic scale" })).toHaveAttribute("aria-checked", "true");
    await context.close();
  });

  test("with reduced motion, focusing an offscreen header control scrolls instantly", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openHarness(page);
    const scroll = await page.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>(".raze-chart-toolbar")!;
      const last = [...toolbar.querySelectorAll<HTMLElement>("button")].at(-1)!;
      const before = toolbar.scrollLeft;
      last.focus();
      return { before, after: toolbar.scrollLeft, overflow: toolbar.scrollWidth > toolbar.clientWidth };
    });
    expect(scroll.overflow).toBe(true);
    expect(scroll.before).toBe(0);
    expect(scroll.after).toBeGreaterThan(0);
  });

  test("the loading spinner keeps its keyframes in every shadow root and after a remount", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(() => {
      const LoadingScreen = (window as unknown as { LoadingScreen: new (o: unknown, bg: string) => { el: HTMLElement; showEmpty(): void; destroy(): void } }).LoadingScreen;
      const hasSpin = (root: ShadowRoot) => root.adoptedStyleSheets.some((sheet) =>
        [...sheet.cssRules].some((rule) => rule instanceof CSSKeyframesRule && rule.name === "raze-chart-spin"));
      const make = () => {
        const host = document.createElement("div");
        const shadow = host.attachShadow({ mode: "open" });
        return { host, shadow };
      };
      // First root: the host is attached after the screen is built and mounted.
      const a = make();
      const screenA = new LoadingScreen(undefined, "#000");
      a.shadow.appendChild(screenA.el);
      document.body.appendChild(a.host);
      // Second root, mounted the usual way.
      const b = make();
      document.body.appendChild(b.host);
      const screenB = new LoadingScreen(undefined, "#000");
      b.shadow.appendChild(screenB.el);
      return new Promise<Record<string, boolean>>((resolve) => {
        queueMicrotask(() => {
          const first = hasSpin(a.shadow);
          const second = hasSpin(b.shadow);
          // A component framework replaces the root's sheets, then the widget
          // re-mounts the screen to show a message.
          b.shadow.adoptedStyleSheets = [];
          screenB.el.remove();
          b.shadow.appendChild(screenB.el);
          screenB.showEmpty();
          resolve({ first, second, afterRemount: hasSpin(b.shadow) });
          screenA.destroy();
          screenB.destroy();
        });
      });
    });
    expect(result).toEqual({ first: true, second: true, afterRemount: true });
  });
});
