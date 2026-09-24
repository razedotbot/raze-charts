// Financial widget browser benchmark. Runs only through
// playwright.perf.config.ts (node scripts/benchmark-widget.mjs); the default
// Playwright config never matches *.bench.ts, so the visual and accessibility
// suites stay fast and deterministic.
//
// Environment (set by the runner, all optional):
//   RAZE_BENCH_SIZES   comma-separated bar counts (default 1000,10000,100000,500000)
//   RAZE_BENCH_OUT     path of the JSON results file
//   RAZE_BENCH_RASTER  "0" skips the canvas readback that otherwise follows
//                      every frame so rasterisation counts as frame cost
//   RAZE_BENCH_CHECK   "1" fails the run when a median exceeds its budget

import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateBudgets,
  parseSizes,
  summarize,
} from "../../scripts/widget-benchmark-lib.mjs";

type Sample = {
  ms: number;
  scriptMs?: number;
  /** JS inside animation frames only (no input handler). */
  frameMs?: number;
  rasterMs: number;
  frames: number;
  /** Crosshair scenarios: paints of the main (scene) layer during the sample. */
  mainPaints?: number;
  /** Crosshair scenarios: paints of the overlay layer during the sample. */
  overlayPaints?: number;
};
type Summary = ReturnType<typeof summarize>;
type MeasureOptions = {
  view?: "default" | "zoomed-out" | "all";
  warmup?: number;
  minSamples?: number;
  maxSamples?: number;
  timeBudgetMs?: number;
};

interface BenchApi {
  environment(): { crossOriginIsolated: boolean; devicePixelRatio: number; userAgent: string };
  setup(size: number): { bars: number };
  setRasterFlush(enabled: boolean): void;
  load(): Promise<Sample>;
  unload(): Promise<void>;
  addStudies(): Promise<{ studies: number }>;
  measure(name: string, opts?: MeasureOptions): Promise<Sample[]>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sizes = parseSizes(process.env.RAZE_BENCH_SIZES);
const outPath = resolve(root, process.env.RAZE_BENCH_OUT || "test-results/widget-benchmark.json");
const rasterFlush = process.env.RAZE_BENCH_RASTER !== "0";
const enforceBudgets = process.env.RAZE_BENCH_CHECK === "1";

const results: {
  scenarios: Record<string, Record<string, Summary>>;
  environment: Record<string, unknown>;
} = { scenarios: {}, environment: {} };
let pageEnvironment: Awaited<ReturnType<BenchApi["environment"]>> | null = null;

function record(id: string, size: number, summary: Summary): void {
  (results.scenarios[id] ??= {})[String(size)] = summary;
}

/** Load samples per data size: the first load in each page is JIT-cold. */
function loadRuns(size: number): number {
  if (size >= 500_000) return 3;
  if (size >= 100_000) return 5;
  return 7;
}

type BenchWindow = Window & { __razeBench: BenchApi; __razeBenchReady?: boolean };

/**
 * Opens the benchmark page and returns a live list of page errors. Library
 * warnings ("[raze-charts] ...") count as errors too: a warning means the
 * widget fell back or ignored something, so the run no longer measures the
 * configuration it claims to.
 */
async function openBench(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const type = message.type();
    const text = message.text();
    if (type === "error") errors.push(text);
    else if ((type === "warning" || type === "log" || type === "info") && text.includes("[raze-charts]")) {
      errors.push(`${type}: ${text}`);
    }
  });
  await page.goto("/examples/benchmark.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (window as unknown as BenchWindow).__razeBenchReady === true,
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(() => document.fonts.ready);
  return errors;
}

async function heapMB(cdp: CDPSession): Promise<number> {
  // Two collections let weak references and finalizers settle.
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  return usedSize / (1024 * 1024);
}

async function measure(
  page: Page,
  id: string,
  size: number,
  scenario: string,
  opts: MeasureOptions = {},
): Promise<{ summary: Summary; samples: Sample[] }> {
  // Slow scenarios stop at the time budget (never below five samples).
  const timeBudgetMs = size >= 500_000 ? 2_500 : 1_500;
  const samples = await page.evaluate(
    ({ name, options }) => (window as unknown as BenchWindow).__razeBench.measure(name, options),
    { name: scenario, options: { timeBudgetMs, ...opts } },
  );
  expect(samples.length, `${id} at ${size} bars produced samples`).toBeGreaterThanOrEqual(5);
  // Every sample must paint: a step that changes nothing on screen measures
  // only its input handler and would drag the median towards zero.
  const idle = samples.filter((sample) => sample.frames === 0).length;
  expect(idle, `${id} at ${size} bars: ${idle} of ${samples.length} samples painted no frame`).toBe(0);
  const summary = summarize(samples);
  record(id, size, summary);
  return { summary, samples };
}

/**
 * Crosshair moves repaint only the overlay layer (AD-04): no sample may paint
 * the main scene, and the overlay paints at most once per frame. Records the
 * overlay frame cost (animation-frame JS only) under `overlayId`.
 */
function checkOverlayOnly(overlayId: string, size: number, samples: Sample[]): void {
  for (const sample of samples) {
    expect(sample.mainPaints, `${overlayId} at ${size} bars: a crosshair move repainted the main layer`).toBe(0);
    expect(sample.overlayPaints ?? 0, `${overlayId} at ${size} bars: the overlay painted more than once per frame`)
      .toBeLessThanOrEqual(sample.frames);
    expect(sample.overlayPaints ?? 0, `${overlayId} at ${size} bars: the crosshair move did not repaint the overlay`)
      .toBeGreaterThan(0);
  }
  record(overlayId, size, summarize(samples.map((sample) => ({
    ms: sample.frameMs ?? 0,
    rasterMs: sample.rasterMs,
    frames: sample.frames,
  }))));
}

/** Absolute slack of the overlay scale checks: timer noise on a sub-millisecond frame. */
const OVERLAY_SLACK_MS = 0.25;

/**
 * The overlay frame must not depend on the visible span or on the history
 * length (AD-04). Relative checks stay portable where the absolute 0.5 ms
 * `target` would not (it is enforced by `--check --strict`): an overlay that
 * walked the visible bars again would cost 100x more with 500k bars in view.
 */
function checkOverlayScaleFree(size: number): void {
  const frame = results.scenarios["overlay-frame"] ?? {};
  const view = frame[String(size)]?.median;
  const all = results.scenarios["overlay-frame-all"]?.[String(size)]?.median;
  expect(view, `overlay-frame at ${size} bars was recorded`).toBeDefined();
  expect(all, `overlay-frame-all at ${size} bars was recorded`).toBeDefined();
  expect(all!, `overlay-frame-all at ${size} bars: the overlay frame grows with the visible span`)
    .toBeLessThanOrEqual(2 * view! + OVERLAY_SLACK_MS);
  const smallest = frame[String(sizes[0])]?.median;
  if (smallest !== undefined && size !== sizes[0]) {
    expect(view!, `overlay-frame at ${size} bars: the overlay frame grows with the history length`)
      .toBeLessThanOrEqual(2 * smallest + OVERLAY_SLACK_MS);
  }
}

test.describe.configure({ mode: "serial" });

test.afterAll(async ({ browser }) => {
  results.environment = {
    browser: `${browser.browserType().name()} ${browser.version()}`,
    sizes,
    rasterFlush,
    viewport: "1100x620 @1x",
    crossOriginIsolated: pageEnvironment?.crossOriginIsolated ?? false,
    userAgent: pageEnvironment?.userAgent ?? "unknown",
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
});

for (const size of sizes) {
  test(`financial widget at ${size.toLocaleString("en-US")} bars`, async ({ page }) => {
    test.setTimeout(size >= 500_000 ? 600_000 : 300_000);
    const cdp = await page.context().newCDPSession(page);
    const errors = await openBench(page);
    const load = (): Promise<Sample> => page.evaluate(() => (window as unknown as BenchWindow).__razeBench.load());
    await page.evaluate((flush) => (window as unknown as BenchWindow).__razeBench.setRasterFlush(flush), rasterFlush);
    pageEnvironment ??= await page.evaluate(() => (window as unknown as BenchWindow).__razeBench.environment());

    // Heap baseline before the series exists, so `heap` covers bar objects,
    // the widget's own copies, and every cache built for the first frame.
    const heapBefore = await heapMB(cdp);
    await page.evaluate((n) => (window as unknown as BenchWindow).__razeBench.setup(n), size);

    const loads: Sample[] = [];
    loads.push(await load());
    record("heap", size, summarize([await heapMB(cdp) - heapBefore]));

    await measure(page, "frame-default", size, "frame", { view: "default" });
    await measure(page, "frame-zoomed-out", size, "frame", { view: "zoomed-out" });
    await measure(page, "frame-all", size, "frame", { view: "all" });
    const crosshair = await measure(page, "crosshair-move", size, "crosshair-move", { view: "default" });
    checkOverlayOnly("overlay-frame", size, crosshair.samples);
    const crosshairAll = await measure(page, "crosshair-move-all", size, "crosshair-move", { view: "all" });
    checkOverlayOnly("overlay-frame-all", size, crosshairAll.samples);
    checkOverlayScaleFree(size);
    await measure(page, "pan", size, "pan", { view: "default" });
    await measure(page, "wheel-zoom", size, "wheel-zoom", { view: "default" });

    const added = await page.evaluate(() => (window as unknown as BenchWindow).__razeBench.addStudies());
    expect(added.studies, "every reference study was created").toBe(6);
    record("heap-studies", size, summarize([await heapMB(cdp) - heapBefore]));
    await measure(page, "frame-studies", size, "frame", { view: "default" });
    await measure(page, "tick-replace", size, "tick-replace", { view: "default" });
    await measure(page, "tick-append", size, "tick-append", { view: "default" });

    for (let run = 1; run < loadRuns(size); run += 1) {
      loads.push(await load());
    }
    record("load", size, summarize(loads));
    await page.evaluate(() => (window as unknown as BenchWindow).__razeBench.unload());

    expect(errors, "the benchmark page must not log errors").toEqual([]);

    if (enforceBudgets) {
      const baseline = JSON.parse(readFileSync(resolve(root, "benchmarks/widget-baseline.json"), "utf8"));
      const key = String(size);
      const sizeOnly = {
        scenarios: Object.fromEntries(
          Object.entries(results.scenarios)
            .filter(([, bySize]) => bySize[key])
            .map(([id, bySize]) => [id, { [key]: bySize[key]! }]),
        ),
      };
      const { failures, missing } = evaluateBudgets(sizeOnly, baseline);
      expect(missing, "every measured scenario needs a checked-in budget").toEqual([]);
      expect(failures, "medians must stay within benchmarks/widget-baseline.json budgets").toEqual([]);
    }
  });
}
