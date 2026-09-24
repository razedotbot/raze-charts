// Type-level contract tests for defineIndicator v2 and typed createStudy
// inputs (W1B-15). Checked by `tsc -p tsconfig.type-tests.json` (part of
// `npm run typecheck`); never run.

import type { IChartWidgetApi, StudyDefinition, StudyInputsOf, StudySource } from "../../src";
import {
  bool,
  createStudyContext,
  defineIndicator,
  float,
  int,
  runIndicator,
  select,
  source,
  type IndicatorHandle,
} from "../../src/studies";

const Crossover = defineIndicator({
  name: "Crossover",
  pane: "overlay",
  inputs: {
    fast: int({ min: 1, default: 12 }),
    slow: int(26, { min: 1 }),
    mult: float(2, { step: 0.1 }),
    src: source("close"),
    showSignal: bool(true),
    mode: select(["sma", "ema"], "ema"),
  },
  plots: [
    { id: "fastLine", title: "Fast", style: "line" },
    { id: "slowLine", title: "Slow", style: "line" },
  ],
  fills: [{ id: "cloud", between: ["fastLine", "slowLine"], color: "#2962ff" }],
  compute: (bars, inputs, ctx) => {
    const fast: number = inputs.fast;
    const src: StudySource = inputs.src;
    const showSignal: boolean = inputs.showSignal;
    const mode: "sma" | "ema" = inputs.mode;
    const zone: string = ctx.timezone;
    void [fast, src, showSignal, mode, zone];
    // @ts-expect-error inputs are exactly the declared schema
    void inputs.lenght;
    return { fastLine: bars.map(() => null), slowLine: bars.map(() => null) };
  },
});

// Handles are StudyDefinitions: they go straight into raze.custom_studies.
const asDefinition: StudyDefinition = Crossover;
const typedHandle: IndicatorHandle = Crossover;
void [asDefinition, typedHandle];

// Incremental definitions infer their state from init().
const Cumulative = defineIndicator({
  name: "Cumulative",
  pane: "pane",
  inputs: { scale: float(1) },
  plots: [{ id: "total", title: "Total", style: "histogram" }],
  init: () => ({ total: 0 }),
  update: ({ bar }, state, inputs) => {
    const total: number = state.total + bar.close * inputs.scale;
    return { state: { total }, values: { total } };
  },
});

const outputs = runIndicator(Cumulative, [], { scale: 2 }, createStudyContext({ timezone: "America/New_York" }));
const totals: (number | null)[] = outputs.total;
void totals;

declare module "../../src" {
  interface StudyInputsRegistry {
    Crossover: StudyInputsOf<typeof Crossover>;
  }
}

if (false) {
  // @ts-expect-error a compute() result must return every declared plot
  defineIndicator({ name: "Broken", pane: "pane", inputs: {}, plots: [{ id: "a", title: "A", style: "line" }], compute: () => ({ b: [] }) });

  // @ts-expect-error fills must name declared plots
  defineIndicator({ name: "Broken", pane: "pane", inputs: {}, plots: [{ id: "a", title: "A", style: "line" }], fills: [{ id: "f", between: ["a", "z"], color: "#000" }], compute: () => ({ a: [] }) });

  const chart = null as unknown as IChartWidgetApi;
  void chart.createStudy("Crossover", false, false, { fast: 5, src: "hl2", showSignal: false });
  // @ts-expect-error TypeScript rejects wrongly typed inputs for registered studies
  void chart.createStudy("Crossover", false, false, { fast: "x" });
  // @ts-expect-error typos in input ids are rejected
  void chart.createStudy("Crossover", false, false, { fsat: 5 });
  // @ts-expect-error select inputs accept only their options
  void chart.createStudy("Crossover", false, false, { mode: "wma" });
  // Unregistered names keep the open TradingView input map.
  void chart.createStudy("Moving Average Exponential", false, false, { length: 9, source: "close" });
}
