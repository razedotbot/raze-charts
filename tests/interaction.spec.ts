// Real-browser interaction correctness (W1B-10): wheel zoom scaled by delta,
// pan bounds, monotonic zoom-out after ALL, whole-shape body drags with a
// drag slop and one undo entry, topmost-first selection, Escape cancelling a
// drag, no refit on a drawing double-click, and the inline text editor inside
// a sandboxed iframe (where window.prompt is blocked).

import { expect, test, type Frame, type Page } from "@playwright/test";

type Point = { time: number; price: number };
interface ChartState {
  bars: number;
  visibleRange: { from: number; to: number };
  priceMin: number;
  priceMax: number;
}
interface Geometry {
  left: number;
  top: number;
  plotW: number;
  plotH: number;
}

const TIME_AXIS_H = 22;

async function openChart(page: Page, testCase = "dark"): Promise<void> {
  await page.goto(`/examples/visual.html?case=${testCase}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, null, { timeout: 30_000 });
  await page.evaluate(() => { (window as unknown as { __RAZE_DEBUG: boolean }).__RAZE_DEBUG = true; });
}

const canvas = (page: Page) => page.locator(".raze-chart-root canvas").first();

async function frames(page: Page, count = 2): Promise<void> {
  await page.evaluate((n) => new Promise<void>((resolve) => {
    const step = (left: number): void => {
      if (left <= 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(n);
  }), count);
}

async function state(page: Page): Promise<ChartState> {
  await frames(page);
  return page.evaluate(() => (window as unknown as { __razeChartState: ChartState }).__razeChartState);
}

const span = (s: ChartState): number => s.visibleRange.to - s.visibleRange.from;

/** Bars whose centre lies inside the plot (index i visible when from - 0.5 <= i <= to - 0.5). */
const visibleBars = (s: ChartState): number => {
  const first = Math.max(0, Math.ceil(s.visibleRange.from - 0.5));
  const last = Math.min(s.bars - 1, Math.floor(s.visibleRange.to - 0.5));
  return Math.max(0, last - first + 1);
};

async function cursorAt(page: Page, x: number, y: number): Promise<string> {
  await page.mouse.move(x, y);
  return canvas(page).evaluate((element) => (element as HTMLCanvasElement).style.cursor);
}

/** Plot origin and size in page pixels; the price-axis edge is found by probing its resize cursor. */
async function geometry(page: Page): Promise<Geometry> {
  const box = (await canvas(page).boundingBox())!;
  let inside = box.width / 2;
  let outside = box.width - 1;
  while (outside - inside > 1) {
    const mid = Math.floor((inside + outside) / 2);
    if (await cursorAt(page, box.x + mid, box.y + 12) === "ns-resize") outside = mid;
    else inside = mid;
  }
  return { left: box.x, top: box.y, plotW: inside, plotH: box.height - TIME_AXIS_H };
}

function mapper(g: Geometry, s: ChartState) {
  const spacing = g.plotW / span(s);
  return {
    x: (index: number) => g.left + (index - s.visibleRange.from + 0.5) * spacing,
    y: (price: number) => g.top + ((s.priceMax - price) / (s.priceMax - s.priceMin)) * g.plotH,
  };
}

async function lastBarTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const chart = (window as unknown as { __razeChart: { activeChart(): { getVisibleRange(): { to: number } } } }).__razeChart;
    return chart.activeChart().getVisibleRange().to;
  });
}

async function createTrend(page: Page, points: Point[], options: Record<string, unknown> = {}): Promise<string> {
  return page.evaluate(async ({ points, options }) => {
    const chart = (window as unknown as { __razeChart: { activeChart(): { createMultipointShape(p: unknown, o: unknown): Promise<string> } } }).__razeChart;
    return chart.activeChart().createMultipointShape(points, { shape: "trend_line", overrides: { linecolor: "#2962ff" }, ...options });
  }, { points, options });
}

async function pointsOf(page: Page, id: string): Promise<Point[]> {
  return page.evaluate((entity) => {
    const chart = (window as unknown as { __razeChart: { activeChart(): { getShapeById(id: string): { getPoints(): Point[] } } } }).__razeChart;
    return chart.activeChart().getShapeById(entity).getPoints();
  }, id);
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(() => {
    const chart = (window as unknown as { __razeChart: { activeChart(): { executeActionById(id: string): void } } }).__razeChart;
    chart.activeChart().executeActionById("undo");
  });
}

/** A horizontal trend line across 30-60% of the view at mid price, with its screen mapping. */
async function trendFixture(page: Page, options: Record<string, unknown> = {}) {
  const g = await geometry(page);
  const s = await state(page);
  const tLast = await lastBarTime(page);
  const i1 = Math.round(s.visibleRange.from + span(s) * 0.3);
  const i2 = Math.round(s.visibleRange.from + span(s) * 0.6);
  const price = (s.priceMin + s.priceMax) / 2;
  const time = (index: number): number => tLast - (s.bars - 1 - index) * 60;
  const points = [{ time: time(i1), price }, { time: time(i2), price }];
  const id = await createTrend(page, points, options);
  await frames(page);
  const map = mapper(g, s);
  return { id, points, i1, i2, price, map, mid: { x: map.x((i1 + i2) / 2), y: map.y(price) } };
}

test.describe("interaction correctness", () => {
  test("wheel zoom scales with the delta: trackpad nudges are gentle, a notch is about 11%", async ({ page }) => {
    await openChart(page);
    const box = (await canvas(page).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
    const before = span(await state(page));
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 1);
    const afterTrackpad = span(await state(page));
    expect(afterTrackpad / before - 1).toBeLessThan(0.25);
    expect(afterTrackpad).toBeGreaterThan(before);
    await page.mouse.wheel(0, 100);
    const growth = span(await state(page)) / afterTrackpad - 1;
    expect(growth).toBeGreaterThanOrEqual(0.1);
    expect(growth).toBeLessThanOrEqual(0.12);
  });

  test("panning 10 plot widths either way keeps real data in the plot", async ({ page }) => {
    await openChart(page);
    const box = (await canvas(page).boundingBox())!;
    const y = box.y + box.height * 0.5;
    const sweep = async (fromX: number, toX: number): Promise<void> => {
      await page.mouse.move(fromX, y);
      await page.mouse.down();
      await page.mouse.move(toX, y, { steps: 4 });
      await page.mouse.up();
    };
    const leftX = box.x + 20;
    const rightX = box.x + box.width - 120;
    for (let i = 0; i < 10; i++) await sweep(leftX, rightX);
    let s = await state(page);
    expect(visibleBars(s)).toBeGreaterThanOrEqual(3);
    expect(s.priceMax - s.priceMin).toBeGreaterThan(1);
    expect(s.priceMin).toBeGreaterThan(1);
    for (let i = 0; i < 12; i++) await sweep(rightX, leftX);
    s = await state(page);
    expect(visibleBars(s)).toBeGreaterThanOrEqual(3);
    expect(s.priceMin).toBeGreaterThan(1);
  });

  test("a zoom-out after ALL never shrinks the span", async ({ page }) => {
    await openChart(page);
    await page.getByRole("button", { name: "Range ALL" }).click();
    const all = span(await state(page));
    const box = (await canvas(page).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.wheel(0, 100);
    expect(span(await state(page))).toBeGreaterThanOrEqual(all);
    await page.mouse.wheel(0, 100);
    expect(span(await state(page))).toBeGreaterThanOrEqual(all);
  });

  test("a body drag moves every anchor by the same delta with one undo entry", async ({ page }) => {
    await openChart(page);
    const { id, points, mid } = await trendFixture(page);
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    await page.mouse.move(mid.x + 60, mid.y + 60, { steps: 6 });
    await page.mouse.up();
    const moved = await pointsOf(page, id);
    const dt = moved.map((point, i) => point.time - points[i]!.time);
    const dp = moved.map((point, i) => point.price - points[i]!.price);
    expect(dt[0]).toBe(dt[1]);
    expect(dt[0]! % 60).toBe(0);
    expect(dt[0]).toBeGreaterThan(0);
    expect(dp[0]).toBeCloseTo(dp[1]!, 6);
    expect(dp[0]).toBeLessThan(0);
    await undo(page);
    expect(await pointsOf(page, id)).toEqual(points);
    await undo(page);
    expect(await pointsOf(page, id)).toEqual([]);
  });

  test("dragging an anchor handle moves only that anchor", async ({ page }) => {
    await openChart(page);
    const { id, points, i1, price, map } = await trendFixture(page);
    await page.mouse.move(map.x(i1), map.y(price));
    await page.mouse.down();
    await page.mouse.move(map.x(i1) - 40, map.y(price) - 30, { steps: 4 });
    await page.mouse.up();
    const moved = await pointsOf(page, id);
    expect(moved[0]).not.toEqual(points[0]);
    expect(moved[1]).toEqual(points[1]);
  });

  test("a click with 1px of jitter is a no-op and adds no undo entry", async ({ page }) => {
    await openChart(page);
    const { id, points, mid } = await trendFixture(page);
    const events: string[] = [];
    await page.exposeFunction("recordDrawingEvent", (type: string) => events.push(type));
    await page.evaluate(() => {
      const widget = (window as unknown as { __razeChart: { subscribe(e: string, cb: (...a: unknown[]) => void): void } }).__razeChart;
      widget.subscribe("drawing_event", (_id, type) => (window as unknown as { recordDrawingEvent(t: unknown): void }).recordDrawingEvent(type));
    });
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    await page.mouse.move(mid.x + 1, mid.y + 1);
    await page.mouse.up();
    expect(await pointsOf(page, id)).toEqual(points);
    await expect.poll(() => events).toEqual(["click"]);
    await undo(page);
    expect(await pointsOf(page, id)).toEqual([]);
  });

  test("overlapping drawings select the one painted on top", async ({ page }) => {
    await openChart(page);
    const bottom = await trendFixture(page, { zOrder: "bottom", overrides: { linecolor: "#f23645" } });
    const top = await createTrend(page, bottom.points, { zOrder: "top" });
    await frames(page);
    await page.mouse.click(bottom.mid.x, bottom.mid.y);
    await page.keyboard.press("Delete");
    expect(await pointsOf(page, top)).toEqual([]);
    expect(await pointsOf(page, bottom.id)).toEqual(bottom.points);
  });

  test("Escape during a drag restores the drawing and commits nothing", async ({ page }) => {
    await openChart(page);
    const { id, points, mid } = await trendFixture(page);
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    await page.mouse.move(mid.x + 40, mid.y - 40, { steps: 4 });
    expect(await pointsOf(page, id)).not.toEqual(points);
    await page.keyboard.press("Escape");
    expect(await pointsOf(page, id)).toEqual(points);
    await page.mouse.move(mid.x + 80, mid.y - 80, { steps: 4 });
    await page.mouse.up();
    expect(await pointsOf(page, id)).toEqual(points);
    await undo(page);
    expect(await pointsOf(page, id)).toEqual([]);
  });

  test("double-clicking a drawing keeps the zoom; double-clicking empty plot still fits", async ({ page }) => {
    await openChart(page);
    const box = (await canvas(page).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100);
    const { mid } = await trendFixture(page);
    const zoomed = await state(page);
    await page.mouse.dblclick(mid.x, mid.y);
    const after = await state(page);
    expect(after.visibleRange).toEqual(zoomed.visibleRange);
    expect([after.priceMin, after.priceMax]).toEqual([zoomed.priceMin, zoomed.priceMax]);
    await page.mouse.dblclick(box.x + 30, box.y + 30);
    expect(span(await state(page))).not.toBeCloseTo(span(zoomed), 3);
  });
});

test.describe("inline text editor", () => {
  async function sandboxedChart(page: Page, baseURL: string): Promise<Frame> {
    const url = new URL("/examples/visual.html?case=dark", baseURL);
    await page.setContent(
      `<iframe title="chart" sandbox="allow-scripts allow-same-origin" src="${url.href}" style="width:1000px;height:600px;border:0"></iframe>`,
    );
    await expect.poll(() => page.frames().some((candidate) => candidate.url().includes("visual.html"))).toBe(true);
    const frame = page.frames().find((candidate) => candidate.url().includes("visual.html"))!;
    await frame.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, null, { timeout: 30_000 });
    return frame;
  }

  test("the text tool edits inline inside a sandboxed iframe", async ({ page, baseURL }) => {
    // A sandbox without allow-modals ignores prompt() and logs it; the editor never calls it.
    const promptLogs: string[] = [];
    page.on("console", (message) => {
      if (/prompt/i.test(message.text())) promptLogs.push(message.text());
    });
    page.on("dialog", (dialog) => void dialog.dismiss().then(() => promptLogs.push(dialog.message())));
    const frame = await sandboxedChart(page, baseURL!);
    await frame.getByRole("button", { name: "Text", exact: true }).click();
    const chartCanvas = frame.locator(".raze-chart-root canvas").first();
    const box = (await chartCanvas.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.35);
    const editor = frame.getByRole("textbox", { name: "Drawing text" });
    await expect(editor).toBeFocused();
    await page.keyboard.type("Hi");
    await page.keyboard.press("Enter");
    await expect(editor).toHaveCount(0);
    const texts = async (): Promise<string[]> => frame.evaluate(() => {
      const widget = (window as unknown as { __razeChart: { save(): { drawings: { shape: string; text: string }[] } } }).__razeChart;
      return widget.save().drawings.filter((drawing) => drawing.shape === "text").map((drawing) => drawing.text);
    });
    expect(await texts()).toEqual(["Hi"]);
    await expect(chartCanvas).toBeFocused();

    // Double-click re-opens the editor with the text (after the label has painted).
    await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.dblclick(box.x + box.width * 0.4 + 4, box.y + box.height * 0.35 - 6);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("Hi");
    await page.keyboard.press("End");
    await page.keyboard.type(" there");
    await page.keyboard.press("Enter");
    expect(await texts()).toEqual(["Hi there"]);

    // Escape discards an edit.
    await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.dblclick(box.x + box.width * 0.4 + 4, box.y + box.height * 0.35 - 6);
    await expect(editor).toHaveValue("Hi there");
    await page.keyboard.type(" nope");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    expect(await texts()).toEqual(["Hi there"]);
    expect(promptLogs).toEqual([]);
  });
});
