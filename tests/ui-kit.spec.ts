import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
        'export { openPopup, popupRow } from "./src/ui/popup.ts";',
        'export { LoadingScreen } from "./src/ui/LoadingScreen.ts";',
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

/**
 * axe-core, when installed. It is not a dependency yet (no network installs in
 * package work), so the structural audit below always runs and axe joins it
 * automatically once `axe-core` resolves from the repository root.
 */
const AXE_SOURCE: string | null = (() => {
  try {
    return readFileSync(createRequire(resolve(root, "package.json")).resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    return null;
  }
})();

/** Run axe on `selector` and expect no violations (annotated when axe is absent). */
async function expectAxeClean(page: Page, selector: string): Promise<void> {
  if (!AXE_SOURCE) {
    test.info().annotations.push({ type: "axe", description: `axe-core not installed; ${selector} got the structural audit only` });
    return;
  }
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: AXE_SOURCE });
  const violations = await page.evaluate(async (sel) => {
    const axe = (window as unknown as { axe: { run(context: Element, options: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const target = document.querySelector(sel);
    if (!target) return [`missing ${sel}`];
    const result = await axe.run(target, { resultTypes: ["violations"] });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  }, selector);
  expect(violations).toEqual([]);
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
    // Role-restricted ARIA attributes (axe aria-allowed-attr), per WAI-ARIA 1.2.
    const range = ["spinbutton", "slider", "progressbar", "scrollbar", "separator", "meter"];
    const allowedOn: Record<string, string[]> = {
      "aria-checked": ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"],
      "aria-selected": ["tab", "option", "gridcell", "row"],
      "aria-modal": ["dialog", "alertdialog"],
      "aria-valuenow": range,
      "aria-valuetext": range,
      "aria-valuemin": range,
      "aria-valuemax": range,
      "aria-orientation": ["scrollbar", "select", "separator", "slider", "tablist", "toolbar", "listbox", "menu", "menubar", "radiogroup", "tree", "treegrid"],
      "aria-multiselectable": ["grid", "listbox", "tablist", "tree", "treegrid"],
      "aria-pressed": ["button"],
      "aria-required": ["checkbox", "combobox", "gridcell", "listbox", "radiogroup", "spinbutton", "textbox", "searchbox", "tree", "treegrid", "columnheader", "rowheader"],
      "aria-placeholder": ["textbox", "searchbox"],
    };
    const requiredChildren: Record<string, string> = { tablist: "tab", radiogroup: "radio", listbox: "option" };
    const requiredParent: Record<string, string> = { tab: "tablist", radio: "radiogroup", option: "listbox" };
    // Explicit roles ARIA in HTML allows on elements the kit uses (axe aria-allowed-role).
    const allowedRoles: Record<string, string[]> = {
      form: ["search", "none", "presentation"],
      input: ["spinbutton", "slider", "combobox", "searchbox", "switch", "checkbox", "radio", "textbox"],
      ul: ["listbox", "menu", "tablist", "radiogroup", "group", "none", "presentation"],
      h2: ["tab", "none", "presentation"],
    };

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
      const explicitRole = el.getAttribute("role");
      const allowed = allowedRoles[el.tagName.toLowerCase()];
      if (explicitRole && allowed && !allowed.includes(explicitRole)) problems.push(`aria-allowed-role: ${where}`);
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
    await expectAxeClean(page, ".raze-kit-dialog");

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
    await expectAxeClean(page, ".raze-kit-dialog");

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
    await expectAxeClean(page, ".raze-kit-popover");
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
    await expectAxeClean(page, ".raze-kit-dialog");
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
    // Regression: the menu sheet is exposed as a modal dialog (the menu role
    // itself may not carry aria-modal), so screen readers stay inside it.
    await expect(page.getByRole("dialog", { name: "Indicators" })).toHaveAttribute("aria-modal", "true");
    await expect(menu).not.toHaveAttribute("aria-modal", /./);
    expect(await audit(page, ".raze-kit-sheet")).toEqual([]);
    await expectAxeClean(page, ".raze-kit-sheet");
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

  test("Tab and Shift+Tab stay inside a sheet menu", async ({ page }) => {
    const { button, menu } = await openIndicators(page);
    const items = menu.locator('[role^="menuitem"],button');
    const first = menu.getByRole("menuitemcheckbox").first();
    await expect(first).toBeFocused();
    // Regression: Shift+Tab used to close the sheet and drop focus onto a
    // control hidden behind the backdrop.
    await page.keyboard.press("Shift+Tab");
    await expect(menu).toBeVisible();
    await expect(items.last()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(first).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest(".raze-kit-sheet"))).toBe(true);
    // Focus moved behind the sheet programmatically is pulled back inside.
    await button.evaluate((element) => (element as HTMLElement).focus());
    expect(await page.evaluate(() => !!document.activeElement?.closest(".raze-kit-sheet"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test("popover sheets are modal dialogs whatever the content role", async ({ page }) => {
    await openHarness(page);
    const opened = await page.evaluate(() => {
      const kit = (window as any).RazeKit;
      const opener = document.getElementById("opener")!;
      const popover = kit.openPopover({
        anchor: opener,
        label: "Timeframes",
        role: "menu",
        content(body: HTMLElement) {
          for (const label of ["1m", "5m", "1h"]) {
            const item = document.createElement("button");
            item.type = "button";
            item.setAttribute("role", "menuitem");
            item.textContent = label;
            body.appendChild(item);
          }
        },
      });
      (window as any).__popover = popover;
      return popover.presentation;
    });
    expect(opened).toBe("sheet");
    // aria-modal is only allowed on dialogs (axe aria-allowed-attr): a
    // menu-role sheet gets a dialog container that carries it instead.
    const container = page.getByRole("dialog", { name: "Timeframes" });
    await expect(container).toHaveAttribute("aria-modal", "true");
    await expect(page.getByRole("menu", { name: "Timeframes" })).not.toHaveAttribute("aria-modal", /./);
    expect(await audit(page, ".raze-kit-sheet")).toEqual([]);
    await expectAxeClean(page, ".raze-kit-sheet");
    await page.evaluate(() => (window as any).__popover.close());

    // A dialog-role popover sheet is itself the modal dialog: no second one.
    await page.evaluate(() => {
      const kit = (window as any).RazeKit;
      (window as any).__popover = kit.openPopover({ anchor: document.getElementById("opener"), label: "Quick settings", content: "Hello" });
    });
    const dialogs = page.getByRole("dialog");
    await expect(dialogs).toHaveCount(1);
    await expect(dialogs).toHaveAttribute("aria-modal", "true");
    expect(await audit(page, ".raze-kit-sheet")).toEqual([]);
    await page.evaluate(() => (window as any).__popover.close());
  });

  test("on wide touch screens a sheet stays a centred 640px column", async ({ page }) => {
    const { menu } = await openIndicators(page);
    // Rotating/resizing a touch device keeps the sheet (the pointer is still
    // coarse), but it must not stretch across a tablet-width screen.
    await page.setViewportSize({ width: 1000, height: 700 });
    await expect(menu).toBeVisible();
    await expect.poll(async () => (await page.locator(".raze-kit-sheet").boundingBox())?.width).toBe(640);
    const box = (await page.locator(".raze-kit-sheet").boundingBox())!;
    expect(box.x).toBe(180);
    expect(Math.round(box.y + box.height)).toBe(700);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });
});

test.describe("narrow desktop window", () => {
  test.use({ viewport: { width: 480, height: 700 } });

  test("a sheet menu closes and restores focus when the window widens past 520px", async ({ page }) => {
    await page.goto("/examples/visual.html?case=dark", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, { timeout: 30_000 });
    const button = page.getByRole("toolbar", { name: "Drawing and chart tools" }).getByRole("button", { name: "Indicators" });
    await button.click();
    const menu = page.getByRole("menu", { name: "Indicators" });
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
    await expect(menu).toHaveAttribute("data-presentation", "sheet");
    await page.setViewportSize({ width: 1100, height: 700 });
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
    // Reopening at the new width picks the anchored presentation.
    await button.click();
    await expect(menu).toHaveAttribute("data-presentation", "anchored");
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
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

/**
 * A chart root inside an open shadow root whose "Studies" button toggles an
 * openPopup() menu of three checkable rows (like the widget's menus).
 */
async function mountShadowMenu(page: Page, presentation?: "sheet" | "anchored"): Promise<void> {
  await openHarness(page);
  await page.evaluate((mode) => {
    const kit = (window as any).RazeKit;
    const host = document.createElement("div");
    host.id = "shadow-host";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const chart = document.createElement("div");
    chart.className = "raze-chart-root";
    const anchor = document.createElement("button");
    anchor.type = "button";
    anchor.textContent = "Studies";
    chart.appendChild(anchor);
    shadow.appendChild(chart);
    const state: { clicks: string[]; popup: any } = { clicks: [], popup: null };
    (window as any).__menu = state;
    anchor.addEventListener("click", () => {
      if (state.popup) {
        state.popup.close();
        return;
      }
      const popup = kit.openPopup({
        fontFamily: "sans-serif",
        anchor,
        label: "Studies menu",
        presentation: mode,
        onClose: () => {
          if (state.popup === popup) state.popup = null;
        },
      });
      for (const label of ["EMA 9", "SMA 20", "RSI 14"]) {
        const row = kit.popupRow(label, () => {
          state.clicks.push(label);
          row.setAttribute("aria-checked", String(row.getAttribute("aria-checked") !== "true"));
        }, { role: "menuitemcheckbox", checked: false });
        popup.el.appendChild(row);
      }
      state.popup = popup;
    });
  }, presentation);
}

const menuClicks = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__menu.clicks);

test.describe("popup menus inside shadow roots", () => {
  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("a sheet menu handles row taps, arrows, Escape and the backdrop", async ({ page }) => {
      await mountShadowMenu(page);
      const anchor = page.getByRole("button", { name: "Studies" });
      await anchor.tap();
      const menu = page.getByRole("menu", { name: "Studies menu" });
      await expect(menu).toHaveAttribute("data-presentation", "sheet");
      expect(await page.evaluate(() => (window as any).__menu.popup.el.getRootNode() === document.getElementById("shadow-host")!.shadowRoot)).toBe(true);
      const rows = menu.getByRole("menuitemcheckbox");
      await expect(rows.nth(0)).toBeFocused();
      // Regression: arrow keys read document.activeElement (the shadow host)
      // and always jumped back to the first row.
      await page.keyboard.press("ArrowDown");
      await expect(rows.nth(1)).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(rows.nth(2)).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(rows.nth(1)).toBeFocused();
      await settle(page);

      // Regression: the document saw a press inside the sheet as a press on
      // the shadow host ("outside") and closed the sheet before the row's
      // click could run.
      await rows.nth(2).tap();
      await expect(rows.nth(2)).toHaveAttribute("aria-checked", "true");
      expect(await menuClicks(page)).toEqual(["RSI 14"]);
      await expect(menu).toBeVisible();

      // Regression: Escape with focus inside the sheet did nothing.
      await rows.nth(0).focus();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(anchor).toBeFocused();
      await expect(anchor).toHaveAttribute("aria-expanded", "false");

      await anchor.tap();
      await expect(rows.nth(0)).toBeFocused();
      await settle(page);
      await page.touchscreen.tap(195, 40); // backdrop
      await expect(menu).toHaveCount(0);
      await expect(anchor).toBeFocused();
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
    });
  });

  test("a sheet requested on a desktop handles clicks, arrows and Escape", async ({ page }) => {
    await mountShadowMenu(page, "sheet");
    const anchor = page.getByRole("button", { name: "Studies" });
    await anchor.click();
    const menu = page.getByRole("menu", { name: "Studies menu" });
    await expect(menu).toHaveAttribute("data-presentation", "sheet");
    const rows = menu.getByRole("menuitemcheckbox");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    await settle(page);
    await rows.nth(1).click();
    expect(await menuClicks(page)).toEqual(["SMA 20"]);
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(anchor).toBeFocused();
  });

  test("an anchored menu toggles from its shadow-root anchor and follows focus", async ({ page }) => {
    await mountShadowMenu(page, "anchored");
    const anchor = page.getByRole("button", { name: "Studies" });
    await anchor.click();
    const menu = page.getByRole("menu", { name: "Studies menu" });
    await expect(menu).toHaveAttribute("data-presentation", "anchored");
    const rows = menu.getByRole("menuitemcheckbox");
    await expect(rows.nth(0)).toBeFocused();
    await rows.nth(1).click();
    expect(await menuClicks(page)).toEqual(["SMA 20"]);
    await expect(menu).toBeVisible();
    // Regression: a press on the anchor read as an outside press (the
    // document saw the shadow host), so the menu closed and the anchor's own
    // click reopened it instead of toggling it closed.
    await anchor.click();
    await expect(menu).toHaveCount(0);

    // Focus moving back onto the anchor keeps the menu (the anchor toggles
    // it); Escape there closes it. (Tab and Shift+Tab leave a menu: it
    // closes and the browser moves on from the anchor.)
    await anchor.click();
    await expect(rows.nth(0)).toBeFocused();
    await anchor.focus();
    await expect(anchor).toBeFocused();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(anchor).toBeFocused();

    // Focus moving anywhere else closes it without pulling focus back.
    await anchor.click();
    await expect(rows.nth(0)).toBeFocused();
    await page.locator("#other").focus();
    await expect(menu).toHaveCount(0);
    await expect(page.locator("#other")).toBeFocused();
  });
});

test.describe("anchored widget menus", () => {
  test("pressing a row other than the focused one activates it", async ({ page }) => {
    await page.goto("/examples/visual.html?case=dark", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, { timeout: 30_000 });
    const sidebar = page.getByRole("toolbar", { name: "Drawing and chart tools" });
    // Regression: focus-out dismissal ran while the press was moving focus
    // (document.activeElement is <body> then), so the menu closed before the
    // pressed row's click and the choice was lost.
    await sidebar.getByRole("button", { name: /Chart type/ }).click();
    const typeMenu = page.getByRole("menu", { name: "Chart type" });
    const types = typeMenu.getByRole("menuitemradio");
    await expect(types.first()).toBeFocused();
    const target = (await types.nth(2).getAttribute("aria-label"))!;
    await types.nth(2).click();
    await expect(typeMenu).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: `Chart type: ${target}` })).toBeVisible();

    await sidebar.getByRole("button", { name: "Indicators" }).click();
    const indicators = page.getByRole("menu", { name: "Indicators" });
    const presets = indicators.getByRole("menuitemcheckbox");
    await expect(presets.first()).toBeFocused();
    await presets.nth(1).click();
    await expect(presets.nth(1)).toHaveAttribute("aria-checked", "true");
    await expect(presets.nth(1)).toBeFocused();
    await expect(indicators).toBeVisible();
    // Focus moving elsewhere (here: the chart) still closes it.
    await page.locator("canvas").first().focus();
    await expect(indicators).toHaveCount(0);
  });
});

test.describe("loading screen", () => {
  test("a standalone LoadingScreen spins without the widget, in documents and shadow roots", async ({ page }) => {
    // Strict style-src: the keyframes must come from an adopted sheet.
    await openHarness(page, "default-src 'self'; script-src 'self'; style-src 'self'");
    const spinning = await page.evaluate(async () => {
      const kit = (window as any).RazeKit;
      const light = new kit.LoadingScreen(undefined, "#131722");
      document.getElementById("chart")!.appendChild(light.el);
      const host = document.createElement("div");
      host.style.cssText = "position:relative;width:200px;height:120px";
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: "open" });
      const inShadow = new kit.LoadingScreen({ foregroundColor: "#089981" }, "#ffffff");
      shadow.appendChild(inShadow.el);
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const running = (screen: { el: HTMLElement }): number => screen.el.querySelector(".raze-chart-loading-spinner")!
        .getAnimations()
        .filter((animation) => (animation as CSSAnimation).animationName === "raze-chart-spin" && animation.playState === "running")
        .length;
      return { light: running(light), shadow: running(inShadow) };
    });
    expect(spinning).toEqual({ light: 1, shadow: 1 });
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

  test("the financial widget's chrome needs no 'unsafe-inline' styles", async ({ page }) => {
    // Record every CSP violation from the first byte on.
    await page.addInitScript(() => {
      const log: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = log;
      document.addEventListener("securitypolicyviolation", (event) => {
        log.push(`${event.effectiveDirective} ${event.sourceFile || event.blockedURI}:${event.lineNumber} ${event.sample}`);
      });
    });
    // The example page's own inline <style> and module <script> are allowed by
    // hash, so the policy contains no 'unsafe-inline' at all and any
    // violation comes from the library. (The HTML parser normalises CRLF
    // before hashing, so a Windows checkout hashes the LF form.)
    await page.route("**/examples/visual.html*", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const hashes = (pattern: RegExp): string => [...body.matchAll(pattern)]
        .map((match) => `'sha256-${createHash("sha256").update(match[1]!.replace(/\r\n?/g, "\n"), "utf8").digest("base64")}'`)
        .join(" ");
      const csp = [
        "default-src 'self'",
        `script-src 'self' ${hashes(/<script type="module">([\s\S]*?)<\/script>/g)}`,
        `style-src 'self' ${hashes(/<style>([\s\S]*?)<\/style>/g)}`,
        "img-src 'self' data: blob:",
      ].join("; ");
      await route.fulfill({ response, body, headers: { ...response.headers(), "content-security-policy": csp } });
    });
    await page.goto("/examples/visual.html?case=dark", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, { timeout: 30_000 });
    const violations = () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp.slice());

    // The loading spinner's keyframes ship in the adopted chrome sheet rather
    // than an inline <style> element.
    const chrome = await page.evaluate(() => ({
      spinKeyframes: document.adoptedStyleSheets.some((sheet) =>
        [...sheet.cssRules].some((rule) => rule instanceof CSSKeyframesRule && rule.name === "raze-chart-spin")),
      inlineStyleElements: document.querySelectorAll("style:not([data-raze-styles])").length,
    }));
    expect(chrome).toEqual({ spinKeyframes: true, inlineStyleElements: 1 }); // the page's own hashed <style>

    const sidebar = page.getByRole("toolbar", { name: "Drawing and chart tools" });
    // Chart type: the checked row keeps its accent colour and icon layout.
    await sidebar.getByRole("button", { name: /Chart type/ }).click();
    const typeMenu = page.getByRole("menu", { name: "Chart type" });
    await expect(typeMenu).toBeVisible();
    const icons = await typeMenu.getByRole("menuitemradio").evaluateAll((rows) => rows.map((row) => {
      const icon = row.querySelector("span")!;
      const style = getComputedStyle(icon);
      return { checked: row.getAttribute("aria-checked"), color: style.color, display: style.display, width: style.width, text: row.textContent };
    }));
    const checked = icons.find((icon) => icon.checked === "true")!;
    const unchecked = icons.find((icon) => icon.checked === "false")!;
    // inline-flex, blockified by the flex row (a blocked style="" gives "block").
    expect(checked.display).toBe("flex");
    expect(checked.width).toBe("18px");
    expect(checked.text).toMatch(/^✓ /);
    expect(checked.color).not.toBe(unchecked.color);
    expect(unchecked.color).toBe(await typeMenu.evaluate((menu) => getComputedStyle(menu).color));
    await page.keyboard.press("Escape");
    await expect(typeMenu).toHaveCount(0);

    // Indicators: add a study so its legend row renders too.
    await sidebar.getByRole("button", { name: "Indicators" }).click();
    const indicators = page.getByRole("menu", { name: "Indicators" });
    await expect(indicators.getByRole("menuitemcheckbox").first()).toBeFocused();
    await indicators.getByRole("menuitemcheckbox").first().click();
    await expect(indicators.getByRole("menuitemcheckbox").first()).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(indicators).toHaveCount(0);

    // Objects tree and the chart context menu (which needs host items).
    await sidebar.getByRole("button", { name: "Objects tree" }).click();
    await expect(page.locator('[role="menu"],[role="dialog"]').first()).toBeVisible();
    // Escape reaches the menu only once it has taken focus.
    await expect(page.getByRole("menu", { name: "Objects tree" }).getByRole("menuitemcheckbox").first()).toBeFocused();
    await page.keyboard.press("Escape");
    // The chart menu opens only with an onContextMenu callback; without one
    // this step raced the closing objects tree.
    await expect(page.locator('[role="menu"],[role="dialog"]')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { __razeChart: any }).__razeChart.onContextMenu(() => [
      { position: "top", text: "Add alert here", click: () => {} },
      { position: "top", text: "-" },
      { position: "top", text: "Reset chart", click: () => {} },
    ]));
    const canvas = page.locator("canvas").first();
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await expect(page.getByRole("menu").first()).toBeVisible();
    await page.keyboard.press("Escape");

    expect(await violations()).toEqual([]);
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

    // Custom sidebar icons: an Element involves no markup sink at all (the
    // option for hosts that enforce Trusted Types); host markup strings still
    // go through the raze-charts policy.
    await page.keyboard.press("Escape");
    const custom = await page.evaluate(async () => {
      const libraryUrl = "/dist/charting_library.esm.js";
      const feedUrl = "/examples/mock-datafeed.mjs";
      const { widget } = await import(libraryUrl);
      const { makeMockDatafeed } = await import(feedUrl);
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 18 18");
      svg.appendChild(document.createElementNS(ns, "circle"));
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:0;top:0;width:640px;height:360px";
      document.body.appendChild(host);
      new widget({
        symbol: "MOCK",
        interval: "1",
        container: host,
        autosize: true,
        datafeed: makeMockDatafeed({ bars: 60, live: false }),
        raze: {
          sidebar: [
            "cursor",
            { id: "alerts", title: "Alerts", icon: svg, onClick() {} },
            { id: "notes", title: "Notes", icon: '<svg viewBox="0 0 18 18"><rect width="6" height="6"/></svg>', onClick() {} },
          ],
        },
      });
      const alerts = host.querySelector<HTMLElement>('button[aria-label="Alerts"]');
      const notes = host.querySelector<HTMLElement>('button[aria-label="Notes"]');
      return {
        element: !!alerts?.querySelector("svg circle"),
        cloned: svg.parentNode === null,
        hidden: alerts?.querySelector("svg")?.getAttribute("aria-hidden"),
        markup: !!notes?.querySelector("svg rect"),
      };
    });
    expect(custom).toEqual({ element: true, cloned: true, hidden: "true", markup: true });
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

  test("the loading spinner stands still", async ({ page }) => {
    await openHarness(page);
    const animation = await page.evaluate(() => {
      const screen = new (window as any).RazeKit.LoadingScreen(undefined, "#131722");
      document.getElementById("chart")!.appendChild(screen.el);
      return getComputedStyle(screen.el.querySelector(".raze-chart-loading-spinner")).animationName;
    });
    expect(animation).toBe("none");
  });
});
