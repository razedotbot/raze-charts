# Performance and data correctness

Performance is a product contract only when the scenario, data size, renderer,
machine, and budget are explicit. Raze ships a dependency-free compiler
benchmark and keeps correctness constraints next to optimization guidance.

## Reproduce the native compiler benchmark

Build once, then run all four deterministic data sizes:

```bash
npm run build
node scripts/benchmark.mjs
```

Machine-readable output and the CI guard are available separately:

```bash
node scripts/benchmark.mjs --json
node scripts/benchmark.mjs --check
```

The scenario is one interactive numeric line with default pixel-aware
decimation at a 1280x720 compile size. Grid, legend, data generation, DOM
mounting, SVG serialization, Canvas painting, pointer queries, and browser
compositing are excluded; hover-sample compilation is included. It measures
renderer-neutral scene compilation, not frame rate.

The checked-in reference currently records:

| Source points | Reference median | Portable CI budget |
| ---: | ---: | ---: |
| 1,000 | 0.84 ms | 20 ms |
| 10,000 | 3.61 ms | 75 ms |
| 100,000 | 24.75 ms | 500 ms |
| 1,000,000 | 330.27 ms | 5,000 ms |

Reference: Node 24.20.0 on Windows x64, AMD Ryzen 9 5900X. The source of truth
is [dashboard-baseline.json](../benchmarks/dashboard-baseline.json). The wide
portable budget catches algorithmic regressions and pathological allocation on
shared runners; it is not a browser SLA and should not be used to compare
machines.

## Bundle budgets

The bundle gate measures every public entrypoint twice, with gzip level 9 and
without source maps:

- **Artifact** — the published `dist/<entry>.esm.js` file as shipped. It guards
  accidental growth of the distributable. `/chart`, `/react`, and `/studies` are
  deliberately unminified so their PURE annotations survive for downstream tree
  shaking, so this number over-states what a consumer ships.
- **Scenario** — what a consumer ships: a browser bundle of a realistic named
  import from the packed package, resolved through `exports`, tree-shaken and
  minified by esbuild. React stays external as an optional peer; `/react`
  scenarios include the shared `/chart` runtime they pull in.

```bash
npm run build
npm run check:size
```

<!-- bundle-budgets:start -->
<!-- Generated from benchmarks/budgets/*.json by `node scripts/check-bundle-size.mjs --write-docs`. Do not edit by hand. -->

| Entrypoint | Measurement | Contents | Gzip budget |
| --- | --- | --- | ---: |
| Root financial widget (`@razedotbot/charts`) | Published artifact | `charting_library.esm.js` | 55 KiB |
| | Scenario: Widget only | `import { widget }` | 49 KiB |
| Native chart (`@razedotbot/charts/chart`) | Published artifact | `chart.esm.js` | 42 KiB |
| | Scenario: Line-only mount | `import { defineChart, line, mountChart }` | 33 KiB |
| | Scenario: Static line SVG | `import { defineChart, line, renderChartSvg }` | 23 KiB |
| React adapter (`@razedotbot/charts/react`) | Published artifact | `react.esm.js` | 10 KiB |
| | Scenario: React LineChart | `import { LineChart, Line, XAxis, YAxis, Tooltip }` | 37 KiB |
| | Scenario: Grammar only | `import { defineChart }` | 2 KiB |
| Study kernels (`@razedotbot/charts/studies`) | Published artifact | `studies.esm.js` | 5 KiB |
| | Scenario: Single kernel | `import { ema }` | 1 KiB |
| | Scenario: Registry with built-ins | `import { StudyRegistry }` | 3 KiB |

<!-- bundle-budgets:end -->

Each entrypoint has one budget file, `benchmarks/budgets/<entry>.json`, keyed
by the entry ids in `scripts/entries.mjs`. The gate fails when an entrypoint
has no budget file, when a budget file names no entrypoint, or when a scenario
imports a name the entrypoint does not export. The table above is generated
from those files and `npm run check:docs` fails when it drifts; regenerate it
with `node scripts/check-bundle-size.mjs --write-docs`. Use `--json` for
machine-readable measurements, including the largest inputs of each scenario.

The native allowance includes the complete runtime validation boundary,
renderer-neutral compiler, SVG and Canvas renderers, interactions, and color
system; it does not hide those costs in runtime dependencies.

## Dense native charts

Line and area marks use automatic extrema-envelope decimation. Unless
configured otherwise, each series renders at most two points per horizontal
plot pixel. Each bucket retains its minimum and maximum in source order, so a
narrow spike is not erased by simple stride sampling.

The budget is a hard cap across all valid segments of a series, not once per
gap; any finite value greater than or equal to `1` is honored after flooring.
For disconnected input, allocation prioritizes the true tail and global
extrema, then distributes the remaining budget across the timeline. If an
extremely small cap cannot represent every priority, the tail wins. The
compiler never reconnects retained segments across invalid data; raise the
budget or disable decimation when every tiny segment matters.

```ts
const chart = defineChart({
  marks: [line(points, { x: "time", y: "value" })],
  performance: {
    maxRenderedPoints: 2_000,
  },
});

const compiled = compileChart(chart, { width: 1_000, height: 400 });
console.log(compiled.diagnostics);
// { sourceRows, renderedNodes, hoverSamples, decimatedPoints }
```

Use `performance.decimation: "none"` only when every valid source point must
appear in output geometry, such as an offline geometry test. Exact geometry can
create very large SVG strings and hover indexes.

Important boundaries:

- Decimation bounds output geometry; domain inference and envelope construction
  still scan every source row. Compilation is O(n).
- Bar, point, heatmap, pie, radar, and custom plugin nodes are not automatically
  decimated. Aggregate or window those datasets before defining a chart.
- A custom mark plugin owns its output budget. It runs during every compilation
  and should avoid DOM access and side effects.
- `MountHandle.update()` preserves the mount and listeners but recompiles and
  repaints. Compile failures roll back to the last valid definition and scene;
  there is no retained scene diff.

Choose SVG for modest scenes, server-generated static output, and easy DOM
inspection. Choose Canvas for denser frequently repainted scenes. Always
measure the final browser interaction because string generation, rasterization,
fonts, device pixel ratio, and surrounding layout are outside the compiler
benchmark.

## React update flow

The React `<Chart>` component mounts the framework-neutral runtime once. New
definition references and options call `MountHandle.update()` instead of
destroying and recreating the mount.

Keep large input arrays and definitions referentially stable when nothing
changed. In Recharts-shaped JSX, `useMemo` can prevent avoidable definition
work in the host, but data changes still require a full native compile:

```tsx
const definition = useMemo(
  () => defineChart({ marks: [line(points, { x: "time", y: "value" })] }),
  [points],
);

return <Chart definition={definition} renderer="canvas" />;
```

## Financial data correctness

### Latest target owns async results

`DataManager` assigns a generation to symbol/resolution work. History, marks,
pagination, and live callbacks verify that generation before mutating chart
state. Changing target unsubscribes the previous live stream immediately;
destroy invalidates pending work. This prevents late responses from mixing
symbols or intervals even when the upstream callback API cannot be cancelled.

The Promise-first `createDatafeed` adapter gives native realtime setup an
`AbortSignal`. A returned cleanup function is invoked on unsubscribe, including
when an asynchronous setup resolves after it was already cancelled.

### Actual timestamps own the time axis

`TimeIndex` performs binary search over sorted real bar timestamps. Adjacent
bars remain adjacent logical indices across a weekend, a closed session, or a
data gap. Fractional values interpolate between the two actual neighbors, and
the inverse mapping uses the same segment. Only whitespace beyond the loaded
edges uses the expected resolution.

This mapping is shared by drawings, marks, and pointer conversions. Do not
reintroduce `(time - firstTime) / resolution` in product extensions: it creates
phantom logical bars anywhere wall-clock intervals are missing.

### Incremental studies

Built-in EMA, SMA, and RSI recognize two hot-path mutations:

- append one new bar;
- replace the current forming bar.

Only the newest indicator value is updated in those cases. Backfill, historical
correction, array replacement, and custom study definitions use full-array
recomputation. If a high-rate custom indicator is expensive, coalesce forming
bar updates in the feed or precompute it upstream; its public contract is not
incremental today.

## Review checklist

- Record source size, visible size, renderer, DPR, browser, and interaction.
- Verify diagnostics before guessing where node/sample growth originates.
- Profile production builds; development React behavior is not representative.
- Test gaps, duplicate timestamps, corrections, request reordering, and
  teardown alongside throughput.
- Keep one reproducible before/after command in a performance pull request.
- Treat a changed budget as an API decision that requires explanation, not as
  the default response to a regression.
