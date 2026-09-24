# Shared seams

Wave 1A declares every field, setter and plugin contract that wave-1B packages
share. Each package can then own its files and build against a fixed interface
instead of editing the same state bag in parallel. This page lists every seam
with its **producer** (the code that fills or implements it) and its
**consumers** (the code that reads or calls it).

Rules for every seam:

- **The producer fills and the consumer falls back.** When a same-wave producer
  has not landed yet, the consumer keeps today's behaviour. For example, a
  painter that finds no `handleFill` token uses `paneBackground`. The merged
  wave suite checks both sides.
- **Setters are the only writers.** `visibleRange`, the price-scale flags and
  `chartStyle` stay readable fields. Every write goes through
  `setViewport`/`setScaleMode`/`setChartType`, which validate, tag the change
  with a reason, fire exactly one event and request exactly one repaint. W2-02
  later puts a store behind the setters and adds a lint that forbids direct
  writes.
- **Nothing is silent.** Unknown reasons, modes, chart types, patch keys, id
  namespaces and inverted or non-finite ranges throw an error that lists the
  supported values.

Contract tests: `node tests/seams.mjs` (runtime) and
`tests/types/seams.test.ts` (compile-time, part of `npm run typecheck`).

## Context seams (`src/core/context.ts`)

`createChartContext(init, { clock?, ids? })` extends the widget's state object
in place with the seams below. `Widget` builds its context through it.
`ChartEngine` installs the hooks marked *engine* when it mounts and resets them
when it is destroyed.

| Seam | Type | Producer | Consumers | Fallback / status |
| --- | --- | --- | --- | --- |
| `setViewport(range, reason, { notify? })` | `boolean` (changed) | W1A-06, implemented | Writers to route: W1B-07 (fit, reset), W1B-10 (pan, zoom, pinch, keyboard, drag cancel), W1B-13 (presets, `load()`), W1B-18 (initial view, `rebase` after prepend, `realtime`, `setVisibleRange`, timeframe). Store: W2-02 | Implemented. Current writers still assign directly until their W1B owner routes them. |
| `rangeChanged` | `Delegate<[ViewportChange]>` | `setViewport` | W1B-15 (visible-range studies), W1B-18 (pagination trigger), W2-02 | Fires once per effective change, with `previous` and `reason`. |
| `viewportChanged` (existing) | Unix-second window | `setViewport` (except `rebase`) and the existing direct writers | Layout sync, `onVisibleRangeChanged` | `visibleUnixRange()` builds the payload with the same mapping as `DataManager.visibleUnixRange()`. |
| `setScaleMode(patch, reason)` | `{ mode?, autoScale?, priceRange? }` | W1A-06, implemented | Writers to route: W1B-07 (fits re-enable autoscale), W1B-10 (axis drag, axis double-click, cancel), W1B-13 (`load()`), W1B-19 (percent on the first compare), W1B-22 (ScaleBar) | `log` and `percent` are exclusive, a manual range turns autoscale off, and `autoScale: true` clears the range. |
| `scaleChanged` | `Delegate<[ScaleChange]>` | `setScaleMode` | W1B-22 (ScaleBar `aria-pressed`), W3-01 (price-scale API events) | ScaleBar keeps its click-driven sync until W1B-22. |
| `scaleState()` / `readScaleState()` | `ScaleState` | W1A-06 | Any reader of the scale | Reproduces the painters' precedence: percent wins, and autoscale ignores a stale manual range. |
| `setChartType(style, reason)` | `boolean` | W1A-06, implemented | Writers to route: W1B-13 (sidebar callback, `load()`) | Unknown styles throw with `CHART_STYLES`. |
| `chartTypeChanged` | `Delegate<[ChartTypeChange]>` | `setChartType` | W1B-23 (sidebar picker state), W3-01 (chart-type API) | Not yet subscribed. |
| `requestOverlayPaint()` | hook | *engine*: `ChartEngine.markOverlayDirty()`. W1B-07 splits the layers | W1B-10 (crosshair/hover moves), W1B-13 (countdown timer, synced-crosshair relay) | Without an engine it calls `requestPaint()`. The engine paints one layer until W1B-07, so the whole frame repaints. |
| `defaultVisibleBars()` | hook returning bars | W1B-07 (width-aware provider from the target bar spacing) | W1B-18 (`initVisibleRange` replaces `INITIAL_VISIBLE_BARS`), W1B-07 (reset view) | `DEFAULT_VISIBLE_BARS` (120, today's count). |
| `now()` / `setServerTimeOffset(ms)` | epoch ms | W1B-18 (offset from `getServerTime`) | W1B-09 (countdown), W1B-13 (timeframe presets, go-to-date), W1B-18 (initial history `to`) | Offset 0, so `now()` equals `Date.now()`. The clock can be injected for tests. |
| `timezone` / `setTimezone(zone)` / `timezoneChanged` | `string \| null` (`exchange`, IANA, or null to follow the symbol) | Seeded from `options.timezone`. `chart.setTimezone()` (W1B-05) writes it | W1B-05 (ticks and crosshair through the W1A-05 core), W1B-09 (corner label) | `resolveTimezone(setting, symbolInfo)` reproduces today's axis-chrome rule. The field is read-only; assigning it throws. |
| `overlayHost` | `HTMLElement \| null` | *engine*: a `div.raze-chart-overlay-host` stacked above the canvas | W1B-16 (DOM legend), W1B-10 (inline text editor, timescale-mark tooltip) | null until an engine mounts. It has `pointer-events: none` and clips its children, which opt in to pointer events. |
| `ids` | `IdAllocator` | W1A-06 | W1B-15 (StudyStore), W1B-20 (ShapeStore, TradingStore), W1B-19 (compare ids), W2-15 (`raze.idFactory`) | Stores keep their module counters until they adopt it. |
| `syncedCrosshair.symbol` | `string?` | W1B-13 (layout relay in `Widget`) | W1B-05 (always syncs the time line; syncs the price line only for the same symbol) | Absent means today's price-in-range check. |
| `compare[].resolution` | `ResolutionString?` | W1B-19 (compare loader) | W1B-19 (stale-resolution reload), W1B-09 (compare painter) | Absent means the series was loaded at the chart's resolution. |
| `ThemeColors.drawingDefault`, `handleFill`, `handleStroke`, `labelBackground`, `labelText` | optional colours | W1B-11 (`buildTheme` in `core/theme.ts`) | W1B-11 (drawing painters), W1B-10 (the default colour of UI-created drawings) | Painters keep their current literals until the tokens exist. |
| `buildFeatureSet(options, { defaultsOn?, aliases? })` | `Set<string>` | W1A-06 | W1B-13 (`timeframes_toolbar` as the canonical name, with an alias) | Without a config the defaults are unchanged. W1B-13 can set the policy from the widget without editing `context.ts`. |

Change reasons are frozen vocabularies: `VIEWPORT_CHANGE_REASONS`,
`SCALE_CHANGE_REASONS` and `CHART_TYPE_CHANGE_REASONS`. The `rebase` reason
re-anchors indices after bars are prepended while the visible time stays the
same, so it skips the public `viewportChanged` unless `notify: true` is passed.

## View seams (`src/engine/paint/view.ts`)

`ChartRenderer.financeView()` builds the `FinanceView` once per frame and for
each gesture hit test.

| Field | Producer | Consumers | Fallback / status |
| --- | --- | --- | --- |
| `dpr` | Renderer (`engine.dpr`), filled | W1B-08 (`pixel.ts` bitmap-space snapping) | Filled now. |
| `axisTags: AxisTag[]` | Painters queue tags: W1B-11 (horizontal-line price tags), later trading, studies and compares | W1B-07 (the axis-overlay pass that de-collides tags with `AXIS_TAG_PRIORITY` and paints them after the axes) | Each view starts with a fresh empty array. Nothing paints the queue until W1B-07. |
| `axisChromeRect: Rect` | Renderer, filled: the corner cell where the price axis meets the time axis | W1B-09 (timezone and countdown paint only inside it), W1B-05 (tick labels never enter it), W1B-22 (ScaleBar placement) | See the coordination note below. |
| `hoverShapeId` | Renderer (gesture hover), filled | W1B-11 (handles appear only on hover or selection) | Filled now. |
| `timescaleMarkScreen: TimescaleMarkHit[]` | W1B-09 (badge painter, which resets it every frame) | W1B-10 (hover, focus and tooltip) | Empty until W1B-09. |
| `hoverTimescaleMark` | W1B-10 (sets `renderer.hoverTimescaleMark`) | W1B-09 and W1B-10 (tooltip) | null until W1B-10. |
| `ShapeHit.z`, `ShapeHit.hitTest` | W1B-11 (registry painters) | W1B-10 (topmost-first anchor, body and label hits) | Optional. Without them, gestures keep the `y`-proximity test. |

## Engine seams (`src/engine/ChartEngine.ts`)

- `overlayHost`: see the context table. It sits directly above the canvas in
  DOM order, so its interactive children follow the canvas in tab order.
- `markOverlayDirty()`: the overlay-only invalidation installed as
  `requestOverlayPaint`. Until W1B-07 adds the main and overlay canvases it
  schedules the same coalesced frame as `markDirty()`.

## Plugin and data contracts

| Module | Contract | Implemented by | Consumed by |
| --- | --- | --- | --- |
| `src/drawings/types.ts` | `DrawingToolDefinition` (anchors spec, property schema, `paint`, `hitTest`, `handles`, `constrain`, `validateProps`, `describe`), `DrawingHit`, `DrawingEnv` / `DrawingPaintEnv` (with the `pushAxisTag` sink), theme tokens, the closed `BuiltinDrawingToolId` | W1B-11 (`defineDrawingTool` registry, built-ins in `tools/*`) | W1B-10 (hits, drafting via `minAnchors`/`anchorsComplete`), W1B-20 (integer `z`, closed kinds, TV aliases), W3-14 (settings dialog from the property schema) |
| `src/studies/types.ts` | `IndicatorDefinition` (typed input schema, plots, fills, levels, compute or pure `init`/`update`), `StudyComputeContext`, `StudyChange` | W1B-15 (`defineIndicator` v2, store adapter for v1 definitions) | W1B-16 (`shortTitle`, `formatLabel`, `inLabel` inputs, plot colours), W1B-17 (`pane`, `range`, `levels`), W5-16 (`Float64Array` values) |
| `src/chart/sceneTypes.ts` | Scene contract v2: `SceneFormatters`, measured `SceneAxes` with tick anchor and rotation, `SceneLegendLayout` with stable ids and hidden rows, structured `SceneHoverSample`, `ScenePointerEvent`, `isSceneV2()` | W1B-01 (formatters, axes, ticks), W1B-02 (legend layout, stable series ids) | W1B-03 (renderers read structured samples and fall back to v1 fields while `isSceneV2()` is false) |
| `src/core/stateTypes.ts` | `StateSlice` (`key`, `version`, `requiresDataReload`, `save`, `validate`, `apply`, `migrate`, `subscribe`), `defineStateSlice()`, `findNonJsonValue()` | W2-02 (viewport/chart), W3-06 (studies), W3-14 (drawings) | W3-16 (registry, snapshot v2, `setState` diffing, URL codec). `trading` is a reserved key because broker state is never persisted. |
| `src/core/ids.ts` | `IdAllocator` (`next`, `reserve`, `peek`, `reset`, factory hook), `idSlug()` | W1A-06 | W1B-15, W1B-19, W1B-20, W2-15 |

## Coordination notes

- **One owner for `context.ts` and `view.ts` in wave 1B (W1B-07).** Every other
  1B need that touches them is declared above. A 1B package that finds a
  missing field should report it rather than edit the file.
- **The corner cell is shared.** `axisChromeRect` is the only reserved slot at
  the right end of the time axis. W1B-09 paints the timezone and countdown in
  it, abbreviating long zone names. W1B-22 wants the ScaleBar in the same
  corner. The two packages must agree on the split, for example the ScaleBar
  in the cell and the timezone and countdown moved to the last-price tag
  (`series-countdown-format`) and a compact zone label.
- **The scene types stay where W1A-08 puts them.** `sceneTypes.ts` imports the
  v1 scene types from the public `src/chart/index.ts` barrel, so the W1A-08
  split can move them freely.
- **Subpath exports.** The plugin contract types become public through the
  `/drawings` and `/studies` subpath barrels that W1A-01 creates. The root
  entry exports only the context and view seam types.
