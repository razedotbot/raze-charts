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
| In-place lifecycle update | Symbol, resolution, bars, marks, drawings, trading overlays and studies | Yes — `MountHandle.update()` preserves the host | Yes — `<Chart>` mounts once and forwards updates |
| Dark/light visual system | Yes | Yes | Yes |
| Partial custom theme | TradingView-style overrides and CSS variables | Yes — `Partial<DashboardTheme>` | Yes — through a native definition |
| Custom price formatter | Yes | No dedicated formatter hook | No dedicated formatter hook |

## Financial domain

| Capability | Status | Notes |
| --- | --- | --- |
| Candlestick, line, area, Heikin Ashi, bars, hollow candles, baseline, columns | **Yes** | Selected through the financial chart UI/options. |
| Volume | **Yes** | Overlay (default), dedicated pane, or hidden via `raze.volume_mode`. |
| Initial history and lazy left pagination | **Yes** | Uses the TradingView-shaped `getBars` contract. |
| Promise-first native data source | **Yes** | `defineDataSource` + `createDatafeed` adapt promises and optional realtime cleanup to the callback protocol. |
| Live bars | **Yes** | `subscribeBars` / `unsubscribeBars`; append and forming-bar replacement are supported. |
| Abortable native realtime setup | **Yes** | The native adapter supplies `AbortSignal` and runs cleanup even when async setup finishes after unsubscribe. |
| Symbol and resolution races | **Yes** | Latest request wins; stale history, marks, and subscription callbacks are ignored. |
| Async marks | **Yes** | Callback-based asynchronous `getMarks` results are applied only to the active target. |
| Timescale marks | **Yes** | `getTimescaleMarks` is requested with history and painted on the time axis. |
| Gapped market sessions | **Yes** | `TimeIndex` maps actual timestamps onto adjacent logical bar indices; `session_breaks` draws optional gap lines. |
| Timeframe / go-to-date | **Yes** | Honours `options.timeframe`; header presets and go-to-date call `setVisibleRange`, which pages history when needed. |
| Symbol search | **Yes** | Header search calls `searchSymbols`. |
| Timezone and bar countdown | **Yes** | `timezone_display` and `countdown` features (on by default). |
| EMA, SMA, RSI, VWAP, Bollinger, MACD | **Yes** | Multi-series `compute` results paint lines, bands, and histograms. Incremental built-ins remain EMA/SMA/RSI. |
| Custom studies | **Yes** | Overlay or pane; public contract recomputes the full array after a data mutation. `forceOverlay` and `lock` are stored on the instance. |
| Multiple study panes | **Subset** | Pane studies are supported; arbitrary user-defined pane layouts are not. |
| Drawing tools | **Yes** | Horizontal/vertical line, trend, ray, extended line, measure (ephemeral), Fibonacci, rectangle, and text. |
| Magnet / stay-in-mode / objects tree | **Yes** | OHLC magnet, stay-in-drawing-mode, and an objects tree over shapes and studies. |
| Shape editing | **Yes** | Create, drag, read/update points, remove, and remove all shapes. |
| Order and position lines | **Yes** | TradingView-style fluent adapters, styling, quantity/P&L labels, move/modify/cancel callbacks, mouse/touch drag, and one-tick keyboard adjustment. |
| Stop-loss / take-profit brackets | **Yes** | Linked entry/SL/TP lines, risk/reward shading and ratio, auto-scale participation, group callbacks and cancellation. |
| Marks on bars | **Yes** | Hover tooltip and refresh/clear APIs. |
| Compare / multiple symbols | **Yes** | `createCompare(symbol)` overlays extra series; `raze.layout` `"2x1"` / `"2x2"` syncs range and crosshair. |
| Save/load chart layouts | **Yes** | Versioned JSON with stable drawing/study IDs via `save()` / `load()`; `disableSave` excludes a drawing and live broker/trading state is intentionally rehydrated separately. |
| Undo/redo command history | **Yes** | Drawings and studies; `disableUndo` skips a create. |
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
| Reference rules | **Yes** | `ruleY` / `ruleX`; React `ReferenceLine` accepts exactly one of `y` or `x`. |
| Tooltip and crosshair | **Yes** | Pointer interaction in `mountChart`; native default is enabled unless set to `false`. Structured tooltip payloads are exposed through `onTooltip`. |
| Legend | **Yes** | Built from series metadata; click hides a series on a mount. |
| Responsive mount | **Yes** | `ResizeObserver` when an explicit width is not supplied. |
| Custom mark plugin | **Yes** | Typed domain contribution and scene compilation through `defineMarkPlugin`; contexts are isolated and returned domains/scene geometry are validated. |
| Runtime definition validation | **Yes** | `ChartCompileError` carries stable codes for malformed specs, composition, scales, sizes, mark-specific options, channels, and plugins. |
| Missing numeric samples | **Yes** | Invalid line/area values create separate paths instead of bridging a gap; dense-mode budget applies across retained segments. |
| Renderer-neutral scene inspection | **Yes** | `compileChart` and `MountHandle.getScene()`. |
| Multiple coordinated panes | **Subset** | `createViewportGroup()` syncs X windows across mounts; the compiler does not layout multi-plot chrome. |
| Animation/transitions | **No** | Updates repaint immediately. |
| Viewport brush or controlled zoom | **Yes** | `ChartSpec.viewport` windows rows before map/decimate; `mountChart` brush/zoom/pan; optional range presets and navigator. |
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
| `XAxis`, `YAxis` | **Subset** | Select a `dataKey`; custom ticks/domains/formatters are not mapped. Native `scales.*.tickFormat` remains available on `ChartSpec`. |
| `CartesianGrid` | **Yes** | Boolean configuration descriptor. |
| `Tooltip` | **Subset** | Enables the native tooltip; custom content/render props are not implemented. |
| `Legend` | **Subset** | Enables the native legend; click-to-hide is mount state, not a Recharts render prop. |
| `ReferenceLine` | **Yes** | Exactly one of numeric `y` or `x`; optional `stroke`, `strokeWidth`, and `name`. |
| `ResponsiveContainer` | **Subset** | Measures its box with `ResizeObserver` and injects numeric width/height into exactly one chart child; it is not the complete Recharts sizing API. |
| `Brush` | **Yes** | `startIndex`/`endIndex` or a time domain window the native viewport; `height` enables the navigator strip. |
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

## UI kit, CSP and localization

| Capability | Status | Notes |
| --- | --- | --- |
| Phone and narrow-viewport menus | **Yes** | Menus opened by `openPopup()` (Indicators, chart type, objects tree, context menu) render as bottom sheets when the primary pointer is coarse or the viewport is narrower than 520px. Sheets are full width, at most 70% of the viewport height, safe-area padded, with 48px rows and scroll lock. A backdrop tap, the handle, a swipe down or Escape closes a sheet and restores focus. `PopupOptions.presentation` overrides the choice and `PopupHandle.presentation` reports it. |
| Scoped stylesheet in shadow roots | **Subset** | `ensureBaseStyles(target?, { nonce? })` installs the chrome sheet into the Document or ShadowRoot that renders `target`. The widget itself still calls it for the document. Kit overlays adopt their styles wherever they render. |
| Strict CSP `style-src` | **Subset** | Chrome styles use constructable stylesheets, which need no `'unsafe-inline'`. Without them, the `<style>` fallback takes a nonce from `ensureBaseStyles(…, { nonce })` or `<meta property="csp-nonce" nonce="…">`. |
| Trusted Types (`require-trusted-types-for 'script'`) | **Subset** | The financial widget writes library-owned icon markup only through the `raze-charts` policy, so allow `trusted-types raze-charts`. The `/chart` SVG mount still assigns SVG markup directly and is not yet Trusted Types compatible. `SidebarCustomItem.icon` is host-authored markup written through the same policy: never build it from user input. |
| Localized built-in chrome | **No** | Built-in labels are English. An internal `t(key, default)` runtime with lazy locale packs is in place, and chrome strings move to it before a public locale API ships. |
| Overlays in element fullscreen | **Subset** | Bottom sheets and kit overlays follow the fullscreen element and shadow roots. Anchored desktop menus still portal to `document.body`. |

## How compatibility changes

Before adding a compatibility-shaped export, it must do one of two things:

1. implement a documented behavior and gain a regression test; or
2. fail clearly with migration guidance.

Silent no-op props and components are treated as defects. Update this matrix
in the same pull request whenever support changes.
