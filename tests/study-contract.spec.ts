import { expect, test } from "@playwright/test";

// Real-browser check for the defineIndicator v2 contract (W1B-15): a fill
// between two plot outputs is painted on the canvas. Incremental update()
// semantics are covered headlessly by tests/study-contract.mjs.

interface ProbeWindow {
  __fillProbe?: {
    countFill(): number;
    addStudy(): Promise<string>;
    stats(): { inits: number; updates: number };
  };
}

const probe = (page: import("@playwright/test").Page) => ({
  countFill: () => page.evaluate(() => (window as unknown as ProbeWindow).__fillProbe!.countFill()),
  addStudy: () => page.evaluate(() => (window as unknown as ProbeWindow).__fillProbe!.addStudy()),
  stats: () => page.evaluate(() => (window as unknown as ProbeWindow).__fillProbe!.stats()),
});

test("a fill between two defineIndicator outputs renders on the canvas", async ({ page }) => {
  await page.goto("/examples/visual.html?case=dark", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, { timeout: 30_000 });

  await page.evaluate(async () => {
    const load = (path: string) => import(path);
    const [{ widget }, studies, { makeMockDatafeed, VISUAL_NOW }] = await Promise.all([
      load("/dist/charting_library.esm.js"),
      load("/dist/studies.esm.js"),
      load("/examples/mock-datafeed.mjs"),
    ]);
    document.body.replaceChildren();
    const host = document.createElement("div");
    host.className = "probe-host";
    document.body.append(host);
    Object.assign(host.style, { position: "absolute", inset: "0" });

    let inits = 0;
    let updates = 0;
    // A band 250-500 price units above the close: empty chart area, so any
    // green there is the fill (#00ff00 painted at 20% opacity).
    const Channel = studies.defineIndicator({
      name: "Probe channel",
      pane: "overlay",
      inputs: { offset: studies.float(250, { min: 0 }) },
      plots: [
        { id: "upper", title: "Upper", style: "line", color: "#ff00ff" },
        { id: "lower", title: "Lower", style: "line", color: "#ff00ff" },
      ],
      fills: [{ id: "band", between: ["upper", "lower"], color: "#00ff00" }],
      init: () => {
        inits += 1;
        return 0;
      },
      update: ({ bar }: { bar: { close: number } }, _state: number, { offset }: { offset: number }) => {
        updates += 1;
        return { state: 0, values: { upper: bar.close + offset * 2, lower: bar.close + offset } };
      },
    });

    const chart = new widget({
      symbol: "MOCK",
      datafeed: makeMockDatafeed({ bars: 200, startPrice: 6400, now: VISUAL_NOW, live: false }),
      interval: "1",
      container: host,
      autosize: true,
      theme: "dark",
      timezone: "Etc/UTC",
      disabled_features: ["header_widget", "left_toolbar", "scale_bar", "countdown"],
      raze: { custom_studies: [Channel] },
    });
    await new Promise<void>((resolve) => chart.onChartReady(() => resolve()));
    const api = chart.activeChart();

    (window as unknown as ProbeWindow).__fillProbe = {
      countFill() {
        let count = 0;
        for (const canvas of host.querySelectorAll("canvas")) {
          const ctx = canvas.getContext("2d");
          if (!ctx || !canvas.width || !canvas.height) continue;
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i]!;
            const g = data[i + 1]!;
            const b = data[i + 2]!;
            if (g > r + 30 && g > b + 30) count += 1;
          }
        }
        return count;
      },
      addStudy: async () => String(await api.createStudy("Probe channel", false, false, { offset: 250 })),
      stats: () => ({ inits, updates }),
    };
  });

  const p = probe(page);
  await page.waitForTimeout(300);
  const before = await p.countFill();
  const id = await p.addStudy();
  expect(id).toMatch(/^study_probe_channel_\d+$/);
  await page.waitForTimeout(300);
  const after = await p.countFill();
  expect(before).toBeLessThan(50);
  expect(after).toBeGreaterThan(before + 2_000);

  const stats = await p.stats();
  expect(stats.inits).toBe(1);
  expect(stats.updates).toBeGreaterThanOrEqual(200);
});
