# Raze Charts

Raze Charts is a dependency-free TypeScript toolkit for product-grade charts.
It combines a realtime financial widget, a small renderer-neutral chart grammar,
and a thin React adapter without locking product UI behind a proprietary shell.

The priorities are deliberate: a clear API, predictable lifecycle, excellent
defaults, honest compatibility, and escape hatches that remain typed.

> Raze Charts is not affiliated with TradingView. It is an independent,
> clean-room implementation of a documented subset of the TradingView widget
> and datafeed interfaces. TradingView is a trademark of TradingView, Inc.

## Choose a surface

| Import | Use it for | Contract |
| --- | --- | --- |
| `@razedotbot/charts` | Realtime financial charts and low-level financial building blocks | TradingView-shaped compatibility subset plus Raze-native exports |
| `@razedotbot/charts/chart` | Framework-neutral product and dashboard charts | Native typed grammar, SVG string rendering, SVG/Canvas DOM mounting |
| `@razedotbot/charts/react` | React product charts or an incremental Recharts migration | Thin adapter over `/chart`; React is an optional peer dependency |

Those are the only public package subpaths today. Imports from `src/**` or
`dist/**` are implementation details and are not a compatibility contract.

For a precise feature-by-feature view, see the
[capability matrix](./docs/capabilities.md). For internals and extension
points, see [architecture](./docs/architecture.md).

## Product principles

- **Native first.** The typed chart definition and data source own behavior;
  compatibility layers translate into those contracts.
- **No silent compatibility.** A supported component works; a known
  unsupported Recharts prop such as `Line fill` fails with guidance.
- **One explicit lifecycle.** Mounted charts update in place and expose cleanup;
  stale async work cannot regain ownership after a target change or teardown.
- **One semantic scene.** SVG and Canvas consume the same compiled chart, with
  renderer parity tested rather than assumed.
- **Measured quality.** Accessibility, package formats, visual output, dense
  data, and bundle size have documented checks and honest boundaries.

## Install

```bash
npm install @razedotbot/charts
```

Node 18 or newer is required for development and server-side SVG generation.
React 17 or newer is required only when importing the React entrypoint. There
are no runtime dependencies. The published declaration surface requires
TypeScript 5.0 or newer.

## Native charts: recommended for new product UI

Data keys are inferred from the datum type. A misspelled key is a TypeScript
error, and accessors can be functions when a key is not enough.

```ts
import { defineChart, line, mountChart } from "@razedotbot/charts/chart";

type PricePoint = {
  time: Date;
  close: number;
};

const prices: PricePoint[] = [
  { time: new Date("2026-09-01T00:00:00Z"), close: 42.1 },
  { time: new Date("2026-09-02T00:00:00Z"), close: 44.8 },
];

const definition = defineChart({
  marks: [
    line(prices, {
      x: "time",
      y: "close",
      name: "Close",
      stroke: "#66d89e",
    }),
  ],
  scales: { x: { type: "time" } },
  tooltip: true,
  legend: true,
  ariaLabel: "Daily close price",
  ariaDescription: "Close price for 1 and 2 September 2026.",
});

const chart = mountChart(document.querySelector("#chart")!, definition, {
  renderer: "svg", // or "canvas"
  height: 320,
});

// Preserve the host and interaction lifecycle while data or options change.
chart.update(definition, { height: 360 });
chart.destroy();
```

Built-in marks are `line`, `area`, `bar`, `point`, `ruleY`, `pie`, `radar`,
and `heatmap`. Scales are `linear`, `band`, `time`, and `log`. The compiler
produces a renderer-neutral scene that can be inspected with `getScene()` or
rendered with `renderChartSvg`, `svgFromCompiled`, and `paintChartCanvas`.

Omit `scales.x` to infer it from the data; once an X scale object is present,
its `type` is required so configuration cannot silently mean something else.
Built-in marks expose mark-specific option types, and dynamic JavaScript input
is checked against the same boundary with stable `ChartCompileError` codes.
Pie and heatmap are standalone compositions. Multiple radar layers may be
overlaid when they share the same axes; Cartesian scales cannot be mixed into
a polar chart.

Dense line and area geometry is reduced by a pixel-aware extrema envelope by
default. Tune it with `performance.maxRenderedPoints`, opt out with
`performance.decimation: "none"`, and inspect `CompiledChart.diagnostics`.
While decimation is enabled, the configured maximum is a hard per-series cap
on source-derived path samples (minimum `1`; area closure vertices are extra).
The compiler still scans source rows, so this bounds render complexity without
pretending input processing is free.

Product-specific layers can use the typed `defineMarkPlugin` + `customMark`
extension point without forking the compiler. Plugins receive isolated,
read-only scale/theme snapshots and must return validated, discriminated scene
geometry. The plugin contract is documented in
[architecture](./docs/architecture.md#custom-marks).

## Financial widget

The root entrypoint is for candlesticks, live bars, financial studies,
drawings, marks, and TradingView-style datafeeds.

```ts
import {
  widget,
  type IBasicDataFeed,
  type ResolutionString,
} from "@razedotbot/charts";

declare const datafeed: IBasicDataFeed;

const financialChart = new widget({
  container: document.querySelector("#chart")!,
  symbol: "MYTOKEN",
  interval: "1" as ResolutionString,
  datafeed,
  autosize: true,
  theme: "dark",
  enabled_features: ["mark_on_bars"],
  raze: {
    chart_types: ["candles", "line"],
    compact_breakpoint: 520,
    aria_label: "MYTOKEN price chart",
    aria_description: "One-minute candles quoted in USD.",
  },
});

financialChart.onChartReady(() => {
  void financialChart.activeChart().createStudy(
    "EMA",
    false,
    false,
    { length: 21 },
  );
});

// Required when the host unmounts.
financialChart.remove();
```

### Trading overlays

Orders and positions are first-class broker primitives rather than drawings.
They stay above the price series, participate in auto-scale, support mouse and
touch dragging, and can be nudged one minimum tick with Up/Down while selected.
The fluent order/position adapters mirror the TradingView integration style;
`createBracketOrder` links entry, stop-loss, and take-profit with live
risk/reward shading and callbacks.

```ts
financialChart.onChartReady(async () => {
  const chart = financialChart.activeChart();
  const bracket = await chart.createBracketOrder({
    side: "buy",
    entryPrice: 101.5,
    stopLossPrice: 98,
    takeProfitPrice: 108.5,
    quantity: 2,
    currency: "USD",
    onChange: (snapshot, event) => {
      sendOrderAmendment(event.line.id, event.line.price);
      updateRiskPreview(snapshot.riskRewardRatio);
    },
    onCancel: (snapshot) => cancelOrderGroup(snapshot.id),
  });

  bracket.stopLoss
    ?.setLineColor("#ef5350")
    .onMove((line) => console.log("new stop", line.getPrice()));

  const limit = await chart.createOrderLine({
    side: "sell",
    price: 112,
    quantity: 1,
    text: "Reduce",
  });
  limit.onCancel(() => cancelOrder(limit.id));
});
```

`trading_event` subscriptions receive a detached line snapshot plus the event
type. Trading overlays are deliberately excluded from `widget.save()` because
broker state must be rehydrated from the execution backend, not a chart layout.

For a standalone browser bundle, `dist/charting_library.standalone.js` assigns
`window.TradingView.widget`:

```html
<script src="/static/charting_library.standalone.js"></script>
<script>
  const chart = new TradingView.widget({ /* widget options */ });
</script>
```

For new integrations, a Promise-first data source avoids callback plumbing and
adapts to the widget protocol:

```ts
import {
  createDatafeed,
  defineDataSource,
  type ResolutionString,
} from "@razedotbot/charts";

const source = defineDataSource({
  async resolveSymbol(symbol) {
    return {
      name: symbol,
      ticker: symbol,
      description: symbol,
      type: "crypto",
      session: "24x7",
      timezone: "Etc/UTC",
      exchange: "Raze",
      listed_exchange: "Raze",
      format: "price",
      minmov: 1,
      pricescale: 100,
      has_intraday: true,
      supported_resolutions: ["1", "5", "15"] as ResolutionString[],
    };
  },
  async getBars({ symbol, resolution, from, to }) {
    const query = new URLSearchParams({
      symbol,
      resolution: String(resolution),
      from: String(from),
      to: String(to),
    });
    const response = await fetch(`/api/bars?${query}`);
    if (!response.ok) throw new Error(`History failed: ${response.status}`);
    return response.json();
  },
});

const datafeed = createDatafeed(source, {
  supportedResolutions: ["1", "5", "15"] as ResolutionString[],
});
```

`subscribeBars` additionally receives an `AbortSignal` and may resolve to a
cleanup function, making async realtime setup safe. Existing
`IBasicDataFeed` implementations remain supported directly.

The data path handles initial history, left-scroll pagination, live updates,
marks, symbol/interval changes, and stale async callbacks. `TimeIndex` maps real
timestamps to logical bars, so weekends and missing sessions do not create
phantom candles for drawings or marks. See
[performance and data correctness](./docs/performance.md#financial-data-correctness).

### Financial customization

Chrome is data-driven through `favorites`, feature flags, and `raze` options:

```ts
new widget({
  // ...required widget options
  favorites: { intervals: ["1", "5", "15"] as ResolutionString[] },
  disabled_features: ["scale_bar"],
  raze: {
    sidebar: [
      "cursor",
      "trend_line",
      "horizontal_line",
      "separator",
      "indicators",
      "fit",
      "screenshot",
    ],
    indicator_presets: [
      { name: "EMA", length: 9 },
      { name: "RSI", length: 14 },
    ],
    custom_studies: [
      {
        name: "MOM",
        pane: "pane",
        defaults: { length: 10, color: "#8ecae6" },
        levels: [{ value: 0, dashed: true, axisLabel: true }],
        compute: (bars, { length }) =>
          bars.map((bar, index) =>
            index < length ? null : bar.close - bars[index - length]!.close,
          ),
      },
    ],
  },
});
```

Custom studies use the public full-array `compute` contract. Built-in EMA,
SMA, and RSI update incrementally for an appended or replaced live bar;
backfills and custom studies recompute. This distinction matters for high-rate
feeds and is intentionally documented rather than hidden.

### Price formatting

One formatter controls the price axis, last-price tag, OHLC legend, crosshair,
and shape price labels. A TradingView-shaped factory takes precedence; return
`null` to fall through to the Raze-native formatter and then the built-in
`pricescale` formatter.

```ts
declare function formatTokenPrice(value: number, pricescale?: number): string;

new widget({
  // ...required widget options
  custom_formatters: {
    priceFormatterFactory: (symbolInfo) =>
      symbolInfo ? { format: (value) => formatTokenPrice(value) } : null,
  },
  raze: {
    format_price: (value, pricescale) =>
      formatTokenPrice(value, pricescale),
  },
});
```

Percent-scale ticks keep percent notation. Overlay studies may still own their
legend value through `StudyDefinition.formatValue`.

The root also exports `DataManager`, `TimeIndex`, `ChartEngine`,
`ChartRenderer`, `ShapeStore`, `TradingStore`, `StudyStore`, indicator math, formatting and
resolution helpers, `defineDataSource` / `createDatafeed`, and the default UI
chrome. These pieces are useful for a custom financial shell, but currently
share the widget's mutable `ChartContext`; they are not separate package
subpaths.

## React

For the native API, `<Chart>` is a lifecycle adapter around a
`ChartDefinition`. It mounts once and forwards new definitions, dimensions,
renderer choices, and accessibility text through `update()`.

For Recharts-shaped JSX, use the typed factory in new code:

```tsx
import { createChartComponents } from "@razedotbot/charts/react";

type Sale = { month: string; revenue: number };

const { LineChart, Line, XAxis, CartesianGrid, Tooltip, Legend } =
  createChartComponents<Sale>({ xKey: "month", valueKey: "revenue" });

export function RevenueChart({ data }: { data: Sale[] }) {
  return (
    <LineChart
      data={data}
      height={320}
      ariaLabel="Monthly revenue"
      ariaDescription="Revenue from January through March."
    >
      <CartesianGrid />
      <XAxis dataKey="month" />
      <Line dataKey="revenue" name="Revenue" stroke="#66d89e" />
      <Tooltip />
      <Legend />
    </LineChart>
  );
}
```

`Tooltip` and `Legend` are functional configuration toggles consumed by the
parent chart. They are not customizable overlay components. `Brush` windows
the native viewport through `startIndex`/`endIndex` (or a time domain) and
throws on unknown Recharts brush props; it is never silently ignored. The
adapter is a migration convenience, not a drop-in implementation of the full
Recharts API. See the
[Recharts migration matrix](./docs/migration.md#recharts-shaped-jsx).

Each series component accepts only the options it implements, both in
TypeScript and at runtime. `ResponsiveContainer` measures its box and injects
numeric dimensions into exactly one chart child; set visual size through chart
props or the container, not `Chart.style.width` / `height`. `onReady` exposes
only detached, deeply frozen scene snapshots, while React retains lifecycle
and teardown ownership.

## Design and accessibility

Dark and light themes ship with cohesive pane, grid, axis, tooltip, status,
and series colors. Every native chart also accepts a partial theme, so a
product can own its visual language without replacing the renderer.

Good visual defaults do not make every integration accessible automatically.
Supply a specific `ariaLabel`, add `ariaDescription` when the trend needs
context, preserve keyboard focus styles, and offer a table or textual summary
when users need exact values. The implemented behavior and integration
checklist live in the [accessibility guide](./docs/accessibility.md). Raze
Charts does not claim a blanket WCAG conformance certification.

## Compatibility and migration

- [Capability matrix](./docs/capabilities.md) — what each entrypoint supports.
- [Migration guide](./docs/migration.md) — TradingView and Recharts mappings,
  differences, and unsupported surfaces.
- [Architecture](./docs/architecture.md) — data flow, lifecycle, renderers, and
  custom mark plugins.
- [Performance](./docs/performance.md) — reproducible benchmarks, budgets, and
  large-data guidance.
- [Accessibility](./docs/accessibility.md) — current semantics and host-app
  responsibilities.

## Development

```bash
npm ci
npm run quality
npm run test:visual
```

`npm run quality` runs strict source/API type checks, builds the distributable
artifacts, and exercises the widget, dashboard compiler and edge cases,
SVG/Canvas color parity, React 17/18 contracts, data races, time indexing,
studies, declaration watch mode, the packed ESM/CJS/NodeNext package contract,
documentation, bundle budgets, and compiler performance. Visual tests use
Playwright Chromium snapshots and remain a separate platform-specific gate.

Use `npm run typecheck` as the faster type-only feedback loop while editing.

Open `examples/index.html`, `examples/dashboard.html`, or
`examples/visual.html` through a local HTTP server after building:

```bash
python -m http.server 8799
```

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
