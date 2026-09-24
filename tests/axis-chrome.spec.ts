import { expect, test, type Page } from "@playwright/test";

// Real-browser acceptance for the axis chrome (W1B-09): the timezone caption
// lives in the reserved corner cell and never touches a time tick, the bar
// countdown reads h:mm:ss under the last-price tag, timescale marks are badges
// above the axis, and a compare of a different magnitude stays in the plot.
//
// The page records every fillText and stroke per animation frame through an
// init script, so the assertions read the geometry the painters produced.

const HARNESS = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Axis chrome</title>
  <style>html, body { margin: 0; height: 100%; background: #181615; } #wrap { position: absolute; top: 0; left: 0; }</style>
</head>
<body>
  <div id="wrap"></div>
  <script type="module">
    import { widget } from "/dist/charting_library.esm.js";
    const params = new URLSearchParams(location.search);
    const width = Number(params.get("w") || 1280);
    const height = Number(params.get("h") || 620);
    const resolution = params.get("res") || "1";
    const timezone = params.get("tz") || "Etc/UTC";
    const withMarks = params.get("marks") === "1";
    const wrap = document.getElementById("wrap");
    wrap.style.width = width + "px";
    wrap.style.height = height + "px";

    const RES_MS = { "1": 60000, "5": 300000, "60": 3600000, "1D": 86400000 };
    // The last bar opens at the frozen clock's bar boundary.
    const NOW = Number(params.get("now"));
    const BASES = { BTC: 74000, ETH: 2978 };
    function gen(symbol, res, count) {
      const step = RES_MS[res];
      const end = Math.floor(NOW / step) * step;
      const out = [];
      let seed = symbol === "ETH" ? 99991 : 1234567;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      let price = BASES[symbol] ?? 100;
      const vol = symbol === "ETH" ? 0.03 : 0.012;
      for (let i = count - 1; i >= 0; i--) {
        const open = price;
        const close = Math.max(0.01, price + (rnd() - 0.49) * price * vol);
        out.push({ time: end - i * step, open, close, high: Math.max(open, close) * (1 + rnd() * 0.004), low: Math.min(open, close) * (1 - rnd() * 0.004), volume: Math.floor(rnd() * 1000) });
        price = close;
      }
      return out;
    }
    const cache = new Map();
    const seriesFor = (symbol, res) => {
      const key = symbol + "|" + res;
      if (!cache.has(key)) cache.set(key, gen(symbol, res, 300));
      return cache.get(key);
    };
    const datafeed = {
      onReady: (cb) => setTimeout(() => cb({ supported_resolutions: ["1", "5", "60", "1D"], supports_timescale_marks: true }), 0),
      searchSymbols: (_a, _b, _c, cb) => cb([]),
      resolveSymbol: (symbol, ok) => setTimeout(() => ok({
        name: symbol, ticker: symbol, description: symbol, type: "crypto", session: "24x7", timezone,
        exchange: "Mock", listed_exchange: "Mock", format: "price", minmov: 1, pricescale: 100,
        has_intraday: true, has_daily: true, supported_resolutions: ["1", "5", "60", "1D"], data_status: "endofday",
      }), 0),
      getBars: (info, res, _p, cb) => {
        const bars = seriesFor(info.name, res);
        setTimeout(() => cb(bars.slice(-(_p.countBack || bars.length)), { noData: false }), 0);
      },
      subscribeBars() {},
      unsubscribeBars() {},
      getTimescaleMarks: (info, from, to, cb, res) => {
        if (!withMarks) return cb([]);
        const bars = seriesFor(info.name, res);
        const pick = (i) => Math.floor(bars[bars.length - 1 - i].time / 1000);
        cb([
          { id: "e1", time: pick(12), color: "red", label: "Earnings", tooltip: ["Earnings", "EPS 1.23"] },
          { id: "d1", time: pick(40), color: "blue", label: "D", tooltip: ["Dividend 0.25"] },
          { id: "s1", time: pick(40), color: "yellow", label: "S", tooltip: ["Split 2:1"] },
          { id: "e2", time: pick(75), color: "green", label: "E", tooltip: ["Earnings"] },
        ]);
      },
    };
    const w = new widget({
      symbol: "BTC",
      datafeed,
      interval: resolution,
      container: wrap,
      library_path: "/",
      locale: "en",
      theme: "dark",
      autosize: true,
      timezone,
      custom_font_family: "Arial, Helvetica, sans-serif",
      disabled_features: ["header_symbol_search", "popup_hints", "left_toolbar"],
      overrides: {
        "paneProperties.background": "#181615",
        "scalesProperties.backgroundColor": "#181615",
        "scalesProperties.textColor": "#8b887e",
        "mainSeriesProperties.candleStyle.upColor": "#66d89e",
        "mainSeriesProperties.candleStyle.downColor": "#e57359",
        "mainSeriesProperties.candleStyle.borderUpColor": "#66d89e",
        "mainSeriesProperties.candleStyle.borderDownColor": "#e57359",
        "mainSeriesProperties.candleStyle.wickUpColor": "#66d89e",
        "mainSeriesProperties.candleStyle.wickDownColor": "#e57359",
      },
      raze: { compact_breakpoint: 520 },
    });
    w.onChartReady(async () => {
      if (params.get("compare")) await w.activeChart().createCompare(params.get("compare"));
      window.__razeChart = w;
      window.__razeReady = true;
    });
  </script>
</body>
</html>`;

/** Records canvas text and strokes per animation frame. */
const RECORDER = () => {
  type Rec = Record<string, unknown>;
  const w = window as unknown as { __frames: Rec[][] };
  w.__frames = [[]];
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => {
    w.__frames.push([]);
    if (w.__frames.length > 40) w.__frames.shift();
    cb(t);
  });
  const proto = CanvasRenderingContext2D.prototype;
  const current = (): Rec[] => w.__frames[w.__frames.length - 1]!;
  const fillText = proto.fillText;
  proto.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
    current().push({
      op: "text", text: String(text), x, y, font: this.font, align: this.textAlign,
      baseline: this.textBaseline, width: this.measureText(String(text)).width,
    });
    return maxWidth === undefined ? fillText.call(this, text, x, y) : fillText.call(this, text, x, y, maxWidth);
  };
  const paths = new WeakMap<CanvasRenderingContext2D, { x: number; y: number }[]>();
  const beginPath = proto.beginPath;
  proto.beginPath = function (this: CanvasRenderingContext2D) {
    paths.set(this, []);
    return beginPath.call(this);
  };
  for (const name of ["moveTo", "lineTo"] as const) {
    const original = proto[name];
    proto[name] = function (this: CanvasRenderingContext2D, x: number, y: number) {
      paths.get(this)?.push({ x, y });
      return original.call(this, x, y);
    };
  }
  const stroke = proto.stroke;
  proto.stroke = function (this: CanvasRenderingContext2D, ...args: [Path2D?]) {
    current().push({ op: "stroke", color: String(this.strokeStyle), lineWidth: this.lineWidth, points: (paths.get(this) ?? []).slice() });
    return (stroke as (...a: unknown[]) => void).apply(this, args);
  };
  const fillRect = proto.fillRect;
  proto.fillRect = function (this: CanvasRenderingContext2D, x: number, y: number, rw: number, rh: number) {
    current().push({ op: "fillRect", x, y, w: rw, h: rh });
    return fillRect.call(this, x, y, rw, rh);
  };
};

interface TextCall { op: "text"; text: string; x: number; y: number; font: string; align: string; baseline: string; width: number }
interface StrokeCall { op: "stroke"; color: string; lineWidth: number; points: { x: number; y: number }[] }
interface RectCall { op: "fillRect"; x: number; y: number; w: number; h: number }
type Call = TextCall | StrokeCall | RectCall;

async function openHarness(page: Page, query: Record<string, string | number>, now: number): Promise<void> {
  await page.clock.setFixedTime(new Date(now));
  await page.addInitScript(RECORDER);
  await page.route("**/__axis/index.html*", (route) => route.fulfill({ body: HARNESS, contentType: "text/html" }));
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])), now: String(now) });
  await page.goto(`/__axis/index.html?${qs}`);
  await page.waitForFunction(() => (window as unknown as { __razeReady?: boolean }).__razeReady === true, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

/** The newest recorded frame that painted the time axis. */
async function lastFrame(page: Page): Promise<Call[]> {
  // The countdown timer repaints once a second; wait for a fresh full frame.
  await page.waitForTimeout(1_200);
  return page.evaluate(() => {
    const frames = (window as unknown as { __frames: unknown[][] }).__frames;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i]!.some((c) => (c as { op: string; h?: number }).op === "fillRect" && (c as { h: number }).h === 22)) {
        return frames[i] as never;
      }
    }
    return [] as never;
  });
}

function timeAxisTop(frame: Call[]): number {
  const axis = frame.find((c): c is RectCall => c.op === "fillRect" && c.h === 22 && c.x === 0);
  if (!axis) throw new Error("time axis not painted");
  return axis.y;
}

type Box = { l: number; r: number; t: number; b: number };
const textBox = (c: TextCall): Box => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(c.font)?.[1] ?? 11);
  const l = c.align === "center" ? c.x - c.width / 2 : c.align === "right" || c.align === "end" ? c.x - c.width : c.x;
  return { l, r: l + c.width, t: c.y - size / 2, b: c.y + size / 2 };
};
const intersects = (a: Box, b: Box): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

function tickLabels(frame: Call[], top: number, exclude: string[]): TextCall[] {
  return frame.filter((c): c is TextCall =>
    c.op === "text" && c.align === "center" && c.y > top && c.y < top + 22 && !exclude.includes(c.text));
}

const MIN = 60_000;
// 12:00:00 UTC plus 20 s into the forming 1-minute bar.
const NOW_1M = Date.UTC(2024, 0, 15, 12, 0, 20);

for (const width of [390, 480, 1280]) {
  for (const tz of ["Etc/UTC", "America/New_York"]) {
    test(`corner caption never touches a tick label at ${width}px (${tz})`, async ({ page }) => {
      await page.setViewportSize({ width: Math.max(width, 400), height: 700 });
      await openHarness(page, { w: width, h: 620, tz }, NOW_1M);
      const frame = await lastFrame(page);
      const top = timeAxisTop(frame);
      const caption = frame.find((c): c is TextCall => c.op === "text" && (c.text === tz || /^UTC([+-]\d+(:\d\d)?)?$/.test(c.text)));
      expect(caption, "the timezone caption is painted").toBeTruthy();
      if (tz === "America/New_York") expect(caption!.text).toBe("UTC-5");
      const captionBox = textBox(caption!);
      expect(captionBox.t).toBeGreaterThanOrEqual(top);
      expect(captionBox.b).toBeLessThanOrEqual(top + 22);
      const ticks = tickLabels(frame, top, [caption!.text]);
      expect(ticks.length, "tick labels are painted").toBeGreaterThan(0);
      for (const tick of ticks) {
        expect(intersects(textBox(tick), captionBox), `tick "${tick.text}" clears the caption`).toBe(false);
      }
      // The countdown is on the price axis, never glued to the caption.
      expect(frame.some((c) => c.op === "text" && /\d{3,}:\d\d/.test(c.text))).toBe(false);
      const countdown = frame.find((c): c is TextCall => c.op === "text" && c.text === "0:40");
      expect(countdown, "the 1-minute countdown reads 0:40").toBeTruthy();
      expect(countdown!.y).toBeLessThan(top);
    });
  }
}

test("the 1D countdown reads 22:55:25 under the last-price tag", async ({ page }) => {
  const now = Date.UTC(2024, 0, 15, 1, 4, 35);
  await page.setViewportSize({ width: 1280, height: 700 });
  await openHarness(page, { w: 1280, h: 620, res: "1D" }, now);
  const frame = await lastFrame(page);
  const top = timeAxisTop(frame);
  const countdown = frame.find((c): c is TextCall => c.op === "text" && c.text === "22:55:25");
  expect(countdown, "h:mm:ss countdown").toBeTruthy();
  expect(countdown!.y).toBeLessThan(top);
  const root = await page.locator(".raze-chart-root").boundingBox();
  expect(countdown!.x).toBeGreaterThan(root!.width - 80);
  expect(frame.some((c) => c.op === "text" && /\d{4}:\d\d/.test(c.text)), "no four-digit minute count").toBe(false);
  await expect(page).toHaveScreenshot("axis-chrome-countdown-1d.png", {
    clip: { x: 1280 - 300, y: 0, width: 300, height: 620 },
  });
});

test("a stale feed shows no countdown", async ({ page }) => {
  // The mock's last 1-minute bar opened at 12:00; ten minutes later it is stale.
  await openHarness(page, { w: 1280, h: 620 }, NOW_1M);
  await page.clock.setFixedTime(new Date(NOW_1M + 10 * MIN));
  const frame = await lastFrame(page);
  const top = timeAxisTop(frame);
  const priceAxisTexts = frame.filter((c): c is TextCall => c.op === "text" && c.y < top && c.x > 1280 - 70);
  expect(priceAxisTexts.some((c) => /^\d+:\d\d$/.test(c.text)), "no frozen countdown on the price axis").toBe(false);
  expect(frame.some((c) => c.op === "text" && c.text === "Etc/UTC")).toBe(true);
});

test("timescale marks are badges above the axis that never overprint ticks", async ({ page }) => {
  await openHarness(page, { w: 1280, h: 620, marks: 1 }, NOW_1M);
  const frame = await lastFrame(page);
  const top = timeAxisTop(frame);
  const badges = frame.filter((c): c is TextCall => c.op === "text" && /^600 [89]px/.test(c.font));
  expect(badges.map((b) => b.text).sort()).toEqual(["D", "E", "E", "S"]);
  const ticks = tickLabels(frame, top, []);
  for (const badge of badges) {
    expect(badge.y + 8).toBeLessThanOrEqual(top);
    for (const tick of ticks) expect(intersects(textBox(badge), textBox(tick))).toBe(false);
  }
  const stacked = badges.filter((b) => b.text === "D" || b.text === "S");
  expect(stacked[0]!.x).toBeCloseTo(stacked[1]!.x, 5);
  expect(stacked[0]!.y).not.toBeCloseTo(stacked[1]!.y, 0);
  expect(frame.some((c) => c.op === "text" && c.text === "Ear")).toBe(false);
});

test("ETH compared on a BTC chart stays inside the plot", async ({ page }) => {
  await openHarness(page, { w: 1280, h: 620, compare: "ETH" }, NOW_1M);
  for (const mode of ["price", "percent"] as const) {
    if (mode === "percent") {
      await page.getByRole("button", { name: "Percent scale" }).click();
    }
    const frame = await lastFrame(page);
    const top = timeAxisTop(frame);
    const line = frame.find((c): c is StrokeCall => c.op === "stroke" && c.color === "#26a69a" && c.lineWidth === 1.5);
    expect(line, `${mode}: the compare line is painted`).toBeTruthy();
    expect(line!.points.length).toBeGreaterThan(50);
    const ys = line!.points.map((p) => p.y);
    expect(Math.min(...ys), `${mode}: compare top inside the plot`).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys), `${mode}: compare bottom inside the plot`).toBeLessThanOrEqual(top);
    if (mode === "percent") {
      await expect(page.locator(".raze-chart-root")).toHaveScreenshot("axis-chrome-compare-percent.png");
    }
  }
});

test.describe("device pixel ratio 2", () => {
  test.use({ deviceScaleFactor: 2 });

  test("the bottom-right corner has no overlapping glyphs", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 620 });
    await openHarness(page, { w: 480, h: 620, tz: "America/New_York" }, NOW_1M);
    const frame = await lastFrame(page);
    const top = timeAxisTop(frame);
    const texts = frame.filter((c): c is TextCall => c.op === "text" && c.y > top && c.y < top + 22);
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        expect(intersects(textBox(texts[i]!), textBox(texts[j]!)), `"${texts[i]!.text}" and "${texts[j]!.text}" overlap`).toBe(false);
      }
    }
    // The time-axis row only: the ScaleBar above it is W1B-22's to move.
    await expect(page).toHaveScreenshot("axis-chrome-corner-dpr2.png", {
      clip: { x: 480 - 300, y: 620 - 24, width: 300, height: 24 },
    });
  });
});
