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
  `Delete` remove selection. **Fully composable** — see
  [Configuring the chrome](#configuring-the-chrome).
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

## Configuring the chrome

Every visible piece — options, buttons, sidebar, indicators — is data-driven.
The defaults reproduce the stock chrome; each knob below is optional and typed
(`RazeChartsOptions` in the bundled `.d.ts`).

```ts
new widget({
  // ...standard TradingView options...

  // TV-compatible: which intervals sit inline in the header row.
  favorites: { intervals: ["1S", "1", "5", "15"] as ResolutionString[] },

  // TV-compatible granular hiding (all default-on):
  //   header_widget · header_resolutions · left_toolbar · legend_widget · scale_bar
  disabled_features: ["scale_bar"],

  raze: {
    // Sidebar layout: builtin ids, "separator", or your own buttons.
    sidebar: [
      "cursor", "trend_line", "horizontal_line",
      "separator",
      "indicators",
      { id: "alerts", title: "Alerts", icon: "<svg…>", onClick: () => openAlerts() },
      "separator",
      "fit", "screenshot", "fullscreen", "chart_type",
    ],

    // Chart-type picker whitelist (default: all four).
    chart_types: ["candles", "line"],

    // Rows of the Indicators panel (default: EMA 9/21, SMA 20/50, RSI 14,
    // plus one row per custom study).
    indicator_presets: [
      { name: "EMA", length: 9 },
      { name: "EMA", length: 21, color: "#26a69a" },
      { label: "Momentum", name: "MOM", length: 10 },
    ],

    // Register your own indicators — same shape as the built-ins. `pane:
    // "overlay"` draws on the price pane; `pane: "pane"` gets its own
    // sub-pane with optional fixed range, guide levels and label.
    custom_studies: [
      {
        name: "MOM",
        pane: "pane",
        defaults: { length: 10, color: "#8ecae6" },
        levels: [{ value: 0, dashed: true, axisLabel: true }],
        compute: (bars, { length }) =>
          bars.map((b, i) => (i < length ? null : b.close - bars[i - length].close)),
      },
    ],
  },
});
```

Custom studies are first-class: `createStudy("MOM")` resolves them, the
Indicators panel lists them, the legend shows their values, and pane studies
render with auto-fit or fixed ranges. Sidebar items, interval favorites,
built-in study catalogue (`BUILTIN_STUDIES`, `StudyRegistry`) and preset
defaults (`DEFAULT_SIDEBAR_ITEMS`, `DEFAULT_INDICATOR_PRESETS`,
`DEFAULT_INTERVAL_FAVORITES`) are all exported for composition.

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
welcome): the full ~70 TradingView drawing-tool set, TradingView's built-in
studies library (bring your own via `raze.custom_studies` — each pane study
gets its own sub-pane), compare/multi-symbol, save/load layouts, study
templates. Where TradingView types are enormous unions, the bundled
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
