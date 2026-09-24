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
```

The root, `/chart`, and `/react` package exports are public. Source paths and
individual distribution files are not. The project is pre-1.0, so additions
should still preserve documented behavior wherever practical and call out
breaking changes explicitly.

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
window; `createViewportGroup()` keeps several mounts on the same X range.
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

## Repository map

```text
src/
  chart/       typed native grammar, scales, scene compiler, SVG/Canvas output
  react/       lifecycle adapter and Recharts-shaped descriptors
  core/        financial widget, API, context, theme, shape state
  data/        financial feed orchestration and TimeIndex
  engine/      financial layout, interactions, renderer, Canvas paint layers
  studies/     built-in calculations, registry, active study state
  ui/          optional financial chrome and popup primitives
  util/        formatting, resolution, delegates, Heikin Ashi
tests/         unit, lifecycle, package contract, and visual regressions
scripts/       packaging helpers and dependency-free quality tooling
docs/          capability, migration, architecture, a11y, and performance guides
```
