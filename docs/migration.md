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
| `createShape`, `createMultipointShape` | Supported subset | Use the drawing kinds in the capability matrix; any other name rejects with a `ShapeError` listing them. `extended` and `date_and_price_range` are mapped for you. Point times are Unix seconds, and every point needs a `price` except on `vertical_line` (TradingView's `channel` fallback is not supported). |
| `getShapeById`, `removeEntity`, `removeAllShapes` | Supported | Shape point editing, `setProperties({ text })`, z-order moves and removal are implemented. `getShapeById` throws for an unknown id instead of returning a no-op handle. |
| Order-line `onMove` / `onModify` / `onCancel` | Supported | Both `(callback)` and TradingView's `(data, callback)` forms; drag and keyboard prices are rounded to the symbol tick. |
| `createStudy` | Supported subset | EMA, SMA, RSI, VWAP, Bollinger, MACD, plus studies registered through `raze.custom_studies`. Names match exactly (TradingView names such as `Moving Average Exponential` are aliases); an unsupported study rejects instead of resolving to a similar one. Built-in inputs accept ids, TradingView input titles (`Fast Length`), aliases (`src`, `multiplier`) and `in_N`; `load()` rejects a layout naming an unknown study with the same guidance. `forceOverlay` draws a pane study (RSI, MACD) on the price pane with its own scale; `lock` is stored but not separately enforced. Positional (`[30]`) and boolean inputs are honoured; invalid values reject with a `StudyInputError`. Overrides support `<plot>.color`, `<plot>.linewidth` and `<plot>.visible` for any plot; options support `disableUndo` and `priceScale: "as-series"`. Everything else warns once. |
| `subscribe` / `unsubscribe` | Supported subset | `drawing_event`, `trading_event`, `error`, and the Raze events `drawing_selection_changed` and `drawing_tool_changed`. Other event names throw instead of never firing. |
| `executeActionById`, `getCheckableActionState` | Supported subset | See the `ChartActionId` union; unsupported ids such as `chartProperties` throw. |
| `createButton` | Supported | Use it for small host actions; own complex UI outside the widget. |
| `save()` / `load()` | Supported | Versioned JSON snapshot of symbol, interval, range, style, shapes, and studies with stable entity IDs. `disableSave` omits a live shape. The host owns storage. |
| `createCompare(symbol)` | Supported | Overlay another symbol on the same pane; `raze.layout` `"2x1"` / `"2x2"` syncs range and crosshair across panes. It rejects with a `[raze-charts]` message when the symbol cannot be resolved or its history fails, and adds nothing. The first compare switches the price scale to percent with autoscale. Compares follow interval and symbol changes, `resetData()`, left pagination and live bars. `load()` skips a saved compare that no longer resolves or loads, reports it with a `[raze-charts]` console error, and loads the rest of the layout. |
| unlisted TradingView option or event | Not guaranteed | A permissive compatibility type is not proof of runtime support. |

### Datafeed checklist

- Emit `Bar.time` in Unix milliseconds. `PeriodParams.from` / `to` and mark
  times use Unix seconds; these units are intentionally different and typed.
  Times below 1e11 are reported as seconds, and bars with non-finite or string
  OHLC are dropped with one warning naming the field and index. Set
  `raze.coerce_bars: true` to convert strings, seconds and inverted high/low
  instead.
- Mark gaps with `HistoryMetadata.nextTime` (Unix seconds) on an empty page;
  the next request uses `to = nextTime`. Reserve `noData` without `nextTime`
  for the true start of history.
- Use TradingView resolution strings: `"1S"`, `"15"`, `"240"`, `"D"`/`"1D"`,
  `"W"`, `"M"`/`"3M"`. The chart and your feed receive the canonical spelling
  (`"D"` arrives as `"1D"`). Invalid values such as `"4h"` or `"1H"` throw a
  `RangeError` instead of loading one-minute bars. The exported
  `parseResolution`, `resolutionToMs`, `resolutionLabel` and `floorToBar`
  helpers throw the same error instead of returning one minute; test untrusted
  strings with `isValidResolution()`. Saved layouts whose interval is invalid
  (for example `"4h"`, which used to load as one minute) now make `load()`
  reject with the same `RangeError`; rewrite them with `normalizeResolution()`
  or check them with `isValidResolution()` before loading.
- Return bars in ascending order. The manager canonicalizes and de-duplicates,
  but a sorted feed avoids unnecessary work.
- Treat the subscription GUID as opaque and stop producing work after
  `unsubscribeBars`.
- Call the error callback with useful context; active failures are surfaced and
  already committed data remains visible. A call without a reason is still a
  failure (logged, and backed off during pagination), never a cancellation.
- Call the `onReady` callback once; later calls are ignored with a warning.
- Set `supports_marks` / `supports_timescale_marks` in the `onReady`
  configuration to have `getMarks` / `getTimescaleMarks` called; bar marks
  then render by default (the Raze-only `enabled_features: ["mark_on_bars"]`
  no longer turns them on, and `disabled_features: ["mark_on_bars"]` hides
  them). Late results from an obsolete symbol or interval are discarded.
- Set `supports_time: true` with `getServerTime` (Unix seconds) to end the
  first history window, and resolve `options.timeframe`, at the server's time
  instead of the client clock's.
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

The range bar uses TradingView's featureset name, `timeframes_toolbar`. The
earlier `time_frames_toolbar` spelling still works as a deprecated alias and
logs a warning when `debug: true`.

### Widget size, timeframe and layouts

- `width`, `height`, `autosize` and `fullscreen` are honoured. `autosize: true`
  (and the default without dimensions) fills the container; `width`/`height`
  without `autosize: true` size the chart in pixels; `fullscreen: true` fills
  the browser viewport. Integrations that passed `width`/`height` into a sized
  container and relied on them being ignored should drop them or pass
  `autosize: true`.
- `timeframe` accepts TradingView's `{ from, to }` and `TimeFrameValue`
  objects. The earlier Raze `{ type: "time-range", value: "from,to" }` shape still
  works and is typed as deprecated.
- In `raze.layout` grids, an interval change on any pane now applies to every
  pane, like TradingView's default interval sync. Pass
  `raze.layout_sync: { interval: false }` to keep the previous per-pane
  intervals.

### Content Security Policy

TradingView's library renders inside an iframe. Raze renders in your page,
so your page's CSP applies to it. The widget's chrome styles use
constructable stylesheets and CSSOM, so `style-src 'self'` works without
`'unsafe-inline'`. Where constructable stylesheets are unavailable, provide a
nonce through `raze.style_nonce`, `<meta property="csp-nonce" nonce="…">` or
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

### Context menu items: `ContextMenuItem`

`onContextMenu` follows TradingView's conventions: `{ text: "-" }` renders a
separator (it used to render a literal "-" row) and `{ text: "-Label" }`
removes the default item named `Label` instead of adding a row. Because a
separator or a removal needs no handler, `ContextMenuItem.click` and
`ContextMenuItem.position` are now optional (`position` defaults to `"top"`).
Code that builds items compiles unchanged; code that reads `item.click` or
`item.position` back needs an `undefined` check. Tab and Shift+Tab on a row
now close an open menu and move on from its button instead of walking its
rows; a field or other control a host puts inside an `openPopup()` menu keeps
the normal Tab order. An item without `click` renders disabled: the arrow
keys reach it, as the WAI-ARIA menu pattern recommends, but it does nothing.

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

A shell that assembles its own `FinanceView` for the painters (instead of
calling `ChartRenderer.financeView()`) must now fill six more fields. The
built-in renderer fills them, so widget users are unaffected:

| Field | Type | What to pass |
| --- | --- | --- |
| `dpr` | `number` | Device pixels per CSS pixel of the canvas backing store, used to snap lines to the bitmap grid. |
| `timescaleMarkScreen` | `TimescaleMarkHit[]` | A fresh empty array; the timescale-mark painter fills it for hit-testing. |
| `hoverTimescaleMark` | `TimescaleMark \| null` | The hovered timescale mark, or `null`. |
| `hoverShapeId` | `string \| null` | The hovered drawing id, or `null`; drawing handles paint only when hovered or selected. |
| `axisTags` | `AxisTag[]` | A fresh empty array per frame; drawings, trading lines and studies queue price/time axis tags into it. |
| `axisChromeRect` | `Rect` | The price-axis by time-axis corner cell (`x` = plot right edge, `y` = time-axis top, `w` = price-axis width, `h` = time-axis height), the only area the timezone/countdown chrome may paint. |

Spreading `renderer.financeView()` and overriding only what the shell owns is
the least fragile way to build one.

### Custom studies: study contract v2

Existing `raze.custom_studies` definitions keep working. Some public types
changed, and TypeScript code that relies on the old shapes needs small edits:

- `StudyDefinition.compute` now takes a third argument,
  `ctx: StudyComputeContext`. Implementations that ignore it compile
  unchanged. Code that calls `definition.compute(bars, inputs)` itself must
  pass a context, for example `createStudyContext({ symbolInfo, resolution })`
  from `@razedotbot/charts/studies`.
- The `StudyInputs` index signature, `StudyDefinition.defaults` and the
  `inputs` of `ChartLayoutSnapshot` studies widened from `number | string` to
  `number | string | boolean`. Code that reads these values as
  `number | string` needs a `typeof` check.
- `createStudy()` now validates inputs against a declared schema and rejects
  with a `StudyInputError` (`code`: `unknown-input` or `invalid-value`)
  instead of dropping or ignoring bad values. Boolean inputs are kept.
  `load()` stays lenient and resets stale saved inputs to their defaults with
  a warning.

[Custom indicators](./indicators.md) documents the full contract.

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
| `ReferenceLine` | Add a horizontal (`y`, a number) or vertical (`x`, a category, number or Date) rule | Exactly one of `y` or `x`. |
| `ResponsiveContainer` | Measure the wrapper and inject numeric width/height into its child | The child is one component element (a chart, or your own wrapper that forwards `width`/`height`) or a render function `({ width, height }) => …`; host elements such as `<div>` and bare descriptors such as `<Line>` are rejected. |
| `Brush` | Window the native viewport | `startIndex`/`endIndex` or a time domain; it is not the Recharts brush overlay API. |
| `syncId` | Share the X window between charts | Charts with the same `syncId` share one X window (pan, zoom, brush and presets). Unlike Recharts, the tooltip and crosshair position are not synchronized. `viewportGroup` is the explicit form. |

### Exact React prop surface

The adapter accepts exactly these props. Series descriptors are validated at
run time as well as in TypeScript, so an unlisted prop throws with the
supported list instead of being ignored. The table is generated from the
adapter source, and `npm run check:docs` fails when it drifts.

<!-- react-props:start -->
<!-- Generated from src/react/index.tsx (SUPPORTED_PROPS and the public prop interfaces) by `node scripts/check-docs.mjs --write`. Do not edit by hand. -->

| Component | Accepted props |
| --- | --- |
| `LineChart`, `BarChart`, `AreaChart`, `ScatterChart`, `PieChart`, `RadarChart`, `HeatmapChart`, `ComposedChart` | `data`, `width`, `height`, `renderer`, `children`, `ariaLabel`, `ariaDescription`, `idPrefix`, `className`, `style`, `onReady`, `onViewportChange`, `onSelect`, `viewportGroup`, `syncId` |
| `Chart` | `definition`, `width`, `height`, `renderer`, `ariaLabel`, `ariaDescription`, `idPrefix`, `className`, `style`, `onReady`, `interaction`, `viewport`, `onViewportChange`, `onSelect`, `viewportGroup`, `syncId` |
| `ResponsiveContainer` | `children`, `width`, `height`, `className`, `style` |
| `Line` | `dataKey`, `data`, `name`, `stroke`, `strokeWidth`, `lastValue`, `dashed`, `curve` |
| `Area` | `dataKey`, `data`, `name`, `stroke`, `fill`, `fillOpacity`, `strokeWidth`, `lastValue`, `dashed`, `curve`, `y0` |
| `Bar` | `dataKey`, `data`, `name`, `fill`, `stackId`, `lastValue`, `fade` |
| `Scatter` | `dataKey`, `data`, `name`, `fill`, `fillOpacity`, `r` |
| `Pie` | `dataKey`, `data`, `name`, `innerRadius`, `outerRadius` |
| `Radar` | `dataKey`, `data`, `name`, `stroke`, `fill`, `fillOpacity`, `strokeWidth` |
| `Heatmap` | `dataKey`, `data` |
| `XAxis` | `dataKey` |
| `YAxis` | `dataKey` |
| `CartesianGrid` | No props |
| `Tooltip` | No props |
| `Legend` | No props |
| `ReferenceLine` | `y`, `x`, `stroke`, `strokeWidth`, `name` |
| `Brush` | `dataKey`, `height`, `startIndex`, `endIndex` |

<!-- react-props:end -->

Series take `data` to override the container's rows for that series. `Heatmap`
reads its X/Y channels from the axes or the typed factory defaults.
`Chart.style` cannot set dimensions. `ResponsiveContainer.style` cannot set
`width`, `height`, `position`, or `minWidth`, because those values are owned
by its measurement contract.

Unknown React children are currently ignored because they may be ordinary
composition wrappers. Known-but-unsupported Raze descriptors must throw. Do
not interpret the absence of a warning for an arbitrary Recharts component as
support.

Pie and heatmap containers compile as standalone coordinate systems. A composed
radar chart may contain multiple radar series only when all category axes
match. Move mixed Cartesian/polar layouts into separate chart instances.

### Synchronized charts

Recharts' `syncId` maps to a viewport group. Charts in the same group share
one X window: a wheel zoom, drag pan, brush or range preset on any member moves
the others. Each chart joins when it mounts and leaves when it unmounts. Only
the X window is shared: unlike Recharts, hovering one chart does not move the
tooltip or crosshair of the others.

```tsx
import { LineChart, Line, XAxis, createViewportGroup } from "@razedotbot/charts/react";

type Row = { t: number; price: number; volume: number };

// Create the group once (module scope or useMemo), not on every render.
const dashboard = createViewportGroup();

export function Dashboard({ rows }: { rows: Row[] }) {
  return (
    <>
      <LineChart data={rows} height={240} viewportGroup={dashboard}>
        <XAxis dataKey="t" />
        <Line dataKey="price" />
      </LineChart>
      <LineChart data={rows} height={120} syncId="dashboard-volume">
        <XAxis dataKey="t" />
        <Line dataKey="volume" />
      </LineChart>
    </>
  );
}
```

`syncId="…"` is shorthand for a group shared by every chart with the same id.
Use `viewportGroup` when the host also drives the window (for example
`dashboard.setViewport({ x: [from, to] })` from a date picker) or reads it
back with `dashboard.getViewport()`. `onReady` handles also satisfy
`ViewportHandle`, so `group.add(handle)` works for charts you wire up by hand;
call the function it returns when that chart unmounts. A handle added this way
only follows the group; its own gestures do not move the others. To make it
lead as well, prefer the `viewportGroup` prop, which joins and broadcasts, or
also pass `onViewportChange={(v) => group.setViewport(v)}` to that chart. Only
the chart the user interacted with calls its `onViewportChange`; followers are
moved programmatically.

### Next.js App Router and Server Components

`@razedotbot/charts/react` starts with a `"use client"` directive, so a Server
Component can render its charts directly; you do not need your own client
wrapper file. Props cross the server/client boundary, so they must be
serializable: pass data rows and strings, not functions. Callbacks such as
`onSelect` or `onReady`, and a `viewportGroup` object, belong in a client
component of your own (a `syncId` string works from the server). Charts measure
and paint in the browser: during server rendering the chart host is an empty,
correctly sized `<div>`. The framework-neutral `/chart` entry has no directive
and stays usable on the server, for example `renderChartSvg()` in a route
handler.

## Moving from JSX to the native grammar

Use `/chart` when you need typed accessors, explicit scale/domain control,
server-generated SVG, scene inspection, or custom mark plugins.

<!-- prelude: native-data -->
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
