# Migration guide

Raze Charts provides compatibility-shaped surfaces to reduce migration cost,
not to imply complete parity with TradingView or Recharts. Start by identifying
the smallest surface your product actually uses, then verify it against the
[capability matrix](./capabilities.md).

## TradingView-shaped widget

### Module replacement

The standalone build exposes `window.TradingView.widget`. The package root
exports both `widget` and the default TradingView-shaped namespace.

```ts
import TradingView, { widget } from "@razedotbot/charts";

TradingView.widget === widget; // true
```

For a vendored integration, redirect its charting-library module to the Raze
ESM artifact at bundle time. For example, with webpack:

```js
config.resolve.alias[
  "charting_library/charting_library.esm.js"
] = require.resolve("@razedotbot/charts");
```

Prefer importing the package export instead of a `dist/**` path in new code.
The `dist` filenames exist for packaging and standalone delivery, but package
exports are the stable resolver contract.

### API mapping

| Existing integration | Raze status | Migration note |
| --- | --- | --- |
| `new widget(options)` | Supported subset | Keep the constructor; audit options against `ChartingLibraryWidgetOptions`. |
| `onChartReady`, `headerReady` | Supported | Teardown settles pending lifecycle work and prevents late resurrection. |
| `activeChart()` / `chart()` | Supported | Both return the implemented chart API subset. |
| `setSymbol(symbol, interval, callback)` | Supported | Symbol and interval change atomically; stale requests cannot commit. |
| `IBasicDataFeed.onReady` | Supported | Keep callback semantics. |
| `resolveSymbol`, `getBars` | Supported | Initial history and left pagination are implemented. |
| `subscribeBars`, `unsubscribeBars` | Supported | Old subscription callbacks are ignored after a target change. |
| `getMarks` | Supported | Async callback results are accepted and scoped to the active request. |
| `createShape`, `createMultipointShape` | Supported subset | Use only the drawing kinds in the capability matrix. |
| `getShapeById`, `removeEntity`, `removeAllShapes` | Supported | Shape point editing and removal are implemented. |
| `createStudy` | Supported subset | EMA, SMA, RSI, VWAP, Bollinger, MACD, plus studies registered through `raze.custom_studies`. `forceOverlay` draws a pane study (RSI, MACD) on the price pane with its own scale; `lock` is stored but not separately enforced. |
| `createButton` | Supported | Use it for small host actions; own complex UI outside the widget. |
| `save()` / `load()` | Supported | Versioned JSON snapshot of symbol, interval, range, style, shapes, and studies with stable entity IDs. `disableSave` omits a live shape. The host owns storage. |
| `createCompare(symbol)` | Supported | Overlay another symbol on the same pane; `raze.layout` `"2x1"` / `"2x2"` syncs range and crosshair across panes. |
| unlisted TradingView option or event | Not guaranteed | A permissive compatibility type is not proof of runtime support. |

### Datafeed checklist

- Emit `Bar.time` in Unix milliseconds. `PeriodParams.from` / `to` and mark
  times use Unix seconds; these units are intentionally different and typed.
- Return bars in ascending order. The manager canonicalizes and de-duplicates,
  but a sorted feed avoids unnecessary work.
- Treat the subscription GUID as opaque and stop producing work after
  `unsubscribeBars`.
- Call the error callback with useful context; active failures are surfaced and
  already committed data remains visible.
- Implement `getMarks` only if marks are enabled. Late results from an obsolete
  symbol or interval are intentionally discarded.
- Always call `remove()` when the host unmounts.

### Move a callback feed to the native data source

Existing `IBasicDataFeed` implementations can stay as they are. For new code,
`defineDataSource` preserves inference for a Promise-first contract and
`createDatafeed` adapts it to the widget:

| Native source method | Return value / lifecycle |
| --- | --- |
| `configuration` | Static configuration or sync/async factory |
| `resolveSymbol(symbol)` | Symbol metadata or a promise |
| `getBars(request)` | Bar array, `{ bars, meta }`, or a promise |
| `searchSymbols(request)` | Optional result array or promise |
| `getMarks(request)` | Optional mark array or promise |
| `getServerTime()` | Optional Unix seconds or promise |
| `subscribeBars(request, handlers)` | Optional cleanup function, promise of cleanup, or void |

Realtime `request.signal` aborts as soon as the widget unsubscribes. If an
async subscription resolves its cleanup function after that point, the adapter
runs it immediately. Use `handlers.next(bar)` for updates and
`handlers.reset()` when cached history must reload.

History request `from` / `to` values and mark times are Unix seconds;
returned `Bar.time` values are Unix milliseconds.

### Feature flags and Raze extensions

Keep compatible flags in `enabled_features`, `disabled_features`, and
`favorites`. Product-specific capabilities live under `raze`, including
sidebar composition, chart type choices, compact breakpoint, custom studies,
indicator presets, and native price formatting.

This separation makes it obvious which configuration can travel with an
existing widget integration and which configuration intentionally couples to
Raze.

### Content Security Policy

TradingView's library renders inside an iframe. Raze renders in your page,
so your page's CSP applies to it. The widget's chrome styles use
constructable stylesheets and CSSOM, so `style-src 'self'` works without
`'unsafe-inline'`. Where constructable stylesheets are unavailable, provide a
nonce through `<meta property="csp-nonce" nonce="…">` or
`ensureBaseStyles(target, { nonce })`. With Trusted Types enforced, allow the
`raze-charts` policy (`trusted-types raze-charts`). The
[capability matrix](./capabilities.md#ui-kit-csp-and-localization) lists the
remaining gaps.

### Custom sidebar icons: `SidebarCustomItem.icon` type

`SidebarCustomItem.icon` (in `raze.sidebar`) accepts an `Element` as well as
a markup string, so its type widened from `string` to `string | Element`. An
Element is cloned into the 32×32 button and needs no HTML sink, which is the
option for pages that enforce Trusted Types. Code that only builds sidebar
items compiles unchanged. Code that reads `item.icon` back as a string, for
example to inspect or serialise a sidebar configuration, now needs a check
such as `typeof item.icon === "string"` before using it as one.

### Custom financial shells

A custom shell built from the root building blocks (`ChartEngine`,
`ChartRenderer`, `DataManager` and the stores) creates its shared context with
`createChartContext(state)` instead of an object literal. A `ChartContext` now
carries reason-tagged setters and change delegates. A literal typed as
`ChartContext` no longer compiles because it lacks them. Write the viewport
with `setViewport(range, reason)`, the price scale with
`setScaleMode(patch, reason)` and the series style with
`setChartType(style, reason)`. Each setter validates its input, fires one
change event and requests one repaint. The widget's own code is still moving
from direct field writes to these setters. [Shared seams](./seams.md) lists
every field.

## Recharts-shaped JSX

The React entrypoint is a focused translation layer over the native chart
grammar. It is useful for familiar JSX and incremental migration, but it does
not execute arbitrary Recharts props.

### Recommended migration sequence

1. Replace the outer chart and the documented series/axis children.
2. Add an explicit `ariaLabel` and, when useful, `ariaDescription`.
3. Replace custom tooltip/legend renderers with product UI outside the chart,
   or use the native built-in presentation.
4. Remove unsupported event, animation, custom-shape, and axis formatter props.
5. Use `<Brush startIndex endIndex />` or native `viewport` when the chart
   should window data before geometry; keep host-side filtering when you need
   a different aggregation.
6. Adopt `createChartComponents<T>({ xKey, valueKey })` so defaults and invalid
   `dataKey` values fail during type checking. Add `heatmapYKey` when a typed
   heatmap does not declare `<YAxis dataKey="..." />`.

```tsx
import { createChartComponents } from "@razedotbot/charts/react";

type Point = { date: string; value: number };

const { LineChart, Line, XAxis, Tooltip, Legend } =
  createChartComponents<Point>({ xKey: "date", valueKey: "value" });

export function Trend({ data }: { data: Point[] }) {
  return (
    <LineChart data={data} ariaLabel="Value by date">
      <XAxis dataKey="date" />
      <Line dataKey="value" />
      <Tooltip />
      <Legend />
    </LineChart>
  );
}
```

### JSX mapping

| Recharts-shaped element | Implemented meaning | Important difference |
| --- | --- | --- |
| Chart containers | Select the default native mark | Width/height props are authoritative; `style.width` and `style.height` are rejected to avoid two sizing sources. |
| Series children | Create native marks | Each series accepts only its declared Raze props; unsupported dynamic props throw instead of becoming silent no-ops. |
| `XAxis` / `YAxis` | Select channel keys | No custom tick component or formatter contract. |
| `CartesianGrid` | Enable grid | No line-style prop mapping. |
| `Tooltip` | Enable built-in pointer tooltip | It is a configuration descriptor, not a rendered React overlay. |
| `Legend` | Enable built-in legend | It is a configuration descriptor, not a customizable React child. |
| `ReferenceLine` | Add a numeric horizontal or vertical rule | Exactly one of `y` or `x`. |
| `ResponsiveContainer` | Measure the wrapper and inject numeric width/height into one chart child | It requires exactly one valid chart child and does not mirror every Recharts sizing behavior. |
| `Brush` | Window the native viewport | `startIndex`/`endIndex` or a time domain; it is not the Recharts brush overlay API. |

### Exact React prop surface

All series accept `dataKey` and optional per-series `data`. The remaining
implemented props are deliberately small and exact:

| Component | Additional series props |
| --- | --- |
| `Line` | `name`, `stroke`, `strokeWidth`, `lastValue`, `dashed`, `curve` |
| `Area` | `name`, `stroke`, `fill`, `fillOpacity`, `strokeWidth`, `lastValue`, `dashed`, `curve`, `y0` |
| `Bar` | `name`, `fill`, `stackId`, `lastValue`, `fade` |
| `Scatter` | `name`, `fill`, `fillOpacity`, `r` |
| `Pie` | `name`, `innerRadius`, `outerRadius` |
| `Radar` | `name`, `stroke`, `fill`, `fillOpacity`, `strokeWidth` |
| `Heatmap` | No additional series props; X/Y channels come from axes or typed factory defaults. |

Chart containers accept `data`, `width`, `height`, `renderer`, `children`,
`ariaLabel`, `ariaDescription`, `idPrefix`, `className`, `style`, and `onReady`.
`XAxis` / `YAxis` accept `dataKey`; `ReferenceLine` accepts `y`, `stroke`,
`strokeWidth`, and `name`. `Chart.style` cannot set dimensions.
`ResponsiveContainer.style` cannot set `width`, `height`, `position`, or
`minWidth`, because those values are owned by its measurement contract.

Unknown React children are currently ignored because they may be ordinary
composition wrappers. Known-but-unsupported Raze descriptors must throw. Do
not interpret the absence of a warning for an arbitrary Recharts component as
support.

Pie and heatmap containers compile as standalone coordinate systems. A composed
radar chart may contain multiple radar series only when all category axes
match. Move mixed Cartesian/polar layouts into separate chart instances.

## Moving from JSX to the native grammar

Use `/chart` when you need typed accessors, explicit scale/domain control,
server-generated SVG, scene inspection, or custom mark plugins.

```ts
import { defineChart, line, renderChartSvg } from "@razedotbot/charts/chart";

const definition = defineChart({
  marks: [line(data, { x: "date", y: "value", name: "Value" })],
  ariaLabel: "Value by date",
});

const svg = renderChartSvg(definition, { width: 720, height: 320 });
```

The React `<Chart definition={definition}>` component accepts the same native
definition when the application still wants React to own the lifecycle.

### Native axis and value formatting changes

Native charts now size and format their axes from the data, so a few labels
read differently after upgrading:

- Heatmaps no longer add a `+` sign and `%` to every value. Add
  `valueFormat: "signed-percent"` to a heatmap mark that shows returns (values
  in percentage points), or `"percent"`, `"signed"` or a function for other
  data. The colour bar uses the same format.
- Values from a million up use compact notation (`1.2T` instead of
  `1,200,000,000,000`, `25.0004M` for 25,000,400) in ticks, chips and
  tooltips. Pass `scales.y.tickFormat` to keep full digits.
- Tick labels take their decimals from the tick step (`1.0850` rather than
  `1.1`), and time axes label calendar boundaries (`2025`, `Feb`, `14 Feb`,
  `09:30`) instead of `D Mon` at fixed day steps.
- A numeric viewport on a Date axis keeps the time scale; numbers are no
  longer guessed to be timestamps from their magnitude.
- The value axis widens to fit long labels and chips, and crowded category
  labels rotate; set `margin.right` / `margin.bottom` or `scales.x.labels` to
  pin the previous layout.
