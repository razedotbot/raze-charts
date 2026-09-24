// Drawing tools in a real browser (W1B-11): goldens for every built-in kind in
// both themes (dashed trend and vertical lines, filled rectangles, fib, measure,
// text styles) plus pixel checks that a rectangle's configured fill is what is
// painted, that handles appear only on hover or selection, and that a host
// tool registered at runtime paints, is listed in the objects tree and
// round-trips through the widget's save()/load().

import { test, expect, type Page } from "@playwright/test";

async function open(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.goto(`/examples/drawing-tools.html?theme=${theme}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

/**
 * Pixels of the composited chart matching `match`, and one of them in page
 * coordinates: the median by x, so a few stray anti-aliased pixels elsewhere
 * cannot pull the point off the drawing (as a mean would). Every canvas in the
 * chart root is drawn onto one scratch canvas in stacking order (z-index, then
 * DOM order), so the check reads what is on screen whether the frame is one
 * canvas or split into layers (a main bitmap under an interactive overlay).
 */
async function pixels(page: Page, match: string): Promise<{ count: number; x: number; y: number }> {
  return page.evaluate((source) => {
    const test = new Function("r", "g", "b", `return ${source};`) as (r: number, g: number, b: number) => boolean;
    const layers = [...document.querySelectorAll<HTMLCanvasElement>(".raze-chart-root canvas")]
      .filter((canvas) => canvas.width > 0 && canvas.height > 0)
      .map((canvas, order) => ({ canvas, order, z: Number.parseInt(getComputedStyle(canvas).zIndex, 10) || 0 }))
      .sort((a, b) => a.z - b.z || a.order - b.order);
    const base = layers.find((layer) => layer.order === 0)!.canvas;
    const rect = base.getBoundingClientRect();
    const scale = base.width / rect.width;
    const frame = document.createElement("canvas");
    frame.width = base.width;
    frame.height = base.height;
    const ctx = frame.getContext("2d")!;
    for (const { canvas } of layers) {
      const r = canvas.getBoundingClientRect();
      // Whole device pixels, so a layer the size of the frame is copied 1:1 (no resampling).
      const at = (value: number) => Math.round(value * scale);
      ctx.drawImage(canvas, at(r.left - rect.left), at(r.top - rect.top), at(r.width), at(r.height));
    }
    const { data, width } = ctx.getImageData(0, 0, frame.width, frame.height);
    const hits: [number, number][] = [];
    for (let i = 0; i < data.length; i += 4) {
      if (test(data[i]!, data[i + 1]!, data[i + 2]!)) hits.push([(i / 4) % width, Math.floor(i / 4 / width)]);
    }
    const [x, y] = hits.sort((a, b) => a[0] - b[0] || a[1] - b[1])[hits.length >> 1] ?? [0, 0];
    return { count: hits.length, x: rect.left + (x + 0.5) / scale, y: rect.top + (y + 0.5) / scale };
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
  // Hover the dashed trend line where it is drawn (one of its magenta pixels).
  await page.mouse.move(idle.x, idle.y);
  await page.waitForTimeout(100);
  const hovered = await pixels(page, MAGENTA);
  expect(hovered.count).toBeGreaterThan(idle.count + 20);
  // Somewhere empty inside the plot (leaving the canvas keeps the last hover).
  const box = (await page.locator(".raze-chart-root canvas").first().boundingBox())!;
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

test("a host tool registered at runtime paints, is listed in the objects tree and round-trips through save()/load()", async ({ page }) => {
  await open(page, "dark");
  const MARKER = "r === 0 && g === 254 && b === 127";
  expect((await pixels(page, MARKER)).count).toBe(0);

  const saved = await page.evaluate(async () => {
    const win = window as any;
    win.__razeDefineDrawingTool({
      id: "acme_arrow_marker",
      title: "Arrow marker",
      icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 15L15 3M15 3H9M15 3V9" stroke="currentColor"/></svg>',
      anchors: 2,
      props: { linecolor: { type: "color", title: "Line color", default: "#00fe7f" } },
      paint(ctx: CanvasRenderingContext2D, drawing: { props: { linecolor: string } }, geometry: { anchors: ({ x: number; y: number } | null)[] }) {
        const [a, b] = geometry.anchors;
        if (!a || !b) return;
        ctx.strokeStyle = drawing.props.linecolor;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      },
      hitTest: () => null,
    });
    const chart = win.__razeWidget.activeChart();
    await chart.createMultipointShape([win.__razeAt(104, 0.55), win.__razeAt(72, 0.62)], { shape: "acme_arrow_marker" });
    return win.__razeWidget.save();
  });
  await page.waitForTimeout(100);
  const painted = await pixels(page, MARKER);
  expect(painted.count).toBeGreaterThan(100);
  expect(saved.drawings.filter((drawing: { shape: string }) => drawing.shape === "acme_arrow_marker")).toHaveLength(1);

  // The objects tree lists it like any built-in kind.
  await page.getByRole("button", { name: "Objects tree" }).click();
  const tree = page.getByRole("menu", { name: "Objects tree" });
  await expect(tree.getByRole("menuitem", { name: /^Delete acme[ _]arrow[ _]marker$/ })).toHaveCount(1);
  // Escape reaches the menu once it has taken focus.
  await expect(tree.getByRole("menuitemcheckbox").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tree).toHaveCount(0);

  // Clear, then load the saved layout back through the widget.
  await page.evaluate(() => (window as unknown as { __razeWidget: { activeChart(): { removeAllShapes(): void } } }).__razeWidget.activeChart().removeAllShapes());
  await page.waitForTimeout(100);
  expect((await pixels(page, MARKER)).count).toBe(0);
  const restored = await page.evaluate(async (state) => {
    const w = (window as any).__razeWidget;
    await w.load(state);
    return w.save().drawings.map((drawing: { shape: string }) => drawing.shape);
  }, saved);
  expect(restored).toEqual(saved.drawings.map((drawing: { shape: string }) => drawing.shape));
  await page.waitForTimeout(100);
  // Painted again (load() also restores the saved view, so the length can differ by a few pixels).
  expect((await pixels(page, MARKER)).count).toBeGreaterThan(painted.count * 0.8);
});
