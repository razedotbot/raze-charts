# raze-charts

An open, **dependency-free Canvas-2D financial charting library** with a
widget API **drop-in compatible** with the TradingView Charting Library.

Built for and battle-tested on [app.raze.bot](https://app.raze.bot), where it
renders live sub-second candles for on-chain markets. Runtime dependencies:
**zero**. ESM bundle: **~70 KB** minifiable, sourcemapped, tree-shakeable.

> **Not affiliated with TradingView.** This is an independent, clean-room
> implementation of a *subset* of the widget API surface published in the
> TradingView Charting Library type definitions. It contains no TradingView
> code or assets. "TradingView" is a trademark of TradingView, Inc.

## Why

The TradingView Charting Library is closed-source and cannot be redistributed,
which makes it awkward for open-source apps and self-hosted deployments. If
your integration uses the common widget surface — `new widget(...)`, a
`IBasicDataFeed` datafeed, shapes, marks, studies — this package replaces the
vendored library without touching consumer code.

## Features

- **Widget API:** `new widget(options)`, `onChartReady`, `headerReady`,
  `activeChart()`/`chart()`, `createButton`, `setCSSCustomProperty`,
  `subscribe("drawing_event")`, `onContextMenu`, `remove`.
- **Chart API:** `resolution`, `onIntervalChanged().subscribe`, `createShape` /
  `createMultipointShape` (horizontal_line, trend_line, fib_retracement,
  rectangle, text), `getShapeById().setPoints/getPoints`, `removeEntity`,
  `clearMarks` / `refreshMarks`, `resetData`, `getVisibleRange` /
  `setVisibleRange`, `createStudy` (EMA / SMA / RSI).
- **Datafeed:** drives any `IBasicDataFeed` — `onReady`, `resolveSymbol`,
  `getBars` (initial + lazy left-scroll pagination), `subscribeBars` /
  `unsubscribeBars` (live ticks), `getMarks`.
- **Rendering:** candlesticks / line / area / heikin ashi + volume, crosshair,
  draggable price/time scales (linear / log / %), OHLC legend, bar marks with
  hover tooltip, shape drag editing, seconds resolutions, autosize,
  loading screen, pan/zoom/fit.
- **Chrome:** left sidebar (drawing tools, indicators, fit / screenshot /
  fullscreen, chart type), header interval selector, bottom `%` / `log` /
  `auto` scale bar. Keyboard: arrows pan, `+`/`-` zoom, `f` fit, `Esc` cancel,
  `Delete` remove selection. Chrome hides via `disabled_features`
  (`left_toolbar`, `header_widget`).
- **Theming:** TradingView-style `overrides` keys, `theme: "dark" | "light"`,
  CSS custom properties, custom fonts.

## Install

```bash
npm i github:razedotbot/raze-charts   # builds on install (prepare script)
```

Or clone and build:

```bash
git clone https://github.com/razedotbot/raze-charts
cd raze-charts && npm install && npm run build
```

`dist/` then contains `charting_library.esm.js` (+ `.cjs.js`,
`.standalone.js`, the drop-in `charting_library.d.ts`, and generated
`types/` for the modular API).

## Use

### As a package

```ts
import { widget } from "@raze/charts";

const w = new widget({
  container: document.getElementById("chart")!,
  symbol: "MYTOKEN",
  interval: "1S" as ResolutionString,
  datafeed: myDatafeed,          // any TradingView-style IBasicDataFeed
  autosize: true,
  theme: "dark",
  enabled_features: ["seconds_resolution", "mark_on_bars"],
});
w.onChartReady(() => w.activeChart().createStudy("EMA", false, false, { length: 21 }));
```

### As a `<script>` tag

`charting_library.standalone.js` assigns `window.TradingView.widget`, mirroring
the TradingView standalone bundle:

```html
<script src="/static/charting_library.standalone.js"></script>
<script>new TradingView.widget({ /* ... */ });</script>
```

### Drop-in replacement for a vendored TradingView library

Keep every existing import and swap the module at bundle time. Webpack / Next:

```js
// next.config.js — behind an env flag, e.g. NEXT_PUBLIC_CHART_ENGINE=raze
config.plugins.push(
  new webpack.NormalModuleReplacementPlugin(
    /charting_library[\\/]charting_library\.esm(\.js)?$/,
    path.resolve(__dirname, "public/static/raze_charts/charting_library.esm.js"),
  ),
);
```

`scripts/sync-to-app.mjs` copies the built bundle + `.d.ts` into a host app
(`node scripts/sync-to-app.mjs <appDir> [subdir]`). Type imports keep pointing
at the TradingView `charting_library.d.ts` superset or at the bundled drop-in
`.d.ts` — both compile.

## Modular API

Everything the widget is made of is exported à la carte, fully typed:

```ts
// Indicator math — pure functions, no DOM
import { ema, sma, rsi, closesFromBars, heikinAshi } from "@raze/charts";

// Datafeed orchestration without the widget shell (pagination + live merge)
import { DataManager } from "@raze/charts";

// Engine + renderer for a custom shell
import { ChartEngine, ChartRenderer, ShapeStore, StudyStore } from "@raze/charts";

// Formatting / resolution helpers
import { formatPrice, formatCompact, parseResolution, resolutionToMs } from "@raze/charts";
```

UI chrome (`Toolbar`, `LeftSidebar`, `IndicatorsMenu`, `IntervalSelector`,
`ScaleBar`, `LoadingScreen`) and theming (`buildTheme`, `withAlpha`) are
exported too. `sideEffects: false` — bundlers drop whatever you don't import.

## Examples & tests

```bash
npm test                        # build + headless jsdom smoke of the full widget lifecycle
python3 -m http.server 8799     # then open http://localhost:8799/examples/index.html
```

`examples/index.html` mounts a full chart against the synthetic
`examples/mock-datafeed.mjs` (random-walk OHLCV + 1 s live ticks).
`examples/snap.mjs` / `examples/drag-axis.mjs` are optional Playwright visual
checks against that page.

## Scope

Implemented: the API surface above. **Not** implemented (by design, PRs
welcome): the full ~70 TradingView drawing-tool set, the full studies library,
multi-pane beyond the RSI pane, compare/multi-symbol, save/load layouts,
study templates. Where TradingView types are enormous unions, the bundled
`.d.ts` uses permissive index signatures so existing consumer code
type-checks without enumerating thousands of keys.

## Development

```bash
npm run dev        # esbuild watch
npm run typecheck  # tsc strict, no emit
npm test           # build + smoke
```

Layout:

```
src/
  index.ts                     public entry — widget + modular named exports
  types/charting_library.d.ts  hand-authored drop-in types (copied to dist)
  core/      Widget, ChartApi, ShapeStore, context, theme
  data/      DataManager (datafeed orchestration, bar store, pagination, live)
  engine/    ChartEngine (canvas/rAF loop), ChartRenderer (draw + interaction)
  studies/   SMA/EMA/RSI calc + StudyStore
  ui/        Toolbar, LeftSidebar, IndicatorsMenu, IntervalSelector, ScaleBar, …
  util/      delegate, resolution, format, heikinAshi
```

## License

MIT — see [LICENSE](./LICENSE).
