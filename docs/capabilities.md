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

Indicator math also ships on its own: `@razedotbot/charts/studies` exports the
pure kernels (`sma`, `ema`, `rsi`, `stdev`, `bollinger`, `macd`, `vwap`,
`closesFromBars`, `sourceValues`), `StudyRegistry`, `BUILTIN_STUDIES`,
`searchStudies`, and the `StudyDefinition` contract types, with no DOM or
widget code (**Yes** — ESM, CommonJS, and NodeNext types are covered by the
packed package contract). A registry created there is standalone; pass
definitions to a widget through `raze.custom_studies`.

## Financial domain

| Capability | Status | Notes |
| --- | --- | --- |
| Candlestick, line, area, Heikin Ashi, bars, hollow candles, baseline, columns | **Yes** | Selected through the financial chart UI/options. |
| Crisp series at any device pixel ratio | **Yes** | Grid, separators, candles, OHLC bars, volume, columns, line/area, last-price and trading lines paint in device pixels: hairlines are `max(1, floor(dpr))` pixels with no half-intensity smear at 125/150/175 % scaling, and every wick is centred in its body. Line, area and baseline strokes are 2 CSS pixels wide (TradingView's default line width), sized the same way: `floor(2 × dpr)` device pixels. The width is not configurable yet. On-screen crispness also needs the canvas backing store to match the device-pixel content box; at widths where width × DPR is fractional the browser resamples the bitmap slightly (ChartEngine sizing follow-up). |
| OHLC bar thickness | **Yes** | `overrides["mainSeriesProperties.barStyle.thinBars"]` (default `true`) keeps stems and ticks one hairline wide; `false` thickens them with the zoom. A non-boolean value warns and falls back to `true`. |
| Series clipped to the price pane | **Yes** | Candles, bars and every other main-series style clip to the price pane, so trimmed or manually scaled wicks never cross the volume pane or sub-panes. A wick that autoscale trims ends in a small arrowhead at the pane edge. |
| Volume | **Yes** | Overlay (default), dedicated pane, or hidden via `raze.volume_mode`. The crosshair reads the volume on the axis over a dedicated pane. |
| Initial history and lazy left pagination | **Yes** | Uses the TradingView-shaped `getBars` contract. |
| Promise-first native data source | **Yes** | `defineDataSource` + `createDatafeed` adapt promises and optional realtime cleanup to the callback protocol. |
| Live bars | **Yes** | `subscribeBars` / `unsubscribeBars`; append and forming-bar replacement are supported. |
| Abortable native realtime setup | **Yes** | The native adapter supplies `AbortSignal` and runs cleanup even when async setup finishes after unsubscribe. |
| Symbol and resolution races | **Yes** | Latest request wins; stale history, marks, and subscription callbacks are ignored. |
| Async marks | **Yes** | Callback-based asynchronous `getMarks` results are applied only to the active target. |
| Timescale marks | **Yes** | `getTimescaleMarks` is requested with history and painted as coloured badges (`circle`, `earning`, `earningUp`, `earningDown`; other shapes warn and draw a circle) just above the time axis, stacked per bar with a `+N` overflow badge, so they never overprint tick labels. Each badge records a hit target; the hover and keyboard tooltip with the `tooltip[]` lines is not wired yet. |
| Gapped market sessions | **Yes** | `TimeIndex` maps actual timestamps onto adjacent logical bar indices; `session_breaks` draws optional lines at session opens (after a gap) and, inside round-the-clock intraday sessions (gap-free runs longer than a day, such as a forex week or 24x7 crypto between outages), at each local midnight of the display zone. Sessions of a day or less, such as equity sessions or 23-hour futures sessions, break only at their open. |
| Timeframe / go-to-date | **Yes** | Honours `options.timeframe`; header presets and go-to-date call `setVisibleRange`, which pages history when needed. |
| Fit and reset view | **Yes** | `F`, a double-click in the plot, the sidebar Fit button and `chart.fitContent()` fit every loaded bar with price autoscale; `chart.resetView()` returns to the default spacing anchored to the latest bar. Each fires one visible-range change, so `raze.layout` panes stay synced. A fit may pack bars tighter than the 1.5 px gesture zoom-out limit; zooming out from there holds the span and zooming in steps in from it. Both are optional members of the TypeScript `IChartWidgetApi` (call `chart.fitContent?.()` in typed code); the Raze chart always provides them. |
| Default bar spacing | **Yes** | The initial and reset view show 6 CSS px per bar at any width (phone to desktop); a resize keeps the spacing and the right edge. The panes of a `raze.layout` boot with the same view, and a resize keeps every pane's spacing without pulling them out of sync. |
| Layered rendering | **Yes** | A scene canvas and an overlay canvas per chart: crosshair, legend values, hover, draft and countdown repaint without redrawing the scene; a resize repaints synchronously (no blank frame); an opaque pane background uses an `{ alpha: false }` context, a translucent one still composites over the page. Chromium draws scene text on the opaque canvas with LCD subpixel anti-aliasing while overlay text stays greyscale; screenshots repaint into an alpha canvas, so exported PNGs have greyscale text. The first `canvas` in the chart host (`canvas.raze-chart-canvas`) now holds only the overlay: target it for input and focus, and read pixels through `ChartEngine.composite()` or `ChartRenderer.snapshot()`. |
| Symbol search | **Yes** | Header search calls `searchSymbols`. |
| Timezone | **Yes** | `timezone` (an IANA zone, a fixed offset such as `"+05:30"`, `"exchange"` for `symbolInfo.timezone`, or a `custom_timezones` id) sets the zone of the time-axis labels, the crosshair time and the session breaks. DST is handled: the repeated fall-back hour is labelled twice and the skipped hour never. `activeChart().setTimezone()`, `timezone()`, `onTimezoneChanged()` and `getTimezoneApi()` change and observe it at runtime. `setTimezone()` throws a `RangeError` for an unknown zone; an unknown zone in options or in `symbolInfo` warns once and shows UTC. Daily and coarser bars keep their trading date in every zone. |
| Time axis | **Yes** | Calendar-aligned weighted ticks (year, month, week, day, hour, down to seconds) spaced by pixels per bar, so gapped sessions keep their label density and session opens show their date. Labels never overlap or collide with the corner cell. `custom_formatters.tickMarkFormatter`, `dateFormatter` and `timeFormatter` customise the axis and crosshair labels. |
| Timezone label and bar countdown | **Yes** | `timezone_display` and `countdown` features (on by default). The timezone caption sits in the corner cell under the price axis and names the zone the axis shows: it follows `setTimezone()`, resolves `"exchange"` and `custom_timezones` ids, reads `Etc/UTC` when the configured zone is unknown, and abbreviates long names to their UTC offset (`UTC-4`). The countdown is a second line of the last-price tag: `m:ss` under an hour, `h:mm:ss` under a day, `Nd hh:mm` above, with calendar months for monthly bars. It follows the datafeed server clock and hides when the last bar is more than one period old. `mainSeriesProperties.showCountdown: false` hides it. |
| EMA, SMA, RSI, VWAP, Bollinger, MACD | **Yes** | Multi-series `compute` results paint lines, bands, and histograms. Incremental built-ins remain EMA/SMA/RSI. Every documented input is honoured (see the next row); zero and negative prices are ordinary values, and a non-finite bar is a gap (`null`) that no window or recurrence carries forward. Stdev/Bollinger are O(n) for any length. MACD values keep at least four significant digits in the legend and crosshair tag (`-0.00000318`, not `-0.0`). |
| Built-in study inputs | **Yes** | By id, TradingView input title (`Fast Length`, `fastLength`, `StdDev`), the aliases `src`, `len`, `period` and `multiplier`, or TradingView `in_N` position (`createStudy('MACD', false, false, { in_0: 14, in_1: 30, in_3: 'close', in_2: 9 })`). EMA/SMA: `length`, `source`, `offset`; RSI: `length`, `source`; Bollinger Bands: `length`, `mult`, `source`, `offset`; MACD: `fast`, `slow`, `signal`, `source` (`length` sets `slow`; a `fast` that is not below `slow` warns); VWAP: `anchor` (`session`/`week`/`month`/`quarter`/`year`), `source` (default `hlc3`), `offset`. Sources: `open`, `high`, `low`, `close`, `hl2`, `hlc3`, `ohlc4`, `hlcc4`, `volume`. An unknown key or invalid value warns once with the supported list; out-of-range numbers are clamped. Legend labels still show the store's `length`. |
| VWAP sessions | **Yes** | Resets at the start of each trading day of `symbolInfo.session` in `symbolInfo.timezone` (DST-aware), so sessions crossing UTC midnight (ASX, CME Globex `1700-1600`) stay continuous; `24x7` symbols reset at midnight as before. A zero-volume bar carries the running VWAP; a feed with no volume at all warns. An unknown zone or session string warns and falls back to UTC days. |
| Study names | **Yes** | `createStudy()` and `load()` match a definition's name or alias exactly (case-insensitive; a TradingView `@tv-basicstudies` suffix is ignored). Names Raze lacks, such as `Double Exponential Moving Average`, `Bollinger Bands %B` or `Anchored VWAP`, reject with the list of available studies instead of resolving to a similar built-in. `keywords` only feed `searchStudies(registry.list(), query)` (exported by `@razedotbot/charts/studies`) for pickers. |
| Custom studies | **Yes** | Overlay or pane; public contract recomputes the full array after a data mutation. `forceOverlay` paints a pane study on the price pane with its own scale (`range`, or its visible values; unlabeled, like TradingView's "No scale"); `lock` is stored on the instance. |
| Multiple study panes | **Subset** | Pane studies are supported; arbitrary user-defined pane layouts are not. The main plot always keeps max(120px, 40% of the height above the time axis); extra panes shrink evenly to 24px, then collapse to titled strips, and never pass the time axis. |
| Drawing tools | **Yes** | Horizontal/vertical line, trend, ray, extended line, measure (ephemeral), Fibonacci, rectangle, and text. |
| Magnet / stay-in-mode / objects tree | **Yes** | OHLC magnet, stay-in-drawing-mode, and an objects tree over shapes and studies. |
| Shape editing | **Yes** | Create, drag, read/update points, remove, and remove all shapes. |
| Order and position lines | **Yes** | TradingView-style fluent adapters, styling, quantity/P&L labels, move/modify/cancel callbacks, mouse/touch drag, and one-tick keyboard adjustment. |
| Stop-loss / take-profit brackets | **Yes** | Linked entry/SL/TP lines, risk/reward shading and ratio, auto-scale participation, group callbacks and cancellation. |
| Marks on bars | **Yes** | Hover tooltip and refresh/clear APIs. |
| Compare / multiple symbols | **Yes** | `createCompare(symbol)` overlays extra series, each normalised to its own close at the first visible bar (TradingView's same-% scale) and included in autoscale, so symbols of any magnitude share the plot; `raze.layout` `"2x1"` / `"2x2"` syncs range and crosshair. The synced crosshair's time line and time label show in every pane. Its price line shows for the same symbol; until the layout relay reports the source symbol, it also shows in any pane whose price range contains the source price. |
| Save/load chart layouts | **Yes** | Versioned JSON with stable drawing/study IDs via `save()` / `load()`; `disableSave` excludes a drawing and live broker/trading state is intentionally rehydrated separately. |
| Undo/redo command history | **Yes** | Drawings and studies; `disableUndo` skips a create. |
| Encapsulated runtime surface | **Yes** | `widget` and `activeChart()` objects expose only the documented `IChartingLibraryWidget` / `IChartWidgetApi` methods. Internal state is `#private` or module-private and cannot be reached or mutated at runtime. |
| Full TradingView study/drawing catalog | **No** | Compatibility is a documented subset, not feature parity. |
| WebGL, LOD, or worker renderer | **No** | Canvas 2D is the current financial renderer. |
| Price-axis ticks and precision | **Yes** | Ticks are multiples of the symbol's `minmov / pricescale`. With the built-in formatter every label on the axis (ticks, crosshair, last-price and order tags) uses one fixed precision and rounds to the min tick. If fewer than two tradable prices are visible, for example because the `pricescale` is coarser than the prices, the ticks use plain 1/2/5 steps and the precision rises so the labels stay distinct. `priceFormatterFactory` and `raze.format_price` receive the raw price and set their own digits. |
| Logarithmic price scale | **Yes** | Ticks are round, decade-aware prices, such as 86,000 / 88,000 / 90,000 or 1 / 2 / 5 / 10, at least 40px apart. When the visible data or the manual price range reaches zero or below, the axis maps linearly and logs one console warning. Log mapping returns once the visible data is positive again. |
| Negative and zero prices | **Yes** | Autoscale, ticks, labels, percent mode and Heikin-Ashi accept any finite price, including zero and negative values such as spreads, P&L, rates and WTI at -37; flat and all-zero data are centred. Candles, bars, line, area, baseline, columns and the last-price label paint lows and closes at or below zero. A bar whose `close` is not a finite number is whitespace. A log scale skips prices it cannot place; when the visible data reaches zero or below it maps linearly and logs one console warning. |
| Number locale | **Yes** | `locale` sets digit grouping and the decimal separator of built-in price labels (axis, crosshair, legend, tags). TradingView tags such as `pt_BR` are accepted. An invalid tag warns once and falls back to `en-US`. Without `locale` the output matches `en-US`. |

## Native dashboard charts

| Capability | Status | Notes |
| --- | --- | --- |
| Line, area, bar, point/scatter | **Yes** | Cartesian marks infer scales when omitted. An explicit X scale object requires `type`. Points paint in the series colour at one radius (`fill`/`r` override). A zero bar paints nothing yet stays hoverable; `minBarHeight` opts into a stub for tiny values. `bar({ fade })` fades toward the theme background. |
| Ranged area (`area({ y0 })`) | **Yes** | Both band edges follow the mark's `curve`, so the fill meets its strokes; `stroke0` strokes the lower edge. |
| Series identity | **Yes** | Each mark has a stable id: `id`, else `mark-<index>`. Every series keeps its own legend row: names that collide are numbered (`value`, `value (2)`), and an explicit `name` reused with a different colour is numbered too and logs a one-time warning. Marks sharing an explicit `name` and colour (an area plus its outline) share one row and toggle together. `hiddenSeries` matches ids, row ids, display names and base names, so `["value"]` hides `value` and `value (2)`. Duplicate ids throw `E_MARK_OPTION`. |
| Axis formatters | **Yes** | `scales.*.tickFormat` formats ticks, tooltips, last-value chips, bar chips, rule labels and the mounted crosshair value chip, which shows the hovered datum's value (not a pixel read back). `CompiledChart.formatters` and `hoverSamples` (raw `xValue`/`yValue`, `datum`, source `index` or -1 for plugin samples, `seriesId`) carry them; heatmap colour-bar labels use `formatters.color` when a scene sets it. |
| Stacked and grouped bars | **Yes** | `stackId` opts into stacking; positive and negative totals diverge around zero and equivalent quantitative X values share a group. |
| Pie/donut | **Yes** | Renderer-neutral polar scene nodes; a pie chart is a standalone composition. |
| Radar | **Yes** | Multiple layers may overlay when their category axes match; Cartesian scales and non-radar marks are rejected. |
| Heatmap | **Yes** | Standalone composition with configured band-domain layout, a diverging color scale, square cells, and labels where the whole value fits. Values print as plain numbers by default; `valueFormat` selects `"percent"`, `"signed"`, `"signed-percent"` or a function for cells, tooltips and the colour bar. Dense row and column labels thin; the crosshair chips still name the hovered row and column in full. A grid with more cells than whole pixels (a year of days by hours) drops its 2px gaps and uses fractional square cells, so it still fits the chart. |
| Axis tick precision and number formats | **Yes** | Tick decimals come from the tick step (a 0.0005 step reads 1.0850, 1.0855); value labels use the series' data precision (at most 8 decimals). Magnitudes from a million up use compact M/B/T notation: ticks share one unit (0.4T, 0.8T, 1.2T) and value labels keep up to six significant digits (25.0004M). `scales.*.tickFormat` overrides both. |
| Measured axis layout | **Yes** | The compiler estimates label widths (exact for the default monospace font) and grows the value axis to the widest label and last-value chip, capped at 35% of the chart with an ellipsis. X labels are thinned, rotated -45° with reserved bottom margin, or cut; `scales.x.labels` sets `rotate`, `maxWidth` and `interval`. Explicit `margin` sides are never changed. |
| Calendar time axis | **Yes** | Time scales tick on UTC calendar boundaries from milliseconds to millennia (1/5/15/30 s and min, 1/2/3/6/12 h, 1 and 2 days, Monday weeks, half months, 1/3/6 months, then 1/2/5 years and their multiples of ten). Labels switch between `HH:mm`, `D Mon`, `Mon` and `YYYY`, boundary ticks name the higher unit, and tooltips add the year or clock when the data need it. Display time zones other than UTC are not configurable on `/chart`. |
| Reference rules | **Yes** | `ruleY` / `ruleX` label the formatted value (prefixed by `name` when set); `label` text or `false`, `labelPosition` (`start`/`middle`/`end`), and `dashed: false` for a solid rule. React `ReferenceLine` accepts exactly one of `y` or `x`. |
| Tooltip and crosshair | **Yes** | Pointer interaction in `mountChart`; native default is enabled unless set to `false`. `onTooltip`/`onSelect` payloads are data-space: `x` is a number on quantitative axes and the category on band axes, and built-in marks (line, area, and point samples, bars, heatmap cells, pie slices, radar vertices) carry `datum`, `index`, `markIndex`, and `seriesId`. Crosshair chips show the hovered datum, not the nearest tick. The tooltip stays under a stationary pointer across `update()`, resizes, and viewport changes; those repaints call `onTooltip` only when the hovered values change, and never from a repaint that `onTooltip` itself started. Overlays map through the plotted stage, so presets, the navigator, and CSS scaling do not offset them. |
| Legend | **Yes** | Built from series metadata and keyed by series id; click, or keyboard on the legend's toggle buttons (`aria-pressed`), toggles a series on SVG and Canvas mounts alike, and hidden series stay listed (dimmed, hollow swatch) so the toggle is reversible, including series hidden at mount by `spec.hiddenSeries` or `mountChart({ hiddenSeries })` (the mount's list then replaces `spec.hiddenSeries`). The top legend wraps and grows the top margin (up to ~30% of the height, then `+N more`), with plugin rows measured into the band; a hidden plugin keeps its rows. The pie legend compacts to 20px rows, then shows `+N more`, whose SVG tooltip lists the names; the Canvas summary lists every series and marks hidden ones. Pie slices toggle individually, from the legend or through `hiddenSeries` (`<seriesId>/<label>` or the label). |
| Responsive mount | **Yes** | `ResizeObserver` when an explicit width is not supplied. |
| Custom mark plugin | **Yes** | Typed domain contribution and scene compilation through `defineMarkPlugin`; contexts are isolated and returned domains/scene geometry are validated. |
| Runtime definition validation | **Yes** | `ChartCompileError` carries stable codes for malformed specs, composition, scales, sizes, mark-specific options, channels, and plugins. |
| Missing numeric samples | **Yes** | Invalid line/area values create separate paths instead of bridging a gap; dense-mode budget applies across retained segments. |
| Renderer-neutral scene inspection | **Yes** | `compileChart` and `MountHandle.getScene()`. |
| Multiple coordinated panes | **Subset** | `createViewportGroup()` syncs X windows across mounts; the compiler does not layout multi-plot chrome. |
| Animation/transitions | **No** | Updates repaint immediately. |
| Viewport brush or controlled zoom | **Yes** | `ChartSpec.viewport` windows rows before map/decimate; `mountChart` brush/zoom/pan; optional range presets and navigator. Zoom is bounded by `interaction.zoom.minSpan` (default three data points) and `maxSpan` (default the full extent), in X data units, or decades on log axes; range presets outside those bounds are hidden. `interaction.panBounds` (`"data"` by default, or `"none"`) keeps pan, brush, and navigator windows inside the data. Wheel, trackpad, and resize repaints are coalesced to one per animation frame; horizontal wheel pans. Invalid limits throw. |
| Automatic dense line/area decimation | **Yes** | Pixel-aware extrema envelope; defaults to two rendered points per plot pixel. Input scanning remains O(n). |
| Decimation diagnostics and opt-out | **Yes** | `CompiledChart.diagnostics`; tune `maxRenderedPoints` or set `decimation: "none"`. |
| Retained scene diffing | **No** | `update()` preserves the mount, then recompiles and repaints the scene. It also re-reads the full data behind the navigator and zoom bounds, so rows mutated in place are picked up. A call that passes `viewport`, moving the window or echoing the one `onViewportChange` reported (as controlled hosts and the React adapter do), reuses them unless rows were added or removed, and an echo made inside `onViewportChange` is that change's only repaint. |
| Tick density and nice steps | **Yes** | `ticks(n)` returns between `ceil(n / 2)` and `n + 1` ticks on 1, 2 or 5 x 10^k steps (2.5 only when those miss the budget by two or more), as exact decimals. A non-finite `n` throws a `RangeError`. |
| Log scale ticks | **Yes** | Powers of ten, with 2x and 5x subdivisions when the budget allows and every n-th decade on very wide domains. A domain narrower than a decade that holds too few of those values falls back to linear ticks (3-7 gives 3, 4, 5, 6, 7). |
| Flat-series domains | **Yes** | An all-equal series v gets `v ± max(abs(v) × 1%, 1)`, capped so a non-zero value never crosses zero, and plots in the vertical middle. Bars and areas keep their zero baseline. |
| Colour-vision-safe palettes | **Yes** | Every default series-palette pair is at least ΔE76 15 apart under normal vision and simulated protan, deutan and tritan vision, has 4.5:1 contrast with its plot, and avoids the text colour. `COLORBLIND_CHART_THEME` / `COLORBLIND_LIGHT_CHART_THEME` encode up/down, heatmaps and the scatter ramp as blue/orange instead of green/red. Heatmap colours derive from the theme's `accent`, `down` and `heatZero` tokens. |

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
| Phone and narrow-viewport menus | **Yes** | Menus opened by `openPopup()` (Indicators, chart type, objects tree, context menu) render as bottom sheets when the primary pointer is coarse or the viewport is narrower than 520px. Sheets are full width (a centred 640px column on wider touch screens), at most 70% of the viewport height, safe-area padded, with 48px rows and scroll lock. Sheets are modal: Tab and Shift+Tab stay inside, and assistive technology sees an `aria-modal` dialog. A backdrop tap, the handle, a swipe down or Escape closes a sheet and restores focus. An automatically chosen presentation closes the menu, restoring focus, when a resize, rotation or pointer change flips it. `PopupOptions.presentation` overrides the choice and `PopupHandle.presentation` reports it. |
| Scoped stylesheet in shadow roots | **Subset** | `ensureBaseStyles(target?, { nonce? })` installs the chrome sheet into the Document or ShadowRoot that renders `target`. The widget itself still calls it for the document. Kit overlays adopt their styles wherever they render. |
| Strict CSP `style-src` | **Subset** | The financial widget renders under `style-src 'self'` with no `'unsafe-inline'`: its chrome styles use constructable stylesheets and CSSOM, and a browser test opens its menus under that policy and expects zero violations. Browsers without constructable stylesheets fall back to a `<style>` element that takes a nonce from `ensureBaseStyles(…, { nonce })` or `<meta property="csp-nonce" nonce="…">`. A nonce given to `ensureBaseStyles` also applies to overlays that later render in other roots of that document. The `/chart` SVG renderer (the default) still writes `style` attributes into its SVG markup, so it needs `'unsafe-inline'` for style attributes. Host markup (a string `SidebarCustomItem.icon`, `popupRow(…, { trustedHtml: true })`) must itself satisfy the page's policy. |
| Trusted Types (`require-trusted-types-for 'script'`) | **Subset** | The financial widget writes library-owned icon markup only through the `raze-charts` policy, so allow `trusted-types raze-charts`. The `/chart` SVG mount still assigns SVG markup directly and is not yet Trusted Types compatible. A string `SidebarCustomItem.icon` and `popupRow(…, { trustedHtml: true })` content are host-authored markup written through the same policy, so never build them from user input. `SidebarCustomItem.icon` also accepts an `Element`, which is cloned into the button and needs no markup sink. |
| Localized built-in chrome | **No** | Built-in labels are English. An internal `t(key, default)` runtime with lazy locale packs is in place, and chrome strings move to it before a public locale API ships. |
| Overlays in element fullscreen | **Subset** | Bottom sheets and kit overlays follow the fullscreen element and shadow roots, and menus whose button sits inside a shadow root handle presses, arrow keys, Escape and focus there (open shadow roots). Anchored desktop menus still portal to `document.body`. |

## How compatibility changes

Before adding a compatibility-shaped export, it must do one of two things:

1. implement a documented behavior and gain a regression test; or
2. fail clearly with migration guidance.

Silent no-op props and components are treated as defects. Update this matrix
in the same pull request whenever support changes.
