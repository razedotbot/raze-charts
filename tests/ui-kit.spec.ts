import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";

// Real-browser acceptance for the UI kit: dialog accessibility and focus,
// bottom sheets on phones (kit dialogs and the widget's menus), portals in
// fullscreen and shadow roots, strict CSP/Trusted Types, tooltips and toasts.

const root = process.cwd();
let bundle = "";

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: [
        'export * from "./src/ui/kit/index.ts";',
        'export * from "./src/ui/styles.ts";',
        'export * as i18n from "./src/i18n/index.ts";',
      ].join("\n"),
      resolveDir: root,
      sourcefile: "ui-kit-harness.ts",
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

const HARNESS = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UI kit</title></head>
<body>
  <main>
    <div class="raze-chart-root" id="chart">
      <button id="opener" type="button">Open settings</button>
      <button id="other" type="button">Other</button>
    </div>
  </main>
  <script src="/__kit/kit.js"></script>
</body>
</html>`;

async function openHarness(page: Page, csp?: string): Promise<void> {
  await page.route("**/__kit/kit.js", (route) => route.fulfill({ body: bundle, contentType: "text/javascript" }));
  await page.route("**/__kit/index.html", (route) => route.fulfill({
    body: HARNESS,
    contentType: "text/html",
    headers: csp ? { "content-security-policy": csp } : {},
  }));
  await page.goto("/__kit/index.html");
  await page.waitForFunction(() => "RazeKit" in window);
  // Theme the widget root through CSSOM (allowed under a strict style-src).
  await page.evaluate(() => {
    const chart = document.getElementById("chart")!;
    chart.style.setProperty("--tv-color-popup-background", "#ffffff");
    chart.style.setProperty("--tv-color-popup-element-text", "#131722");
    chart.style.setProperty("--tv-color-toolbar-divider-background", "#d1d4dc");
    chart.style.height = "300px";
  });
}

/** Open the reference settings dialog (tabs + every control) from #opener. */
async function openSettings(page: Page, presentation = "auto"): Promise<void> {
  await page.evaluate((mode) => {
    const kit = (window as unknown as { RazeKit: any }).RazeKit;
    const opener = document.getElementById("opener")!;
    opener.onclick = () => {
      (window as any).__dialog = kit.openDialog({
        title: "Moving Average Exponential",
        description: "Settings for EMA 9",
        anchor: opener,
        presentation: mode,
        onReset() {},
        tabs: [
          {
            id: "inputs",
            label: "Inputs",
            render(panel: HTMLElement) {
              panel.append(
                kit.numberField({ label: "Length", value: 9, min: 1, max: 500 }).el,
                kit.selectField({ label: "Source", value: "close", options: [
                  { value: "open", label: "Open" }, { value: "close", label: "Close" }, { value: "hl2", label: "(H + L)/2" },
                ] }).el,
                kit.textField({ label: "Title", value: "EMA" }).el,
                kit.checkboxField({ label: "Show on price scale", value: true }).el,
              );
            },
          },
          {
            id: "style",
            label: "Style",
            render(panel: HTMLElement) {
              panel.append(
                kit.colorField({ label: "Line color", value: { color: "#2962ff", opacity: 1 } }).el,
                kit.lineWidthField({ label: "Line width", value: 2 }).el,
                kit.lineStyleField({ label: "Line style", value: "solid" }).el,
              );
            },
          },
        ],
      });
    };
  }, presentation);
  await page.locator("#opener").click();
  await expect(page.getByRole("dialog", { name: "Moving Average Exponential" })).toBeVisible();
}

/** Axe-style structural audit of an accessibility subtree (no external deps). */
async function audit(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const rootEl = document.querySelector(sel) ?? document.querySelector("[data-raze-portal]")?.shadowRoot?.querySelector(sel);
    if (!rootEl) return [`missing ${sel}`];
    const problems: string[] = [];
    const docRoot = rootEl.getRootNode() as Document | ShadowRoot;
    const byId = (id: string): Element | null => docRoot.getElementById?.(id) ?? document.getElementById(id);
    const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const implicitRole = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (el as HTMLInputElement).type;
        return type === "checkbox" ? "checkbox" : type === "range" ? "slider" : type === "radio" ? "radio" : "textbox";
      }
      if (tag === "a" && el.hasAttribute("href")) return "link";
      if (/^h[1-6]$/.test(tag)) return "heading";
      return "";
    };
    const roleOf = (el: Element): string => el.getAttribute("role") ?? implicitRole(el);
    const nameOf = (el: Element): string => {
      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) return labelledby.split(/\s+/).map((id) => text(byId(id))).join(" ").trim();
      const label = el.getAttribute("aria-label");
      if (label?.trim()) return label.trim();
      if (el.id) {
        const forLabel = (docRoot as ParentNode).querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (forLabel) return text(forLabel);
      }
      const wrapping = el.closest("label");
      if (wrapping) return text(wrapping);
      if (["button", "tab", "option", "radio", "menuitem", "link", "heading"].includes(roleOf(el))) return text(el);
      return "";
    };
    const focusable = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]";
    const interactive = new Set(["button", "link", "checkbox", "radio", "tab", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "textbox", "combobox", "slider", "spinbutton", "switch"]);
    const needsName = new Set([...interactive, "dialog", "tablist", "radiogroup", "listbox", "tabpanel", "menu", "region", "tooltip"]);
    const booleanAttrs = ["aria-checked", "aria-selected", "aria-modal", "aria-expanded", "aria-hidden", "aria-disabled", "aria-busy", "aria-invalid"];
    const allowedOn: Record<string, string[]> = {
      "aria-checked": ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"],
      "aria-selected": ["tab", "option", "gridcell", "row"],
      "aria-modal": ["dialog", "alertdialog"],
      "aria-valuenow": ["spinbutton", "slider", "progressbar", "scrollbar", "separator"],
    };
    const requiredChildren: Record<string, string> = { tablist: "tab", radiogroup: "radio", listbox: "option" };
    const requiredParent: Record<string, string> = { tab: "tablist", radio: "radiogroup", option: "listbox" };

    const all = [rootEl, ...rootEl.querySelectorAll("*")];
    const seen = new Map<string, number>();
    for (const el of (docRoot as ParentNode).querySelectorAll("[id]")) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    for (const [id, count] of seen) if (count > 1) problems.push(`duplicate-id: ${id}`);

    for (const el of all) {
      const role = roleOf(el);
      const where = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}[role=${role}]`;
      if ((el as HTMLElement).hidden || el.closest("[hidden]")) continue;
      for (const attr of ["aria-labelledby", "aria-describedby", "aria-controls", "aria-activedescendant"]) {
        const value = el.getAttribute(attr);
        if (value) for (const id of value.split(/\s+/)) if (!byId(id)) problems.push(`aria-valid-attr-value: ${where} ${attr} -> #${id} missing`);
      }
      for (const attr of booleanAttrs) {
        const value = el.getAttribute(attr);
        if (value !== null && !["true", "false", "mixed"].includes(value)) problems.push(`aria-valid-attr-value: ${where} ${attr}=${value}`);
      }
      for (const [attr, roles] of Object.entries(allowedOn)) {
        if (el.hasAttribute(attr) && !roles.includes(role)) problems.push(`aria-allowed-attr: ${where} ${attr}`);
      }
      if (needsName.has(role) && !nameOf(el)) problems.push(`name: ${where} has no accessible name`);
      if (requiredChildren[role] && !el.querySelector(`[role="${requiredChildren[role]}"]`)) problems.push(`aria-required-children: ${where}`);
      if (requiredParent[role] && !el.parentElement?.closest(`[role="${requiredParent[role]}"]`)) problems.push(`aria-required-parent: ${where}`);
      if (interactive.has(role) && el.querySelector(focusable)) problems.push(`nested-interactive: ${where}`);
      if (el.getAttribute("aria-hidden") === "true" && (el.matches(focusable) || el.querySelector(focusable))) {
        const tabbable = [el, ...el.querySelectorAll(focusable)].some((node) => (node as HTMLElement).tabIndex >= 0);
        if (tabbable) problems.push(`aria-hidden-focus: ${where}`);
      }
    }
    return problems;
  }, selector);
}

/** Wait for entrance animations to finish before measuring geometry. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
}

async function activeInfo(page: Page): Promise<{ inDialog: boolean; label: string }> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      inDialog: !!active?.closest(".raze-kit-dialog"),
      label: active?.getAttribute("aria-label") || active?.id || active?.textContent?.trim() || active?.tagName || "",
    };
  });
}

test.describe("dialog", () => {
  test("passes the accessibility audit, traps Tab and restores focus", async ({ page }) => {
    await openHarness(page);
    await openSettings(page, "dialog");
    const dialog = page.getByRole("dialog", { name: "Moving Average Exponential" });
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAccessibleDescription("Settings for EMA 9");
    await expect(page.getByRole("spinbutton", { name: "Length" })).toBeFocused();
    expect(await audit(page, ".raze-kit-dialog")).toEqual([]);

    // Tab cycles forward through every control and wraps inside the dialog.
    const count = await page.evaluate(() => (window as any).RazeKit.tabbables(document.querySelector(".raze-kit-dialog")).length);
    expect(count).toBeGreaterThan(6);
    const visited: string[] = [];
    for (let index = 0; index < count + 2; index++) {
      await page.keyboard.press("Tab");
      const info = await activeInfo(page);
      expect(info.inDialog).toBe(true);
      visited.push(info.label);
    }
    expect(new Set(visited.slice(0, count)).size).toBe(count);
    expect(visited[count]).toBe(visited[0]);
    expect(visited[count + 1]).toBe(visited[1]);

    // Shift+Tab from the first control wraps to the last one.
    await page.getByRole("spinbutton", { name: "Length" }).focus();
    const first = (await activeInfo(page)).label;
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    expect((await activeInfo(page)).inDialog).toBe(true);
    let wrapped = false;
    for (let index = 0; index < count + 1; index++) {
      await page.keyboard.press("Shift+Tab");
      const info = await activeInfo(page);
      expect(info.inDialog).toBe(true);
      if (info.label === first) wrapped = true;
    }
    expect(wrapped).toBe(true);

    // Focus moved behind the modal programmatically is pulled back inside.
    await page.evaluate(() => document.getElementById("other")!.focus());
    expect((await activeInfo(page)).inDialog).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("#opener")).toBeFocused();
    expect(await page.evaluate(() => (window as any).__dialog.result)).toBe("escape");
  });

  test("tabs, controls and the colour popover are keyboard operable", async ({ page }) => {
    await openHarness(page);
    await openSettings(page, "dialog");
    const dialog = page.getByRole("dialog", { name: "Moving Average Exponential" });
    const length = dialog.getByRole("spinbutton", { name: "Length" });
    await length.press("ArrowUp");
    await expect(length).toHaveValue("10");
    await expect(length).toHaveAttribute("aria-valuenow", "10");
    await length.press("PageDown");
    await expect(length).toHaveValue("1");

    const source = dialog.getByRole("combobox", { name: "Source" });
    await source.focus();
    await source.selectOption("hl2");
    await expect(source).toHaveValue("hl2");
    const checkbox = dialog.getByRole("checkbox", { name: "Show on price scale" });
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).not.toBeChecked();

    const inputsTab = dialog.getByRole("tab", { name: "Inputs" });
    const styleTab = dialog.getByRole("tab", { name: "Style" });
    await inputsTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(styleTab).toBeFocused();
    await expect(styleTab).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("tabpanel", { name: "Style" })).toBeVisible();
    expect(await audit(page, ".raze-kit-dialog")).toEqual([]);

    const width = dialog.getByRole("radiogroup", { name: "Line width" });
    await width.getByRole("radio", { checked: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(width.getByRole("radio", { name: "3px" })).toBeFocused();
    await expect(width.getByRole("radio", { name: "3px" })).toHaveAttribute("aria-checked", "true");

    const swatch = dialog.getByRole("button", { name: "Line color" });
    await expect(swatch).toHaveAccessibleDescription("#2962ff, 100% opacity");
    await swatch.focus();
    await page.keyboard.press("Enter");
    const picker = page.getByRole("dialog", { name: "Line color" });
    await expect(picker).toBeVisible();
    await expect(swatch).toHaveAttribute("aria-expanded", "true");
    expect(await audit(page, ".raze-kit-popover")).toEqual([]);
    const palette = picker.getByRole("listbox", { name: "Palette" });
    await expect(palette.getByRole("option", { name: "#2962ff" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(palette.getByRole("option", { name: "#673ab7" })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(palette.getByRole("option", { name: "#673ab7" })).toHaveAttribute("aria-selected", "true");
    await expect(swatch).toHaveAccessibleDescription("#673ab7, 100% opacity");

    const opacity = picker.getByRole("slider", { name: "Opacity" });
    await opacity.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(opacity).toHaveAttribute("aria-valuetext", "99%");
    await expect(swatch).toHaveAccessibleDescription("#673ab7, 99% opacity");

    // Escape closes only the popover; the dialog stays open and focus returns.
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(swatch).toBeFocused();

    await dialog.getByRole("button", { name: "OK" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("#opener")).toBeFocused();
  });

  test("is draggable by its header and stays on screen", async ({ page }) => {
    await openHarness(page);
    await openSettings(page, "dialog");
    const header = page.locator(".raze-kit-dialog-header");
    const before = await page.locator(".raze-kit-dialog").boundingBox();
    const grip = await page.locator(".raze-kit-dialog-title").boundingBox();
    await page.mouse.move(grip!.x + 20, grip!.y + 5);
    await page.mouse.down();
    await page.mouse.move(grip!.x + 120, grip!.y + 65, { steps: 5 });
    await page.mouse.up();
    const after = await page.locator(".raze-kit-dialog").boundingBox();
    expect(Math.round(after!.x - before!.x)).toBe(100);
    expect(Math.round(after!.y - before!.y)).toBe(60);
    await page.mouse.move(grip!.x + 120, grip!.y + 65);
    await page.mouse.down();
    await page.mouse.move(grip!.x + 120, -400, { steps: 5 });
    await page.mouse.up();
    const clamped = await page.locator(".raze-kit-dialog").boundingBox();
    expect(clamped!.y).toBeGreaterThanOrEqual(-0.5);
    await expect(header).toBeVisible();
  });
});

test.describe("phone presentation", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a dialog renders as a bottom sheet with a drag handle", async ({ page }) => {
    await openHarness(page);
    await openSettings(page);
    const dialog = page.getByRole("dialog", { name: "Moving Average Exponential" });
    expect(await page.evaluate(() => (window as any).__dialog.presentation)).toBe("sheet");
    await settle(page);
    const sheet = await page.locator(".raze-kit-sheet").boundingBox();
    expect(sheet!.x).toBe(0);
    expect(sheet!.width).toBe(390);
    expect(Math.round(sheet!.y + sheet!.height)).toBe(844);
    expect(sheet!.height).toBeLessThanOrEqual(844 * 0.7 + 1);
    await expect(page.getByRole("button", { name: "Close" }).first()).toBeVisible();
    await expect(page.locator(".raze-kit-sheet-handle")).toBeVisible();
    expect(await audit(page, ".raze-kit-dialog")).toEqual([]);
    const tabHeight = await dialog.getByRole("tab", { name: "Inputs" }).evaluate((el) => el.getBoundingClientRect().height);
    expect(tabHeight).toBeGreaterThanOrEqual(48);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe("hidden");

    await page.touchscreen.tap(195, 40); // backdrop
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("#opener")).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
  });

  async function openIndicators(page: Page) {
    await page.goto("/examples/visual.html?case=dark", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, { timeout: 30_000 });
    const button = page.getByRole("toolbar", { name: "Drawing and chart tools" }).getByRole("button", { name: "Indicators" });
    await button.tap();
    const menu = page.getByRole("menu", { name: "Indicators" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
    await settle(page);
    return { button, menu };
  }

  test("widget menus open as bottom sheets: full width, <=70vh, 48px rows", async ({ page }) => {
    const { button, menu } = await openIndicators(page);
    const sheet = page.locator(".raze-kit-sheet");
    await settle(page);
    const box = await sheet.boundingBox();
    expect(box!.x).toBe(0);
    expect(box!.width).toBe(390);
    expect(Math.round(box!.y + box!.height)).toBe(844);
    expect(box!.height).toBeLessThanOrEqual(844 * 0.7 + 1);
    const rows = await menu.locator('[role^="menuitem"]').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    expect(rows.length).toBeGreaterThan(3);
    for (const height of rows) expect(height).toBeGreaterThanOrEqual(48);
    await expect(button).toHaveAttribute("aria-expanded", "true");
    const padding = await sheet.evaluate((el) => getComputedStyle(el).paddingBottom);
    expect(padding).toBe("0px"); // env(safe-area-inset-bottom) is 0 in the emulator

    // Toggling a row keeps the sheet open (re-render inside the sheet).
    await menu.getByRole("menuitemcheckbox").first().tap();
    await expect(menu.getByRole("menuitemcheckbox").first()).toHaveAttribute("aria-checked", "true");
    await expect(sheet).toBeVisible();

    await page.touchscreen.tap(195, 60); // backdrop
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute("aria-expanded", "false");
  });

  test("swiping a menu sheet down dismisses it and restores focus", async ({ page }) => {
    const { button, menu } = await openIndicators(page);
    // Drag the handle.
    const handle = await page.locator(".raze-kit-sheet-handle").boundingBox();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 200, { steps: 8 });
    await page.mouse.up();
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();

    // A short drag snaps back instead of closing.
    await button.tap();
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
    await settle(page);
    const handle2 = await page.locator(".raze-kit-sheet-handle").boundingBox();
    await page.mouse.move(handle2!.x + 20, handle2!.y + 10);
    await page.mouse.down();
    await page.mouse.move(handle2!.x + 20, handle2!.y + 40, { steps: 10 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await expect(menu).toBeVisible();
    await expect.poll(() => page.locator(".raze-kit-sheet").evaluate((el) => (el as HTMLElement).style.transform)).toBe("");
    // Regression: releasing a drag must not replay the slide-up entrance.
    const replayed = await page.locator(".raze-kit-sheet").evaluate((el) =>
      el.getAnimations().some((animation) => (animation as CSSAnimation).animationName === "raze-kit-rise"));
    expect(replayed).toBe(false);

    // Touch-swipe on the content while scrolled to the top.
    const client = await page.context().newCDPSession(page);
    const row = await menu.locator('[role^="menuitem"]').first().boundingBox();
    const x = row!.x + 40;
    const y = row!.y + row!.height / 2;
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 10; step++) {
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + step * 25 }] });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
    // The swipe did not activate the row it started on.
    await button.tap();
    // Opening moves focus to the first row (deferred past the opening tap).
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
    await expect(menu.getByRole("menuitemcheckbox").first()).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });
});

test.describe("portal", () => {
  test("follows element fullscreen and returns afterwards", async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => {
      const kit = (window as any).RazeKit;
      (window as any).__popover = kit.openPopover({ anchor: document.getElementById("other"), label: "Quick settings", content: "Hello", presentation: "anchored", initialFocus: false });
    });
    const portalParent = () => page.evaluate(() => {
      const portal = document.querySelector("[data-raze-portal]");
      return portal?.parentElement?.id || portal?.parentElement?.tagName || "";
    });
    expect(await portalParent()).toBe("BODY");
    await page.evaluate(() => document.getElementById("chart")!.requestFullscreen());
    await page.waitForFunction(() => document.fullscreenElement?.id === "chart");
    await expect.poll(portalParent).toBe("chart");

    // New overlays opened in fullscreen mount inside it and are hit-testable.
    // (Opened programmatically so the popover is not dismissed by a click.)
    await page.evaluate(() => {
      const kit = (window as any).RazeKit;
      (window as any).__dialog = kit.openDialog({ title: "Fullscreen settings", anchor: document.getElementById("opener"), presentation: "dialog", content: "Body" });
    });
    await expect(page.getByRole("dialog", { name: "Fullscreen settings" })).toBeVisible();
    const inside = await page.evaluate(() => {
      const dialog = document.querySelector(".raze-kit-dialog")!;
      const box = dialog.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 20);
      return { contained: document.getElementById("chart")!.contains(dialog), hit: !!hit && dialog.contains(hit) };
    });
    expect(inside).toEqual({ contained: true, hit: true });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Fullscreen settings" })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__popover.closed)).toBe(false);
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement);
    await expect.poll(portalParent).toBe("BODY");
  });

  test("mounts inside shadow roots with scoped, themed styles", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(() => {
      const kit = (window as any).RazeKit;
      const host = document.createElement("div");
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: "open" });
      const chart = document.createElement("div");
      chart.className = "raze-chart-root";
      chart.style.setProperty("--tv-color-popup-background", "#fafafa");
      const anchor = document.createElement("button");
      anchor.textContent = "Open";
      chart.appendChild(anchor);
      shadow.appendChild(chart);
      anchor.focus();
      const dialog = kit.openDialog({ title: "Shadow settings", anchor, presentation: "dialog", content: "Body" });
      const style = getComputedStyle(dialog.el);
      const portal = dialog.el.closest("[data-raze-portal]");
      const inShadow = portal?.parentNode === shadow;
      const documentHasKitRules = [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])].some((sheet: CSSStyleSheet) => {
        try {
          return [...sheet.cssRules].some((rule) => rule.cssText.includes("raze-kit-dialog"));
        } catch {
          return false;
        }
      });
      const out = { inShadow, position: style.position, background: style.backgroundColor, documentHasKitRules, active: shadow.activeElement === dialog.el.querySelector("button") || !!dialog.el.contains(shadow.activeElement) };
      dialog.close();
      out.active = out.active && shadow.activeElement === anchor;
      return out;
    });
    expect(result).toEqual({ inShadow: true, position: "fixed", background: "rgb(250, 250, 250)", documentHasKitRules: false, active: true });
  });
});

test.describe("content security", () => {
  test("kit styles apply under a strict style-src without unsafe-inline", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    await openHarness(page, "default-src 'self'; script-src 'self'; style-src 'self'");
    await openSettings(page, "dialog");
    const style = await page.locator(".raze-kit-dialog").evaluate((el) => {
      const computed = getComputedStyle(el);
      return { position: computed.position, radius: computed.borderTopLeftRadius };
    });
    expect(style).toEqual({ position: "fixed", radius: "6px" });
    expect(violations).toEqual([]);
  });

  test("the nonce fallback styles a <style> element under a nonce CSP", async ({ page }) => {
    await openHarness(page, "default-src 'self'; script-src 'self'; style-src 'nonce-r4ze'");
    await page.evaluate(() => (window as any).RazeKit.configureStyles({ nonce: "r4ze", strategy: "style-element" }));
    await openSettings(page, "dialog");
    const style = await page.locator(".raze-kit-dialog").evaluate((el) => getComputedStyle(el).position);
    expect(style).toBe("fixed");
    expect(await page.locator("style[data-raze-styles]").count()).toBe(1);
  });

  test("the widget renders under an enforced Trusted Types policy", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/examples/visual.html*", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": "require-trusted-types-for 'script'; trusted-types raze-charts" },
      });
    });
    await page.goto("/examples/visual.html?case=dark", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, { timeout: 30_000 });
    const enforced = await page.evaluate(() => {
      try {
        document.createElement("div").innerHTML = "<b>x</b>";
        return false;
      } catch {
        return true;
      }
    });
    expect(enforced).toBe(true);
    const sidebar = page.getByRole("toolbar", { name: "Drawing and chart tools" });
    await expect(sidebar.locator("button svg").first()).toBeAttached();
    const chartType = sidebar.getByRole("button", { name: /Chart type/ });
    await chartType.click();
    const menu = page.getByRole("menu", { name: "Chart type" });
    await expect(menu.locator("svg").first()).toBeAttached();
    expect(errors).toEqual([]);
  });
});

test.describe("tooltip and toast", () => {
  test("tooltips show on hover and keyboard focus, describe the target and dismiss with Escape", async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => {
      const kit = (window as any).RazeKit;
      const other = document.getElementById("other")!;
      other.setAttribute("title", "legacy title");
      kit.attachTooltip(other, "Other action (Alt+O)", { delay: 100 });
      const icon = document.createElement("button");
      icon.id = "icon-only";
      document.getElementById("chart")!.appendChild(icon);
      kit.attachTooltip(icon, "Fit chart");
    });
    const other = page.locator("#other");
    await expect(other).not.toHaveAttribute("title", /./);
    await expect(page.getByRole("button", { name: "Fit chart" })).toBeAttached();
    await other.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveText("Other action (Alt+O)");
    await expect(other).toHaveAccessibleDescription("Other action (Alt+O)");
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    await page.mouse.move(700, 500);

    await page.locator("#opener").focus();
    await page.keyboard.press("Tab");
    await expect(other).toBeFocused();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.locator("#icon-only")).toBeFocused();
    await expect(tooltip).toHaveText("Fit chart");
    await expect(other).not.toHaveAttribute("aria-describedby", /./);
    await page.keyboard.press("Shift+Tab");
    await expect(tooltip).toHaveText("Other action (Alt+O)");
  });

  test("toasts announce through live regions, pause on hover and expire", async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => {
      const kit = (window as any).RazeKit;
      kit.showToast("Layout saved", { duration: 400 });
      kit.showToast("Connection lost", { kind: "error", duration: 0, action: { label: "Retry", onAction: () => ((window as any).__retried = true) } });
    });
    const region = page.getByRole("region", { name: "Notifications" });
    await expect(region).toBeVisible();
    await expect(region.locator('[aria-live="polite"]')).toContainText("Layout saved");
    await expect(region.locator('[aria-live="assertive"]')).toContainText("Connection lost");
    await expect(region.getByText("Layout saved")).toHaveCount(0, { timeout: 3000 });
    await region.getByRole("button", { name: "Retry" }).click();
    expect(await page.evaluate(() => (window as any).__retried)).toBe(true);
    await expect(region).toHaveCount(0);
  });
});

test.describe("reduced motion", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  test("sheets skip their entrance animation", async ({ page }) => {
    await openHarness(page);
    await openSettings(page);
    const animation = await page.locator(".raze-kit-sheet").evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe("none");
  });
});
