// Study pane layout & forced overlays (src/engine/layout.ts,
// src/engine/paint/studies.ts).
//
// Layout: across 300-1200px canvases and 0-10 stacked panes (with and without
// a dedicated volume pane) the main plot keeps max(120px, 40% of the content
// height), panes never overlap and the last pane never passes the time axis.
// Charts with room keep the historical geometry pixel for pixel.
//
// Forced overlays: createStudy("RSI", true) paints on the price pane with its
// own 0-100 scale instead of the price scale (where a 0-100 line on a
// 6,600-7,200 axis was off-screen), and never also paints in a sub-pane.
//
// Both modules are internal, so the test bundles the sources with esbuild.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workdir = mkdtempSync(join(tmpdir(), "raze-pane-layout-"));
let mod;
try {
  const bundle = await build({
    stdin: {
      contents: [
        'export * from "./src/engine/layout.ts";',
        'export * from "./src/engine/paint/studies.ts";',
        'export { yForPrice, priceForY } from "./src/engine/plotScale.ts";',
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const file = join(workdir, "pane-layout.mjs");
  writeFileSync(file, bundle.outputFiles[0].text);
  mod = await import(pathToFileURL(file).href);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

const {
  MAIN_PLOT_MIN_FRACTION,
  MAIN_PLOT_MIN_PX,
  SUB_PANE_GAP,
  SUB_PANE_MIN_H,
  TIME_AXIS_H,
  computePlotLayout,
  drawOverlayStudies,
  drawSubPanes,
  fitPaneHeights,
  forcedOverlayRange,
  isCollapsedPane,
  mainPlotFloor,
  priceForY,
  subPaneRange,
  timeAxisTop,
  yForPrice,
} = mod;

let checks = 0;
function check(name, fn) {
  try {
    fn();
    checks += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const paneDef = (name) => ({ name, pane: "pane", compute: () => [] });
const defs = (n) => Array.from({ length: n }, (_, i) => paneDef(`P${i}`));

/** The pre-W1B-17 formula, for the "has room" parity check. */
function legacyLayout(H, n, volumeMode) {
  const paneFrac = n ? Math.min(0.22, 0.45 / n) : 0;
  const paneH = n ? Math.max(48, Math.floor(H * paneFrac)) : 0;
  const volumeH = volumeMode === "pane" ? Math.max(36, Math.floor(H * 0.16)) : 0;
  const plotH = Math.max(1, H - TIME_AXIS_H - n * (paneH + SUB_PANE_GAP) - (volumeH ? volumeH + SUB_PANE_GAP : 0));
  const volumeTop = volumeH ? plotH + SUB_PANE_GAP : null;
  const origin = volumeH ? volumeTop + volumeH + SUB_PANE_GAP : plotH + SUB_PANE_GAP;
  return {
    plotH,
    volumePane: volumeH ? { top: volumeTop, h: volumeH } : null,
    panes: Array.from({ length: n }, (_, i) => ({ top: origin + i * (paneH + SUB_PANE_GAP), h: paneH })),
  };
}

// ── Layout invariants over the whole grid ─────────────────────────────────

check("main plot floor constant", () => {
  assert.equal(MAIN_PLOT_MIN_PX, 120);
  assert.equal(MAIN_PLOT_MIN_FRACTION, 0.4);
  assert.equal(SUB_PANE_MIN_H, 24);
  assert.equal(mainPlotFloor(300), 120, "300px: 120px beats 40% of 278");
  assert.equal(mainPlotFloor(1200), Math.ceil(0.4 * 1178));
});

let squeezed = 0;
let collapsed = 0;
for (const volumeMode of ["overlay", "pane", "hidden"]) {
  for (let H = 300; H <= 1200; H += 5) {
    for (let n = 0; n <= 10; n++) {
      const label = `${H}px, ${n} panes, volume ${volumeMode}`;
      const layout = computePlotLayout(1000, H, 64, defs(n), volumeMode);
      const content = H - TIME_AXIS_H;
      check(label, () => {
        const floor = Math.max(MAIN_PLOT_MIN_PX, MAIN_PLOT_MIN_FRACTION * content);
        assert.ok(layout.plotH >= floor, `${label}: plotH ${layout.plotH} < floor ${floor}`);
        assert.equal(layout.plotT, 0);
        assert.equal(layout.plotW, 1000 - 64);
        assert.equal(layout.subPanes.length, n, `${label}: every pane study keeps a pane`);
        assert.equal(!!layout.volumePane, volumeMode === "pane");

        const stacked = [...(layout.volumePane ? [layout.volumePane] : []), ...layout.subPanes];
        let prevBottom = layout.plotT + layout.plotH;
        for (const pane of stacked) {
          assert.ok(Number.isInteger(pane.top) && Number.isInteger(pane.h), `${label}: integer geometry`);
          assert.ok(pane.h >= 0, `${label}: non-negative height`);
          assert.equal(pane.top, prevBottom + SUB_PANE_GAP, `${label}: panes stack with one gap`);
          prevBottom = pane.top + pane.h;
        }
        assert.ok(prevBottom <= content, `${label}: last pane bottom ${prevBottom} passes the time axis at ${content}`);
        assert.equal(
          timeAxisTop(layout.plotT, layout.plotH, layout.subPanes, layout.volumePane),
          prevBottom,
        );

        // Stacked panes are all plotted (>= 24px) or all collapsed together.
        const anyCollapsed = stacked.some(isCollapsedPane);
        if (anyCollapsed) {
          collapsed += 1;
          assert.ok(stacked.every(isCollapsedPane), `${label}: collapse is all-or-nothing`);
          const hs = stacked.map((p) => p.h);
          assert.ok(Math.max(...hs) - Math.min(...hs) <= 1, `${label}: collapsed strips share the room`);
        }

        const legacy = legacyLayout(H, n, volumeMode === "pane" ? "pane" : "overlay");
        if (legacy.plotH >= floor) {
          // Room for the preferred geometry: nothing moves.
          assert.equal(layout.plotH, legacy.plotH, `${label}: plotH unchanged when it fits`);
          assert.deepEqual(layout.volumePane, legacy.volumePane, `${label}: volume pane unchanged`);
          assert.deepEqual(
            layout.subPanes.map(({ top, h }) => ({ top, h })),
            legacy.panes,
            `${label}: panes unchanged when they fit`,
          );
        } else {
          squeezed += 1;
          // Squeezed: the main plot gives up nothing past its floor (rounding
          // leftovers only), and study panes shrink evenly.
          assert.ok(layout.plotH - Math.ceil(floor) < stacked.length + 1, `${label}: only rounding goes to the main plot`);
          if (!anyCollapsed) {
            const hs = layout.subPanes.map((p) => p.h);
            if (hs.length) assert.ok(Math.max(...hs) - Math.min(...hs) <= 1, `${label}: study panes shrink evenly`);
          }
        }
      });
    }
  }
}
assert.ok(squeezed > 100, "the grid exercises the squeeze path");
assert.ok(collapsed > 10, "the grid exercises the collapse path");

check("audit repro: 5 panes in a 420px widget", () => {
  const l = computePlotLayout(800, 420, 64, defs(5));
  assert.ok(l.plotH >= 0.4 * (420 - TIME_AXIS_H), `plotH ${l.plotH}`);
  assert.ok(l.subPanes.every((p) => p.h >= SUB_PANE_MIN_H));
});

check("audit repro: 8 panes at 400px no longer leave a 1px plot", () => {
  const l = computePlotLayout(800, 400, 64, defs(8));
  assert.ok(l.plotH >= 152, `plotH ${l.plotH}`);
  const last = l.subPanes.at(-1);
  assert.ok(last.top + last.h <= 400 - TIME_AXIS_H);
});

check("audit repro: 6 panes + volume pane at 442px", () => {
  const l = computePlotLayout(800, 442, 64, defs(6), "pane");
  assert.ok(l.plotH >= 168, `plotH ${l.plotH} (was 41)`);
});

check("historic geometry at the golden size", () => {
  const l = computePlotLayout(1000, 620, 64, defs(1));
  assert.equal(l.plotH, 459);
  assert.deepEqual(l.subPanes.map(({ top, h }) => ({ top, h })), [{ top: 462, h: 136 }]);
});

// ── fitPaneHeights ─────────────────────────────────────────────────────────

check("fitPaneHeights keeps heights that fit", () => {
  assert.deepEqual(fitPaneHeights([60, 40], 100), [60, 40]);
  assert.deepEqual(fitPaneHeights([], 10), []);
});

check("fitPaneHeights shrinks proportionally", () => {
  const out = fitPaneHeights([100, 50], 120);
  assert.deepEqual(out, [80, 40]);
});

check("fitPaneHeights pins small shares to the minimum", () => {
  const out = fitPaneHeights([200, 30, 30], 120);
  assert.deepEqual(out.slice(1), [SUB_PANE_MIN_H, SUB_PANE_MIN_H]);
  assert.ok(out[0] >= SUB_PANE_MIN_H && out.reduce((a, b) => a + b, 0) <= 120);
});

check("fitPaneHeights collapses to equal strips", () => {
  const out = fitPaneHeights([48, 48, 48, 48], 60);
  assert.deepEqual(out, [15, 15, 15, 15]);
  assert.deepEqual(fitPaneHeights([48, 48], -5), [0, 0]);
});

// ── Forced overlay paint ────────────────────────────────────────────────────

/** Records the y coordinate of every path point and text, per stroke colour. */
function recordingContext() {
  const points = [];
  const texts = [];
  const rects = [];
  const ctx = {
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    lineJoin: "miter",
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    clip() {},
    rect() {},
    stroke() {},
    fill() {},
    setLineDash() {},
    moveTo(x, y) { points.push({ x, y, color: ctx.strokeStyle }); },
    lineTo(x, y) { points.push({ x, y, color: ctx.strokeStyle }); },
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, color: ctx.fillStyle }); },
    fillText(text, x, y) { texts.push({ text, x, y }); },
  };
  return { ctx, points, texts, rects };
}

const RSI_COLOR = "#7E57C2";
const rsiDef = {
  name: "RSI",
  pane: "pane",
  range: { min: 0, max: 100 },
  levels: [{ value: 30, axisLabel: true }, { value: 50, dashed: true }, { value: 70, axisLabel: true }],
  compute: () => [],
};
const macdDef = { name: "MACD", pane: "pane", compute: () => [] };

const N = 200;
const bars = Array.from({ length: N }, (_, i) => ({
  time: i * 60,
  open: 6600 + i * 3,
  high: 6610 + i * 3,
  low: 6590 + i * 3,
  close: 6605 + i * 3,
}));
const rsiValues = Array.from({ length: N }, (_, i) => (i < 14 ? null : 50 + 25 * Math.sin(i / 9)));
const macdLine = Array.from({ length: N }, (_, i) => 30 + 20 * Math.sin(i / 11));
const macdHist = Array.from({ length: N }, (_, i) => 5 + 4 * Math.cos(i / 7));

function makeView(studies, subPanes = []) {
  return {
    plotL: 0,
    plotT: 0,
    plotW: 936,
    plotH: 500,
    priceMin: 6550,
    priceMax: 7250,
    pctBase: 0,
    visibleRange: { from: 0, to: N - 1 },
    percentScale: false,
    logScale: false,
    context: {
      bars,
      theme: { paneBackground: "#181615", horzGrid: "#222", vertGrid: "#222", scaleText: "#888" },
    },
    fontFamily: "sans-serif",
    subPanes,
    studies: {
      list: () => studies,
      paneStudies: (def) => studies.filter((s) => s.def === def),
    },
  };
}

check("createStudy('RSI', true) paints across the price pane on its own 0-100 scale", () => {
  const forced = { def: rsiDef, color: RSI_COLOR, values: rsiValues, series: [], forceOverlay: true };
  const v = makeView([forced]);
  const { ctx, points } = recordingContext();
  drawOverlayStudies(ctx, v);
  const line = points.filter((p) => p.color === RSI_COLOR && p.x > v.plotL);
  assert.ok(line.length >= N - 14, `the RSI line has a point per visible bar (got ${line.length})`);
  const ys = line.map((p) => p.y);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  assert.ok(top >= v.plotT && bottom <= v.plotT + v.plotH, `inside the plot: ${top}..${bottom}`);
  assert.ok(bottom - top > v.plotH * 0.3, "RSI 25..75 spans a visible share of the pane");
  // RSI 50 sits on the middle of its own scale.
  assert.equal(forcedOverlayRange(v, forced).max, 100);
  // The price scale itself is untouched: the crosshair still reads prices.
  assert.equal(Math.round(priceForY(v, yForPrice(v, 6900))), 6900);
});

check("the pre-fix mapping would have been off-screen", () => {
  const v = makeView([]);
  assert.ok(yForPrice(v, 75) > v.plotT + v.plotH * 10, "RSI values on the price scale are far below the pane");
});

check("forced overlays draw their guide levels on the price pane", () => {
  const forced = { def: rsiDef, color: RSI_COLOR, values: rsiValues, series: [], forceOverlay: true };
  const v = makeView([forced]);
  const { ctx, points } = recordingContext();
  drawOverlayStudies(ctx, v);
  const levelYs = new Set(points.filter((p) => p.x === v.plotL && p.color === RSI_COLOR).map((p) => p.y));
  assert.ok(levelYs.size >= 3, "30/50/70 guide lines");
  for (const y of levelYs) assert.ok(y > v.plotT && y < v.plotT + v.plotH);
});

check("forced overlay without a fixed range fits its own values, with zero for histograms", () => {
  const forced = {
    def: macdDef,
    color: "#2962ff",
    values: macdLine,
    series: [
      { values: macdLine, style: "line", color: "#2962ff" },
      { values: macdHist, style: "histogram", color: "#66d89e" },
    ],
    forceOverlay: true,
  };
  const v = makeView([forced]);
  const range = forcedOverlayRange(v, forced);
  assert.equal(range.min, 0, "histogram pulls zero into the range");
  assert.ok(range.max > 49 && range.max <= 50);
  const { ctx, points, rects } = recordingContext();
  drawOverlayStudies(ctx, v);
  const line = points.filter((p) => p.color === "#2962ff");
  assert.ok(line.length > 100);
  for (const p of line) assert.ok(p.y >= v.plotT && p.y <= v.plotT + v.plotH);
  assert.ok(rects.length > 100, "histogram bars paint");
  for (const r of rects) assert.ok(r.y >= v.plotT && r.y + r.h <= v.plotT + v.plotH + 1);
});

check("native overlays still use the price scale", () => {
  const ema = { def: { name: "EMA", pane: "overlay", compute: () => [] }, color: "#f5a623", values: bars.map((b) => b.close), series: [] };
  const v = makeView([ema]);
  const { ctx, points } = recordingContext();
  drawOverlayStudies(ctx, v);
  const first = points.find((p) => p.color === "#f5a623");
  assert.equal(first.y, yForPrice(v, bars[0].close));
});

check("a forced overlay never also paints in a sub-pane of the same definition", () => {
  const inPane = { def: rsiDef, color: "#111111", values: rsiValues.map((x) => (x == null ? null : x - 10)), series: [] };
  const forced = { def: rsiDef, color: RSI_COLOR, values: rsiValues, series: [], forceOverlay: true };
  const pane = { def: rsiDef, top: 400, h: 120, min: 0, max: 1 };
  const v = makeView([inPane, forced], [pane]);
  const { ctx, points } = recordingContext();
  drawSubPanes(ctx, v, []);
  assert.ok(points.some((p) => p.color === "#111111"), "pane instance paints");
  assert.ok(!points.some((p) => p.color === RSI_COLOR), "forced instance stays out of the pane");
  const fittedDef = { name: "X", pane: "pane", compute: () => [] };
  const a = { def: fittedDef, color: "#aaaaaa", values: [1, 2, 3], series: [] };
  const b = { def: fittedDef, color: "#bbbbbb", values: [500, 900, 700], series: [], forceOverlay: true };
  const range = subPaneRange(makeView([a, b]), fittedDef);
  assert.ok(range.max < 10, `pane range ignores the forced overlay (max ${range.max})`);
});

check("collapsed panes paint a header strip only", () => {
  const study = { def: rsiDef, color: RSI_COLOR, values: rsiValues, series: [] };
  const pane = { def: rsiDef, top: 400, h: 14, min: 0, max: 1 };
  assert.ok(isCollapsedPane(pane));
  const v = makeView([study], [pane]);
  const { ctx, points, texts } = recordingContext();
  drawSubPanes(ctx, v, [{ index: 10, time: 600 }]);
  assert.equal(points.length, 0, "no values or grid in a collapsed strip");
  assert.deepEqual(texts.map((t) => t.text), ["RSI"]);
  assert.equal(texts[0].y, 407, "title centred in the strip");
});

console.log(`pane-layout: ${checks} checks passed (${squeezed} squeezed, ${collapsed} collapsed layouts)`);
