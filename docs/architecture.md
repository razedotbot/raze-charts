# Architecture

Raze Charts currently contains two chart runtimes with a shared product
philosophy but different domain requirements. Keeping that distinction visible
prevents a compatibility adapter from becoming the architecture.

## Public boundaries

```text
@razedotbot/charts
  TradingView-shaped widget API
        -> data manager + stores + mutable financial context
        -> financial layout, gestures, Canvas paint layers
        -> optional built-in chrome

@razedotbot/charts/react
  React lifecycle / JSX descriptors
        -> native ChartDefinition
            -> compileChart()
                -> renderer-neutral CompiledChart scene
                    -> SVG string, SVG mount, or Canvas mount
@razedotbot/charts/chart

@razedotbot/charts/studies
  pure indicator kernels + StudyRegistry / StudyDefinition
        (the same modules the widget bundles; no DOM, no widget)
```

The root, `/chart`, `/react`, and `/studies` package exports are public. Every
public entrypoint is one row in `scripts/entries.mjs`, which drives the build,
`package.json` exports, the packed package contract, and the per-entry budget
files in `benchmarks/budgets/`. Source paths and individual distribution
files are not public. The project is pre-1.0, so additions
should still preserve documented behavior wherever practical and call out
breaking changes explicitly.

### TradingView-compatible declarations

The TradingView-shaped types are hand-authored. `src/types/charting_library.d.ts`
is a barrel that only re-exports one domain module per concern:

| Module (`src/types/tv/`) | Declares |
| --- | --- |
| `common.d.ts` | Branded ids, theme and timezone names, `ISubscription` |
| `datafeed.d.ts` | Bars, symbols, datafeed configuration and callbacks, marks |
| `shapes.d.ts` | Shape points and `createShape` options, `ILineDataSourceApi` |
| `trading.d.ts` | Order, position and bracket lines |
| `chart-api.d.ts` | `IChartWidgetApi` |
| `layout.d.ts` | `ChartLayoutSnapshot` for `save()` and `load()` |
| `context-menu.d.ts` | `ContextMenuItem` and the `onContextMenu` callback |
| `widget.d.ts` | `IChartingLibraryWidget`, the `widget` class, header button options, `version` |
| `options.d.ts` | `ChartingLibraryWidgetOptions`, the `raze` chrome options, formatters |
| `studies.d.ts` | `StudyDefinition` and Indicators panel presets |

The package root re-exports the barrel, and `dist/types` ships the same module
tree. `build.mjs` also flattens the modules into the self-contained
`dist/charting_library.d.ts` (and its `dist/datafeed-api.d.ts` alias) that
vendored drop-in installs copy next to a bundle. To keep that flattening exact,
`scripts/compat-types.mjs` fails the build when a module breaks one of these
rules:

- every top-level declaration is a named `export`;
- siblings are referenced only through `import type { A, B } from "./<module>"`,
  without renames;
- re-exports live only in the barrel, and every `tv/` module is re-exported;
- a name is declared in one module only;
- a `/** … */` comment sits directly above the declaration it documents.
  TypeScript shows the last such comment before a declaration as its hover
  documentation, even across blank lines and the imports that flattening
  removes, so file headers and section notes are `//` comments.

`tests/compat-types.mjs` checks that every declaration shows the same hover
documentation in the flattened file as in its module.

`tests/types-api-report.mjs` resolves every export of the published
declaration entry points, plus every named package type those exports
reference without exporting, and compares a normalized report with
`tests/types-api-report/*.api.txt`. The report ignores which file declares a
type, so moving a declaration between modules is free, while any change to a
name, member, modifier or type fails with a diff. After an intentional public
type change, review the diff and run
`node tests/types-api-report.mjs --update`.

## Financial runtime

The financial widget owns the host DOM and wires five responsibilities:

1. `DataManager` resolves the symbol, loads/paginates bars and marks, manages
   live subscriptions, and commits only the latest symbol/resolution request.
2. `ChartContext` holds the current bars, viewport, scale state, theme,
   selected tool, and delegates. It is mutable by design in the current
   runtime.
3. `ShapeStore` and `StudyStore` own annotations and active indicators.
4. `ChartEngine`, gestures, layout, and paint modules turn state into a
   device-pixel-ratio-aware Canvas frame.
5. Toolbar, sidebar, interval selector, scale bar, menus, and loading state are
   optional chrome around the plot.

### Widget composition

`Widget` (the exported `widget` class) is a thin facade. Its only runtime
surface is the documented `IChartingLibraryWidget` methods; all state lives in
one `#private` `WidgetRuntime` (`src/core/widget/runtime.ts`). The runtime
builds the `ChartContext`, owns the kernel (data manager, stores, engine,
renderer) and drives the controllers registered in
`src/core/widget/controllers.ts` through four phases:

```text
create   controllers in list order; DOM the engine measures (chrome shell, layout grid)
attach   kernel exists; plot chrome, API wiring, event forwarding, context menu
boot     first load settled; header controls, layout children, shortcuts
destroy  reverse list order, after the kernel stops
```

The built-in controllers are chrome, layout, API, events, actions, compare,
persistence and context menu. `LifecycleController` sits beside them and owns
readiness, teardown state and the "newest data change wins" rule. A new
controller implements `WidgetController`, adds its id to `WidgetControllerMap`
through declaration merging, and appends itself to the list.

`ChartApi` is composed the same way: each module in `src/core/api/*` exports
`this: ChartApi` methods, `src/core/api/index.ts` lists them, and they are
installed on the prototype as non-enumerable methods. Per-instance state is
held in a module-private `WeakMap` (`apiScope(this)`), so an instance has no
own properties. Two modules cannot define the same method.

Canvas interaction follows the same pattern. `src/engine/gestures.ts` owns
the listeners, pointer bookkeeping, pinch and long press, and the active
`DragSession`. It routes every press, wheel, double-click and key to the
`InteractionHandler`s listed in `src/engine/interaction/handlers.ts`, ordered
by ascending `priority`: drawing draft 100, trading lines 200, drawing edit
300, price axis 400, time axis 500, viewport 1000. The first handler to
return a truthy result consumes the event. A handler that returns a session
owns the drag: the session commits on the last pointer up, and it rolls back
on pointer cancel or when a second finger turns the gesture into a pinch.

### Time is a logical bar axis

Financial time is not a wall-clock ruler. A Friday bar and the next Monday bar
are adjacent if no market bars exist between them. `TimeIndex` provides a
binary-search timestamp-to-index mapping and its inverse:

```text
real timestamps:     Fri 16:00                Mon 09:00   Tue 09:00
logical positions:       0         <->            1          2
```

Exact timestamps map to exact array indices. Points inside a gap interpolate
between adjacent real bars. Whitespace beyond either edge uses the expected
resolution. Drawings, marks, hit tests, and context-menu coordinates therefore
share one reversible mapping.

### Shared time and locale core

Both runtimes use one internal time and locale core. New time-axis, timezone,
calendar or `Intl` formatting code goes here instead of into a runtime:

| Module | Responsibility |
| --- | --- |
| `src/util/intl.ts` | Bounded cache of `Intl.NumberFormat`, `DateTimeFormat` and `PluralRules` per locale and options. Output is byte-identical to `toLocaleString`. |
| `src/util/time/zone.ts` | IANA zones built on `Intl`. Offsets are memoised per UTC day and each transition is found to the second. Wall-time conversion follows Temporal's `compatible`, `earlier`, `later` and `reject` rules. Results do not depend on the process `TZ`. Instants outside the `Date` range (±8.64e15 ms) give `NaN`. |
| `src/util/time/calendarTicks.ts` | Weighted calendar ticks from 1 ms to 1000 years. `calendarTicks()` handles continuous ranges (native `/chart`) and `barTicks()` handles logical bar axes. An optional `format(tick, defaultLabel)` supplies custom labels ("14 Feb", "Feb 2025"); labels are formatted before `measure` runs, so collision checks see the final text. Also provides local `floorToCalendar()` and `addCalendar()`; day steps above 1 count days of the month (2 gives odd days, 14 gives the 1st and 15th). |
| `src/engine/timeAxis.ts` | `FinancialTimeAxis` caches per-bar weights and formats ticks and crosshair labels. Every call takes the resolution kind: intraday bars are read in the display zone, daily, weekly and monthly bars in UTC (`calendarZone(kind)`). Pass the same bars array every frame: appends and last-bar updates to it are incremental, a new array recomputes, and `invalidate()` covers other in-place rewrites. |

The tick ladder is 1/2/5/10/20/50/100/200/500 ms, 1/2/5/10/15/30 s and min,
1/2/3/6/12 h, day, odd days, week, half month, 1/3/6 months and 1/2/5/10…1000
years. Adjacent rungs are at most 3.5x apart. The ladder is not one nested
chain, so selection runs on three nested tracks and keeps the densest result:
TradingView's 1/5/15/30 ladder with weeks and quarters first, then 1/5/10/30,
then the binary 1/2/10/30 track with odd days, half months and 2-year rungs.

Within a track, ticks are selected one whole level at a time, starting from
the heaviest. When a level's own calendar rhythm no longer fits the minimum
spacing (40 px by default, or the measured label widths), the core refuses
that level and every finer one. Labels therefore stay regular ("2025 Apr Jul
Oct 2026"). A collision caused by the data rather than the calendar drops only
the finer tick, for example a 09:30 session open next to 10:00. Two fallbacks
keep an axis from going blank: holes much wider than the median gap (sparse
bars, including at either end) are filled from the refused levels, and an axis
with room for two labels but fewer than two admits refused levels greedily
until it has two.

Daily, weekly and monthly bars follow the TradingView datafeed contract: they
are stamped 00:00 UTC of the trading day and are read in UTC whatever the
display zone. A 1 Feb daily bar therefore reads "1 Feb" and carries the
month label in New York and Tokyo alike. Intraday bars are instants and are
read in the display zone. Session boundaries and bar flooring use the same
rule through `FinancialTimeAxis.calendarZone(kind)`.

On a bar axis each bar weighs the heaviest boundary crossed since the
previous bar. The first bar of the series weighs what a session open on its
local day would weigh (at least a day), so it carries its date, and loading
an earlier page does not change that weight. When clocks fall back, two bars in the
repeated hour have the same wall time (01:00 EDT and 01:00 EST). The second
one is told apart from a duplicate by its UTC time and is weighted like the
first, so the hour is labelled twice, as on a continuous axis. It never
weighs a day, so the date is not repeated.

The core is not wired into either runtime yet, so it costs nothing today.
Adopting it will. Measured with the `build.mjs` settings and gzip level 9,
and net of the legacy tick code each runtime removes (about 0.4 KiB):

| Entry | Core it pulls in | As shipped | Fully minified |
| --- | --- | --- | --- |
| Native `/chart` (W1B-01) | `calendarTicks` | +7.8 KiB (40.7 to about 48.5 KiB, budget 42) | +5.4 KiB |
| Root widget (W1B-05) | `FinancialTimeAxis` | +7.8 KiB (51.9 to about 59.6 KiB, budget 55) | +6.3 KiB |

Most of that is the zone math (about 2.7 KiB) and the tick selection. None of
it is dead weight: unused exports and derived tables tree-shake. Minifying
whitespace in the native artifact would drop its PURE annotations, which are
part of its tree-shaking contract. Those budgets therefore have to rise when
the core is adopted: native to at least 49 KiB and the root widget to at
least 60 KiB, before any other growth in those packages.

### Async ownership

A symbol/resolution change starts a new data generation. History, marks,
pagination, and live callbacks capture that generation and may mutate state
only while it remains current. Teardown invalidates the generation and settles
pending readiness work.

This rule is more important than transport cancellation: a callback API may
not offer `AbortSignal`, but an obsolete callback still cannot commit.

For new code, `defineDataSource` describes a Promise-first data source and
`createDatafeed` adapts it to the callback contract consumed by the widget.
Native realtime subscriptions receive an `AbortSignal` and may return a cleanup
function synchronously or asynchronously. The adapter owns both, including the
case where unsubscribe happens before async setup completes. Existing
`IBasicDataFeed` objects remain a direct compatibility input.

### Study updates

Built-in EMA, SMA, and RSI recognize append and replace-last mutations and
update the newest sample incrementally. VWAP, Bollinger Bands, and MACD use
the multi-series `compute` contract (`{ series }`) and recompute in full after
a structural data change. VWAP also resets on UTC day boundaries. A new array
reference, a backfill, a historical correction, or a custom study uses the
public full-array `compute` contract. Custom code must not assume incremental
calls.

`widget.save()` / `widget.load()` serialize a versioned JSON snapshot: symbol,
interval, visible range, style/scale flags, drawings with stable IDs and behavior
flags, study specs (not derived values), and compare symbols. The host owns
storage. A drawing with `disableSave` remains live but is omitted from the
snapshot. `executeActionById("undo"|"redo")`
walks a command stack for drawings and studies. `disableUndo` on a shape skips
that create. There is no cloud layout.

Trading overlays use a separate `TradingStore` because broker state has a
different lifecycle from drawings. `ChartApi` creates fluent line adapters;
the renderer consumes line fields each frame; gesture hit-testing updates
prices through the store so callbacks and `trading_event` stay consistent for
pointer, keyboard, and programmatic changes. Bracket orders share a group id
used to derive risk, reward, and linked cancellation. Trading state is absent
from layout snapshots and should be rehydrated from the host's execution
backend.

Native `viewport` windows source rows in `compileChart` before geometry and
decimation. `mountChart` can brush (Shift-drag), wheel-zoom, and pan that
window within the zoom limits and data bounds (`interaction.zoom`,
`interaction.panBounds`); `createViewportGroup()` keeps several mounts on the
same X range.
React `<Brush>` maps `startIndex`/`endIndex` onto that viewport. Coordinated
panes stay host-owned: the compiler does not layout multiple plots.

## Native chart runtime

The native runtime uses a compile/render split:

```text
typed data + mark builders + ChartSpec
                    |
              ChartDefinition
                    |
              compileChart(size)
                    |
     scales + ticks + legend + scene nodes + hover samples
                    |
        SVG string / mounted SVG / mounted Canvas
```

`compileChart` has no DOM dependency. `renderChartSvg` can generate a static
accessible SVG string in Node. `mountChart` owns resize and pointer behavior in
a browser and returns a small lifecycle handle:

```ts
interface MountHandle {
  update(definition: ChartDefinition, options?: MountChartOptions): void;
  getScene(): CompiledChart | null;
  setViewport(viewport: ChartViewport | null): void;
  getViewport(): ChartViewport | null;
  destroy(): void;
}
```

`update()` preserves the host and listeners, then recompiles and repaints the
scene. A failed compile leaves the prior definition, scene, and DOM active. It
is not retained scene diffing. Dense line and area geometry is reduced
by a pixel-aware extrema envelope by default; this bounds rendered path and
hover-sample size while preserving bucket spikes and troughs. Compilation still
scans source rows to infer domains and build the envelope, so it remains O(n).
`CompiledChart.diagnostics` exposes source rows, nodes, samples, and omitted
geometry. Set `performance.maxRenderedPoints` to tune the bound or
`performance.decimation: "none"` when exact output geometry is required.

### Native source layout

The compiler and renderers are split by concern. `src/chart/defineChart.ts`
and `src/chart/render.ts` are thin facades that re-export the modules below,
so internal imports and the public `/chart` barrel do not depend on the
layout. No module in either directory may exceed 700 lines, and
`tests/native-split-parity.mjs` enforces that limit.

```text
src/chart/compile/
  types.ts      spec, scale-spec, scene, compiled-chart, and plugin contracts
  marks.ts      mark shapes, options, builders, defineMarkPlugin/customMark
  define.ts     defineChart() and typed composition rules
  validate.ts   runtime ChartSpec, scale, mark, and composition validation
  legend.ts     series names/colours, hidden series, legend rows and placement
  domain.ts     viewport windowing, X-type inference, domain checks, X/Y scales
  axes.ts       margins, plot rectangle, time/band/linear ticks
  format.ts     number, date, and signed formatting; axis formatters
  cartesian.ts  line/area, point, ruleY/ruleX, grouped and stacked bars
  decimate.ts   extrema decimation and per-series budget allocation
  polar.ts      pie and radar
  heatmap.ts    square-cell layout and colour cells
  plugin.ts     isolated scales, plugin domains, compile, result validation
  context.ts    per-compile mark context and scene accumulators
  chart.ts      compileChart() pipeline orchestration
  shared.ts, errors.ts   channel helpers and ChartCompileError

src/chart/render/
  svg.ts        SVG nodes, grid, axes, colour bar, document assembly
  canvas.ts     Canvas painter for the same scene
  legend.ts     legend layout (v1 rows, v2 wrapping/hidden rows) for both renderers and hit tests
  chips.ts      bounded last-value chip stacking and crosshair chip labels
  ticks.ts      x tick label placement (edge anchoring, v2 anchor/rotation)
  hit.ts        hit testing, hover-sample index, tooltip text
  pointer.ts    pointer targets with data-space values; onTooltip/onSelect payloads
  frame.ts      stage frame: where the scene sits on screen, for pointer mapping
  zoom.ts       interaction option validation, zoom limits, log-axis transform
  primitives.ts shared paths, arcs, rounded bars, shading, escaping
  mount.ts      mountChart() lifecycle, compile/paint, rAF resize, cached full scene, handle
  overlay.ts    mount DOM, hover crosshair/tooltip overlay, legend toggle buttons
  gestures.ts   select, rAF-coalesced wheel zoom/pan, pan preview, brush, legend toggles
  chrome.ts     themed range presets and navigator
  types.ts      mount options/handle/event types and shared runtime state
```

The parity suite pins every fixture's scene, SVG, Canvas command stream, hit
tests, mounted DOM, callback payloads, and validation messages. If you change
native output on purpose, regenerate its snapshot with
`node tests/native-split-parity.mjs --update` and explain the diff in review.

### Validation and truthful gaps

Type inference rejects invalid datum keys in TypeScript, while compilation also
validates definitions received through JavaScript or dynamic configuration.
`ChartCompileError` exposes a stable `code` for malformed specs, sizes, data,
mark kinds, channels, and plugin failures, plus the original cause when one is
available. Product error boundaries can branch on the code without parsing the
human-readable message.

Non-finite line and area samples split geometry into separate segments. The
compiler does not draw an invented connection across a missing value; this is
a correctness rule as well as a visual detail.

## React adapter

`<Chart>` mounts once in an effect, stores its `MountHandle`, and sends changed
definitions/options through `update()`. Recharts-shaped children are inert
descriptors inspected by the parent; they are not independent DOM components.
The optional `onReady` callback receives a read-only `ReactChartHandle` with
`getSnapshot()` / `getScene()`. Each call returns a detached, deeply frozen
snapshot; React retains exclusive ownership of the live scene and teardown.

This makes `Tooltip` and `Legend` useful boolean toggles while keeping one
renderer and interaction implementation. It also means Recharts custom child
renderers, event props, and layout rules do not transfer automatically. The
[migration guide](./migration.md#recharts-shaped-jsx) lists the exact mapping.

## Custom marks

Native charts expose a renderer-neutral extension rather than a renderer hook.
A plugin contributes domains and compiles data into existing scene node types.

```ts
import {
  customMark,
  defineChart,
  defineMarkPlugin,
} from "@razedotbot/charts/chart";

type Range = { x: number; low: number; high: number };
type RangeOptions = { color: string };
declare const data: Range[];

const ranges = defineMarkPlugin<Range, RangeOptions>({
  kind: "range",
  domain(data) {
    return {
      x: data.map((datum) => datum.x),
      y: data.flatMap((datum) => [datum.low, datum.high]),
    };
  },
  compile({ data, options, mapX, mapY }) {
    return {
      nodes: data.map((datum) => ({
        type: "rule",
        x: mapX(datum.x),
        x2: mapX(datum.x),
        y: mapY(datum.low),
        y2: mapY(datum.high),
        stroke: options.color,
        strokeWidth: 2,
        role: "range",
      })),
      legend: [{ name: "Range", color: options.color }],
    };
  },
});

const definition = defineChart({
  marks: [customMark(ranges, data, { color: "#8ecae6" })],
  ariaLabel: "Daily range",
});
```

Plugins should be deterministic and side-effect free. Domain calculation and
compilation run on every native scene compilation. They receive frozen plot and
theme snapshots plus isolated scale facades, so mutation cannot corrupt the
compiler. Throwing is wrapped with a Raze error code and plugin context. Domain
keys and finite values are checked, and results must contain valid
discriminated scene-node geometry; optional legend, samples, and last values
are validated too. Plugin kinds must be non-empty and cannot collide with a
built-in mark kind. Plugin-specific top-level options belong in the typed
`pluginOptions` payload created by `customMark()`.

## Design rules for changes

- Native contracts own behavior; compatibility adapters translate into them.
- Unsupported known features fail with a useful message instead of rendering
  a silent no-op.
- Data callbacks prove they still own the active generation before committing.
- Renderers consume the same semantic scene wherever the domain allows it.
- Accessibility metadata travels with the chart definition, not as a renderer
  afterthought.
- Mounts expose explicit cleanup and tests exercise teardown during async work.
- Performance claims have a reproducible scenario, baseline, and budget.
- Chrome UI is built from the [UI kit](./ui-kit.md): kit overlays and
  controls, `t(key, default)` strings, `--raze-*` tokens in a scoped
  stylesheet, and text-only rendering of untrusted strings (enforced by
  `node scripts/check-dom-sinks.mjs`).
- Viewport, price-scale and chart-type writes go through the reason-tagged
  context setters, and shared fields and plugin contracts are declared in
  [seams](./seams.md) with their producer and consumers.

## Repository map

```text
src/
  chart/       typed native grammar, scales, scene compiler (compile/),
               SVG/Canvas output and mounts (render/)
  react/       lifecycle adapter and Recharts-shaped descriptors
  core/        financial widget facade, API, context, theme, shape state
    widget/    widget runtime, lifecycle and controllers
    api/       ChartApi method modules
  data/        financial feed orchestration and TimeIndex
  engine/      financial layout, gesture coordinator, renderer, Canvas paint layers
    interaction/  pointer, wheel and keyboard handlers
  studies/     built-in calculations, registry, active study state
               (index.ts is the /studies entrypoint)
  types/       TradingView-compatible declarations: barrel over tv/ modules
  ui/          optional financial chrome and popup primitives
  util/        formatting, Intl cache, time zones and calendar ticks,
               resolution, delegates, Heikin Ashi
tests/         unit, lifecycle, package contract, and visual regressions
scripts/       entry table, test runner, packaging helpers, and quality tooling
benchmarks/    compiler baseline and per-entry bundle budgets (budgets/<entry>.json)
docs/          capability, migration, architecture, a11y, and performance guides
```
