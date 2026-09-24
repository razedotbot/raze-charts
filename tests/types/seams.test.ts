// Type-level contract tests for the W1A-06 seams. Checked by
// `tsc -p tsconfig.type-tests.json` (part of `npm run typecheck`); never run.

import type {
  ChartContext,
  ScaleModePatch,
  ViewportChangeReason,
} from "../../src/core/context";
import type { StateSlice } from "../../src/core/stateTypes";
import type {
  DrawingLineStyle,
  DrawingPropSchema,
  DrawingToolDefinition,
} from "../../src/drawings/types";
import type {
  IndicatorDefinition,
  StudyInputValues,
} from "../../src/studies/types";
import type { CompiledChartV2, CompiledSceneV2Fields } from "../../src/chart/sceneTypes";
import type { CompiledChart } from "../../src/chart";
import type { AxisTag, FinanceView } from "../../src/engine/paint/view";

declare const ctx: ChartContext;
declare const view: FinanceView;
declare const v1: CompiledChart;

// Playwright also loads tests/**/*.test.ts, so nothing below may run.
if (false) {
  // Reason-tagged setters reject typos at compile time.
  ctx.setViewport({ from: 0, to: 10 }, "pan");
  // @ts-expect-error unknown viewport reason
  ctx.setViewport({ from: 0, to: 10 }, "scroll");
  // @ts-expect-error a reason is required
  ctx.setViewport({ from: 0, to: 10 });
  ctx.setScaleMode({ mode: "log" }, "scale-bar");
  // @ts-expect-error `log` is not a patch key; use { mode: "log" }
  ctx.setScaleMode({ log: true }, "scale-bar");
  // @ts-expect-error unsupported price scale mode
  ctx.setScaleMode({ mode: "indexed" }, "api");
  ctx.setChartType("heikin_ashi", "sidebar");
  // @ts-expect-error unknown chart type
  ctx.setChartType("renko", "api");
  // @ts-expect-error the timezone seam is read-only; use setTimezone()
  ctx.timezone = "UTC";
  // @ts-expect-error ids cannot be swapped after creation
  ctx.ids = ctx.ids;

  ctx.rangeChanged.subscribe(null, ((change: { reason: ViewportChangeReason }) => change.reason) as never);
  const patch: ScaleModePatch = { priceRange: { min: 1, max: 2 } };
  void patch;

  // View seams are typed.
  const tag: AxisTag = { axis: "price", coord: 10, text: "7,000", background: "#000", color: "#fff", source: { kind: "drawing", id: "shape_1" } };
  view.axisTags.push(tag);
  // @ts-expect-error tags need a source kind for de-collision and a11y
  view.axisTags.push({ axis: "price", coord: 10, text: "x", background: "#000", color: "#fff" });
  const dpr: number = view.dpr;
  void dpr;

  // ── Study inputs infer their value types ────────────────────────────────────
  const macdInputs = {
    fast: { type: "int", title: "Fast length", default: 12, min: 1 },
    source: { type: "source", title: "Source", default: "close" },
    maType: { type: "select", title: "MA type", default: "ema", options: ["ema", "sma"] as ("ema" | "sma")[] },
    showHist: { type: "bool", title: "Histogram", default: true },
  } as const;

  type MacdValues = StudyInputValues<typeof macdInputs>;
  const values: MacdValues = { fast: 12, source: "hl2", maType: "sma", showHist: false };
  void values;
  // @ts-expect-error int inputs are numbers
  const badFast: MacdValues = { fast: "12", source: "close", maType: "ema", showHist: true };
  // @ts-expect-error sources are a closed union
  const badSource: MacdValues = { fast: 12, source: "median", maType: "ema", showHist: true };
  void badFast;
  void badSource;

  const macd: IndicatorDefinition<typeof macdInputs, "macd" | "signal"> = {
    name: "MACD",
    pane: "pane",
    inputs: macdInputs,
    plots: [
      { id: "macd", title: "MACD", style: "line" },
      { id: "signal", title: "Signal", style: "line" },
    ],
    compute: (bars, inputs) => {
      const length: number = inputs.fast;
      void length;
      return { macd: bars.map(() => null), signal: new Float64Array(bars.length) };
    },
  };
  void macd;

  const missingPlot: IndicatorDefinition<typeof macdInputs, "macd" | "signal"> = {
    name: "MACD",
    pane: "pane",
    inputs: macdInputs,
    plots: [{ id: "macd", title: "MACD", style: "line" }],
    // @ts-expect-error compute must return every declared plot
    compute: (bars) => ({ macd: bars.map(() => null) }),
  };
  void missingPlot;

  const incremental: IndicatorDefinition<typeof macdInputs, "value", { sum: number }> = {
    name: "Running sum",
    pane: "overlay",
    inputs: macdInputs,
    plots: [{ id: "value", title: "Sum", style: "line" }],
    init: () => ({ sum: 0 }),
    update: ({ bar }, state) => ({ state: { sum: state.sum + bar.close }, values: { value: state.sum + bar.close } }),
  };
  void incremental;

  // ── Drawing property schemas match their property types ─────────────────────
  interface ArrowProps {
    color: string;
    width: number;
    style: DrawingLineStyle;
    showLabel: boolean;
    align: "left" | "right";
  }

  const arrowSchema: DrawingPropSchema<ArrowProps> = {
    color: { type: "color", title: "Color", default: "#2962ff" },
    width: { type: "lineWidth", title: "Width", default: 2 },
    style: { type: "lineStyle", title: "Style", default: 0 },
    showLabel: { type: "boolean", title: "Label", default: true },
    align: { type: "select", title: "Align", default: "left", options: [{ value: "left", title: "Left" }, { value: "right", title: "Right" }] },
  };

  const wrongField: DrawingPropSchema<ArrowProps> = {
    ...arrowSchema,
    // @ts-expect-error a boolean property needs a boolean field
    showLabel: { type: "color", title: "Label", default: "#fff" },
  };
  void wrongField;

  const arrow: DrawingToolDefinition<ArrowProps> = {
    id: "arrow_marker",
    title: "Arrow marker",
    icon: "<svg viewBox=\"0 0 18 18\"></svg>",
    group: "annotation",
    anchors: 2,
    props: arrowSchema,
    paint(ctx2d, drawing, geometry, env) {
      const [a, b] = geometry.anchors;
      if (!a || !b) return;
      ctx2d.strokeStyle = drawing.props.color || env.theme.drawingDefault;
      ctx2d.lineWidth = drawing.props.width;
      env.pushAxisTag({ axis: "price", coord: b.y, text: env.formatPrice(env.yToPrice(b.y)), background: drawing.props.color, color: "#fff" });
    },
    hitTest(point, _drawing, geometry, _env, tolerance) {
      const anchor = geometry.anchors.findIndex((p) => p !== null && Math.hypot(p.x - point.x, p.y - point.y) <= tolerance);
      return anchor >= 0 ? { kind: "anchor", index: anchor } : null;
    },
  };
  void arrow;

  // ── Persistence slices only emit JSON ───────────────────────────────────────
  const slice: StateSlice<{ ids: string[] }> = {
    key: "drawings",
    version: 1,
    requiresDataReload: false,
    save: () => ({ ids: [] }),
    validate: () => [],
    apply: (payload, context) => {
      for (const id of payload.ids) context.ids.reserve("shape", id);
    },
  };
  void slice;
  // @ts-expect-error functions are not JSON
  const badSlice: StateSlice<{ fn: () => void }> = slice;
  void badSlice;

  // ── Scene v2 is additive over the v1 scene ──────────────────────────────────
  const partial: CompiledChart & CompiledSceneV2Fields = v1;
  void partial;
  // @ts-expect-error a v1 scene lacks the complete v2 contract
  const full: CompiledChartV2 = v1;
  void full;
}
