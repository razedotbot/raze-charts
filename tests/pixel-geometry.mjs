// Unit tests for bitmap-space painting (W1B-08): pixel.ts helpers, candle
// column geometry, and the painters' handling of clipping and zero/negative
// prices, run against a recording 2D context. Real-browser pixel reads live in
// tests/pixel-snapping.spec.ts. Bundles the internal modules from source with
// esbuild: node tests/pixel-geometry.mjs

import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};
const equal = (actual, expected, message) =>
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);

const entry = `
export * from "./src/engine/paint/pixel";
export { candleColumns, drawCandles, drawOhlcBars, drawColumns, drawBaseline } from "./src/engine/paint/candles";
export { drawLineArea } from "./src/engine/paint/lineArea";
export { drawLastPrice } from "./src/engine/paint/lastPrice";
export { drawGrid } from "./src/engine/paint/grid";
export { drawVolume } from "./src/engine/paint/volume";
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts", sourcefile: "pixel-entry.ts" },
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: ["es2020"],
  write: false,
  logLevel: "silent",
});
const P = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

/** A 2D context double that records drawing calls and tracks a transform. */
function recordingContext({ transform = [1, 0, 0, 1, 0, 0], withGetTransform = true } = {}) {
  const ops = [];
  const stack = [];
  const state = { transform: [...transform], fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1, lineWidth: 1 };
  const ctx = {
    ops,
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v) { state.fillStyle = v; },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v) { state.strokeStyle = v; },
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(v) { state.globalAlpha = v; },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(v) { state.lineWidth = v; },
    lineJoin: "miter",
    lineCap: "butt",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    save() { stack.push({ ...state, transform: [...state.transform] }); ops.push(["save"]); },
    restore() { const s = stack.pop(); if (s) Object.assign(state, s); ops.push(["restore"]); },
    setTransform(...m) { state.transform = m; ops.push(["setTransform", ...m]); },
    fillRect(...a) { ops.push(["fillRect", state.fillStyle, ...a]); },
    rect(...a) { ops.push(["rect", ...a]); },
    beginPath() { ops.push(["beginPath"]); },
    fill() { ops.push(["fill", state.fillStyle]); },
    stroke() { ops.push(["stroke", state.strokeStyle]); },
    clip() { ops.push(["clip"]); },
    moveTo(...a) { ops.push(["moveTo", ...a]); },
    lineTo(...a) { ops.push(["lineTo", ...a]); },
    closePath() { ops.push(["closePath"]); },
    arcTo() {},
    roundRect(...a) { ops.push(["roundRect", ...a]); },
    setLineDash() {},
    fillText(text) { ops.push(["fillText", text]); },
    measureText: (t) => ({ width: String(t).length * 6 }),
    get depth() { return stack.length; },
  };
  if (withGetTransform) {
    ctx.getTransform = () => {
      const [a, b, c, d, e, f] = state.transform;
      return { a, b, c, d, e, f };
    };
  }
  return ctx;
}

const theme = {
  paneBackground: "#000", vertGrid: "vgrid", horzGrid: "hgrid", crosshair: "x", scaleText: "t", scaleBackground: "#000",
  scaleLine: "sep", candleUp: "up", candleDown: "down", borderUp: "up", borderDown: "down", wickUp: "wup", wickDown: "wdown",
  volUp: "vol", volDown: "vol", lineColor: "line", showPriceScaleCrosshairLabel: true, showTimeScaleCrosshairLabel: true,
};

function view(bars, overrides = {}) {
  return {
    context: {
      theme, bars, chartStyle: "candles", volumeMode: "hidden", autoScalePrice: true,
      options: { overrides: {} }, symbolInfo: { pricescale: 100 }, formatPrice: (p) => p.toFixed(2),
    },
    cssWidth: 640, cssHeight: 360, dpr: 1, priceAxisW: 60,
    plotL: 0, plotT: 0, plotW: 580, plotH: 338, priceMin: 80, priceMax: 130, pctBase: 1,
    visibleRange: { from: 0, to: bars.length }, percentScale: false, logScale: false,
    subPanes: [], volumePane: null, seriesBars: bars, fontFamily: "Arial",
    ...overrides,
  };
}

// ── pixel.ts ────────────────────────────────────────────────────────────────
for (const [dpr, expected] of [[1, 1], [1.25, 1], [1.5, 1], [1.75, 1], [2, 2], [2.5, 2], [3, 3]]) {
  equal(P.deviceLineWidth(1, dpr), expected, `a 1px hairline is ${expected} device px at DPR ${dpr}`);
}
equal(P.lineStart(10, 1), 10, "a one-pixel line starts at its anchor");
equal(P.lineStart(10, 3), 9, "an odd line is centred on its anchor");
equal(P.lineStart(10, 2), 10, "an even line grows right/down from its anchor");

{
  const ctx = recordingContext({ transform: [1.5, 0, 0, 1.5, 0, 0] });
  const depth = ctx.depth;
  P.withBitmapSpace(ctx, 99, (s) => {
    equal([s.hpr, s.vpr], [1.5, 1.5], "the bitmap scope reads its ratios from the current transform, not the fallback");
    equal(ctx.getTransform(), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, "the scope paints with an identity transform");
    equal([s.x(10.3), s.y(0.2)], [15, 0], "CSS coordinates round to whole device pixels");
    const a = P.snapRect(s, 0, 0, 10.3, 5);
    const b = P.snapRect(s, 10.3, 0, 7.1, 5);
    equal(a.x + a.w, b.x, "rectangles that share a CSS edge tile without a gap or overlap");
    equal(P.vLineRect(s, 7.7, 1, 9), { x: 12, y: 2, w: 1, h: 12 }, "a vertical hairline is one integer device column");
    equal(P.hLineRect(s, 7.7, 1, 9, 2), { x: 2, y: 11, w: 12, h: 3 }, "a 2px CSS line at DPR 1.5 is floor(3) device rows");
  });
  equal(ctx.depth, depth, "withBitmapSpace restores the context state");
  equal(ctx.getTransform(), { a: 1.5, b: 0, c: 0, d: 1.5, e: 0, f: 0 }, "the caller's transform comes back");
}
{
  const ctx = recordingContext({ withGetTransform: false });
  P.withBitmapSpace(ctx, 2, (s) => equal([s.hpr, s.vpr], [2, 2], "a context without getTransform falls back to the view DPR"));
  const rotated = recordingContext({ transform: [0, 1, -1, 0, 0, 0] });
  P.withBitmapSpace(rotated, 2, (s) => {
    equal([s.hpr, s.vpr], [1, 1], "a rotated transform snaps to the CSS grid");
    assert(!rotated.ops.some(([op]) => op === "setTransform"), "a rotated transform is left in place");
  });
}
{
  const ctx = recordingContext({ transform: [1.5, 0, 0, 1.5, 0, 0] });
  P.withBitmapSpace(ctx, 1.5, (s) => P.dashedHLine(s, 10, 0, 20, 1, [3, 3]));
  const dashes = ctx.ops.filter(([op]) => op === "rect").map(([, x, , w]) => [x, w]);
  // 3 CSS px at DPR 1.5 = 4.5 -> 5 device px on, 5 off, across 30 device px.
  equal(dashes, [[0, 5], [10, 5], [20, 5]], "dashes are whole-device-pixel rectangles on a device-pixel period");
  assert(!ctx.ops.some(([op]) => op === "stroke"), "dashes are filled, not stroked (stroked dash ends anti-alias)");
}
equal(P.alignToDevice(10.6, 1.5), 16 / 1.5, "alignToDevice snaps CSS values to device boundaries");

// ── candle columns ──────────────────────────────────────────────────────────
for (const dpr of [1, 1.25, 1.5, 1.75, 2, 3]) {
  let checked = 0;
  for (let spacing = 1.5; spacing <= 64; spacing += 0.37) {
    const c = P.candleColumns(spacing, dpr);
    if ((c.bodyW - c.wickW) % 2 !== 0) throw new Error(`body/wick parity differs at spacing ${spacing}, DPR ${dpr}`);
    if (c.bodyW < c.wickW) throw new Error(`body narrower than the wick at spacing ${spacing}, DPR ${dpr}`);
    if (!c.thin && c.bodyW > c.slot - c.wickW) throw new Error(`bodies touch at spacing ${spacing}, DPR ${dpr}`);
    if (c.bodyW > Math.ceil(18 * dpr) + 1) throw new Error(`body exceeds CANDLE_MAX_WIDTH at DPR ${dpr}`);
    checked++;
  }
  assert(checked > 100, `candle bodies share the wick's parity, never touch and respect the cap at DPR ${dpr}`);
}
equal(P.candleColumns(9.21, 1), { wickW: 1, bodyW: 7, thin: false, slot: 9 }, "default spacing gives an odd 7px body around a 1px wick");
equal(P.candleColumns(4, 1).bodyW, 3, "spacing 4 keeps a 3px body (thin bars start below 4px)");
assert(P.candleColumns(3.5, 1).thin, "spacing below 4px at DPR 1 paints thin candles");
assert(!P.candleColumns(3.5, 2).thin, "the same spacing at DPR 2 has room for real bodies");

// ── painters ────────────────────────────────────────────────────────────────
const fillRects = (ctx, color) => ctx.ops.filter(([op, style]) => op === "fillRect" && (!color || style === color));
{
  // All-negative (-80..-60) and zero-crossing bars.
  for (const [name, lo, hi] of [["negative", -80, -60], ["zero-crossing", -10, 10]]) {
    const bars = Array.from({ length: 20 }, (_, i) => {
      const open = lo + ((i * 7) % (hi - lo));
      const close = lo + ((i * 11 + 3) % (hi - lo));
      return { time: i, open, close, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, volume: 1 };
    });
    const v = view(bars, { priceMin: lo - 5, priceMax: hi + 5 });
    const candles = recordingContext();
    P.drawCandles(candles, v, bars);
    const bodies = fillRects(candles).filter(([, style]) => style === "up" || style === "down");
    equal(bodies.length, bars.length, `${name}: every candle body paints`);
    const lows = fillRects(candles).filter(([, style]) => style === "wup" || style === "wdown");
    assert(lows.length >= bars.length, `${name}: wicks paint to the real (non-positive) lows`);

    const line = recordingContext();
    P.drawLineArea(line, v, false);
    equal(line.ops.filter(([op]) => op === "lineTo").length, bars.length - 1, `${name}: the line joins every close`);

    const pill = recordingContext();
    P.drawLastPrice(pill, v);
    assert(pill.ops.some(([op, text]) => op === "fillText" && text === bars.at(-1).close.toFixed(2)), `${name}: the last-price pill shows ${bars.at(-1).close.toFixed(2)}`);
  }
}
{
  // Whitespace: non-finite OHLC values are skipped, not painted as zero.
  const bars = [
    { time: 0, open: 100, close: 110, high: 115, low: 95 },
    { time: 1, open: NaN, close: NaN, high: NaN, low: NaN },
    { time: 2, open: 110, close: 100, high: 115, low: 95 },
  ];
  const ctx = recordingContext();
  P.drawCandles(ctx, view(bars), bars);
  equal(fillRects(ctx).filter(([, s]) => s === "up" || s === "down").length, 2, "non-finite bars are whitespace");
  const line = recordingContext();
  P.drawLineArea(line, view(bars), false);
  equal(line.ops.filter(([op]) => op === "moveTo").length, 2, "a whitespace bar breaks the line");
}
{
  // Log scale: non-positive closes cannot be placed and are skipped.
  const bars = [
    { time: 0, open: 1, close: 2, high: 3, low: 0.5 },
    { time: 1, open: 2, close: -1, high: 3, low: -2 },
  ];
  const v = view(bars, { logScale: true, priceMin: -1, priceMax: 1 });
  const ctx = recordingContext();
  P.drawCandles(ctx, v, bars);
  equal(fillRects(ctx).filter(([, s]) => s === "up" || s === "down").length, 1, "log scale skips a candle with a non-positive close");
  const last = recordingContext();
  P.drawLastPrice(last, v);
  assert(!last.ops.some(([op]) => op === "fillText"), "log scale omits a non-positive last price");
}
{
  // Every main-series style clips to the price pane.
  const bars = [{ time: 0, open: 100, close: 110, high: 400, low: -300, volume: 1 }];
  for (const [label, paint] of [
    ["candles", (ctx, v) => P.drawCandles(ctx, v, bars)],
    ["hollow candles", (ctx, v) => P.drawCandles(ctx, v, bars, true)],
    ["bars", (ctx, v) => P.drawOhlcBars(ctx, v, bars)],
    ["columns", (ctx, v) => P.drawColumns(ctx, v, bars)],
    ["line", (ctx, v) => P.drawLineArea(ctx, v, false)],
    ["area", (ctx, v) => P.drawLineArea(ctx, v, true)],
    ["baseline", (ctx, v) => P.drawBaseline(ctx, v)],
  ]) {
    const ctx = recordingContext();
    paint(ctx, view(bars));
    const clipAt = ctx.ops.findIndex(([op]) => op === "clip");
    const firstPaint = ctx.ops.findIndex(([op]) => op === "fillRect" || op === "fill" || op === "stroke");
    assert(clipAt >= 0 && (firstPaint < 0 || clipAt < firstPaint), `${label} clips to the price pane before painting`);
  }
}
{
  // Volume columns: body-wide under normal candles, slot-wide under thin ones.
  const bars = Array.from({ length: 400 }, (_, i) => ({ time: i, open: 100, close: 101, high: 102, low: 99, volume: 10 + i }));
  const widths = (spacing) => {
    const ctx = recordingContext();
    const v = view(bars, { visibleRange: { from: 0, to: 580 / spacing } });
    v.context.volumeMode = "overlay";
    P.drawVolume(ctx, v);
    return [...new Set(fillRects(ctx, "vol").map(([, , , , w]) => w))];
  };
  equal(widths(9.21), [P.candleColumns(9.21, 1).bodyW], "volume columns match the candle body width");
  equal(widths(3.5), [2], "thin candles get volume columns that fill the slot minus a hairline gap");
}
{
  // thinBars override: a non-boolean warns once per overrides object.
  const bars = [{ time: 0, open: 100, close: 110, high: 115, low: 95 }];
  const v = view(bars);
  v.context.options.overrides = { "mainSeriesProperties.barStyle.thinBars": "yes" };
  const warnings = [];
  const warn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    P.drawOhlcBars(recordingContext(), v, bars);
    P.drawOhlcBars(recordingContext(), v, bars);
  } finally {
    console.warn = warn;
  }
  equal(warnings.length, 1, "a non-boolean thinBars override warns exactly once");
  assert(warnings[0].includes("barStyle.thinBars") && warnings[0].includes("boolean"), "the warning names the override and the expected type");
}

console.log(`\npixel geometry: ${passed} assertions passed`);
