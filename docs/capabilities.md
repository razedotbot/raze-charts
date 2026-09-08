# Capability matrix

This page is the support contract for the current pre-1.0 release. It
distinguishes implemented behavior from compatibility-shaped names and future
work.

Legend:

- **Yes** — implemented and covered by an automated or visual test.
- **Subset** — implemented with the constraint shown in the notes.
- **No** — not implemented; do not design an integration around it.

## Public entrypoints

| Capability | Financial widget (`@razedotbot/charts`) | Native charts (`/chart`) | React (`/react`) |
| --- | --- | --- | --- |
| Primary renderer | Canvas 2D | SVG or Canvas 2D | SVG or Canvas 2D through `/chart` |
| Typed TypeScript API | Subset — compatibility types are intentionally permissive in places | Yes — datum keys are inferred by mark builders | Yes — strongest with `createChartComponents<T>({ xKey, valueKey, heatmapYKey? })` |
| No runtime dependencies | Yes | Yes | Subset — React is an optional peer |
| DOM-free compilation | No — widget owns DOM | Yes — `defineChart` + `compileChart` | No — components need React; rendering mounts after commit |
| Static SVG string | No | Yes — `renderChartSvg` / `svgFromCompiled` | Use `/chart` directly |
| In-place lifecycle update | Symbol, resolution, bars, marks, drawings and studies | Yes — `MountHandle.update()` preserves the host | Yes — `<Chart>` mounts once and forwards updates |
| Dark/light visual system | Yes | Yes | Yes |
| Partial custom theme | TradingView-style overrides and CSS variables | Yes — `Partial<DashboardTheme>` | Yes — through a native definition |
| Custom price formatter | Yes | No dedicated formatter hook | No dedicated formatter hook |

## Financial domain

| Capability | Status | Notes |
| --- | --- | --- |
| Candlestick, line, area, Heikin Ashi | **Yes** | Selected through the financial chart UI/options. |
| Volume | **Yes** | Painted with the financial price series. |
| Initial history and lazy left pagination | **Yes** | Uses the TradingView-shaped `getBars` contract. |
| Promise-first native data source | **Yes** | `defineDataSource` + `createDatafeed` adapt promises and optional realtime cleanup to the callback protocol. |
| Live bars | **Yes** | `subscribeBars` / `unsubscribeBars`; append and forming-bar replacement are supported. |
| Abortable native realtime setup | **Yes** | The native adapter supplies `AbortSignal` and runs cleanup even when async setup finishes after unsubscribe. |
| Symbol and resolution races | **Yes** | Latest request wins; stale history, marks, and subscription callbacks are ignored. |
| Async marks | **Yes** | Callback-based asynchronous `getMarks` results are applied only to the active target. |
| Gapped market sessions | **Yes** | `TimeIndex` maps actual timestamps onto adjacent logical bar indices. |
| EMA, SMA, RSI | **Yes** | Appended/replaced last bars use incremental built-in updates. |
| Custom studies | **Yes** | Overlay or pane; public contract recomputes the full array after a data mutation. |
| Multiple study panes | **Subset** | Pane studies are supported; arbitrary user-defined pane layouts are not. |
| Drawing tools | **Subset** | Horizontal line, trend line, Fibonacci retracement, rectangle, and text. |
| Shape editing | **Yes** | Create, drag, read/update points, remove, and remove all shapes. |
| Marks on bars | **Yes** | Hover tooltip and refresh/clear APIs. |
| Compare / multiple symbols | **No** | One primary symbol per widget. |
| Save/load complete layouts | **No** | The host can persist its own inputs; there is no layout serializer. |
| Undo/redo command history | **No** | The current financial state is mutable and imperative. |
| Full TradingView study/drawing catalog | **No** | Compatibility is a documented subset, not feature parity. |
| WebGL, LOD, or worker renderer | **No** | Canvas 2D is the current financial renderer. |

## Native dashboard charts

| Capability | Status | Notes |
| --- | --- | --- |
| Line, area, bar, point/scatter | **Yes** | Cartesian marks infer scales when omitted. An explicit X scale object requires `type`. |
| Stacked and grouped bars | **Yes** | `stackId` opts into stacking; positive and negative totals diverge around zero and equivalent quantitative X values share a group. |
| Pie/donut | **Yes** | Renderer-neutral polar scene nodes; a pie chart is a standalone composition. |
| Radar | **Yes** | Multiple layers may overlay when their category axes match; Cartesian scales and non-radar marks are rejected. |
| Heatmap | **Yes** | Standalone composition with configured band-domain layout, a diverging color scale, square cells, and labels where space permits. |
| Reference rules | **Yes** | `ruleY` / React `ReferenceLine`. |
| Tooltip and crosshair | **Yes** | Pointer interaction in `mountChart`; native default is enabled unless set to `false`. |
| Legend | **Yes** | Built from series metadata; may be disabled. |
| Responsive mount | **Yes** | `ResizeObserver` when an explicit width is not supplied. |
| Custom mark plugin | **Yes** | Typed domain contribution and scene compilation through `defineMarkPlugin`; contexts are isolated and returned domains/scene geometry are validated. |
| Runtime definition validation | **Yes** | `ChartCompileError` carries stable codes for malformed specs, composition, scales, sizes, mark-specific options, channels, and plugins. |
| Missing numeric samples | **Yes** | Invalid line/area values create separate paths instead of bridging a gap; dense-mode budget applies across retained segments. |
| Renderer-neutral scene inspection | **Yes** | `compileChart` and `MountHandle.getScene()`. |
| Multiple coordinated panes | **No** | Compose separate chart instances in the host application. |
| Animation/transitions | **No** | Updates repaint immediately. |
| Viewport brush or controlled zoom | **No** | Not part of the native grammar yet. |
| Automatic dense line/area decimation | **Yes** | Pixel-aware extrema envelope; defaults to two rendered points per plot pixel. Input scanning remains O(n). |
| Decimation diagnostics and opt-out | **Yes** | `CompiledChart.diagnostics`; tune `maxRenderedPoints` or set `decimation: "none"`. |
| Retained scene diffing | **No** | `update()` preserves the mount, then recompiles and repaints the scene. |

## React adapter

| JSX surface | Status | Semantics |
| --- | --- | --- |
| `<Chart definition={...}>` | **Yes** | Thin lifecycle adapter over `mountChart`; `onReady` exposes detached, deeply read-only scene snapshots. |
| `LineChart`, `BarChart`, `AreaChart`, `ScatterChart` | **Yes** | Translate child descriptors to native marks. |
| `PieChart`, `RadarChart`, `HeatmapChart`, `ComposedChart` | **Yes** | Translate to the corresponding native marks. |
| `Line`, `Bar`, `Area`, `Scatter`, `Pie`, `Radar`, `Heatmap` | **Subset** | Each component has an exact documented prop surface; unsupported props fail type checking and dynamic input fails at runtime. |
| `XAxis`, `YAxis` | **Subset** | Select a `dataKey`; custom ticks/domains/formatters are not mapped. |
| `CartesianGrid` | **Yes** | Boolean configuration descriptor. |
| `Tooltip` | **Subset** | Enables the native tooltip; custom content/render props are not implemented. |
| `Legend` | **Subset** | Enables the native legend; custom layout/content props are not implemented. |
| `ReferenceLine` | **Subset** | Horizontal numeric `y`, optional `stroke`, `strokeWidth`, and `name`. |
| `ResponsiveContainer` | **Subset** | Measures its box with `ResizeObserver` and injects numeric width/height into exactly one chart child; it is not the complete Recharts sizing API. |
| `Brush` | **No** | Reserved export; using it throws a descriptive runtime error. |
| Recharts event/custom-shape ecosystem | **No** | Use the native grammar or a custom mark plugin instead. |

## Accessibility support boundary

SVG and Canvas dashboard output expose an image name; `ariaDescription` adds a
longer description. Canvas output also receives a hidden summary derived from
series metadata and a bounded set of values. Financial chrome uses native
buttons and menu/toolbar semantics, and the plot supports documented keyboard
shortcuts.

This is an implementation baseline, not a blanket conformance claim. Exact
value exploration, custom-theme contrast, product copy, focus placement, and
an alternative data table remain integration responsibilities. See the
[accessibility guide](./accessibility.md).

## How compatibility changes

Before adding a compatibility-shaped export, it must do one of two things:

1. implement a documented behavior and gain a regression test; or
2. fail clearly with migration guidance.

Silent no-op props and components are treated as defects. Update this matrix
in the same pull request whenever support changes.
