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
  with a reason and request exactly one repaint. `setScaleMode` and
  `setChartType` fire exactly one event (`scaleChanged`, `chartTypeChanged`).
  `setViewport` fires its index-space `rangeChanged` once and, unless the
  reason is a local one (`rebase`, `resize`) or `notify: false` is passed,
  the public time-space `viewportChanged` once as well, so an effective call
  fires two events, one on each delegate. An unchanged value fires nothing.
  W2-02 later puts a store behind the setters and adds a lint that forbids
  direct writes.
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
| `setViewport(range, reason, { notify? })` | `boolean` (changed) | W1A-06, implemented | Writers: W1B-07 routes fit (`fit`), reset view (`reset`) and the resize spacing adjustment (`resize`). To route: W1B-10 (pan, zoom, pinch, keyboard, drag cancel), W1B-13 (presets, `load()`), W1B-18 (initial view, `rebase` after prepend, `realtime`, `setVisibleRange`, timeframe). Store: W2-02 | Implemented. Fires `rangeChanged` and (except the local reasons `rebase` and `resize`, `LOCAL_VIEWPORT_REASONS`) `viewportChanged`, one each. Writers not yet routed still assign directly. |
| `rangeChanged` | `Delegate<[ViewportChange]>` | `setViewport` | W1B-15 (visible-range studies), W1B-18 (pagination trigger), W2-02 | Fires once per effective change, with `previous` and `reason`. |
| `viewportChanged` (existing) | Unix-second window | `setViewport` (except `rebase` and `resize`) and the existing direct writers | Layout sync, `onVisibleRangeChanged` | `visibleUnixRange()` builds the payload with the same mapping as `DataManager.visibleUnixRange()`. A resize never reaches layout sync; a visible-range subscriber that must also hear resize-driven changes (W2-01) listens to `rangeChanged` with reason `resize`. |
| `setScaleMode(patch, reason)` | `{ mode?, autoScale?, priceRange? }` | W1A-06, implemented | Writers: W1B-07 (fit and reset re-enable autoscale, reasons `fit` and `reset`). To route: W1B-10 (axis drag, axis double-click, cancel), W1B-13 (`load()`), W1B-19 (percent on the first compare), W1B-22 (ScaleBar) | `log` and `percent` are exclusive, a manual range turns autoscale off, and `autoScale: true` clears the range. An empty window (`min === max`) throws a `RangeError`: pass `max > min`, or `autoScale: true`. |
| `scaleChanged` | `Delegate<[ScaleChange]>` | `setScaleMode` | W1B-22 (ScaleBar `aria-pressed`), W3-01 (price-scale API events) | ScaleBar keeps its click-driven sync until W1B-22. |
| `scaleState()` / `readScaleState()` | `ScaleState` | W1A-06 | Any reader of the scale | Reproduces the painters' precedence: percent wins, and autoscale ignores a stale manual range. |
| `setChartType(style, reason)` | `boolean` | W1A-06, implemented | Writers to route: W1B-13 (sidebar callback, `load()`) | Unknown styles throw with `CHART_STYLES`. |
| `chartTypeChanged` | `Delegate<[ChartTypeChange]>` | `setChartType` | W1B-23 (sidebar picker state), W3-01 (chart-type API) | Not yet subscribed. |
| `requestOverlayPaint()` | hook | *engine*: `ChartEngine.markOverlayDirty()`, which repaints only the overlay canvas (W1B-07) | W1B-10 (crosshair/hover moves), W1B-13 (countdown timer, synced-crosshair relay) | Without an engine it calls `requestPaint()`. The engine still repaints the main layer when main-layer state changed (see the engine seams). |
| `defaultVisibleBars()` | hook returning bars | *renderer*: W1B-07 installs a width-aware provider, `DEFAULT_BAR_SPACING` (6 px) per bar for the current plot width. The plot width uses the price-axis width measured on bars, or `PRICE_AXIS_W_MIN` before any bar painted (what an empty first frame measures for its placeholder labels), so the panes of a layout boot with the same count whether or not one of them painted an empty frame first | `DataManager.initVisibleRange` (boot; W1B-18 keeps it when routing through `setViewport`), `ChartRenderer.resetView()` | `DEFAULT_VISIBLE_BARS` (120) without a renderer or while the plot has no width. A chart that booted hidden gets the 6 px view on its first layout. |
| `now()` / `setServerTimeOffset(ms)` | epoch ms | W1B-18 (offset from `getServerTime`) | W1B-09 (countdown), W1B-13 (timeframe presets, go-to-date), W1B-18 (initial history `to`) | Offset 0, so `now()` equals `Date.now()`. The clock can be injected for tests. |
| `timezone` / `setTimezone(zone)` / `timezoneChanged` | `string \| null` (`exchange`, IANA, or null to follow the symbol) | Seeded from `options.timezone`. `chart.setTimezone()` (W1B-05) writes it | W1B-05 (ticks and crosshair through the W1A-05 core), W1B-09 (corner label) | `resolveTimezone(setting, symbolInfo)` reproduces today's axis-chrome rule. The field is read-only; assigning it throws. |
| `overlayHost` | `HTMLElement \| null` | *engine*: a `div.raze-chart-overlay-host` stacked above the canvas | W1B-16 (DOM legend), W1B-10 (inline text editor, timescale-mark tooltip) | null until an engine mounts. It has `pointer-events: none` and clips its children, which opt in to pointer events. |
| `ids` | `IdAllocator` | W1A-06 | W1B-15 (StudyStore), W1B-20 (ShapeStore, TradingStore), W1B-19 (compare ids), W2-15 (`raze.idFactory`) | Stores keep their module counters until they adopt it. |
| `syncedCrosshair.symbol` | `string?` | W1B-13 (layout relay in `Widget`) | W1B-05 (always syncs the time line; syncs the price line only for the same symbol) | Absent means today's price-in-range check. |
| `compare[].resolution` | `ResolutionString?` | W1B-19 (compare loader) | W1B-19 (stale-resolution reload), W1B-09 (compare painter) | Absent means the series was loaded at the chart's resolution. |
| `ThemeColors.drawingDefault`, `handleFill`, `handleStroke`, `labelBackground`, `labelText` | optional colours | W1B-11 (`buildTheme` in `core/theme.ts`) | W1B-11 (drawing painters), W1B-10 (the default colour of UI-created drawings) | Painters keep their current literals until the tokens exist. |
| `buildFeatureSet(options, { defaultsOn?, aliases? })` | `Set<string>` | W1A-06 | W1B-13 (`timeframes_toolbar` as the canonical name, with an alias) | Without a config the defaults are unchanged. W1B-13 can set the policy from the widget without editing `context.ts`. |

Change reasons are frozen vocabularies: `VIEWPORT_CHANGE_REASONS`,
`SCALE_CHANGE_REASONS` and `CHART_TYPE_CHANGE_REASONS`. Two viewport reasons
are local to the pane (`LOCAL_VIEWPORT_REASONS`) and skip the public
`viewportChanged` unless `notify: true` is passed: `rebase` re-anchors indices
after bars are prepended while the visible time stays the same, and `resize`
keeps a pane's bar spacing when its width changes. Every pane of a layout
rescales by its own width ratio; relaying one pane's rescaled range to a
sibling that rescales too would apply the ratio twice.

## View seams (`src/engine/paint/view.ts`)

`ChartRenderer.financeView()` builds the `FinanceView` once per frame and for
each gesture hit test.

| Field | Producer | Consumers | Fallback / status |
| --- | --- | --- | --- |
| `dpr` | Renderer (`engine.dpr`), filled | W1B-08 (`pixel.ts` bitmap-space snapping) | Filled now. |
| `axisTags: AxisTag[]` | Painters queue tags: W1B-11 (horizontal-line price tags), later trading, studies, compares and the crosshair (W1B-05) | W1B-07, implemented: `paint/axisTags.ts` runs after the axes on each layer, keeps the highest-priority tag (`AXIS_TAG_PRIORITY`, or `priority`) at its exact position, slides lower ones to the nearest free slot inside `clamp`, and paints lowest priority first | Each view starts with a fresh empty array. Main-layer painters feed the main pass; overlay painters (the crosshair) feed the overlay pass. |
| `axisChromeRect: Rect` | Renderer, filled: the corner cell where the price axis meets the time axis | W1B-09 (timezone and countdown paint only inside it), W1B-05 (tick labels never enter it), W1B-22 (ScaleBar placement) | See the coordination note below. |
| `hoverShapeId` | Renderer (gesture hover), filled | W1B-11 (handles appear only on hover or selection) | Filled now. |
| `timescaleMarkScreen: TimescaleMarkHit[]` | W1B-09 (badge painter, which resets it every frame) | W1B-10 (hover, focus and tooltip) | Empty until W1B-09. |
| `hoverTimescaleMark` | W1B-10 (sets `renderer.hoverTimescaleMark`) | W1B-09 and W1B-10 (tooltip) | null until W1B-10. |
| `ShapeHit.z`, `ShapeHit.hitTest` | W1B-11 (registry painters) | W1B-10 (topmost-first anchor, body and label hits) | Optional. Without them, gestures keep the `y`-proximity test. |

Hit lists (`markScreen`, `shapeScreen`, `tradingScreen`,
`timescaleMarkScreen`) belong to the main layer: its painters reset and fill
them, and hit testing reads the renderer's copies between main paints.
Overlay painters may read them (the mark tooltip reads `markScreen`) but must
never add to them, because overlay frames run without the main paint that
resets them. The overlay view therefore carries a per-frame scratch
`shapeScreen` that receives the draft ghost, and screenshots paint with
scratch lists throughout.

## Engine seams (`src/engine/ChartEngine.ts`, `src/engine/layers.ts`)

Each pane paints two stacked canvases (AD-04, W1B-07). The scene marks and the
overlay marks are listed in `FINANCE_LAYER_ORDER` (`src/engine/scene.ts`).

| Layer | Canvas | Paints | Repaints on |
| --- | --- | --- | --- |
| main | `engine.mainCanvas` (`.raze-chart-layer-main`, `aria-hidden`, no pointer events, `z-index: -1` in the host's isolated stacking context) | grid, volume, series, compares, studies, drawings, marks, axes, last price, trading lines, main axis-tag pass, separators | `markDirty()` / `requestPaint()`: data, viewport, scale, style, store, resize |
| overlay | `engine.canvas` (`.raze-chart-canvas`, the interactive element with the role, name, focus and listeners; the host's first canvas) | draft shape, timezone/countdown corner, crosshair and its pills, overlay axis-tag pass, legend values, mark tooltip | `markOverlayDirty()` / `requestOverlayPaint()`, and every main paint |

- `overlayHost`: see the context table. It sits directly above the
  interactive canvas in DOM order, so its interactive children follow the
  canvas in tab order.
- `paintHook` paints the main layer over the pane background;
  `overlayPaintHook` paints the overlay onto a cleared transparent bitmap.
  Without an overlay hook, `markOverlayDirty()` repaints the whole frame.
- `mainInvalidationCheck()`: consulted on overlay-only frames. The renderer
  compares the main-layer inputs a gesture can change without calling
  `markDirty()` (range, scale, style, bars, selection, hover target, ...), so
  a direct `visibleRange` write followed by an overlay request still repaints
  the scene. `ChartRenderer.requestPaint()` (the gesture host) asks for an
  overlay frame, or a full frame while a pointer is pressed because drags edit
  drawings in place. A press ends on `pointerup`, `pointercancel`, a window
  `blur`, or any pointer event reporting no button down (a hover move, the
  `lostpointercapture` after a release), so a release that never reached the
  window cannot pin every later hover frame to a full repaint.
- `onResize(size)`: called after the bitmaps are resized and before the
  synchronous repaint; the renderer keeps the bar spacing there (reason
  `resize`, anchored to the right edge). The adjustment is local to the pane:
  it fires `rangeChanged` but not `viewportChanged`, so layout sync does not
  relay it, and equal-width panes stay in sync because each rescales by the
  same ratio. A resize paints synchronously inside the `ResizeObserver`
  callback, so no presented frame shows a cleared bitmap, and one resize
  causes one paint in every pane.
- `paintStats` counts frames and main, overlay and resize paints for
  benchmarks and tests. `composite()` stacks the two layer bitmaps exactly
  as displayed (pixel checks). Screenshots and exports use
  `ChartRenderer.snapshot()` instead, which repaints both layers into a new
  alpha canvas (see the next point).
- The main context is created with `{ alpha: false }` when
  `theme.paneBackground` is opaque (`isOpaqueColor()`), and the bitmap is
  swapped for an alpha context when the background becomes translucent. The
  overlay always keeps alpha. Trade-off: Chromium draws text on an opaque
  canvas with LCD subpixel anti-aliasing (no context option or flag turns it
  off, `--disable-lcd-text` included), so axis labels on the scene layer are
  subpixel while overlay text (crosshair pills, legend) stays greyscale.
  `snapshot()` keeps exported PNGs
  greyscale, because colour fringes baked into a file look wrong once it is
  scaled or shown on another display.
- Pixels and events: `engine.canvas`, the first `canvas` in the host, holds
  only the overlay. Target `canvas.raze-chart-canvas` for input and focus,
  and read pixels through `composite()` or `snapshot()`, never from a single
  layer.

### View ranges (`src/engine/ChartRenderer.ts`)

- `fitContent()` (F, double-click, the sidebar Fit button, `chart.fitContent()`)
  shows every loaded bar: `fitAllRange()` spreads them at most
  `MAX_BAR_SPACING` apart, and may pack them tighter than `MIN_BAR_SPACING`,
  the gesture zoom-out limit (5,000 bars on a 1,000 px plot is 0.2 px per
  bar). The ALL preset and `setVisibleRange` can do the same.
- Every zoom gesture (wheel, `-`, pinch, time-axis drag) therefore treats the
  limit as "never zoom out past it", not "clamp to it": a zoom-out from a span
  already above `plotW / MIN_BAR_SPACING` holds the span, and a zoom-in steps
  in from it instead of jumping to the limit. W1B-10's `zoomSpan()`
  (`interaction/limits.ts`) implements the same rule for every writer; W2-04
  lowers the limit once level-of-detail painting makes dense views cheap.
- `resetView()` (`chart.resetView()`) returns to `DEFAULT_BAR_SPACING` per
  bar anchored to the latest bar. Both route through `setViewport` (reasons
  `fit` and `reset`) and `setScaleMode({ autoScale: true })`.

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
- **Temporary shim: drawing selection and tool events (W1B-10).**
  `DrawingEventsController` observes `context.selectedShapeId` and
  `context.drawingTool` by swapping them for accessors at attach (delegating
  to an accessor the context already defines) and restores them on destroy.
  It exists only because `context.ts` has no change delegates for these
  fields. Follow-up for the `context.ts` owner (W1B-07, then the W2-02
  viewport store): fire `selectionChanged` and `toolChanged` delegates from
  the context's own setters, and switch the controller to subscribing to them
  so it no longer redefines shared fields.
