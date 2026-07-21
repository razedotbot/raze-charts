# @raze/charts

An open, **Canvas-2D financial charting library** — a clean-room, dependency-free
replacement for the (closed-source, un-publishable) TradingView Charting Library,
built to be a **drop-in** for the widget API surface that
[app.raze.bot](https://app.raze.bot) uses.

It is *not* a reimplementation of all of TradingView. It implements exactly the
API and rendering features the Raze app relies on, so the existing
`import { widget } from ".../charting_library.esm"` and the `charting_library.d.ts`
type imports keep working unchanged when this package replaces the vendored
library.

## What it does

- **Widget API:** `new widget(options)`, `onChartReady`, `headerReady`,
  `activeChart()`/`chart()`, `createButton`, `setCSSCustomProperty`,
  `subscribe("drawing_event")`, `onContextMenu`, `remove`.
- **Chart API:** `resolution`, `onIntervalChanged().subscribe`, `createShape`
  (`horizontal_line` + overrides + drag), `getShapeById().setPoints/getPoints`,
  `removeEntity`, `clearMarks`, `refreshMarks`, `resetData`,
  `getVisibleRange`/`setVisibleRange`.
- **Datafeed:** drives any `IBasicDataFeed` — `onReady`, `resolveSymbol`,
  `getBars` (initial + lazy left-scroll pagination), `subscribeBars`/
  `unsubscribeBars` (live), `getMarks`.
- **Rendering:** candlesticks + volume, crosshair with axis labels, price/time
  scales with `pricescale`/`minmov`-aware formatting, OHLC legend, bar marks
  (`mark_on_bars`), horizontal-line shapes with drag, theming via `overrides`
  and CSS custom properties, seconds resolution, autosize, loading screen,
  pan/zoom/fit.

It does **not** (by design, matching the app's *API* usage) fully implement
the full drawing-tool suite, multi-pane layouts beyond RSI, or save/load.
**Indicators (Fase 1, 2026-07-21):** EMA/SMA overlays + RSI sub-pane via toolbar
"Indicators" menu and `chart.createStudy("EMA"|"SMA"|"RSI", …)`. Roadmap:
vault `2026-07-21-raze-charts-tv-parity-roadmap`.

## Roadmap (2026-07-21)

| Phase | Focus | Status |
|-------|--------|--------|
| 0 | Drop-in freeze, build/sync/smoke `:3111` | baseline |
| 1 | Indicators: EMA/SMA overlay, RSI pane | **done 2026-07-21** |
| 2 | Drawings: trend_line, fib, rectangle, text | **next** |
| 3 | Chart types: line / area / heikin ashi | queued |
| 4 | UX: keyboard, fit, fullscreen, screenshot | queued |
| 5 | Close remaining TVChart API stubs | continuous |

## Build

```bash
npm install
npm run build      # → dist/charting_library.{esm,cjs,standalone}.js + .d.ts
npm test           # build + headless jsdom smoke test of the full lifecycle
npm run dev        # watch mode
```

## Try it

Open `examples/index.html` in a browser (served over http) — it mounts a
full chart against a synthetic datafeed using the same options as the Raze app.

## Layout

```
src/
  index.ts                 public entry — exports { widget, version }
  types/charting_library.d.ts  hand-authored public types (copied to dist)
  core/      Widget, ChartApi, ShapeStore, context, theme
  data/      DataManager (datafeed orchestration, bar store, pagination, live)
  engine/    ChartEngine (canvas/rAF), ChartRenderer (draw + interaction)
  ui/        Toolbar, LoadingScreen, ContextMenu
  util/      delegate, resolution, format
```

## License

MIT — see [LICENSE](./LICENSE).
