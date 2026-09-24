// Real-browser pixel tests for bitmap-space painting (W1B-08, pixel.ts).
//
// Two layers:
// 1. Painter level: the financial painters are bundled from source with
//    esbuild and run against a real Chromium canvas at DPR 1..3. Opaque,
//    channel-separated colours make any anti-aliased pixel detectable exactly,
//    so "crisp" means every pixel is one of the palette colours.
// 2. Widget level: a real widget (tests/fixtures/pixel-widget.html) at
//    fractional deviceScaleFactor, read back through getImageData, plus goldens
//    at DPR 1.5.

import { test, expect, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DPRS = [1, 1.25, 1.5, 1.75, 2, 3] as const;

let painterBundle = "";

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: [
        'export { drawCandles, drawOhlcBars, drawColumns, candleColumns } from "./src/engine/paint/candles";',
        'export { drawGrid, drawSeparators } from "./src/engine/paint/grid";',
        'export { drawVolume } from "./src/engine/paint/volume";',
        'export { drawLineArea } from "./src/engine/paint/lineArea";',
        'export { drawLastPrice } from "./src/engine/paint/lastPrice";',
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    globalName: "RazePaint",
    platform: "browser",
    target: "es2020",
    write: false,
  });
  painterBundle = result.outputFiles[0]!.text;
});

// ── colours (opaque, channel-separated) ─────────────────────────────────────
type RGB = [number, number, number];
const BG: RGB = [0, 0, 0];
const H_GRID: RGB = [0, 255, 0];
const V_GRID: RGB = [0, 0, 255];
const SEP: RGB = [255, 255, 0];
const UP: RGB = [255, 0, 0];
const DOWN: RGB = [255, 0, 255];
const VOL: RGB = [0, 255, 255];
const hex = (c: RGB): string => `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}`;

interface BarLike { time: number; open: number; high: number; low: number; close: number; volume?: number }

interface SceneSpec {
  dpr: number;
  w: number;
  h: number;
  plotH?: number;
  bars: BarLike[];
  range: { from: number; to: number };
  min: number;
  max: number;
  style?: string;
  paint: string[];
  priceTicks?: number[];
  timeTicks?: { index: number; time: number }[];
  volumePane?: { top: number; h: number } | null;
  volumeMode?: string;
  autoScale?: boolean;
  overrides?: Record<string, unknown>;
}

interface SceneResult {
  width: number;
  height: number;
  /** RGBA bytes, base64 (a JSON number array of a DPR 3 canvas is far too slow). */
  data: string;
  texts: string[];
  warnings: string[];
}

/** Paint a synthetic finance view with the source painters and read it back. */
async function paintScene(page: Page, spec: SceneSpec): Promise<SceneResult> {
  return page.evaluate(({ spec, colors }) => {
    const encodePixels = (window as unknown as { __encodePixels: (d: Uint8ClampedArray) => string }).__encodePixels;
    const P = (window as unknown as { RazePaint: Record<string, (...args: unknown[]) => void> }).RazePaint;
    const theme = {
      paneBackground: colors.bg,
      vertGrid: colors.vGrid,
      horzGrid: colors.hGrid,
      crosshair: colors.bg,
      scaleText: colors.sep,
      scaleBackground: colors.bg,
      scaleLine: colors.sep,
      candleUp: colors.up,
      candleDown: colors.down,
      borderUp: colors.up,
      borderDown: colors.down,
      wickUp: colors.up,
      wickDown: colors.down,
      volUp: colors.vol,
      volDown: colors.vol,
      lineColor: colors.up,
      showPriceScaleCrosshairLabel: true,
      showTimeScaleCrosshairLabel: true,
    };
    const priceAxisW = 60;
    const view = {
      context: {
        theme,
        bars: spec.bars,
        chartStyle: spec.style ?? "candles",
        volumeMode: spec.volumeMode ?? "hidden",
        autoScalePrice: spec.autoScale ?? true,
        options: { overrides: spec.overrides ?? {} },
        symbolInfo: { pricescale: 100 },
        formatPrice: (p: number) => p.toFixed(2),
      },
      cssWidth: spec.w,
      cssHeight: spec.h,
      dpr: spec.dpr,
      priceAxisW,
      plotL: 0,
      plotT: 0,
      plotW: spec.w - priceAxisW,
      plotH: spec.plotH ?? spec.h - 22,
      priceMin: spec.min,
      priceMax: spec.max,
      pctBase: 1,
      visibleRange: spec.range,
      percentScale: false,
      logScale: false,
      subPanes: [],
      volumePane: spec.volumePane ?? null,
      seriesBars: spec.bars,
      fontFamily: "Arial",
    };
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(spec.w * spec.dpr);
    canvas.height = Math.round(spec.h * spec.dpr);
    const ctx = canvas.getContext("2d")!;
    const texts: string[] = [];
    const fillText = ctx.fillText.bind(ctx);
    ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
      texts.push(text);
      if (maxWidth === undefined) fillText(text, x, y);
      else fillText(text, x, y, maxWidth);
    };
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      // Same frame setup as ChartEngine.paint(): CSS-space transform at the DPR.
      ctx.setTransform(spec.dpr, 0, 0, spec.dpr, 0, 0);
      ctx.fillStyle = theme.paneBackground;
      ctx.fillRect(0, 0, spec.w, spec.h);
      for (const step of spec.paint) {
        if (step === "grid") P.drawGrid(ctx, view, spec.priceTicks ?? [], spec.timeTicks ?? []);
        else if (step === "separators") P.drawSeparators(ctx, view);
        else if (step === "candles") P.drawCandles(ctx, view, spec.bars, false);
        else if (step === "hollow") P.drawCandles(ctx, view, spec.bars, true);
        else if (step === "bars") P.drawOhlcBars(ctx, view, spec.bars);
        else if (step === "columns") P.drawColumns(ctx, view, spec.bars);
        else if (step === "volume") P.drawVolume(ctx, view);
        else if (step === "line") P.drawLineArea(ctx, view, false);
        else if (step === "area") P.drawLineArea(ctx, view, true);
        else if (step === "lastPrice") P.drawLastPrice(ctx, view);
        else throw new Error(`unknown paint step ${step}`);
      }
    } finally {
      console.warn = warn;
    }
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: encodePixels(image.data), texts, warnings };
  }, {
    spec,
    colors: { bg: hex(BG), hGrid: hex(H_GRID), vGrid: hex(V_GRID), sep: hex(SEP), up: hex(UP), down: hex(DOWN), vol: hex(VOL) },
  });
}

class Pixels {
  constructor(readonly width: number, readonly height: number, private readonly data: ArrayLike<number>) {}

  at(x: number, y: number): RGB {
    const i = (y * this.width + x) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!];
  }

  is(x: number, y: number, c: RGB): boolean {
    const p = this.at(x, y);
    return p[0] === c[0] && p[1] === c[1] && p[2] === c[2];
  }

  /** Pixels in the rectangle whose colour is not in `palette`. */
  offPalette(palette: RGB[], x0 = 0, y0 = 0, x1 = this.width, y1 = this.height): { x: number; y: number; rgb: RGB }[] {
    const allowed = new Set(palette.map((c) => (c[0] << 16) | (c[1] << 8) | c[2]));
    const bad: { x: number; y: number; rgb: RGB }[] = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * this.width + x) * 4;
        const key = (this.data[i]! << 16) | (this.data[i + 1]! << 8) | this.data[i + 2]!;
        if (!allowed.has(key)) bad.push({ x, y, rgb: this.at(x, y) });
      }
    }
    return bad;
  }

  /** Runs of pixels matching `match` along a row, as [start, endExclusive]. */
  rowRuns(y: number, match: (p: RGB) => boolean, x0 = 0, x1 = this.width): [number, number][] {
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = x0; x <= x1; x++) {
      const on = x < x1 && match(this.at(x, y));
      if (on && start < 0) start = x;
      if (!on && start >= 0) { runs.push([start, x]); start = -1; }
    }
    return runs;
  }

  colRuns(x: number, match: (p: RGB) => boolean, y0 = 0, y1 = this.height): [number, number][] {
    const runs: [number, number][] = [];
    let start = -1;
    for (let y = y0; y <= y1; y++) {
      const on = y < y1 && match(this.at(x, y));
      if (on && start < 0) start = y;
      if (!on && start >= 0) { runs.push([start, y]); start = -1; }
    }
    return runs;
  }
}

const same = (c: RGB) => (p: RGB): boolean => p[0] === c[0] && p[1] === c[1] && p[2] === c[2];
const series = (p: RGB): boolean => same(UP)(p) || same(DOWN)(p);
const hairline = (dpr: number): number => Math.max(1, Math.floor(dpr));
const pixels = (r: { width: number; height: number; data: string }): Pixels =>
  new Pixels(r.width, r.height, Buffer.from(r.data, "base64"));

/** Page-side base64 encoder for canvas bytes, installed before any evaluate. */
const ENCODE_PIXELS = `window.__encodePixels = (bytes) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
};`;

async function openPainterPage(browser: Browser, dpr: number): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: ENCODE_PIXELS });
  await page.addScriptTag({ content: painterBundle });
  return { page, close: () => context.close() };
}

/** Alternating up/down candles: body 100..110, wicks 90..120. */
function uniformBars(count: number): BarLike[] {
  return Array.from({ length: count }, (_, i) => {
    const up = i % 2 === 0;
    return { time: i * 60_000, open: up ? 100 : 110, close: up ? 110 : 100, high: 120, low: 90, volume: 1000 + (i % 7) * 500 };
  });
}

/** Device row of a price in a painter scene (plotT = 0). */
function rowOf(spec: { min: number; max: number; plotH: number; dpr: number }, price: number): number {
  return Math.round(((spec.max - price) / (spec.max - spec.min)) * spec.plotH * spec.dpr);
}

test.describe("pixel.ts painters (real canvas)", () => {
  for (const dpr of DPRS) {
    test(`grid and separators are full-intensity integer hairlines at DPR ${dpr}`, async ({ browser }) => {
      const { page, close } = await openPainterPage(browser, dpr);
      try {
        const spec: SceneSpec = {
          dpr, w: 640, h: 360, bars: uniformBars(60), range: { from: 0.37, to: 47.9 }, min: 0, max: 100,
          paint: ["grid", "separators"],
          priceTicks: [7, 19.3, 33.1, 47.77, 61.5, 88.25],
          timeTicks: [3, 11, 20, 33, 41].map((index) => ({ index, time: index * 60_000 })),
        };
        const img = pixels(await paintScene(page, spec));
        expect(img.offPalette([BG, H_GRID, V_GRID, SEP]).slice(0, 8), "no partial-intensity grid pixels").toEqual([]);

        const hw = hairline(dpr);
        // A column between vertical grid lines crosses every horizontal line.
        const hRuns = img.colRuns(Math.round(2 * dpr), same(H_GRID));
        expect(hRuns.length, "one run per price tick").toBe(spec.priceTicks!.length);
        for (const [a, b] of hRuns) expect(b - a, "horizontal grid thickness").toBe(hw);
        const vRuns = img.rowRuns(Math.round(3 * dpr), same(V_GRID));
        expect(vRuns.length, "one run per time tick").toBe(spec.timeTicks!.length);
        for (const [a, b] of vRuns) expect(b - a, "vertical grid thickness").toBe(hw);
        // Price-axis separator: one crisp hairline centred on the plot's right
        // edge pixel (pixel.ts centres odd widths on the anchor pixel).
        const sepStart = Math.round(580 * dpr) - Math.floor((hw - 1) / 2);
        const sepRuns = img.rowRuns(Math.round(100 * dpr), same(SEP));
        expect(sepRuns).toEqual([[sepStart, sepStart + hw]]);
      } finally {
        await close();
      }
    });

    test(`candle wicks sit on the body centre for spacings 3..40 px at DPR ${dpr}`, async ({ browser }) => {
      const { page, close } = await openPainterPage(browser, dpr);
      try {
        const plotW = 580;
        const plotH = 338;
        for (const spacing of [3, 4, 5.3, 7, 9.21, 13.7, 22, 40]) {
          const span = plotW / spacing;
          const bars = uniformBars(Math.ceil(span) + 4);
          const from = 0.29; // fractional so bar centres land on fractional pixels
          const spec: SceneSpec = { dpr, w: 640, h: 360, bars, range: { from, to: from + span }, min: 80, max: 130, paint: ["candles"] };
          const img = pixels(await paintScene(page, spec));
          expect(img.offPalette([BG, UP, DOWN]).slice(0, 8), `crisp candles at spacing ${spacing}`).toEqual([]);

          const plotRight = Math.round(plotW * dpr);
          const bodyRow = rowOf({ ...spec, plotH }, 105);
          const wickRow = rowOf({ ...spec, plotH }, 116);
          const bodies = img.rowRuns(bodyRow, series, 0, plotRight).filter(([a, b]) => a > 0 && b < plotRight);
          const wicks = img.rowRuns(wickRow, series, 0, plotRight);
          expect(bodies.length, `candles visible at spacing ${spacing}`).toBeGreaterThan(Math.floor(span) - 3);
          const widths = new Set(bodies.map(([a, b]) => b - a));
          expect([...widths], `one body width at spacing ${spacing}`).toHaveLength(1);
          for (const [l, r] of bodies) {
            const wick = wicks.find(([a, b]) => a >= l && b <= r);
            expect(wick, `wick inside body ${l}..${r} at spacing ${spacing}`).toBeDefined();
            const [wl, wr] = wick!;
            expect(wr - wl, "wick is one hairline").toBe(hairline(dpr));
            expect(wl - l, `equal body margins around the wick (spacing ${spacing}, body ${l}..${r})`).toBe(r - wr);
          }
        }
      } finally {
        await close();
      }
    });
  }

  for (const dpr of [1, 1.5, 2]) {
    test(`hollow candles keep the wick out of the body and stay crisp at DPR ${dpr}`, async ({ browser }) => {
      const { page, close } = await openPainterPage(browser, dpr);
      try {
        const spec: SceneSpec = {
          dpr, w: 640, h: 360, bars: uniformBars(50), range: { from: 0.4, to: 40.4 }, min: 80, max: 130, paint: ["hollow"],
        };
        const img = pixels(await paintScene(page, spec));
        expect(img.offPalette([BG, UP, DOWN]).slice(0, 8)).toEqual([]);
        const bodyRow = rowOf({ ...spec, plotH: 338 }, 105);
        const upBodies = img.rowRuns(bodyRow, same(UP));
        // Hollow up candles: two border columns per body at the body middle row.
        expect(upBodies.length).toBeGreaterThan(30);
        for (const [a, b] of upBodies) expect(b - a).toBe(hairline(dpr));
      } finally {
        await close();
      }
    });

    test(`OHLC bars use integer stems and ticks at DPR ${dpr}`, async ({ browser }) => {
      const { page, close } = await openPainterPage(browser, dpr);
      try {
        for (const thinBars of [true, false]) {
          const spec: SceneSpec = {
            dpr, w: 640, h: 360, bars: uniformBars(80), range: { from: 0.33, to: 26.7 }, min: 80, max: 130,
            paint: ["bars"], overrides: { "mainSeriesProperties.barStyle.thinBars": thinBars },
          };
          const img = pixels(await paintScene(page, spec));
          expect(img.offPalette([BG, UP, DOWN]).slice(0, 8), `crisp bars (thinBars ${thinBars})`).toEqual([]);
          const between = rowOf({ ...spec, plotH: 338 }, 95); // stem only (below both ticks)
          const stems = img.rowRuns(between, series, 0, Math.round(580 * dpr));
          expect(stems.length).toBeGreaterThan(20);
          const stemWidths = new Set(stems.map(([a, b]) => b - a));
          expect(stemWidths.size, "every stem has the same width").toBe(1);
          const stemW = [...stemWidths][0]!;
          if (thinBars) expect(stemW).toBe(hairline(dpr));
          else expect(stemW).toBeGreaterThan(hairline(dpr));
          // The open tick (left of the stem) is exactly one tick-height run.
          const [left] = stems[3]!;
          const tickRuns = img.colRuns(left - 1, series);
          expect(tickRuns.length, "one open tick left of the stem").toBe(1);
          const tickH = tickRuns[0]![1] - tickRuns[0]![0];
          expect(tickH).toBe(thinBars ? hairline(dpr) : Math.max(hairline(dpr), stemW));
        }
      } finally {
        await close();
      }
    });
  }

  test("a non-boolean thinBars override warns instead of being ignored", async ({ browser }) => {
    const { page, close } = await openPainterPage(browser, 1);
    try {
      const result = await paintScene(page, {
        dpr: 1, w: 640, h: 360, bars: uniformBars(40), range: { from: 0, to: 30 }, min: 80, max: 130,
        paint: ["bars"], overrides: { "mainSeriesProperties.barStyle.thinBars": "no" },
      });
      expect(result.warnings.join("\n")).toContain("barStyle.thinBars");
    } finally {
      await close();
    }
  });

  for (const dpr of [1, 1.5, 2]) {
    test(`spike wicks never enter the volume pane and show a clip marker at DPR ${dpr}`, async ({ browser }) => {
      const { page, close } = await openPainterPage(browser, dpr);
      try {
        const plotH = 240;
        const volumePane = { top: 243, h: 90 };
        const bars = uniformBars(40).map((b, i) => (i === 17 ? { ...b, high: 400, low: -300 } : b));
        const base: SceneSpec = {
          dpr, w: 640, h: 360, plotH, bars, range: { from: 0.4, to: 30.4 }, min: 80, max: 130,
          volumePane, volumeMode: "pane", paint: ["volume", "candles"],
        };
        const plotBottom = Math.round(plotH * dpr);
        for (const style of ["candles", "bars"]) {
          for (const autoScale of [true, false]) {
            const img = pixels(await paintScene(page, { ...base, autoScale, paint: ["volume", style] }));
            const leak: { x: number; y: number }[] = [];
            for (let y = plotBottom; y < img.height; y++) {
              for (let x = 0; x < img.width; x++) if (series(img.at(x, y))) leak.push({ x, y });
            }
            expect(leak, `${style}: no series pixels below the price pane (autoScale ${autoScale})`).toEqual([]);
            expect(img.offPalette([BG, UP, DOWN, VOL]).slice(0, 8), `${style}: crisp`).toEqual([]);
            // Only the spike reaches the pane edges. While autoscaling, its
            // trimmed wick widens into an arrowhead at both edges (third row
            // in); with a manual scale it stays a plain wick.
            const topRuns = img.rowRuns(0, series);
            expect(topRuns, `${style}: only the spike reaches the top edge`).toHaveLength(1);
            const topRun = topRuns[0]!;
            expect(topRun[1] - topRun[0], `${style}: the edge row is the wick itself`).toBe(hairline(dpr));
            const thirdRow = 2 * hairline(dpr);
            const overlaps = ([a, b]: [number, number]): boolean => a <= topRun[0] && b >= topRun[1];
            const innerRun = img.rowRuns(thirdRow, series).find(overlaps)!;
            const bottomRun = img.rowRuns(plotBottom - 1 - thirdRow, series).find(overlaps)!;
            expect(innerRun && bottomRun, `${style}: the spike reaches both edges`).toBeTruthy();
            const widths = [innerRun[1] - innerRun[0], bottomRun[1] - bottomRun[0]];
            if (autoScale) {
              expect(widths, `${style}: arrowheads at both edges`).toEqual([hairline(dpr) + 4 * hairline(dpr), hairline(dpr) + 4 * hairline(dpr)]);
            } else {
              expect(widths, `${style}: no marker for a manual scale`).toEqual([hairline(dpr), hairline(dpr)]);
            }
          }
        }
      } finally {
        await close();
      }
    });
  }

  test("candles, bars, line and area render prices in -80..-60 and across zero", async ({ browser }) => {
    const { page, close } = await openPainterPage(browser, 1.5);
    try {
      const fixtures = [
        { name: "negative", lo: -80, hi: -60, min: -85, max: -55 },
        { name: "zero-crossing", lo: -10, hi: 10, min: -12, max: 12 },
      ];
      for (const f of fixtures) {
        const count = 40;
        const mid = (f.lo + f.hi) / 2;
        const amp = (f.hi - f.lo) / 2;
        const bars: BarLike[] = Array.from({ length: count }, (_, i) => {
          const open = mid + amp * 0.8 * Math.sin(i / 3);
          const close = mid + amp * 0.8 * Math.sin((i + 1) / 3);
          return {
            time: i * 60_000, open, close,
            high: Math.min(f.hi, Math.max(open, close) + amp * 0.1),
            low: Math.max(f.lo, Math.min(open, close) - amp * 0.1),
            volume: 1000,
          };
        });
        const base = { dpr: 1.5, w: 640, h: 360, bars, range: { from: 0, to: count }, min: f.min, max: f.max };
        const plotRight = Math.round(580 * 1.5);
        const columnsWithSeries = (img: Pixels): number[] => {
          const cols: number[] = [];
          for (let x = 0; x < plotRight; x++) {
            for (let y = 0; y < Math.round(338 * 1.5); y++) {
              const p = img.at(x, y);
              if (p[0] > 0 || p[2] > 0) { cols.push(x); break; }
            }
          }
          return cols;
        };
        for (const style of ["candles", "bars"]) {
          const img = pixels(await paintScene(page, { ...base, paint: [style] }));
          expect(img.offPalette([BG, UP, DOWN]).slice(0, 8), `${f.name} ${style} crisp`).toEqual([]);
          // Every bar paints: count separate column groups.
          const cols = columnsWithSeries(img);
          let groups = 0;
          for (let i = 0; i < cols.length; i++) if (i === 0 || cols[i]! - cols[i - 1]! > 1) groups++;
          expect(groups, `${f.name}: every ${style} bar renders`).toBe(count);
        }
        for (const style of ["line", "area"]) {
          const img = pixels(await paintScene(page, { ...base, paint: [style] }));
          const cols = columnsWithSeries(img);
          // The line spans from the first to the last bar centre.
          expect(cols.length, `${f.name}: ${style} renders`).toBeGreaterThan(plotRight * 0.9);
        }
        const withPill = await paintScene(page, { ...base, paint: ["candles", "lastPrice"] });
        const last = bars[count - 1]!.close.toFixed(2);
        expect(withPill.texts, `${f.name}: last-price pill shows the negative value`).toContain(last);
      }
    } finally {
      await close();
    }
  });

  test("volume columns line up under the candle bodies", async ({ browser }) => {
    for (const dpr of [1, 1.5, 2]) {
      const { page, close } = await openPainterPage(browser, dpr);
      try {
        const spec: SceneSpec = {
          dpr, w: 640, h: 360, bars: uniformBars(80), range: { from: 0.3, to: 61.3 }, min: 80, max: 130,
          volumeMode: "overlay", paint: ["candles", "volume"],
        };
        const img = pixels(await paintScene(page, spec));
        expect(img.offPalette([BG, UP, DOWN, VOL]).slice(0, 8)).toEqual([]);
        const plotRight = Math.round(580 * dpr);
        const bodies = img.rowRuns(rowOf({ ...spec, plotH: 338 }, 105), series, 0, plotRight);
        const volumes = img.rowRuns(Math.round(337 * dpr), same(VOL), 0, plotRight);
        const inner = (runs: [number, number][]) => runs.filter(([a, b]) => a > 0 && b < plotRight);
        expect(inner(volumes)).toEqual(inner(bodies));
      } finally {
        await close();
      }
    }
  });
});

// ── widget level ────────────────────────────────────────────────────────────

async function openWidget(browser: Browser, dpr: number, testCase: "grid" | "spike") {
  const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 800, height: 480 } });
  await context.addInitScript({ content: ENCODE_PIXELS });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`/tests/fixtures/pixel-widget.html?case=${testCase}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __pixelReady?: boolean }).__pixelReady === true, undefined, {
    timeout: 30_000,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { page, errors, close: () => context.close() };
}

async function readWidgetCanvas(page: Page): Promise<Pixels> {
  const result = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.raze-chart-canvas")!;
    const ctx = canvas.getContext("2d")!;
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const encode = (window as unknown as { __encodePixels: (d: Uint8ClampedArray) => string }).__encodePixels;
    return { width: canvas.width, height: canvas.height, data: encode(image.data) };
  });
  return pixels(result);
}

/** Last-price dashes blend 85 % of a candle colour over whatever is below. */
function lastPriceBlends(): RGB[] {
  const out: RGB[] = [];
  for (const top of [UP, DOWN]) {
    for (const under of [BG, H_GRID, V_GRID, UP, DOWN]) {
      out.push(top.map((c, i) => Math.round(c * 0.85 + under[i]! * 0.15)) as RGB);
    }
  }
  return out;
}

test.describe("pixel.ts in the widget", () => {
  for (const dpr of [1.25, 1.5, 1.75, 2]) {
    test(`plot has no partial-intensity pixels at DPR ${dpr}`, async ({ browser }) => {
      const { page, errors, close } = await openWidget(browser, dpr, "grid");
      try {
        const img = await readWidgetCanvas(page);
        // The price-axis separator is the first scale-line column from the left.
        const probeRow = Math.round(40 * dpr);
        const sep = img.rowRuns(probeRow, same(SEP))[0];
        expect(sep, "price-axis separator found").toBeDefined();
        expect(sep![1] - sep![0], "separator is one hairline").toBe(hairline(dpr));
        const sepRow = img.colRuns(Math.round(10 * dpr), same(SEP))[0];
        expect(sepRow, "time-axis separator found").toBeDefined();
        expect(sepRow![1] - sepRow![0]).toBe(hairline(dpr));

        const palette: RGB[] = [BG, H_GRID, V_GRID, UP, DOWN, ...lastPriceBlends()];
        // Tolerate ±1 from alpha rounding in the dashed last-price line only.
        // The axis backgrounds (paint/axes.ts) still fill in CSS space, so the
        // one device pixel next to each separator may be shared with them at
        // fractional DPRs; the plot interior is what this package owns.
        const bad = img.offPalette(palette, 0, 0, sep![0] - 1, sepRow![0] - 1).filter(({ rgb }) =>
          !lastPriceBlends().some((c) => c.every((v, i) => Math.abs(v - rgb[i]!) <= 1)));
        expect(bad.slice(0, 10), "every plot pixel is a palette colour").toEqual([]);

        // Every horizontal grid line is exactly one hairline tall.
        // Probe a column that no vertical grid line or candle covers.
        let probe = -1;
        for (let x = 0; x < sep![0] && probe < 0; x++) {
          const blocked = img.colRuns(x, (p) => same(V_GRID)(p) || series(p), 0, sepRow![0]).length > 0;
          if (!blocked) probe = x;
        }
        expect(probe, "a free column exists").toBeGreaterThanOrEqual(0);
        const hRuns = img.colRuns(probe, same(H_GRID), 0, sepRow![0]);
        expect(hRuns.length, "horizontal grid lines present").toBeGreaterThan(2);
        for (const [a, b] of hRuns) expect(b - a, "grid row thickness").toBe(hairline(dpr));
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    });
  }

  test("a trimmed spike wick stays out of the volume pane (autoscale and manual scale)", async ({ browser }) => {
    const dpr = 1.5;
    const { page, errors, close } = await openWidget(browser, dpr, "spike");
    try {
      const check = async (label: string): Promise<void> => {
        const img = await readWidgetCanvas(page);
        const sepCol = img.rowRuns(Math.round(40 * dpr), same(SEP))[0]![0];
        const paneSep = img.colRuns(Math.round(10 * dpr), same(SEP))[0]!;
        // Volume pane: below the main-pane separator, above the time axis.
        const timeAxisTop = Math.round((img.height / dpr - 22) * dpr);
        let volumePixels = 0;
        const leak = [];
        for (let y = paneSep[1]; y < timeAxisTop; y++) {
          for (let x = 0; x < sepCol; x++) {
            const p = img.at(x, y);
            if (series(p)) leak.push({ x, y });
            if (same(VOL)(p)) volumePixels++;
          }
        }
        expect(volumePixels, `${label}: the volume pane painted`).toBeGreaterThan(100);
        expect(leak.slice(0, 5), `${label}: no candle pixels inside the volume pane`).toEqual([]);
      };
      await check("autoscale");
      await expect(page.locator(".raze-chart-root")).toHaveScreenshot("pixel-spike-volume-pane-dpr1.5.png");

      // Drag the price axis up to zoom in: candles overflow the pane edges.
      const canvas = page.locator("canvas.raze-chart-canvas");
      const box = (await canvas.boundingBox())!;
      const axisX = box.x + box.width - 25;
      const y = box.y + box.height * 0.35;
      await page.mouse.move(axisX, y);
      await page.mouse.down();
      await page.mouse.move(axisX, y - 150, { steps: 10 });
      await page.mouse.up();
      await page.mouse.move(box.x + 5, box.y + box.height - 5);
      await page.waitForTimeout(250);
      await check("manual price range");
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });
});

test.describe("DPR 1.5 goldens", () => {
  test.use({ deviceScaleFactor: 1.5 });

  test("dark widget at DPR 1.5", async ({ page }) => {
    await page.goto("/examples/visual.html?case=dark", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, undefined, {
      timeout: 30_000,
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await expect(page.locator(".raze-chart-root")).toHaveScreenshot("widget-dark-dpr1.5.png");
  });
});
