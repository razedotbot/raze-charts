// Drawing-tool registry and built-in tools (W1B-11).
//
// The registry, the drawing runtime (src/engine/paint/shapes.ts) and the
// built-in tools are bundled from source and exercised against a synthetic
// FinanceView and a recording canvas context, so every assertion is about
// geometry and paint calls rather than pixels:
//   - registry validation (string ids and aliases, the icon allowlist against
//     every HTML attribute separator), aliases, defaults and anchor counts,
//     and the warning for contract hooks nothing calls yet;
//   - hit geometry matches paint (ray/extended extensions, fib levels, text
//     glyph boxes, filled rectangle interiors);
//   - Liang-Barsky clipping reaches the plot from anchors far off-screen;
//   - line style/width, rectangle fill, text style, TradingView fib direction,
//     the formatted measure label, theme tokens and contrast;
//   - handles only on hover (while the pointer is on the canvas) or
//     selection, store z order, queued axis tags, and no hit target for a
//     horizontal line without a price;
//   - an external 3-anchor tool drafted with 3 clicks, dragged by a handle,
//     undone, and round-tripped through the store snapshot (the widget's
//     save()/load() and the objects tree are covered in a real browser by
//     tests/drawing-tools.spec.ts);
//   - development reloads with { replace: true }, and a tool that throws or
//     restores too often cannot unbalance the frame's canvas state.
//
// Run: node tests/drawing-tools.mjs

import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const throwsLike = (fn, pattern, message) => {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof TypeError && pattern.test(error.message), `${message}${error ? ` (${error.message})` : " (nothing thrown)"}`);
};

// ── Text measurement: a deterministic 0.6em-per-glyph font ───────────────────
const fontSizeOf = (font) => Number(/(\d+(?:\.\d+)?)px/.exec(font ?? "")?.[1] ?? 10);
class MeasureContext {
  font = "10px sans-serif";
  measureText(text) {
    return { width: String(text).length * fontSizeOf(this.font) * 0.6 };
  }
}
globalThis.document = { createElement: () => ({ getContext: () => new MeasureContext() }) };

// ── Recording canvas context ─────────────────────────────────────────────────
const STATE_KEYS = [
  "strokeStyle", "fillStyle", "lineWidth", "globalAlpha", "font", "textAlign",
  "textBaseline", "shadowBlur", "shadowColor", "lineDash", "miterLimit",
];
class RecordingContext extends MeasureContext {
  constructor() {
    super();
    this.calls = [];
    this.stack = [];
    Object.assign(this, {
      strokeStyle: "#000", fillStyle: "#000", lineWidth: 1, globalAlpha: 1, textAlign: "start",
      textBaseline: "alphabetic", shadowBlur: 0, shadowColor: "transparent", lineDash: [], miterLimit: 10,
    });
  }
  snapshot() {
    return Object.fromEntries(STATE_KEYS.map((key) => [key, Array.isArray(this[key]) ? [...this[key]] : this[key]]));
  }
  record(op, ...args) {
    this.calls.push({ op, args, state: this.snapshot() });
  }
  save() { this.stack.push(this.snapshot()); }
  restore() { Object.assign(this, this.stack.pop() ?? {}); }
  setLineDash(dash) { this.lineDash = [...dash]; }
  getLineDash() { return [...this.lineDash]; }
  reset() { this.calls.length = 0; }
  ops(op) { return this.calls.filter((call) => call.op === op); }
}
for (const op of ["beginPath", "moveTo", "lineTo", "closePath", "stroke", "fill", "fillRect", "strokeRect", "rect", "clip", "arc", "arcTo", "fillText"]) {
  RecordingContext.prototype[op] = function record(...args) { this.record(op, ...args); };
}

// ── Bundle the drawing modules from source ───────────────────────────────────
const entry = `
export * from "./src/drawings/registry";
export * from "./src/drawings/format";
export { clipLine, dashPattern, wrapText } from "./src/drawings/tools/common";
export { fibLevelPrice } from "./src/drawings/tools/fibRetracement";
export { measureLabel } from "./src/drawings/tools/measure";
export { rectangleFill } from "./src/drawings/tools/rectangle";
export { textLayout } from "./src/drawings/tools/text";
export {
  constrainDrawingPoint, drawDraft, drawShapes, drawingThemeOf, hitComplexShape, hitDrawing, neededPoints,
} from "./src/engine/paint/shapes";
export { buildTheme, DEFAULT_DRAWING_COLOR, isLightColor } from "./src/core/theme";
export { ShapeStore } from "./src/core/ShapeStore";
export { CommandStack } from "./src/core/CommandStack";
export { Delegate } from "./src/util/delegate";
export { createPriceFormatter } from "./src/util/format";
export { drawingDraftHandler, drawingEditHandler } from "./src/engine/interaction/drawing";
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts", sourcefile: "drawing-tools-entry.ts" },
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: ["es2020"],
  write: false,
  logLevel: "silent",
});
const scratch = mkdtempSync(join(tmpdir(), "raze-drawing-tools-"));
const bundlePath = join(scratch, "drawing-tools.mjs");
writeFileSync(bundlePath, bundled.outputFiles[0].text);
const D = await import(pathToFileURL(bundlePath).href);
rmSync(scratch, { recursive: true, force: true });

const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.map(String).join(" "));

// ── Synthetic chart: 200 one-minute bars, 4px per bar, price 0..400 over 400px ──
const T0 = 1_700_000_000; // Unix seconds of bar 0
const BAR = 60;
const bars = Array.from({ length: 200 }, (_, i) => ({ time: (T0 + i * BAR) * 1000, open: 100, high: 110, low: 90, close: 105, volume: 1 }));
const timeOf = (index) => T0 + index * BAR;
const xOf = (index) => (index + 0.5) * 4;
const yOf = (price) => 400 - price;

function makeWorld({ theme = "dark", overrides = {}, pricescale = 100 } = {}) {
  const symbolInfo = { pricescale, minmov: 1 };
  const context = {
    bars,
    resolution: "1",
    symbolInfo,
    formatPrice: D.createPriceFormatter(null, symbolInfo),
    theme: D.buildTheme({ theme, overrides }),
    drawingEvent: new D.Delegate(),
    selectedShapeId: null,
    requestPaint() {},
  };
  const commands = new D.CommandStack();
  const shapes = new D.ShapeStore(context, commands);
  const view = {
    context,
    plotL: 0, plotT: 0, plotW: 800, plotH: 400,
    priceMin: 0, priceMax: 400, pctBase: 0,
    visibleRange: { from: 0, to: 200 },
    percentScale: false, logScale: false,
    cssWidth: 860, cssHeight: 440, dpr: 1, priceAxisW: 60,
    shapes, shapeScreen: [], axisTags: [],
    crosshair: { x: 0, y: 0, active: false },
    hoverShapeId: null, selectedShapeId: null, draft: null,
    fontFamily: "sans-serif",
  };
  const ctx = new RecordingContext();
  const paint = () => {
    ctx.reset();
    view.axisTags = [];
    D.drawShapes(ctx, view);
    return ctx;
  };
  return { context, commands, shapes, view, ctx, paint };
}
const add = async (world, shape, points, overrides = {}, extra = {}) => {
  const id = await world.shapes.createPoints(points.map(([i, price]) => ({ time: timeOf(i), price })), { shape, overrides, ...extra });
  return world.shapes.get(id);
};
const hitAt = (world, shape, x, y) => D.hitDrawing(world.view, shape, x, y);
const strokes = (ctx) => ctx.ops("stroke");

// ── Registry ──────────────────────────────────────────────────────────────────
const builtinIds = D.listDrawingTools().map((tool) => tool.id);
assert(
  JSON.stringify(builtinIds) === JSON.stringify([
    "trend_line", "horizontal_line", "vertical_line", "ray", "extended_line", "measure", "fib_retracement", "rectangle", "text",
  ]),
  "the nine built-in kinds register through the same registry, in sidebar order",
);
assert(D.getDrawingTool("extended")?.id === "extended_line" && D.getDrawingTool("date_and_price_range")?.id === "measure", "TradingView names resolve through tool aliases");
assert(D.neededPoints("trend_line") === 2 && D.neededPoints("text") === 1 && D.neededPoints("cursor") === 0, "anchor counts come from each tool's anchors spec (cursor needs none)");
assert(D.drawingToolDefaults("rectangle").fillBackground === true && D.drawingToolDefaults("measure").linestyle === 2, "schema defaults seed new drawings");
for (const tool of D.listDrawingTools()) {
  const problem = D.drawingToolProblem({ ...tool, id: `${tool.id}_copy`, aliases: [] });
  assert(problem === "" && Object.isFrozen(tool), `built-in ${tool.id} passes the same validation as host tools${problem ? ` (${problem})` : ""}`);
}
const triangleIcon = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 3L15 15H3Z" stroke="currentColor"/></svg>';
const valid = { id: "probe_tool", title: "Probe", icon: triangleIcon, anchors: 2, props: {}, paint() {}, hitTest: () => null };
throwsLike(() => D.defineDrawingTool({ ...valid, id: "Bad Id" }), /id must match/, "invalid tool ids are rejected with the allowed pattern");
throwsLike(() => D.defineDrawingTool({ ...valid, id: "trend_line" }), /already used by "trend_line"/, "built-in ids cannot be re-registered");
throwsLike(() => D.defineDrawingTool({ ...valid, aliases: ["extended"] }), /already used by "extended_line"/, "aliases cannot shadow an existing alias");
throwsLike(() => D.defineDrawingTool({ ...valid, id: undefined }), /id must match/, "a definition without an id is rejected (not registered as \"undefined\")");
throwsLike(() => D.defineDrawingTool({ ...valid, id: null }), /id must match/, "an id of null is rejected (not registered as \"null\")");
throwsLike(() => D.defineDrawingTool({ ...valid, aliases: [null] }), /alias "null" must match/, "a non-string alias is rejected");
throwsLike(() => D.defineDrawingTool({ ...valid, aliases: "probe_alias" }), /aliases must be an array/, "aliases must be an array (a string is not spread into one-letter aliases)");
assert(
  !D.listDrawingTools().some((tool) => typeof tool.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool.id)) && D.getDrawingTool("undefined") === undefined,
  "rejected definitions leave nothing behind in the catalogue",
);
// Icons are inserted as trusted SVG, so every way the HTML parser starts an
// attribute or element must be caught, not only the whitespace-separated one.
const hostileIcons = {
  "a whitespace-separated handler": '<svg onload="alert(1)"></svg>',
  "an uppercase handler": '<SVG ONLOAD=alert(1)></SVG>',
  'a "/"-separated handler on an animation element': "<svg><animate/onbegin=alert(1) attributeName=x dur=1s></svg>",
  'a "/"-separated handler on a path': '<svg><path/onmouseover="alert(1)" d="M1 1"/></svg>',
  "a handler glued to a closing quote": '<svg><path d="M1 1"onmouseover="alert(1)"/></svg>',
  "a handler after a non-HTML whitespace character": '<svg><path d="M1 1" onmouseover="alert(1)"/></svg>',
  "a script element": "<svg><script>x()</script></svg>",
  "a style element": "<svg><style>path{fill:url(https://example.com/x)}</style></svg>",
  "a style attribute": '<svg><path style="fill:red" d="M1 1"/></svg>',
  "a link": '<svg><a href="javascript:alert(1)"><path d="M1 1"/></a></svg>',
  "an external use": '<svg><use href="https://example.com/sprite.svg#x"/></svg>',
  "an xlink:href": '<svg><path xlink:href="https://example.com/x" d="M1 1"/></svg>',
  "a foreignObject": "<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>",
  "markup hidden in an attribute value for an HTML-parsed title": '<svg><desc><title><path d="</title><img src=x onerror=alert(1)>"/></title></desc></svg>',
  "markup inside an attribute value": '<svg><g><path d="</g><img src=x onerror=alert(1)>"/></g></svg>',
  "a comment": "<svg><!-- x --><path d=\"M1 1\"/></svg>",
  "CDATA": "<svg><![CDATA[<img src=x onerror=alert(1)>]]></svg>",
  "an external url() paint": '<svg><path fill="url(https://example.com/x.svg#g)" d="M1 1"/></svg>',
  "an entity-encoded url()": '<svg><path fill="u&#114;l(https://example.com/x)" d="M1 1"/></svg>',
  "a CSS-escaped url()": '<svg><path fill="u\\72l(https://example.com/x)" d="M1 1"/></svg>',
  "markup outside the svg": '<svg></svg><img src=x onerror=alert(1)><svg></svg>',
  "no svg root": '<path d="M1 1"/>',
};
for (const [name, icon] of Object.entries(hostileIcons)) {
  throwsLike(() => D.defineDrawingTool({ ...valid, id: "probe_icon", icon }), /icon /, `icons with ${name} are rejected`);
}
assert(!D.getDrawingTool("probe_icon"), "no hostile icon was registered");
assert(
  D.drawingIconProblem(
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">'
      + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2962ff"/></linearGradient></defs>'
      + "<g transform='translate(1 1)'><circle cx=9 cy=9 r=3 fill=\"url(#g)\"/><rect x=\"2\" y=\"2\" width=\"4\" height=\"4\" rx=\"1\"/></g></svg>",
  ) === "",
  "a static icon with gradients, groups, single-quoted and unquoted values is accepted",
);
throwsLike(() => D.defineDrawingTool({ ...valid, anchors: 0 }), /anchors must be/, "anchor counts must be positive");
throwsLike(() => D.defineDrawingTool({ ...valid, anchors: { min: 2, finish: "never" } }), /anchors must be/, "free-form tools need a finish gesture");
throwsLike(() => D.defineDrawingTool({ ...valid, paint: undefined }), /paint\(\) and hitTest\(\) are required/, "paint and hitTest are required");
throwsLike(
  () => D.defineDrawingTool({ ...valid, props: { width: { type: "lineWidth", title: "Width", default: "2" } } }),
  /props\.width: default must be a finite number/,
  "property defaults must match their field type",
);
throwsLike(() => D.removeDrawingTool("trend_line"), /built-in tools cannot be removed/, "built-in tools cannot be removed");
let changes = 0;
const unsubscribe = D.onDrawingToolsChanged(() => { changes += 1; });
const probe = D.defineDrawingTool(valid);
assert(D.defineDrawingTool(valid) === probe && changes === 1, "registering the same definition twice is an idempotent no-op");
assert(D.removeDrawingTool("probe_tool") && !D.getDrawingTool("probe_tool") && changes === 2, "host tools can be removed and listeners hear about it");
unsubscribe();
{
  // validateProps() and describe() are in the contract but not called yet: registration says so.
  const before = warnings.length;
  D.defineDrawingTool({ ...valid, id: "probe_hooks", validateProps: () => [], describe: () => "Probe" });
  const heard = warnings.slice(before);
  assert(
    heard.length === 2
      && heard.some((w) => w.includes('defineDrawingTool("probe_hooks"): validateProps() is not called yet'))
      && heard.some((w) => w.includes('defineDrawingTool("probe_hooks"): describe() is not called yet')),
    "a tool defining validateProps() or describe() is warned that they are not called yet (no silent no-op)",
  );
  D.defineDrawingTool(D.getDrawingTool("probe_hooks"));
  assert(warnings.length === before + 2, "re-registering the same definition does not warn again");
  D.removeDrawingTool("probe_hooks");
}
{
  // Development reloads (HMR) re-run a module and build a new definition with new functions.
  const first = D.defineDrawingTool({ ...valid, id: "probe_reload", aliases: ["probe_reload_alias"] });
  assert(D.defineDrawingTool({ ...first }) === first, "an equal definition (same field values) is a no-op");
  throwsLike(
    () => D.defineDrawingTool({ ...valid, id: "probe_reload", paint() {} }),
    /already used by "probe_reload".*pass \{ replace: true \}/,
    "re-registering an id with new functions throws and points at { replace: true }",
  );
  let heard = 0;
  const stop = D.onDrawingToolsChanged(() => { heard += 1; });
  const position = D.listDrawingTools().findIndex((tool) => tool.id === "probe_reload");
  const reloaded = D.defineDrawingTool({ ...valid, id: "probe_reload", title: "Probe v2" }, { replace: true });
  assert(
    D.getDrawingTool("probe_reload") === reloaded && reloaded.title === "Probe v2" && heard === 1
      && D.listDrawingTools().findIndex((tool) => tool.id === "probe_reload") === position,
    "{ replace: true } swaps in the new definition in place and notifies listeners",
  );
  assert(D.getDrawingTool("probe_reload_alias") === undefined, "aliases of the replaced definition are released");
  throwsLike(() => D.defineDrawingTool({ ...valid, id: "trend_line" }, { replace: true }), /built-in tools cannot be replaced/, "built-in tools cannot be replaced");
  throwsLike(
    () => D.defineDrawingTool({ ...valid, id: "probe_reload", aliases: ["extended"] }, { replace: true }),
    /already used by "extended_line"/,
    "a replacement still cannot take another tool's alias",
  );
  const world = makeWorld();
  await add(world, "probe_reload", [[10, 100], [20, 150]]);
  let painted = "";
  D.defineDrawingTool({ ...valid, id: "probe_reload", paint() { painted = "v3"; } }, { replace: true });
  world.paint();
  assert(painted === "v3", "existing drawings of a replaced kind paint with the new definition");
  stop();
  D.removeDrawingTool("probe_reload");
}
const freeform = D.defineDrawingTool({ ...valid, id: "probe_path", anchors: { min: 2, finish: "double-click" } });
assert(D.neededPoints("probe_path") === Infinity, "free-form tools collect anchors until their finish gesture");
D.removeDrawingTool(freeform.id);

// ── Theme tokens and contrast ─────────────────────────────────────────────────
const luminance = (color) => {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  const rgb = hex
    ? [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16))
    : /rgba?\(([^)]+)\)/.exec(color)[1].split(",").slice(0, 3).map(Number);
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
for (const theme of ["dark", "light"]) {
  const tokens = D.buildTheme({ theme });
  assert(tokens.drawingDefault === D.DEFAULT_DRAWING_COLOR, `${theme}: UI and API drawings share one default colour token`);
  assert(tokens.handleFill === tokens.paneBackground, `${theme}: handles are filled with the pane background`);
  assert(contrast(tokens.labelText, tokens.paneBackground) >= 4.5, `${theme}: label text keeps >= 4.5:1 on the label backdrop (${contrast(tokens.labelText, tokens.paneBackground).toFixed(2)}:1)`);
}
const custom = D.buildTheme({
  theme: "light",
  overrides: {
    "drawings.defaultColor": "#ff00aa",
    "drawings.handleFillColor": "#eeeeee",
    "drawings.handleBorderColor": "#111111",
    "drawings.labelBackgroundColor": "#000000",
    "drawings.labelTextColor": "#fefefe",
  },
});
assert(
  custom.drawingDefault === "#ff00aa" && custom.handleFill === "#eeeeee" && custom.handleStroke === "#111111"
    && custom.labelBackground === "#000000" && custom.labelText === "#fefefe",
  "every drawing token can be overridden through widget overrides",
);
assert(D.buildTheme({ overrides: { "drawings.labelBackgroundColor": "#ffffff" } }).labelText === "#131722", "an overridden light label backdrop gets dark label text");

// ── Default colour, line style and width ─────────────────────────────────────
{
  const world = makeWorld();
  await add(world, "trend_line", [[10, 100], [20, 150]]);
  let ctx = world.paint();
  assert(strokes(ctx)[0]?.state.strokeStyle === D.DEFAULT_DRAWING_COLOR, "an API drawing without a colour paints with the theme default");

  const styled = makeWorld();
  await add(styled, "trend_line", [[10, 100], [20, 150]], { linestyle: 2, linewidth: 3, linecolor: "#ff0000" });
  await add(styled, "vertical_line", [[40, 100]], { linestyle: 1 });
  await add(styled, "ray", [[10, 100], [20, 150]], { linestyle: 3 });
  await add(styled, "extended_line", [[10, 100], [20, 150]], { linestyle: 4 });
  await add(styled, "rectangle", [[50, 100], [60, 150]], { linestyle: 2 });
  await add(styled, "fib_retracement", [[70, 100], [80, 150]], { linestyle: 1 });
  ctx = styled.paint();
  const dashes = strokes(ctx).map((call) => call.state.lineDash.join(","));
  assert(strokes(ctx)[0].state.lineWidth === 3 && dashes[0] === "15,12", "trend line honours linestyle 2 (dashed) scaled by linewidth 3");
  assert(dashes[1] === "2,3", "vertical line honours linestyle 1 (dotted)");
  assert(dashes[2] === "8,6" && dashes[3] === "2,8", "ray and extended line honour large-dashed and sparse-dotted styles");
  assert(dashes[4] === "5,4", "rectangle border honours linestyle");
  assert(dashes.slice(6).every((dash) => dash === "2,3"), "every fib level honours linestyle");
}

// ── Ray / extended line: painted and hit along the extension ─────────────────
{
  const world = makeWorld();
  const ray = await add(world, "ray", [[10, 100], [20, 100]]);
  const trend = await add(world, "trend_line", [[10, 200], [20, 200]]);
  const extended = await add(world, "extended_line", [[100, 250], [110, 250]]);
  const ctx = world.paint();
  const p2 = xOf(20);
  assert(hitAt(world, ray, p2 + 500, yOf(100)) !== null, "a point on a ray 500px past its second anchor hits");
  assert(hitAt(world, trend, p2 + 500, yOf(200)) === null, "a plain trend line does not hit past its anchors");
  assert(hitAt(world, extended, 5, yOf(250)) !== null && hitAt(world, extended, 795, yOf(250)) !== null, "an extended line hits at both plot edges");
  const rayLine = ctx.ops("lineTo").find((call) => call.args[1] === yOf(100));
  assert(rayLine && near(rayLine.args[0], 800), "the ray is painted exactly to the plot's right edge");
  assert(D.hitComplexShape(world.view, ray, p2 + 500, yOf(100) + 20) === false, "points well off the line miss");
}
{
  // Anchors 9,000 and 8,000 px left of the plot: the ray still crosses it edge to edge.
  const world = makeWorld();
  const index = (x) => x / 4 - 0.5;
  const far = await add(world, "ray", [[index(-9000), 200], [index(-8000), 200]]);
  const ctx = world.paint();
  const moves = ctx.ops("moveTo");
  const lines = ctx.ops("lineTo");
  assert(moves.length === 1 && near(moves[0].args[0], 0, 1e-6) && near(lines[0].args[0], 800, 1e-6), "a ray anchored 9,000px off-plot is painted from x=0 to the plot's right edge");
  assert(hitAt(world, far, 400, yOf(200)) !== null, "and is hit in the middle of the plot");
  const segment = D.clipLine({ x: -100, y: -100 }, { x: 0, y: 0 }, { x: 0, y: 0, w: 800, h: 400 }, true, true);
  assert(segment && near(segment[0].x, 0) && near(segment[1].x, 400) && near(segment[1].y, 400), "Liang-Barsky clips an extended diagonal exactly at the plot corners");
  assert(D.clipLine({ x: -100, y: 500 }, { x: -50, y: 450 }, { x: 0, y: 0, w: 800, h: 400 }, false, false) === null, "segments outside the plot are dropped");
}

// ── Fibonacci retracement: TradingView direction, labels and level hits ───────
{
  assert(near(D.fibLevelPrice(100, 200, 0.618), 138.2), "low-to-high draw: the 61.8% level sits at high - 0.618 * range (138.2)");
  assert(D.fibLevelPrice(100, 200, 0) === 200 && D.fibLevelPrice(100, 200, 1) === 100, "level 0 sits at points[1] and level 1 at points[0]");
  assert(near(D.fibLevelPrice(100, 200, 0.618, true), 161.8), "reverse: true flips the direction");
  const world = makeWorld();
  const fib = await add(world, "fib_retracement", [[10, 100], [30, 200]]);
  const ctx = world.paint();
  const labels = ctx.ops("fillText").map((call) => call.args[0]);
  assert(labels.includes("61.8%  138.20") && labels.includes("0.0%  200.00") && labels.includes("100.0%  100.00"), "level labels show the coefficient and the symbol-formatted price");
  assert(hitAt(world, fib, 795, yOf(138.2)) !== null, "a point on the 61.8% line at the plot's right edge hits the fib");
  assert(hitAt(world, fib, 795, yOf(144)) === null, "a point between levels at the right edge misses");
  const reversed = makeWorld();
  await add(reversed, "fib_retracement", [[10, 100], [30, 200]], { reverse: true });
  assert(reversed.paint().ops("fillText").some((call) => call.args[0] === "61.8%  161.80"), "reverse relabels the levels");
}

// ── Text: style, multi-line, wrapping and glyph-accurate hits ─────────────────
{
  const world = makeWorld();
  const label = await add(world, "text", [[50, 300]], {}, { text: "Long text label" });
  const ctx = world.paint();
  const ax = xOf(50);
  const ay = yOf(300);
  const width = "Long text label".length * 14 * 0.6;
  assert(hitAt(world, label, ax + 4 + width - 3, ay + 10)?.kind === "label", "a point over the last glyph of a text label hits it");
  assert(hitAt(world, label, ax - 18, ay + 10) === null, "a point 18px left of the anchor does not");
  const text = ctx.ops("fillText")[0];
  assert(text.state.font === "14px sans-serif" && text.state.fillStyle === world.context.theme.labelText, "text defaults to 14px in the theme label colour");
  assert(ctx.ops("fillRect")[0]?.state.fillStyle === world.context.theme.labelBackground, "text sits on the theme label backdrop by default");

  const styled = makeWorld();
  await add(styled, "text", [[50, 300]], {
    fontsize: 24, bold: true, italic: true, color: "#ff0000", backgroundColor: "#00ff00", drawBorder: true, borderColor: "#0000ff",
  }, { text: "Big bold\nsecond line" });
  const sctx = styled.paint();
  const lines = sctx.ops("fillText");
  assert(lines.length === 2 && lines[0].state.font === "italic bold 24px sans-serif" && lines[0].state.fillStyle === "#ff0000", "fontsize, bold, italic, colour and multi-line text are honoured");
  assert(sctx.ops("fillRect")[0].state.fillStyle === "#00ff00" && sctx.ops("strokeRect")[0].state.strokeStyle === "#0000ff", "backgroundColor and borderColor/drawBorder are honoured");
  const twoLines = {
    id: "x", toolId: "text", points: [], text: "Big bold\nsecond line", z: 0, locked: false, hidden: false,
    props: { fontsize: 24 },
  };
  const layout = D.textLayout(twoLines, { x: 0, y: 0 }, { fontFamily: "sans-serif" });
  assert(layout.lines.length === 2 && layout.box.h === 2 * Math.round(24 * 1.3) + 8, "the hit box grows with every line");

  const plain = makeWorld();
  await add(plain, "text", [[50, 300]], { fillBackground: false, textcolor: "#abcdef" }, { text: "x" });
  const pctx = plain.paint();
  assert(pctx.ops("fillRect").length === 0 && pctx.ops("fillText")[0].state.fillStyle === "#abcdef", "fillBackground:false drops the backdrop and textcolor is accepted as an alias");

  // Earlier releases painted text in `linecolor`, and toolbar-drawn text was saved with one.
  const legacy = makeWorld();
  await add(legacy, "text", [[50, 300]], { linecolor: "#66d89e" }, { text: "saved" });
  assert(legacy.paint().ops("fillText")[0].state.fillStyle === "#66d89e", "text saved with only a linecolor keeps that colour");
  const both = makeWorld();
  await add(both, "text", [[50, 300]], { linecolor: "#66d89e", textcolor: "#abcdef" }, { text: "x" });
  await add(both, "text", [[50, 200]], { linecolor: "#66d89e", color: "#123456", textcolor: "#abcdef" }, { text: "y" });
  const colours = both.paint().ops("fillText").map((call) => call.state.fillStyle);
  assert(colours[0] === "#abcdef" && colours[1] === "#123456", "color, then textcolor, take precedence over linecolor");

  const wrapped = D.wrapText("alpha beta gamma delta", (s) => s.length * 6, 70);
  assert(JSON.stringify(wrapped) === JSON.stringify(["alpha beta", "gamma delta"]), "word wrap breaks between words at wordWrapWidth");
  assert(D.wrapText("abcdefghij", (s) => s.length * 6, 30).join("|") === "abcde|fghij", "a word wider than the wrap width breaks by glyph");
  const wrapWorld = makeWorld();
  await add(wrapWorld, "text", [[50, 300]], { wordWrap: true, wordWrapWidth: 40, fontsize: 10 }, { text: "alpha beta gamma" });
  assert(wrapWorld.paint().ops("fillText").length === 3, "wordWrap/wordWrapWidth wrap painted text");
}

// ── Rectangle: fill props and filled-interior hits ────────────────────────────
{
  const world = makeWorld();
  const filled = await add(world, "rectangle", [[10, 300], [60, 100]], { backgroundColor: "rgba(0,0,255,0.5)" });
  const ctx = world.paint();
  const fill = ctx.ops("fillRect")[0];
  assert(fill.state.fillStyle === "rgba(0,0,255,0.5)" && fill.state.globalAlpha === 1, "backgroundColor sets the fill");
  assert(hitAt(world, filled, xOf(35), yOf(200))?.kind === "body", "clicking inside a filled rectangle selects it");

  const hollow = makeWorld();
  const empty = await add(hollow, "rectangle", [[10, 300], [60, 100]], { fillBackground: false });
  assert(hollow.paint().ops("fillRect").length === 0, "fillBackground:false removes the fill");
  assert(hitAt(hollow, empty, xOf(35), yOf(200)) === null && hitAt(hollow, empty, xOf(10), yOf(200)) !== null, "an unfilled rectangle is hit on its border only");

  const translucent = makeWorld();
  await add(translucent, "rectangle", [[10, 300], [60, 100]], { backgroundColor: "#00ff00", transparency: 75 });
  assert(near(translucent.paint().ops("fillRect")[0].state.globalAlpha, 0.25), "transparency (0-100) is applied to the fill");

  const auto = makeWorld();
  await add(auto, "rectangle", [[10, 300], [60, 100]], { linecolor: "#ff9800" });
  const autoFill = auto.paint().ops("fillRect")[0];
  assert(autoFill.state.fillStyle === "#ff9800" && near(autoFill.state.globalAlpha, 0.12), "without a backgroundColor the fill follows the border at 12%");
}

// ── Measure: formatted change, bars and span on a theme backdrop ──────────────
{
  const env = {
    formatPrice: D.createPriceFormatter(null, { pricescale: 1e8 }).bind(null),
    formatDuration: D.formatBarsDuration,
    barSpacing: 4,
    timeToX: (seconds) => ((seconds - T0) / 86400) * 4,
  };
  const format = (value) => D.createPriceFormatter(null, { pricescale: 1e8 })(value, 1e8);
  const state = {
    id: "m", toolId: "measure", text: "", z: 0, locked: false, hidden: false, props: {},
    points: [{ time: T0, price: 0.00001234 }, { time: T0 + 42 * 86400, price: 0.00001246 }],
  };
  const [change, duration] = D.measureLabel(state, { ...env, formatPrice: format });
  assert(change === "+0.00000012 (+0.97%)", `the price change uses the symbol formatter at pricescale 1e8 (${change})`);
  assert(duration === "42 bars, 42d", `the duration reads '<n> bars, <span>' (${duration})`);
  assert(D.formatBarsDuration(1, 60) === "1 bar, 1m" && D.formatBarsDuration(-3, 3 * 3600 + 1200) === "−3 bars, 3h 20m", "bar counts pluralise and spans humanise");

  const world = makeWorld();
  await add(world, "measure", [[10, 100], [52, 90]]);
  const ctx = world.paint();
  const texts = ctx.ops("fillText");
  assert(texts.length === 2 && texts[0].args[0] === "−10.00 (−10.00%)" && texts[1].args[0] === "42 bars, 42m", "the painted label shows the formatted change, bars and span");
  assert(texts[0].state.fillStyle === world.context.theme.labelText, "label text uses the theme label colour");
  assert(ctx.ops("fill").some((call) => call.state.fillStyle === world.context.theme.labelBackground), "the label sits on the theme label backdrop");

  // Painted through the runtime: the chart's formatter and the symbol's pricescale reach the label.
  const micro = makeWorld({ pricescale: 1e8 });
  await add(micro, "measure", [[10, 0.00001234], [52, 0.00001246]]);
  const microTexts = micro.paint().ops("fillText").map((call) => call.args[0]);
  assert(microTexts[0] === "+0.00000012 (+0.97%)", `a painted measure at pricescale 1e8 formats through context.formatPrice (${microTexts[0]})`);
  const custom = makeWorld();
  const seen = [];
  custom.context.formatPrice = (price, pricescale) => {
    seen.push(pricescale);
    return `≈${price.toFixed(1)}`;
  };
  await add(custom, "measure", [[10, 100], [52, 90]]);
  const customTexts = custom.paint().ops("fillText").map((call) => call.args[0]);
  assert(customTexts[0] === "−≈10.0 (−10.00%)" && seen.every((scale) => scale === 100), `a host price formatter (custom_formatters, raze.format_price) is used as is (${customTexts[0]})`);
}

// ── Handles: only when hovered or selected, themed ────────────────────────────
{
  const world = makeWorld({ theme: "light" });
  const trend = await add(world, "trend_line", [[10, 100], [20, 150]], { linecolor: "#e91e63" });
  assert(world.paint().ops("arc").length === 0, "an unselected, unhovered drawing paints no handles");
  world.view.hoverShapeId = String(trend.id);
  world.view.crosshair = { x: xOf(15), y: yOf(125), active: true };
  let arcs = world.paint().ops("arc");
  assert(arcs.length === 2 && arcs.every((call) => call.args[2] === 4), "hover shows the anchor handles");
  assert(world.ctx.ops("fill").filter((c) => c.state.fillStyle === "#ffffff").length === 2, "light theme: the handle fill equals paneBackground");
  assert(world.ctx.ops("stroke").slice(-2).every((c) => c.state.strokeStyle === "#e91e63"), "handles ring in the drawing's colour");
  // Leaving the canvas clears the crosshair but not hoverShapeId (gestures keep the last hit).
  world.view.crosshair = { ...world.view.crosshair, active: false };
  assert(world.paint().ops("arc").length === 0, "a hover left behind when the pointer leaves the canvas shows no handles");
  world.view.hoverShapeId = null;
  world.view.selectedShapeId = String(trend.id);
  const selected = world.paint();
  arcs = selected.ops("arc");
  assert(arcs.length === 2 && arcs.every((call) => call.args[2] === 4.5), "selection shows larger handles");
  assert(strokes(selected)[0].state.shadowBlur > 0, "selection adds a halo to the drawing itself");
}

// ── Z order, hit seams, axis tags ─────────────────────────────────────────────
{
  const world = makeWorld();
  const top = await add(world, "trend_line", [[10, 100], [20, 150]], { linecolor: "#0000ff" }, { zOrder: "top" });
  const bottom = await add(world, "horizontal_line", [[5, 125]], { linecolor: "#ff0000" }, { text: "Limit" });
  const ctx = world.paint();
  const order = strokes(ctx).map((call) => call.state.strokeStyle);
  assert(order.indexOf("#ff0000") < order.indexOf("#0000ff"), "a bottom horizontal line paints before a top trend line (store z order for every kind)");
  const hits = world.view.shapeScreen;
  assert(hits.length === 2 && hits.every((hit, i) => hit.z === i && typeof hit.hitTest === "function"), "every painted drawing publishes its z and an exact hitTest");
  assert(hits.find((h) => h.shape === bottom).y === yOf(125), "horizontal lines keep their line y for proximity matching");
  assert(hits.find((h) => h.shape === top).hitTest({ x: xOf(15), y: yOf(125) }, 5)?.kind === "body", "the published hitTest matches the painted geometry");

  const tags = world.view.axisTags;
  assert(tags.length === 1 && tags[0].axis === "price" && tags[0].coord === yOf(125) && tags[0].text === "125.00", "a horizontal line queues its price tag on view.axisTags");
  assert(tags[0].background === "#ff0000" && tags[0].color === "#ffffff" && tags[0].source.kind === "drawing" && tags[0].source.id === String(bottom.id), "the tag carries the line colour, a readable text colour and its source");
  world.shapes.adapter(bottom.id).setProperties({ showPrice: false });
  world.paint();
  assert(world.view.axisTags.length === 0, "showPrice:false hides the tag");
  assert(world.ctx.ops("fillText").some((call) => call.args[0] === "Limit"), "the horizontal line label is painted");
  assert(hitAt(world, bottom, 700, yOf(125))?.kind === "body" && hitAt(world, bottom, 795 - 6, yOf(125) - 8)?.kind === "label", "horizontal lines hit on the line and on their label");
}
{
  // A horizontal line without a price paints nothing. Gestures match
  // horizontal lines by y alone, so publishing one (at a fallback y) would
  // hover and select an invisible line near the bottom of the plot.
  const world = makeWorld();
  const priceless = await world.shapes.createPoints([{ time: timeOf(50) }], { shape: "horizontal_line", overrides: {} });
  const nan = await add(world, "horizontal_line", [[60, Number.NaN]]);
  const ctx = world.paint();
  assert(strokes(ctx).length === 0 && world.view.axisTags.length === 0, "a horizontal line without a finite price paints nothing");
  assert(world.view.shapeScreen.length === 0, "and publishes no hit target");
  assert(
    hitAt(world, world.shapes.get(priceless), 400, 400) === null && hitAt(world, nan, 400, 400) === null,
    "and cannot be hit at the plot bottom",
  );
}

// ── Draft ghost ───────────────────────────────────────────────────────────────
{
  const world = makeWorld();
  world.view.draft = { tool: "measure", points: [{ time: timeOf(10), price: 100 }] };
  world.view.crosshair = { x: xOf(20), y: yOf(120), active: true };
  world.ctx.reset();
  D.drawDraft(world.ctx, world.view);
  assert(strokes(world.ctx)[0]?.state.lineDash.join(",") === "5,4", "the draft ghost is painted by its tool with its line style");
  assert(world.ctx.ops("fillText").length === 2 && world.ctx.ops("arc").length === 2, "the draft shows live measurements and its anchors");
  assert(world.view.shapeScreen.length === 0, "a draft is never hit-testable");
}

// ── Robustness: unknown kinds and throwing tools never break the frame ────────
{
  const world = makeWorld();
  await add(world, "arrow_up", [[10, 100]]);
  await add(world, "trend_line", [[10, 100], [20, 150]]);
  const broken = D.defineDrawingTool({ ...valid, id: "probe_broken", paint() { throw new Error("boom"); } });
  await add(world, "probe_broken", [[10, 100], [20, 150]]);
  world.paint();
  world.paint();
  assert(strokes(world.ctx).length === 1 && world.view.shapeScreen.length === 2, "other drawings still paint around unknown or throwing kinds");
  assert(warnings.filter((w) => w.includes('"arrow_up" is not registered')).length === 1, "an unknown kind warns once, naming defineDrawingTool and the supported kinds");
  assert(warnings.filter((w) => w.includes('"probe_broken" threw while painting')).length === 1, "a throwing tool warns once");
  D.removeDrawingTool(broken.id);
  assert(D.constrainDrawingPoint({ shape: "horizontal_line", points: [{ time: 5, price: 1 }] }, 0, { time: 9, price: 2 }).time === 5, "constrain keeps a horizontal line's time");
}

// ── Unbalanced save()/restore() in a host tool never leaks into the frame ─────
{
  const cases = [
    ["throws inside one save()", (ctx) => { ctx.save(); ctx.globalAlpha = 0.2; ctx.lineWidth = 9; throw new Error("boom"); }],
    ["throws inside two nested save()s", (ctx) => { ctx.save(); ctx.save(); ctx.globalAlpha = 0.2; throw new Error("boom"); }],
    ["returns without its restore()", (ctx) => { ctx.save(); ctx.globalAlpha = 0.2; }],
    ["restores once more than it saved", (ctx) => { ctx.restore(); ctx.globalAlpha = 0.2; }],
    ["restores twice more than it saved", (ctx) => { ctx.restore(); ctx.restore(); ctx.globalAlpha = 0.2; }],
  ];
  for (const [label, body] of cases) {
    const id = `probe_unbalanced_${cases.findIndex(([name]) => name === label)}`;
    D.defineDrawingTool({ ...valid, id, paint: body });
    const world = makeWorld();
    const odd = await add(world, id, [[10, 100], [20, 150]]);
    await add(world, "trend_line", [[30, 100], [40, 150]]);
    world.view.selectedShapeId = String(odd.id);
    const { ctx } = world;
    ctx.reset();
    ctx.fillStyle = "#caller";
    ctx.save(); // the scene's own state, which a drawing must never pop
    world.view.axisTags = [];
    D.drawShapes(ctx, world.view);
    const trend = strokes(ctx).at(-1);
    assert(
      ctx.stack.length === 1 && ctx.stack[0].fillStyle === "#caller" && ctx.globalAlpha === 1 && ctx.miterLimit === 10
        && trend?.state.globalAlpha === 1 && trend.state.lineWidth === 1,
      `a tool that ${label} leaves the caller's save stack and the next drawing untouched`,
    );
    D.removeDrawingTool(id);
  }
}

// ── External 3-anchor tool: draft, select, drag, undo, save/load ─────────────
{
  const inTriangle = (p, [a, b, c]) => {
    const s = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const d1 = s(p, a, b);
    const d2 = s(p, b, c);
    const d3 = s(p, c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const triangle = D.defineDrawingTool({
    id: "acme_triangle",
    title: "Triangle",
    icon: triangleIcon,
    group: "shapes",
    anchors: 3,
    props: {
      linecolor: { type: "color", title: "Line color", default: "#ff9800" },
      fill: { type: "boolean", title: "Fill", default: true },
    },
    paint(ctx, drawing, { anchors }) {
      const points = anchors.filter(Boolean);
      if (points.length < 2) return;
      ctx.strokeStyle = drawing.props.linecolor;
      ctx.beginPath();
      points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
    },
    hitTest(point, drawing, { anchors }, _env, tolerance) {
      const index = anchors.findIndex((a) => a && Math.hypot(a.x - point.x, a.y - point.y) <= tolerance + 2);
      if (index >= 0) return { kind: "anchor", index };
      return anchors.length === 3 && anchors.every(Boolean) && drawing.props.fill && inTriangle(point, anchors) ? { kind: "body" } : null;
    },
  });
  assert(D.getDrawingTool("acme_triangle") === triangle && D.neededPoints("acme_triangle") === 3, "an external tool registers with its anchor count");

  const world = makeWorld();
  const host = {
    context: Object.assign(world.context, { drawingTool: "acme_triangle", stayInDrawingMode: false, magnet: false }),
    shapes: world.shapes,
    draft: null,
    hoverShapeId: null,
    engine: { announce() {} },
    onToolDone: () => {},
    requestPaint() {},
    plotScale: () => world.view,
    financeView: () => world.view,
  };
  const zone = { inPlot: true, inPriceAxis: false, inTimeAxis: false, contentBottom: 400 };
  const clicks = [[xOf(10), yOf(100)], [xOf(30), yOf(200)], [xOf(50), yOf(100)]];
  for (const [i, [x, y]] of clicks.entries()) {
    D.drawingDraftHandler.pointerDown(host, { x, y, zone, pointerType: "mouse" });
    if (i === 1) {
      world.view.draft = host.draft;
      world.view.crosshair = { x: xOf(50), y: yOf(100), active: true };
      world.ctx.reset();
      D.drawDraft(world.ctx, world.view);
      assert(world.ctx.ops("lineTo").length === 2 && world.ctx.ops("arc").length === 3, "after two clicks the draft previews all three anchors");
      world.view.draft = null;
    }
  }
  await Promise.resolve();
  const drawn = world.shapes.list()[0];
  assert(drawn?.shape === "acme_triangle" && drawn.points.length === 3 && host.context.drawingTool === "cursor", "three clicks draft and commit the triangle");
  world.paint();
  assert(world.ctx.ops("lineTo").length === 2 && strokes(world.ctx).length === 1, "the triangle paints through the shared runtime");
  const centre = { x: xOf(30), y: yOf(140) };
  assert(D.hitComplexShape(world.view, drawn, centre.x, centre.y), "the triangle is selectable through its own hitTest");

  host.hoverShapeId = String(drawn.id);
  const before = drawn.points.map((p) => ({ ...p }));
  const session = D.drawingEditHandler.pointerDown(host, { x: xOf(50), y: yOf(100), zone, pointerType: "mouse" });
  session.move(xOf(60), yOf(80));
  session.commit();
  assert(drawn.points[2].price === 80 && near(drawn.points[2].time, timeOf(60)) && drawn.points[0].price === 100, "dragging a handle moves only that anchor");
  world.commands.undo();
  const undone = world.shapes.get(drawn.id);
  assert(JSON.stringify(undone.points) === JSON.stringify(before), "the drag is one undo step");

  const saved = JSON.parse(JSON.stringify(world.shapes.snapshot()));
  const restored = makeWorld();
  for (const shape of saved) restored.shapes.restore(shape);
  restored.paint();
  assert(restored.shapes.list()[0].shape === "acme_triangle" && restored.ctx.ops("lineTo").length === 2, "the triangle round-trips through the store snapshot (save/load)");
  D.removeDrawingTool("acme_triangle");
}

console.warn = originalWarn;
console.log(`\nDRAWING TOOLS: PASS (${passed} assertions)`);
