import { test, expect, type Page } from "@playwright/test";

// Real-browser checks for the measured native axes: the compiler estimates
// label widths without a DOM, and these tests hold that estimate against the
// browser's own text layout (SVG getBBox and Canvas measureText), plus the
// Chromium compile budget for a 10k-point line.

const HARNESS = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Native axes</title></head>
<body style="margin:0"><div id="host"></div></body>
</html>`;

async function openHarness(page: Page): Promise<void> {
  await page.route("**/__native-axes/index.html", (route) => route.fulfill({ body: HARNESS, contentType: "text/html" }));
  await page.goto("/__native-axes/index.html");
  await page.evaluate(async () => {
    (window as unknown as { chart: unknown }).chart = await import("/dist/chart.esm.js" as string);
  });
  await page.evaluate(() => document.fonts.ready);
}

interface Box { x: number; y: number; width: number; height: number; text: string }
interface Rendered {
  plot: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
  yLabels: Box[];
  xLabels: Box[];
  chips: { text: Box; rect: Box }[];
}

/** Compile `source` (a function body returning a ChartSpec), render SVG into the page and return label boxes. */
async function renderSvg(page: Page, source: string, size: { width: number; height: number }): Promise<Rendered> {
  return page.evaluate(({ source, size }) => {
    const chart = (window as unknown as { chart: Record<string, any> }).chart;
    const spec = new Function("chart", source)(chart);
    const scene = chart.compileChart(chart.defineChart(spec), size);
    const host = document.getElementById("host")!;
    host.style.width = `${size.width}px`;
    host.style.height = `${size.height}px`;
    host.innerHTML = chart.svgFromCompiled(scene);
    const svg = host.querySelector("svg")!;
    const origin = svg.getBoundingClientRect();
    const box = (element: Element): { x: number; y: number; width: number; height: number; text: string } => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height, text: element.textContent ?? "" };
    };
    const texts = [...svg.querySelectorAll("text")];
    const yLabels = texts.filter((text) => Number(text.getAttribute("x")) === scene.width - 7).map(box);
    const xLabels = [...svg.querySelectorAll("[data-role='x-labels'] text")].map(box);
    const chips = texts
      .filter((text) => text.getAttribute("font-weight") === "600" && text.previousElementSibling?.getAttribute("rx") === "2.5")
      .map((text) => ({ text: box(text), rect: box(text.previousElementSibling!) }));
    return { plot: scene.plot, width: scene.width, height: scene.height, yLabels, xLabels, chips };
  }, { source, size });
}

function expectNoOverlap(boxes: Box[], label: string): void {
  const sorted = [...boxes].sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i]!.x, `${label}: "${sorted[i - 1]!.text}" / "${sorted[i]!.text}"`).toBeGreaterThanOrEqual(sorted[i - 1]!.x + sorted[i - 1]!.width);
  }
}

test.describe("native measured axes", () => {
  test.beforeEach(async ({ page }) => {
    await openHarness(page);
  });

  test("1.2e12 value labels and chips never overlap the plot", async ({ page }) => {
    const rendered = await renderSvg(page, `
      const rows = [1.2e12, 1.4e12, 1.5e12, 1.1e12, 1.25e12].map((y, x) => ({ x, y }));
      return { marks: [chart.area(rows, { x: "x", y: "y", name: "Large" })] };
    `, { width: 520, height: 300 });
    const plotRight = rendered.plot.x + rendered.plot.w;
    expect(rendered.yLabels.length).toBeGreaterThan(2);
    for (const label of rendered.yLabels) {
      expect(label.x, `"${label.text}" clears the plot`).toBeGreaterThanOrEqual(plotRight + 2);
      expect(label.x + label.width).toBeLessThanOrEqual(rendered.width);
    }
    expect(rendered.chips.length).toBe(1);
    const [{ text, rect }] = rendered.chips;
    expect(text.text).toBe("1.25T");
    expect(text.x).toBeGreaterThanOrEqual(rect.x);
    expect(text.x + text.width).toBeLessThanOrEqual(rect.x + rect.width);
  });

  test("last-value chips of computed series keep their text inside the chip and off the plot", async ({ page }) => {
    const series = {
      sine: "Array.from({ length: 50 }, (_, x) => ({ x, y: Math.sin(x / 5) }))",
      walk: "(() => { let v = 100, s = 7; return Array.from({ length: 200 }, (_, x) => ({ x, y: (v += ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5) })); })()",
      compact: "Array.from({ length: 10 }, (_, x) => ({ x, y: 25_000_000 + 400 * x / 9 }))",
    };
    for (const [name, rows] of Object.entries(series)) {
      for (const width of [360, 600]) {
        const rendered = await renderSvg(page, `
          return { marks: [chart.line(${rows}, { x: "x", y: "y", name: "${name}" })] };
        `, { width, height: 260 });
        expect(rendered.chips.length, `${name} @ ${width}px`).toBe(1);
        const [{ text, rect }] = rendered.chips;
        const label = `${name} @ ${width}px: "${text.text}"`;
        expect(rect.x, label).toBeGreaterThanOrEqual(rendered.plot.x + rendered.plot.w);
        expect(rect.x + rect.width, label).toBeLessThanOrEqual(rendered.width);
        expect(text.x, label).toBeGreaterThanOrEqual(rect.x);
        expect(text.x + text.width, label).toBeLessThanOrEqual(rect.x + rect.width);
      }
    }
  });

  test("Canvas measureText agrees that value labels fit their gutter", async ({ page }) => {
    const result = await page.evaluate(() => {
      const chart = (window as unknown as { chart: Record<string, any> }).chart;
      const rows = Array.from({ length: 5 }, (_, x) => ({ x, y: 1000 + x * 250 }));
      const scene = chart.compileChart(chart.defineChart({
        marks: [chart.line(rows, { x: "x", y: "y" })],
        scales: { y: { tickFormat: (v: unknown) => `$${Number(v).toFixed(2)} USD` } },
      }), { width: 480, height: 280 });
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `9px ${scene.theme.font}`;
      const plotRight = scene.plot.x + scene.plot.w;
      return scene.yTicks.map((tick: { label: string }) => scene.width - 7 - ctx.measureText(tick.label).width - plotRight);
    });
    for (const clearance of result) expect(clearance).toBeGreaterThanOrEqual(2);
  });

  test("time labels at 400px stay inside the chart and never overlap", async ({ page }) => {
    for (const span of [90 * 60_000, 6.5 * 3_600_000, 30 * 86_400_000, 800 * 86_400_000, 3650 * 86_400_000]) {
      const rendered = await renderSvg(page, `
        const rows = Array.from({ length: 300 }, (_, i) => ({ t: new Date(Date.UTC(2021, 2, 1, 9, 30) + (${span} * i) / 299), v: i }));
        return { marks: [chart.line(rows, { x: "t", y: "v" })] };
      `, { width: 400, height: 240 });
      expect(rendered.xLabels.length, `span ${span}`).toBeGreaterThanOrEqual(2);
      for (const label of rendered.xLabels) {
        expect(label.x).toBeGreaterThanOrEqual(0);
        expect(label.x + label.width).toBeLessThanOrEqual(rendered.width);
      }
      expectNoOverlap(rendered.xLabels, `span ${span}`);
    }
  });

  test("category labels thin or rotate without overlapping or leaving the chart", async ({ page }) => {
    for (const width of [300, 480, 760, 1200]) {
      const horizontal = await renderSvg(page, `
        const rows = Array.from({ length: 40 }, (_, i) => ({ k: "Week " + (i + 1), v: (i * 7) % 11 }));
        return { marks: [chart.bar(rows, { x: "k", y: "v" })], scales: { x: { type: "band", labels: { rotate: false } } } };
      `, { width, height: 260 });
      expectNoOverlap(horizontal.xLabels, `horizontal @ ${width}px`);
      for (const label of horizontal.xLabels) {
        expect(label.x).toBeGreaterThanOrEqual(0);
        expect(label.x + label.width).toBeLessThanOrEqual(width);
      }
      const rotated = await renderSvg(page, `
        const regions = ["North America", "South America", "Europe", "Middle East & Africa", "Asia Pacific", "Oceania"];
        return { marks: [chart.bar(regions.map((k, v) => ({ k, v: v + 1 })), { x: "k", y: "v" })] };
      `, { width: Math.min(width, 420), height: 300 });
      const plotBottom = rotated.plot.y + rotated.plot.h;
      for (const label of rotated.xLabels) {
        expect(label.x, `"${label.text}" left`).toBeGreaterThanOrEqual(-0.5);
        expect(label.y, `"${label.text}" below the plot`).toBeGreaterThanOrEqual(plotBottom);
        expect(label.y + label.height, `"${label.text}" inside the chart`).toBeLessThanOrEqual(rotated.height + 0.5);
      }
    }
  });

  test("a 10k-point line compiles within 6 ms in Chromium", async ({ page }) => {
    const median = await page.evaluate(() => {
      const chart = (window as unknown as { chart: Record<string, any> }).chart;
      let value = 100;
      const rows = Array.from({ length: 10_000 }, (_, index) => ({ x: index, y: (value += ((index * 17) % 23 - 11) * 0.0025) }));
      const definition = chart.defineChart({
        marks: [chart.line(rows, { x: "x", y: "y", name: "Benchmark", lastValue: false })],
        grid: false,
        legend: false,
        tooltip: true,
      });
      const medians: number[] = [];
      for (let run = 0; run < 3; run++) {
        for (let i = 0; i < 3; i++) chart.compileChart(definition, { width: 1280, height: 720 });
        const times: number[] = [];
        for (let i = 0; i < 15; i++) {
          const start = performance.now();
          chart.compileChart(definition, { width: 1280, height: 720 });
          times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        medians.push(times[7]!);
      }
      return Math.min(...medians);
    });
    expect(median).toBeLessThanOrEqual(6);
  });
});
