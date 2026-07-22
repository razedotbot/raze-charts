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
- **Chart API:** `resolution`, `onIntervalChanged().subscribe`, `createShape` /
  `createMultipointShape` (horizontal_line, trend_line, fib, rectangle, text),
  `getShapeById().setPoints/getPoints`, `removeEntity`, `clearMarks`,
  `refreshMarks`, `resetData`, `getVisibleRange`/`setVisibleRange`,
  `createStudy` (EMA/SMA/RSI).
- **Datafeed:** drives any `IBasicDataFeed` — `onReady`, `resolveSymbol`,
  `getBars` (initial + lazy left-scroll pagination), `subscribeBars`/
  `unsubscribeBars` (live), `getMarks`.
- **Rendering:** candlesticks / line / area / heikin ashi + volume, crosshair,
  price/time scales (linear / log / %), OHLC legend, bar marks with hover
  tooltip, horizontal + multipoint shapes with drag, theming via overrides and
  CSS custom properties, seconds resolution, autosize, loading screen,
  pan/zoom/fit.
- **Chrome (TV parity):** left sidebar (drawings + Indicators + fit/screenshot/
  fullscreen + chart type), header interval selector, bottom `%` / `log` /
  `auto` scale bar. Keyboard: arrows pan, `+`/`-` zoom, `f` fit, `Esc` cancel,
  `Delete` remove selected shape. Hidden when `left_toolbar` /
  `header_widget` are in `disabled_features`.

## Roadmap (2026-07-22)

| Phase | Focus | Status |
|-------|--------|--------|
| 0 | Drop-in freeze, build/sync/smoke `:3111` | baseline |
| 1 | Indicators: EMA/SMA overlay, RSI pane | **done** |
| 2 | Drawings: trend_line, fib, rectangle, text + left sidebar | **done 2026-07-22** |
| 3 | Chart types: line / area / heikin ashi | **done 2026-07-22** |
| 4 | UX: keyboard, fit, fullscreen, screenshot, log/%, label declutter | **done 2026-07-22** |
| 5 | Close remaining TVChart API stubs | continuous |

Indicators live in the **left sidebar** (not the header).

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
  studies/   SMA/EMA/RSI calc + StudyStore
  ui/        Toolbar, LeftSidebar, IndicatorsMenu, ScaleBar, LoadingScreen, ContextMenu
  util/      delegate, resolution, format, heikinAshi
```

## License

MIT — see [LICENSE](./LICENSE).
