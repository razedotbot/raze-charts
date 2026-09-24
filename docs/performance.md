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
| Root financial widget (`@razedotbot/charts`) | Published artifact | `charting_library.esm.js` | 74 KiB |
| | Scenario: Widget only | `import { widget }` | 64 KiB |
| Native chart (`@razedotbot/charts/chart`) | Published artifact | `chart.esm.js` | 67 KiB |
| | Scenario: Line-only mount | `import { defineChart, line, mountChart }` | 49 KiB |
| | Scenario: Static line SVG | `import { defineChart, line, renderChartSvg }` | 33 KiB |
| React adapter (`@razedotbot/charts/react`) | Published artifact | `react.esm.js` | 10 KiB |
| | Scenario: React LineChart | `import { LineChart, Line, XAxis, YAxis, Tooltip }` | 52 KiB |
| | Scenario: Grammar only | `import { defineChart }` | 2 KiB |
| Study kernels (`@razedotbot/charts/studies`) | Published artifact | `studies.esm.js` | 12 KiB |
| | Scenario: Single kernel | `import { ema }` | 1 KiB |
| | Scenario: Registry with built-ins | `import { StudyRegistry }` | 7 KiB |

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

The native renderer and mount correctness package (W1B-03) raised the native
artifact from 44 to 53 KiB, "Line-only mount" from 33 to 39 KiB, "Static line
SVG" from 23 to 24 KiB, and "React LineChart" from 37 to 42 KiB. Measured on
its branch, the consumer mount scenario grew by about 5.7 KiB gzip (14.5 KiB
minified): zoom limits, option validation, and the data-spacing default
(about 2.3 KiB minified), structured pointer targets shared by hover, chips,
and `onTooltip`/`onSelect` (about 2.1 KiB), the shared legend layout with
hit-testing, hidden rows, scene v2 wrapping, and keyboard toggle buttons
(about 2.6 KiB), rAF-coalesced wheel and resize with the cached full-data
scene (about 3 KiB across mount and gestures), the stage frame and edge tick
placement (about 1.1 KiB), and `t()` for the new accessible labels (about
0.9 KiB). The static SVG path only pays for the legend layout, bounded chip
stacking, and edge-anchored ticks.

The native artifact allowance grew from 44 to 44.5 KiB, and the "Line-only
mount" scenario from 33 to 33.5 KiB, for the bounded tick generator:
exact-decimal steps chosen against the tick budget, decade-aware log ticks
with a sub-decade linear fallback, and nice-domain iteration add about
0.8 KiB to `src/chart/scales.ts`, which every Cartesian chart imports.
Together with the colour-blind theme presets the artifact grows about 1.2 KiB.

Wave 1B package W1B-02 (native marks and legend) raised the native artifact
from 44 to 50 KiB, its "Line-only mount" and "Static line SVG" scenarios from
33 to 38 KiB and from 23 to 27 KiB, and the React "React LineChart" scenario
from 37 to 41 KiB. Measured on that branch, the artifact grew from 42.96 to
49.19 KiB (unminified, so every name counts). The growth is the measured legend
layout (wrapping rows, the compacting side column, `+N more`, text metrics and
ellipsis) and its shared SVG/Canvas painter (about 2.9 KiB), stable series ids
with disambiguated names and reversible hidden rows (about 1 KiB), structured
hover samples, rule-label options, zero-bar hit proxies and the curve-following
ranged-area fill (about 1.5 KiB), and the validation of the new mark options
(about 0.8 KiB). Its review fixes then raised the artifact budget from 50 to
51 KiB. With legend toggles that can show series hidden through
`hiddenSeries` (the keys that hide each row), numbered rows for reused
explicit names, a second legend-planning pass for plugin rows, legend rows for
hidden plugins and value chips formatted from the datum, the artifact measured
50.15 KiB. That is about 0.4 KiB of new code, less 0.2 KiB saved by dropping
the renderer's duplicate monotone-tangent code in favour of the compiler's
copy. The scenario budgets did not change.

The root artifact budget was raised from 55 KiB to the 72 KiB hard cap set by
architecture decision AD-01, and the "Widget only" scenario from 49 KiB to
63 KiB, when wave 1A merged. Measured at that merge, the artifact is 62.7 KiB
and the scenario 54.3 KiB. The growth comes from the bottom-sheet menus, the
scoped stylesheet, the safe HTML sink and `t()` that the widget chrome now
uses (about 5.2 KiB), the context seams and id allocator (about 2.4 KiB), and
the controller and interaction-handler split of the widget (about 2.1 KiB).
72 KiB is a ceiling, not a target: AD-01 requires a later wave to win back at
least 10 KiB of headroom.

The native artifact budget was raised from 44 KiB to 50 KiB, its "Line-only
mount" scenario from 33 KiB to 38 KiB, "Static line SVG" from 23 KiB to
27 KiB, and the React "React LineChart" scenario (which ships the same
runtime) from 37 KiB to 41 KiB, when the native compiler gained measured axes
(W1B-01). 50 KiB is that package's hard cap. Measured then, the artifact is
49.6 KiB and the scenarios 37.3, 26.5 and 40.5 KiB. The compact UTC calendar
ladder costs about 0.9 KiB; step-derived tick precision, compact notation,
en-US digit grouping, label measurement, margin fitting, x-label
thinning/rotation/ellipsis, heatmap value formats and the scene v2 formatters
and measured axes account for the rest. Number formatting no longer imports
the shared Intl cache (see "Native value formatting" below). The artifact is
unminified, so consumer bundles are smaller than it.

Wave 1B integration (W1B-04, W1B-01, W1B-02 and W1B-03 merged) set the native
artifact budget to 67 KiB, "Line-only mount" to 49 KiB, "Static line SVG" to
33 KiB and the React "React LineChart" scenario to 52 KiB. Each package raised
the budget from the same 44 KiB starting point against its own branch, so the
merged runtime carries all four increments: measured on the merged tree the
artifact is 65.9 KiB (42.96 KiB before the wave) and the scenarios 48.3, 32.5
and 51.4 KiB. The budgets keep about 0.5 to 1.1 KiB of headroom. This is a
recorded integration decision, not a target: the per-package caps (50 KiB for
W1B-01) were set per branch, and native-bundle-modular-marks and
perf-native-per-mark-treeshaking (W2-13) are expected to win the mark-specific
code back out of the single-mark scenarios.

The native time axis does not use the shared `calendarTicks()` selector yet.
Importing it costs about 7.5 KiB of the artifact (its zone arithmetic and
eagerly built rung tables), more than the 6.8 KiB the cap left for the whole
package, and its tables also reached the "Grammar only" scenario (1.9 KiB of
its 2 KiB; 1 KiB without them). `src/chart/compile/axes.ts` keeps a compact
UTC ladder with the same label scheme instead, marked with a TODO for W1B-05:
once the core builds its tables lazily and lets UTC-only callers skip the
IANA zone machinery, `/chart` can switch back.

W1B-05 raised the root artifact budget to 74 KiB and the "Widget only"
scenario to 64 KiB, 2 KiB and 1 KiB past the AD-01 cap. This needs an
orchestrator decision before it merges: an AD-01 override that W2-12's
feature packs then win back, or cuts the orchestrator directs. Measured on
this branch, the artifact is 73.8 KiB and the scenario 63.3 KiB, 11.1 KiB and
8.9 KiB more than at the wave 1A merge. About 8.5 KiB of that is the shared
time core the widget now draws its time axis, crosshair and session breaks
through (`FinancialTimeAxis`, the zone math, weighted tick selection and the
Intl cache, per AD-06). The rest is the widget side: display-zone resolution
with `custom_timezones` and warn-once fallbacks, the synced and volume-pane
crosshair, per-session breaks, the chart timezone API (0.6 KiB, of which
`getTimezoneApi()` is 0.35 KiB and `availableTimezones()` 0.08 KiB) and
the custom time formatters (0.13 KiB). The legacy UTC tick code in
`plotScale.ts` is already tree-shaken out of the artifact, so deleting it
saves nothing here. Moving the timezone API and the formatters out of the root
would therefore still leave the artifact above 72 KiB.

The study kernels artifact budget grew from 5 to 10 KiB and the "Registry with
built-ins" scenario from 3 to 7 KiB in wave 1B (W1B-14). Session-anchored VWAP
needs the shared DST-aware time core (`src/util/time/zone.ts` plus the Intl
cache, about 2.3 KiB gzip) instead of UTC-day arithmetic; the kernels gained
gap handling, source selection, offsets and O(n) rolling moments that stay
exact through bad prints and price-level changes (about 1.5 KiB); and the
registry now carries each built-in's input declarations, input validation
with guidance, exact name resolution and the pane value formatter (about
2.1 KiB). Keyword search is the separate `searchStudies()` export, so the
widget does not ship it. The catalogue is declared in one pure expression and
the time core's module state is annotated pure, so the "Single kernel"
scenario still ships well under its 1 KiB budget. In the root widget artifact
the same work adds about 6.2 KiB gzip (62.7 to 68.9 KiB, inside the existing
72 KiB budget): 2.6 KiB is the time core, which other wave 1B packages also
pull in, and about 3.5 KiB is the kernels and registry.

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

## Native value formatting

The native compiler formats a tooltip string for every hover sample, so number
formatting sits on its hottest path. `src/chart/compile/format.ts` prints
en-US numbers (the library default, `DEFAULT_LOCALE` in `src/util/intl.ts`)
without Intl: integers go through `String()`, other values are rounded to
their decimals with integer arithmetic (falling back to `toFixed()` near a
rounding tie, so the digits always match it), and thousands are grouped by
hand. `tests/native-compile-axes.mjs` checks the result against both
`toFixed()` and the en-US `Intl.NumberFormat`.

Measured on the benchmark's 10k-point line (headless Chromium 153, Windows
x64, AMD Ryzen 9 5900X, median of 21 compiles at 1280x720):

| Data | raze-100x before W1B-01 | W1B-01 |
| --- | ---: | ---: |
| y around 100 | 20 ms | 1.8-2.5 ms |
| y from 1,000 up | 46-78 ms | 3.4-3.7 ms |

A CDP CPU profile of 20 such compiles puts all formatting (`formatX`,
`formatNum`, `formatFixed`, grouping and the one-time data-precision scan) at
21-26% of the compile, down from 88% for `toLocaleString` before. What remains
is the count, not the cost, of calls: two formatted numbers for each of the
10k hover samples, built eagerly by the mark compilers. The audit target
(formatting under 10% of the profile) needs those tooltip strings built
lazily, on hover, from the structured samples; that change belongs to the
mark compilers (`src/chart/compile/cartesian.ts`, W1B-02) and the renderer
(W1B-03), and the target stays open until it lands.

Band axes measure every category label once per compile and thin them with a
search that starts at the smallest interval that could fit, so thousands of
categories stay near-linear: 5,000 bar categories compile in about 6 ms and
20,000 in about 26 ms in Node (raze-100x: 4 and 17 ms; before this fix 16 and
159 ms).

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
| `overlay-frame`, `overlay-frame-all` | Animation-frame JS of those crosshair moves alone; any main-layer paint fails the run |
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
| `crosshair-move-all` | 5.32 ms | 28.39 ms | 247 ms | 1359 ms | 20 / 20 / 20 / 20 ms (see the layered canvas section) |
| `pan` | 3.02 ms | 3.18 ms | 2.72 ms | 2.61 ms | 20 / 20 / 20 / 20 ms |
| `wheel-zoom` | 2.73 ms | 2.93 ms | 2.34 ms | 2.50 ms | 20 / 20 / 20 / 20 ms |
| `frame-studies` | 4.54 ms | 4.64 ms | 4.00 ms | 3.93 ms | 30 / 30 / 30 / 30 ms |
| `tick-replace` | 4.55 ms | 6.56 ms | 23.99 ms | 167 ms | 30 / 40 / 150 / 1100 ms |
| `tick-append` | 4.31 ms | 6.20 ms | 23.36 ms | 180 ms | 30 / 40 / 150 / 1100 ms |
| `heap` | 0.4 MB | 1.4 MB | 10.6 MB | 51.8 MB | 2 / 3 / 30 / 110 MB |
| `heap-studies` | 1.0 MB | 4.2 MB | 35.5 MB | 174.3 MB | 3 / 9 / 80 / 400 MB |

Portable budgets are the larger of 10 ms and 6x the reference median, or of
2 MB and 2x the reference for heap. They are rounded up to coarse steps. They
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
  1.4 s at 500k. Crosshair moves no longer do: since the layered canvas they
  repaint only the overlay (see below).
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

### Layered canvas (W1B-07)

Each chart paints a main scene canvas and an interactive overlay canvas above
it. Crosshair, legend values, hover, draft and countdown repaint only the
overlay, so a crosshair move no longer walks the visible bars. The benchmark
proves it: the crosshair scenarios spy on both layers and fail the run when a
move paints the main layer or paints the overlay more than once per frame.
Same machine as the reference above, raster included, medians (the "after"
rows include the cached number formatters described below):

| Scenario | 1k | 10k | 100k | 500k |
| --- | ---: | ---: | ---: | ---: |
| `crosshair-move` before | 2.25 ms | 2.56 ms | 2.21 ms | 2.01 ms |
| `crosshair-move` after | 0.87 ms | 0.82 ms | 0.86 ms | 0.94 ms |
| `crosshair-move-all` before | 4.54 ms | 29.26 ms | 277 ms | 1372 ms |
| `crosshair-move-all` after | 0.88 ms | 0.55 ms | 0.77 ms | 0.89 ms |
| `overlay-frame` (frame JS only) | 0.30 ms | 0.27 ms | 0.29 ms | 0.33 ms |
| `overlay-frame-all` (frame JS only) | 0.31 ms | 0.21 ms | 0.28 ms | 0.31 ms |

The overlay frame no longer depends on the visible span or the history
length, and stays under its 0.5 ms `target` at every size. Half of it used
to be `formatPrice` building a new `Intl.NumberFormat` (through
`toLocaleString`) for every legend and crosshair value, about 20 µs each;
`formatPrice` now reuses cached instances with byte-identical output, which
took the overlay frame from 0.45-0.61 ms to 0.21-0.33 ms. What remains is
mostly text drawing. The absolute 0.5 ms stays a `--strict` target because
runners differ, but every run now checks, per size, that `overlay-frame-all`
stays within 2x `overlay-frame` + 0.25 ms (span independence) and that
`overlay-frame` stays within 2x its value at the smallest size + 0.25 ms
(history independence). Budget changes, recorded in
`widget-baseline.json`: `crosshair-move-all` drops to 20 ms at every size,
because a move that scales with the visible span again is a regression; the
new `overlay-frame` scenarios carry a 4 ms portable budget and a 0.5 ms
target; and the heap floor drops from 16 MB to 2 MB with 1 MB rounding for
small heaps, because the old floor let the 1k and 10k sizes grow tenfold
unnoticed. The harness also fails when a study cannot be created, when the
library logs a `[raze-charts]` warning, when any sample paints no frame, and
when a raster readback fails.

An opaque pane background gives the scene layer an `{ alpha: false }`
context, so the compositor never blends it with the page. Trade-off: Chromium
draws text on an opaque canvas with LCD subpixel anti-aliasing, and no context
option or launch flag turns that off, so scene text (axis labels) is subpixel
while overlay text (crosshair pills, legend) stays greyscale. Screenshots
repaint both layers into an alpha canvas (`ChartRenderer.snapshot()`), so
exported PNGs carry greyscale text rather than colour fringes.

Study contract v2 budget (W1B-15). The `/studies` artifact budget rises from
5 KiB to 12 KiB gzip (about 9 KiB used, leaving room for the kernel fixes of
the same wave) because the subpath now carries the typed indicator contract: `defineIndicator()` validation, the incremental runner, input
builders and resolution, and the settings-form model. The "Single kernel" and
"Registry with built-ins" scenarios are unchanged, so consumers that import
only kernels do not pay for it. The root artifact stays inside its 72 KiB cap
and grows by about 4 KiB: input resolution with documented errors, the compute
context, spec-only undo, the change stream and the handle runner protocol.
The v2 execution code itself lives in `/studies` and travels with each
`defineIndicator()` handle, so the root never bundles it.
