import { test, expect, type Page } from "@playwright/test";

// Real-browser checks for mounted /chart charts (W1B-03): overlay alignment
// with range presets and the navigator, edge tick labels inside the SVG, and
// legend toggles by pointer and keyboard on the Canvas renderer.

interface Box { x: number; y: number; width: number; height: number }
interface MountInfo {
  stage: Box;
  nav: Box | null;
  plot: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
  samples: { x: number; y: number }[];
}

async function openFixture(page: Page): Promise<void> {
  await page.goto("/tests/fixtures/native-mount.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
}

async function mountRevenue(page: Page, options: Record<string, unknown>): Promise<MountInfo> {
  return page.evaluate((mountOptions) => {
    const w = window as unknown as {
      __chart: any;
      __handle: any;
    };
    const { defineChart, line, mountChart } = w.__chart;
    const start = Date.UTC(2026, 8, 9);
    const rows = Array.from({ length: 90 }, (_, i) => ({ t: start + i * 86_400_000, v: 120 + 30 * Math.sin(i / 9) + i / 2 }));
    const host = document.getElementById("host")!;
    w.__handle = mountChart(host, defineChart({
      marks: [line(rows, { x: "t", y: "v", name: "Revenue" })],
      scales: { x: { type: "time" } },
      legend: false,
      ariaLabel: "Revenue",
    }), mountOptions);
    const scene = w.__handle.getScene();
    const wrap = host.firstElementChild as HTMLElement;
    const toBox = (el: Element | null): Box | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const nav = [...wrap.children].find((child) => child.querySelector("canvas[aria-hidden='true']")) ?? null;
    return {
      stage: toBox(wrap.firstElementChild)!,
      nav: toBox(nav),
      plot: scene.plot,
      width: scene.width,
      height: scene.height,
      samples: scene.samples.map((sample: { x: number; y: number }) => ({ x: sample.x, y: sample.y })),
    };
  }, options);
}

test.describe("native mount overlay", () => {
  test("hover dot and X chip stay on the scene with range presets and the navigator", async ({ page }) => {
    await openFixture(page);
    const info = await mountRevenue(page, { interaction: { rangePresets: true, navigator: true } });
    expect(info.nav, "the navigator is shown").not.toBeNull();
    expect(info.height).toBeCloseTo(info.stage.height, 0);
    for (const index of [8, 45, 80]) {
      const sample = info.samples[index]!;
      await page.mouse.move(info.stage.x + sample.x, info.stage.y + sample.y);
      const overlay = await page.evaluate(() => {
        const wrap = document.getElementById("host")!.firstElementChild as HTMLElement;
        const children = [...wrap.children] as HTMLElement[];
        const dot = children.find((el) => el.style.borderRadius === "50%")!;
        const chips = children.filter((el) => el.style.whiteSpace === "nowrap" && el.style.display === "block");
        const box = (el: HTMLElement) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        return { dot: box(dot), chips: chips.map(box) };
      });
      const dotX = overlay.dot.x + overlay.dot.width / 2;
      const dotY = overlay.dot.y + overlay.dot.height / 2;
      expect(Math.abs(dotX - (info.stage.x + sample.x)), "dot x within 1px").toBeLessThanOrEqual(1);
      expect(Math.abs(dotY - (info.stage.y + sample.y)), "dot y within 1px").toBeLessThanOrEqual(1);
      const axisTop = info.stage.y + info.plot.y + info.plot.h;
      const axisBottom = info.stage.y + info.height;
      const chipX = overlay.chips.find((chip) => chip.y >= axisTop - 1);
      expect(chipX, "the X chip is shown below the plot").toBeTruthy();
      expect(chipX!.y + chipX!.height, "the X chip stays in the x-axis band").toBeLessThanOrEqual(axisBottom + 1);
      expect(chipX!.y + chipX!.height, "the X chip never covers the navigator").toBeLessThanOrEqual(info.nav!.y);
    }
  });

  test("first and last x tick labels stay inside the SVG", async ({ page }) => {
    await openFixture(page);
    await mountRevenue(page, { interaction: { rangePresets: true, navigator: true } });
    const result = await page.evaluate(() => {
      const svg = document.querySelector("#host svg")!;
      const bounds = svg.getBoundingClientRect();
      const labels = [...svg.querySelectorAll("[data-role='x-labels'] text")].map((text) => {
        const r = text.getBoundingClientRect();
        return { text: text.textContent, left: r.left, right: r.right };
      });
      return { left: bounds.left, right: bounds.right, labels };
    });
    expect(result.labels.length).toBeGreaterThan(2);
    for (const label of result.labels) {
      expect(label.left, `"${label.text}" starts inside the SVG`).toBeGreaterThanOrEqual(result.left - 0.5);
      expect(label.right, `"${label.text}" ends inside the SVG`).toBeLessThanOrEqual(result.right + 0.5);
    }
  });

  test("canvas legend toggles by pointer and by keyboard", async ({ page }) => {
    await openFixture(page);
    await page.evaluate(() => {
      const w = window as unknown as { __chart: any; __handle: any };
      const { defineChart, line, mountChart } = w.__chart;
      w.__handle = mountChart(document.getElementById("host")!, defineChart({
        marks: [
          line([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 2 }], { x: "x", y: "y", name: "Alpha" }),
          line([{ x: 0, y: 2 }, { x: 1, y: 1 }, { x: 2, y: 4 }], { x: "x", y: "y", name: "Beta" }),
        ],
      }), { renderer: "canvas" });
    });
    const series = () => page.evaluate(() => {
      const handle = (window as unknown as { __handle: any }).__handle;
      return [...new Set(handle.getScene().samples.map((sample: { series: string }) => sample.series))];
    });
    const alpha = page.getByRole("button", { name: "Alpha" });
    await expect(alpha).toHaveAttribute("aria-pressed", "true");
    await alpha.click();
    expect(await series()).toEqual(["Beta"]);
    const beta = page.getByRole("button", { name: "Beta" });
    await beta.focus();
    await expect(beta).toBeFocused();
    await page.keyboard.press("Space");
    expect(await series()).toEqual([]);
  });
});
