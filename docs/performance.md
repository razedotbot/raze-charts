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
| Root financial widget (`@razedotbot/charts`) | Published artifact | `charting_library.esm.js` | 72 KiB |
| | Scenario: Widget only | `import { widget }` | 63 KiB |
| Native chart (`@razedotbot/charts/chart`) | Published artifact | `chart.esm.js` | 44 KiB |
| | Scenario: Line-only mount | `import { defineChart, line, mountChart }` | 33 KiB |
| | Scenario: Static line SVG | `import { defineChart, line, renderChartSvg }` | 23 KiB |
| React adapter (`@razedotbot/charts/react`) | Published artifact | `react.esm.js` | 10 KiB |
| | Scenario: React LineChart | `import { LineChart, Line, XAxis, YAxis, Tooltip }` | 37 KiB |
| | Scenario: Grammar only | `import { defineChart }` | 2 KiB |
| Study kernels (`@razedotbot/charts/studies`) | Published artifact | `studies.esm.js` | 12 KiB |
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
The native artifact allowance grew from 42 to 44 KiB when the compiler and
renderers were split into `src/chart/compile/*` and `src/chart/render/*`: the
unminified artifact keeps every function and property name, so the module
boundaries added about 2.2 KiB with byte-identical output.

The root artifact budget was raised from 55 KiB to the 72 KiB hard cap set by
architecture decision AD-01, and the "Widget only" scenario from 49 KiB to
63 KiB, when wave 1A merged. Measured at that merge, the artifact is 62.7 KiB
and the scenario 54.3 KiB. The growth comes from the bottom-sheet menus, the
scoped stylesheet, the safe HTML sink and `t()` that the widget chrome now
uses (about 5.2 KiB), the context seams and id allocator (about 2.4 KiB), and
the controller and interaction-handler split of the widget (about 2.1 KiB).
72 KiB is a ceiling, not a target: AD-01 requires a later wave to win back at
least 10 KiB of headroom.

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
correction, array replacement, and v1 custom study definitions use full-array
recomputation. A high-rate custom indicator should use `defineIndicator()` with
`init()`/`update()`: each appended or replaced bar then costs exactly one
`update()` call. Studies that read `ctx.visibleRange` recompute at most once per
100 ms while the chart pans.

Undo history stores study specs, not value arrays, and keeps the newest 100
steps by default (`raze.undo_limit`). Adding and removing six studies on 500k
bars used to retain about 118 MB through undo snapshots; it now retains under
2 MB (`tests/study-contract.mjs` measures it after GC).

## Review checklist

- Record source size, visible size, renderer, DPR, browser, and interaction.
- Verify diagnostics before guessing where node/sample growth originates.
- Profile production builds; development React behavior is not representative.
- Test gaps, duplicate timestamps, corrections, request reordering, and
  teardown alongside throughput.
- Keep one reproducible before/after command in a performance pull request.
- Treat a changed budget as an API decision that requires explanation, not as
  the default response to a regression.

## Financial widget browser benchmark

The compiler benchmark above runs in Node and cannot see canvas paint,
rasterisation, browser `Intl` cost, DOM chrome or garbage collection. The
widget benchmark drives the real financial widget in headless Chromium through
Playwright and reports median and p95 for 11 timed scenarios plus retained
heap, each at 1k, 10k, 100k and 500k bars.

Build once, install Chromium once, then run the suite (about 90 seconds):

```bash
node build.mjs
npx playwright install chromium
node scripts/benchmark-widget.mjs
```

| Option | Effect |
| --- | --- |
| `--check` | Exit non-zero when a median exceeds its portable budget, or when a measured scenario has no budget. |
| `--check --strict` | Enforce the aspirational `target` values (where defined) instead of the budgets. |
| `--json` | Machine-readable results on stdout; Playwright progress goes to stderr. |
| `--record` | Write measured medians into the baseline. Existing budgets and targets are kept. |
| `--sizes=1k,100k` | Measure a subset of data sizes. |
| `--no-raster` | Skip the per-frame canvas readback, so only script time is measured. |

`PW_PORT` selects the static server port (default 8798). The suite uses its
own [playwright.perf.config.ts](../playwright.perf.config.ts), so the visual
and accessibility suites (`npx playwright test`) never run it.

### Method

- The page is [examples/benchmark.html](../examples/benchmark.html). It uses a
  1100x620 CSS px viewport at DPR 1, the same surface as the visual goldens.
  Widget chrome is on by default; the countdown and hint popups are disabled.
- The data is a deterministic 1-minute OHLCV random walk. The whole series is
  served on the first request, so no pagination runs while measuring.
- Timed values are main-thread milliseconds. Each one covers the synchronous
  input handler, every `requestAnimationFrame` callback the input causes, and
  a forced 1x1 canvas readback after each frame, which pulls rasterisation
  into the measurement. Inputs are real DOM `PointerEvent`/`WheelEvent`
  dispatches to the element under the pointer, public
  `setVisibleRange` calls, and live `subscribeBars` ticks.
- `load` is wall time from `new widget()` to the end of the first painted data
  frame. It includes the datafeed's asynchronous hand-offs and the first load
  in each page, which runs with a cold JIT.
- `heap` is `Runtime.getHeapUsage` after two forced garbage collections, minus
  the heap before the series was generated. It covers the bar objects, the
  widget's copies and caches. `heap-studies` adds EMA, SMA, RSI, VWAP,
  Bollinger Bands and MACD.
- The page is cross-origin isolated, which gives it 5 µs timers.
  Each scenario runs three warm-up steps, then samples until 40 samples or a
  1.5 s time budget (2.5 s at 500k) is reached, and never takes fewer than 5.

| Scenario | Operation |
| --- | --- |
| `load` | Construct the widget, load the series, paint the first data frame |
| `frame-default` | Repaint after a one-bar viewport change at the default 120-bar zoom |
| `frame-zoomed-out` | Same at 1.5 px per bar (about the widest gesture zoom) |
| `frame-all` | Same with the whole history visible (the ALL range) |
| `crosshair-move` | Mouse move sweeping the crosshair across the default view |
| `crosshair-move-all` | Mouse move sweeping the crosshair with the whole history visible |
| `pan` | One pointer-drag step while panning the default view |
| `wheel-zoom` | Alternating wheel zoom out and in at the default view |
| `frame-studies` | Default-view repaint with the six studies |
| `tick-replace` | Live tick replacing the forming bar, six studies |
| `tick-append` | Live tick appending a new bar, six studies |
| `heap`, `heap-studies` | Retained heap without and with the six studies |

### Reference results

These medians come from Chromium 153 (headless) on Windows x64 with an AMD
Ryzen 9 5900X, captured 2026-09-24 with rasterisation included. Other
workloads were running at the same time, and repeated runs varied by about
30%. Compare trends, not machines. The source of truth is
[widget-baseline.json](../benchmarks/widget-baseline.json).

| Scenario | 1k | 10k | 100k | 500k | Budget (1k / 10k / 100k / 500k) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `load` | 35.30 ms | 36.85 ms | 36.33 ms | 120 ms | 300 / 300 / 300 / 800 ms |
| `frame-default` | 1.98 ms | 2.05 ms | 2.09 ms | 1.88 ms | 15 / 15 / 15 / 15 ms |
| `frame-zoomed-out` | 2.72 ms | 3.04 ms | 3.09 ms | 3.16 ms | 20 / 20 / 20 / 20 ms |
| `frame-all` | 4.89 ms | 29.50 ms | 238 ms | 1387 ms | 30 / 180 / 1500 / 8500 ms |
| `crosshair-move` | 3.15 ms | 3.11 ms | 2.66 ms | 2.71 ms | 20 / 20 / 20 / 20 ms |
| `crosshair-move-all` | 5.32 ms | 28.39 ms | 247 ms | 1359 ms | 40 / 180 / 1500 / 8500 ms |
| `pan` | 3.02 ms | 3.18 ms | 2.72 ms | 2.61 ms | 20 / 20 / 20 / 20 ms |
| `wheel-zoom` | 2.73 ms | 2.93 ms | 2.34 ms | 2.50 ms | 20 / 20 / 20 / 20 ms |
| `frame-studies` | 4.54 ms | 4.64 ms | 4.00 ms | 3.93 ms | 30 / 30 / 30 / 30 ms |
| `tick-replace` | 4.55 ms | 6.56 ms | 23.99 ms | 167 ms | 30 / 40 / 150 / 1100 ms |
| `tick-append` | 4.31 ms | 6.20 ms | 23.36 ms | 180 ms | 30 / 40 / 150 / 1100 ms |
| `heap` | 0.4 MB | 1.4 MB | 10.6 MB | 51.8 MB | 16 / 16 / 30 / 110 MB |
| `heap-studies` | 1.0 MB | 4.2 MB | 35.5 MB | 174.3 MB | 16 / 16 / 80 / 400 MB |

Portable budgets are the larger of 10 ms and 6x the reference median, or of
16 MB and 2x the reference for heap. They are rounded up to coarse steps. They
catch algorithmic regressions on slow shared runners and are not a frame-rate
promise. The baseline also carries aspirational `target` values that
`--check --strict` enforces: a default-zoom frame of at most 2 ms, a
replace-last tick with six studies of at most 2 ms, and at most 15 MB of heap
per 100k bars. These targets show where the widget has to go next; the
default check does not enforce them.

What the numbers show today:

- Work at a fixed zoom does not depend on history length. Default, zoomed-out,
  crosshair, pan and wheel frames cost 2-3 ms from 1k to 500k bars.
- Paint cost grows linearly with the number of visible bars. With the whole
  history in view, every repaint walks all bars: 238 ms at 100k and about
  1.4 s at 500k. Every crosshair move does the same, because the crosshair
  still repaints the entire scene.
- A live tick with six studies is O(n). The incremental paths cover only EMA,
  SMA and RSI, and VWAP, Bollinger Bands and MACD recompute the full series.
  That costs 24 ms at 100k and about 170 ms at 500k, against the 2 ms target.
- Retained heap is about 10.6 MB per 100k bars without studies, inside the
  15 MB target. The six studies raise it to about 35 MB per 100k bars.

Boundaries: the benchmark covers headless Chromium only. GPU compositing, other
browsers, high-DPR displays and a side-by-side comparison with other charting
libraries are out of scope. A comparison against lightweight-charts would need
a third-party dependency, which this repository does not take; publish it
from a separate harness that uses the same page geometry and scenarios. When a
change moves these numbers on purpose, run `--record`. Put the before and
after tables in the pull request. Edit a budget only as an explained API
decision.

Study contract v2 budget (W1B-15). The `/studies` artifact budget rises from
5 KiB to 12 KiB gzip (about 9 KiB used, leaving room for the kernel fixes of
the same wave) because the subpath now carries the typed indicator contract: `defineIndicator()` validation, the incremental runner, input
builders and resolution, and the settings-form model. The "Single kernel" and
"Registry with built-ins" scenarios are unchanged, so consumers that import
only kernels do not pay for it. The root artifact stays inside its 72 KiB cap
and grows by about 3 KiB: input resolution with documented errors, the compute
context, spec-only undo, the change stream and the handle runner protocol.
The v2 execution code itself lives in `/studies` and travels with each
`defineIndicator()` handle, so the root never bundles it.
