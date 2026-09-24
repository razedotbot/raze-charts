// Render loop in a real browser (W1B-07): overlay-only crosshair frames, no
// cleared frame during a live resize, width-based default spacing, fit-all
// (F and the sidebar button), layout sync after F, opaque and transparent pane
// backgrounds, and greyscale text in screenshots.

import { expect, test, type Page } from "@playwright/test";

type DebugState = { bars: number; visibleRange: { from: number; to: number }; plotW: number; barSpacing: number };
type Api = { getVisibleRange(): { from: number; to: number } };
type HarnessWindow = Window & {
  __razeReady?: boolean;
  __razeChart: { activeChart(): Api; chart(index?: number): Api };
  __razeChartState?: DebugState;
  __layerSpy?: { main: { paints: number; calls: number }; overlay: { paints: number }; frames: number };
};

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/examples/render-loop.html${query ? `?${query}` : ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as HarnessWindow).__razeReady === true, undefined, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
}

/** Two animation frames: every invalidation queued so far has painted. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/**
 * Spy on the two layer canvases' own 2D contexts: every layer paint is one
 * outermost save()/restore() pair, so those count paints; `frames` counts
 * animation frames.
 */
async function installLayerSpy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as HarnessWindow;
    const spy = { main: { paints: 0, calls: 0 }, overlay: { paints: 0 }, frames: 0 };
    const main = document.querySelector<HTMLCanvasElement>("canvas.raze-chart-layer-main")!.getContext("2d")!;
    const overlay = document.querySelector<HTMLCanvasElement>("canvas.raze-chart-canvas")!.getContext("2d")!;
    const wrap = (ctx: CanvasRenderingContext2D, name: string, onCall: () => void): void => {
      const original = (ctx as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
      (ctx as unknown as Record<string, unknown>)[name] = function spied(this: unknown, ...args: unknown[]) {
        onCall();
        return original.apply(this, args);
      };
    };
    for (const name of ["setTransform", "fillRect", "clearRect", "fillText", "stroke", "fill", "drawImage"]) {
      wrap(main, name, () => { spy.main.calls += 1; });
    }
    // A layer paint is one outermost save()/restore() pair: the engine sets
    // the device transform inside it, and bitmap-space painters (paint/pixel.ts)
    // set their own transforms in nested saves, so setTransform no longer
    // counts paints.
    const countPaints = (ctx: CanvasRenderingContext2D, onPaint: () => void): void => {
      let depth = 0;
      wrap(ctx, "save", () => {
        depth += 1;
        if (depth === 1) onPaint();
      });
      wrap(ctx, "restore", () => { depth = Math.max(0, depth - 1); });
    };
    countPaints(main, () => { spy.main.paints += 1; });
    countPaints(overlay, () => { spy.overlay.paints += 1; });
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => raf((time) => {
      spy.frames += 1;
      callback(time);
    });
    w.__layerSpy = spy;
  });
}

const layerSpy = (page: Page) => page.evaluate(() => {
  const spy = (window as unknown as HarnessWindow).__layerSpy!;
  return { main: { ...spy.main }, overlay: { ...spy.overlay }, frames: spy.frames };
});

async function plotBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator("canvas.raze-chart-canvas").first().boundingBox();
  if (!box) throw new Error("chart canvas not laid out");
  return box;
}

test.describe("render loop", () => {
  test("100 crosshair pointermoves paint only the overlay, at most once per frame", async ({ page }) => {
    await open(page);
    const box = await plotBox(page);
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await settle(page);
    await installLayerSpy(page);
    for (let i = 0; i < 100; i++) {
      const phase = i / 100;
      await page.mouse.move(box.x + box.width * (0.1 + phase * 0.7), box.y + box.height * (0.2 + (i % 10) * 0.04));
    }
    await settle(page);
    const spy = await layerSpy(page);
    expect(spy.main.paints, "main-layer paints during 100 crosshair moves").toBe(0);
    expect(spy.main.calls, "draw calls on the main layer during 100 crosshair moves").toBe(0);
    expect(spy.overlay.paints).toBeGreaterThan(0);
    expect(spy.overlay.paints, "the overlay paints at most once per animation frame").toBeLessThanOrEqual(spy.frames);
    // The crosshair really moved: the overlay holds it, the scene does not.
    const crosshairDrawn = await page.evaluate(() => {
      const overlay = document.querySelector<HTMLCanvasElement>("canvas.raze-chart-canvas")!;
      const data = overlay.getContext("2d")!.getImageData(0, 0, overlay.width, overlay.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) painted += 1;
      return painted;
    });
    expect(crosshairDrawn, "the overlay bitmap holds the crosshair").toBeGreaterThan(100);
  });

  test("a live resize never presents a cleared canvas and paints once per resize", async ({ page }) => {
    await open(page, "width=900");
    await installLayerSpy(page);
    const result = await page.evaluate(async () => {
      const wrap = document.getElementById("wrap")!;
      const canvas = document.querySelector<HTMLCanvasElement>("canvas.raze-chart-layer-main")!;
      const host = canvas.parentElement!;
      const ctx = canvas.getContext("2d")!;
      const samples: { cleared: boolean }[] = [];
      // Registered after the engine's observer, so it runs just before the
      // browser presents the frame, like the audit probe (run-resize.mjs).
      const probe = new ResizeObserver(() => {
        const px = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        const cleared = px[3] === 0 || (px[0] === 0 && px[1] === 0 && px[2] === 0);
        samples.push({ cleared });
      });
      probe.observe(host);
      const spy = (window as unknown as HarnessWindow).__layerSpy!;
      const nextFrame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
      await nextFrame();
      samples.length = 0;
      for (let i = 1; i <= 30; i++) {
        wrap.style.width = `${900 - i * 9}px`;
        await nextFrame();
      }
      await nextFrame();
      await nextFrame();
      // One more resize in isolation: exactly one main paint.
      const before = spy.main.paints;
      wrap.style.width = "700px";
      await nextFrame();
      await nextFrame();
      await nextFrame();
      probe.disconnect();
      return { frames: samples.length, cleared: samples.filter((s) => s.cleared).length, singleResizePaints: spy.main.paints - before };
    });
    expect(result.frames).toBeGreaterThanOrEqual(30);
    expect(result.cleared, "resize frames presented with a cleared canvas").toBe(0);
    expect(result.singleResizePaints, "main paints caused by one resize").toBe(1);
  });

  for (const width of [390, 480, 1280]) {
    test(`boot bar spacing is 6±1 px at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await open(page, "bars=2000");
      const state = await page.evaluate(() => (window as unknown as HarnessWindow).__razeChartState!);
      expect(Math.abs(state.barSpacing - 6), `bar spacing ${state.barSpacing.toFixed(2)} px`).toBeLessThanOrEqual(1);
    });
  }

  test("F fits every loaded bar", async ({ page }) => {
    await open(page, "bars=5000");
    await page.locator("canvas.raze-chart-canvas").first().focus();
    await page.keyboard.press("f");
    await settle(page);
    const state = await page.evaluate(() => (window as unknown as HarnessWindow).__razeChartState!);
    // The mock feed serves its first page of history; F fits all of it.
    expect(state.bars).toBeGreaterThan(1000);
    expect(state.visibleRange.from).toBeLessThanOrEqual(0);
    expect(state.visibleRange.to).toBeGreaterThanOrEqual(state.bars - 1);
    expect(state.visibleRange.to - state.visibleRange.from).toBeGreaterThanOrEqual(state.bars);
    await expect(page.locator(".raze-chart-a11y-status").first()).toHaveText("Chart fitted to all data.");
    await expect(page.locator(".raze-chart-a11y-description").first()).toContainText("F fits all loaded data");
  });

  test("the sidebar Fit button fits every loaded bar", async ({ page }) => {
    await open(page, "bars=5000");
    await page.getByRole("button", { name: "Fit content (F)" }).click();
    await settle(page);
    const state = await page.evaluate(() => (window as unknown as HarnessWindow).__razeChartState!);
    expect(state.visibleRange.from).toBeLessThanOrEqual(0);
    expect(state.visibleRange.to - state.visibleRange.from).toBeGreaterThanOrEqual(state.bars);
  });

  test("a screenshot repaints both layers into an alpha canvas, so exported text is greyscale", async ({ page }) => {
    await open(page);
    const box = await plotBox(page);
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
    await settle(page);
    await page.evaluate(() => {
      const proto = HTMLCanvasElement.prototype;
      const original = proto.toBlob;
      // Capture the exported canvas instead of downloading it.
      proto.toBlob = function capture(this: HTMLCanvasElement) {
        (window as unknown as { __exported?: HTMLCanvasElement }).__exported = this;
        proto.toBlob = original;
      };
    });
    await page.getByRole("button", { name: "Screenshot" }).click();
    const result = await page.evaluate(() => {
      const exported = (window as unknown as { __exported?: HTMLCanvasElement }).__exported;
      const main = document.querySelector<HTMLCanvasElement>("canvas.raze-chart-layer-main")!;
      const overlay = document.querySelector<HTMLCanvasElement>("canvas.raze-chart-canvas")!;
      if (!exported) return null;
      const ctx = exported.getContext("2d")!;
      // The time-axis labels left of the price axis: neutral text (and the
      // neutral crosshair pill) on the pane background, nothing coloured.
      // Chromium's LCD text on the opaque scene layer shows colour fringes
      // there; an export with greyscale text shows none.
      const plotW = (window as unknown as HarnessWindow).__razeChartState!.plotW;
      const band = (c: CanvasRenderingContext2D) => c.getImageData(0, main.height - 22, Math.floor(plotW) - 1, 22).data;
      const chromatic = (data: Uint8ClampedArray) => {
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
          if (Math.max(r, g, b) - Math.min(r, g, b) > 40) count += 1;
        }
        return count;
      };
      const exportedPx = band(ctx);
      let text = 0;
      for (let i = 0; i < exportedPx.length; i += 4) if (exportedPx[i]! > 90) text += 1;
      // The overlay must be in the export too: the legend values live only on
      // the overlay, so the export differs from the scene layer in the legend.
      const legend = (c: CanvasRenderingContext2D) => c.getImageData(8, 6, 280, 34).data;
      const scenePx = legend(main.getContext("2d")!);
      const exportLegend = legend(ctx);
      let overlayPainted = 0;
      for (let i = 0; i < scenePx.length; i += 4) {
        if (Math.max(Math.abs(scenePx[i]! - exportLegend[i]!), Math.abs(scenePx[i + 1]! - exportLegend[i + 1]!), Math.abs(scenePx[i + 2]! - exportLegend[i + 2]!)) > 60) {
          overlayPainted += 1;
        }
      }
      return {
        alpha: ctx.getContextAttributes?.().alpha ?? null,
        size: [exported.width, exported.height, main.width, main.height],
        isLayer: exported === main || exported === overlay,
        exportedChromatic: chromatic(exportedPx),
        // Informational: platforms without LCD text report 0 here too.
        screenChromatic: chromatic(band(main.getContext("2d")!)),
        text,
        overlayPainted,
      };
    });
    test.info().annotations.push({ type: "lcd", description: `on-screen scene chromatic pixels in the time axis: ${result?.screenChromatic}` });
    expect(result, "takeScreenshot exported a canvas").not.toBeNull();
    expect(result!.text, "the sampled band holds the time-axis labels").toBeGreaterThan(50);
    expect(result!.isLayer, "the export is its own canvas, not a single layer").toBe(false);
    expect(result!.alpha, "the export canvas keeps alpha").toBe(true);
    expect(result!.size.slice(0, 2)).toEqual(result!.size.slice(2));
    expect(result!.overlayPainted, "the export includes the overlay (legend values)").toBeGreaterThan(100);
    expect(result!.exportedChromatic, "chromatic pixels in the exported time-axis labels (LCD fringes)").toBe(0);
  });

  test("a 2x1 layout stays synced after F", async ({ page }) => {
    await open(page, "layout=2x1&bars=1500");
    await page.waitForFunction(() => (window as unknown as HarnessWindow).__razeChart.chart(1).getVisibleRange().to > 0);
    const booted = await page.evaluate(() => {
      const w = (window as unknown as HarnessWindow).__razeChart;
      return [w.chart(0).getVisibleRange(), w.chart(1).getVisibleRange()];
    });
    expect(booted[0], "the panes boot with equal ranges").toEqual(booted[1]);
    const top = page.locator(".raze-chart-layout-pane[data-pane-index='0'] canvas.raze-chart-canvas");
    const box = await top.boundingBox();
    if (!box) throw new Error("top pane not laid out");
    // Zoom out in the top pane first (synced), then fit it.
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.wheel(0, 300);
    await settle(page);
    await top.focus();
    await page.keyboard.press("f");
    await page.waitForFunction(() => {
      const w = (window as unknown as HarnessWindow).__razeChart;
      const a = w.chart(0).getVisibleRange();
      const b = w.chart(1).getVisibleRange();
      return a.from === b.from && a.to === b.to;
    }, undefined, { timeout: 5_000 });
    const ranges = await page.evaluate(() => {
      const w = (window as unknown as HarnessWindow).__razeChart;
      return [w.chart(0).getVisibleRange(), w.chart(1).getVisibleRange()];
    });
    expect(ranges[0]).toEqual(ranges[1]);
  });

  test("a 2x1 layout boots in sync and keeps each pane's bar spacing through a live resize", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 620 });
    await open(page, "layout=2x1&bars=1500");
    await page.waitForFunction(() => (window as unknown as HarnessWindow).__razeChart.chart(1).getVisibleRange().to > 0);
    await settle(page);
    // Each pane's own debug state (fractional index range, plot width) and API range.
    const panes = () => page.evaluate(() => {
      const w = window as unknown as HarnessWindow;
      return [0, 1].map((index) => {
        const canvas = document.querySelector(`.raze-chart-layout-pane[data-pane-index='${index}'] canvas.raze-chart-canvas`) as
          (HTMLCanvasElement & { __razeChartState?: DebugState }) | null;
        const state = canvas?.__razeChartState;
        if (!state) throw new Error(`pane ${index} has not painted`);
        const { from, to } = state.visibleRange;
        return { range: { from, to }, spacing: state.plotW / (to - from), api: w.__razeChart.chart(index).getVisibleRange() };
      });
    });
    const boot = await panes();
    expect(boot[0].range, "both panes boot with the same range").toEqual(boot[1].range);
    expect(boot[0].api).toEqual(boot[1].api);
    const spacing = boot[0].spacing;
    expect(Math.abs(spacing - 6), `boot spacing ${spacing.toFixed(3)} px`).toBeLessThanOrEqual(0.25);
    for (const width of [800, 600, 1100]) {
      await page.setViewportSize({ width, height: 620 });
      await settle(page);
      const after = await panes();
      expect(after[0].range, `both panes share one range at ${width}px`).toEqual(after[1].range);
      expect(after[0].api).toEqual(after[1].api);
      for (const pane of after) {
        // A relayed resize used to rescale the sibling twice (span x ratio²): 9.2 px at 800.
        expect(Math.abs(pane.spacing - spacing), `bar spacing at ${width}px: ${pane.spacing.toFixed(3)} px`).toBeLessThan(0.01);
      }
    }
    const back = (await panes())[0].range;
    expect(back.to, "the right edge never moved").toBe(boot[0].range.to);
    expect(back.from, "back at the boot width, the boot view returns").toBeCloseTo(boot[0].range.from, 6);

    // One resize paints each pane's scene once: no relayed range makes the
    // sibling paint a second time in the next frame.
    await page.evaluate(() => {
      const counts: number[] = [];
      document.querySelectorAll<HTMLCanvasElement>(".raze-chart-layout-pane canvas.raze-chart-layer-main").forEach((canvas, index) => {
        counts[index] = 0;
        const ctx = canvas.getContext("2d")!;
        // One paint is one outermost save(); bitmap-space painters set their
        // own transforms inside nested saves.
        let depth = 0;
        const save = ctx.save.bind(ctx);
        const restore = ctx.restore.bind(ctx);
        ctx.save = () => {
          depth += 1;
          if (depth === 1) counts[index] = (counts[index] ?? 0) + 1;
          save();
        };
        ctx.restore = () => {
          depth = Math.max(0, depth - 1);
          restore();
        };
      });
      (window as unknown as { __paneMainPaints?: number[] }).__paneMainPaints = counts;
    });
    await page.setViewportSize({ width: 900, height: 620 });
    await settle(page);
    await settle(page);
    const paints = await page.evaluate(() => (window as unknown as { __paneMainPaints: number[] }).__paneMainPaints);
    expect(paints, "main-layer paints per pane for one resize").toEqual([1, 1]);
  });

  test("an opaque pane uses an alpha:false scene layer; a transparent pane shows the page behind it", async ({ page }) => {
    await open(page);
    const opaque = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("canvas.raze-chart-layer-main")!;
      const attributes = canvas.getContext("2d")!.getContextAttributes?.();
      return attributes ? attributes.alpha : null;
    });
    expect(opaque).toBe(false);

    await open(page, "bg=rgba(0,0,0,0)&pagebg=rgb(40,90,160)&bars=6");
    const transparent = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("canvas.raze-chart-layer-main")!;
      const ctx = canvas.getContext("2d")!;
      const alpha = ctx.getContextAttributes?.().alpha ?? null;
      // With six bars on the right, the left half of the plot is empty.
      const data = ctx.getImageData(Math.floor(canvas.width * 0.1), Math.floor(canvas.height * 0.3), 40, 40).data;
      let clear = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] === 0) clear += 1;
      return { alpha, clearRatio: clear / (data.length / 4) };
    });
    expect(transparent.alpha).toBe(true);
    expect(transparent.clearRatio, "empty plot pixels stay transparent").toBeGreaterThan(0.9);
    const box = await plotBox(page);
    const shot = await page.screenshot({ clip: { x: box.x + box.width * 0.1, y: box.y + box.height * 0.3, width: 40, height: 40 } });
    const pageColour = await page.evaluate(async (png) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, image.width, image.height).data;
      let match = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i]! - 40) <= 3 && Math.abs(data[i + 1]! - 90) <= 3 && Math.abs(data[i + 2]! - 160) <= 3) match += 1;
      }
      return match / (data.length / 4);
    }, shot.toString("base64"));
    expect(pageColour, "the page background composites through a transparent pane").toBeGreaterThan(0.9);
  });
});
