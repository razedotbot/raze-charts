# Custom indicators

Raze Charts runs two indicator contracts side by side. Both register through
`raze.custom_studies` (or a `StudyRegistry`) and are created with
`chart.createStudy(name, forceOverlay, lock, inputs)`.

| Contract | Use it for | Inputs | Recompute |
| --- | --- | --- | --- |
| `StudyDefinition` (v1) | Simple overlays and oscillators; existing TradingView-style code | `defaults` shorthand, or a typed `inputs` schema | Full array after every data change |
| `defineIndicator()` (v2) | Typed plugins, multi-plot indicators, fills, live feeds | Typed schema with inferred value types | Full array, or one `update()` call per tick |

Everything on this page is exported from `@razedotbot/charts/studies`, which
has no DOM or widget code. A handle created there is a plain definition object,
so it works with the root widget bundle too.

## defineIndicator

```ts
import { defineIndicator, float, int, source, sourceValue } from "@razedotbot/charts/studies";

export const Envelope = defineIndicator({
  name: "Envelope",
  shortTitle: "ENV",
  pane: "overlay",
  inputs: {
    length: int(20, { min: 1, max: 500 }),
    percent: float(2.5, { min: 0, step: 0.1 }),
    src: source("close"),
  },
  plots: [
    { id: "upper", title: "Upper", style: "line", color: "#26a69a" },
    { id: "lower", title: "Lower", style: "line", color: "#ef5350" },
  ],
  fills: [{ id: "band", between: ["upper", "lower"], color: "#2962ff" }],
  compute: (bars, { length, percent, src }) => {
    const upper: (number | null)[] = [];
    const lower: (number | null)[] = [];
    let sum = 0;
    bars.forEach((bar, i) => {
      sum += sourceValue(bar, src);
      if (i >= length) sum -= sourceValue(bars[i - length]!, src);
      const mean = i + 1 >= length ? sum / length : null;
      upper.push(mean === null ? null : mean * (1 + percent / 100));
      lower.push(mean === null ? null : mean * (1 - percent / 100));
    });
    return { upper, lower };
  },
});
```

`defineIndicator()` validates the definition when it is called and throws a
`TypeError` that names the problem and the fix: unknown plot styles, duplicate
plot ids, fills that name undeclared plots, `update()` without `init()`,
unknown `dependsOn` entries, inverted ranges and so on. A malformed plugin
therefore fails at registration instead of drawing nothing. The returned handle
is frozen.

TypeScript infers everything from the definition: `inputs.length` is a
`number`, `inputs.src` is a `StudySource`, a `select(["sma", "ema"])` input is
`"sma" | "ema"`, and `compute()` must return exactly the declared plot ids.

### Incremental indicators

Give an indicator `init()` and `update()` instead of (or as well as)
`compute()` and it advances bar by bar:

```ts
import { defineIndicator, source, sourceValue } from "@razedotbot/charts/studies";

export const CumulativeDelta = defineIndicator({
  name: "Cumulative delta",
  pane: "pane",
  inputs: { src: source("close") },
  plots: [{ id: "delta", title: "Delta", style: "histogram" }],
  init: () => ({ total: 0, previous: Number.NaN }),
  update: ({ bar }, state, { src }) => {
    const value = sourceValue(bar, src);
    const total = Number.isNaN(state.previous) ? 0 : state.total + (value - state.previous);
    return { state: { total, previous: value }, values: { delta: total } };
  },
});
```

The contract:

- `update()` is called **once per appended bar** (`mode: "append"`) and **once
  per forming-bar replacement** (`mode: "replace-last"`). A live tick never
  triggers a full recompute.
- The runtime keeps two states: the state committed before the forming bar and
  the state after it. A replaced forming bar re-runs `update()` from the
  committed state; a new bar first promotes the forming state.
- `update()` must be **pure**: return a new state instead of mutating the one
  it receives. The committed state is frozen, so a mutation throws and the
  study reports the error (see [Errors](#errors)).
- Structural changes (history prepends, backfills, corrections, a new symbol
  or resolution) replay `update()` from `init()` over every bar. When the
  definition also has `compute()`, that is what `runIndicator()` uses for
  headless runs.

### Plots, fills and levels

| Descriptor | Fields | Painted today |
| --- | --- | --- |
| Plot | `id`, `title`, `style`, `color`, `lineWidth`, `lineStyle` (0 solid, 1 dotted, 2 dashed), `base`, `visible`, `trackPrice`, `inLegend` | `line`, `histogram` and `columns` (as bars). `step`, `area`, `circles`, `cross` and `shapes` paint as lines; the requested style travels on `StudySeries.plotStyle` for the plot painter. |
| Fill | `between: [plotA, plotB]` or `between: { levels: [a, b] }`, `color`, `title` | The first fill of a study is painted between its two edges. Further fills warn once at `defineIndicator()` time and are kept on the definition. |
| Level | `value`, `title`, `color`, `dashed`, `axisLabel` | Drawn as pane guides; `axisLabel` labels the pane axis. |

Hidden plots (`visible: false`) are computed but not painted; their values are
available on `StudyInstance.outputs[plotId]`. `range` pins a pane's value
range (for example 0-100) and `precision` sets the legend decimals.

## Inputs

Every input is a descriptor built by a helper:

| Helper | Type | Value | Notes |
| --- | --- | --- | --- |
| `int(14, { min, max, step })` | `int` | number | Rounds to the nearest integer, clamps to `min`/`max`. |
| `float(2, { min, max, step })` | `float` | number | Clamps to `min`/`max`. |
| `price(101.5, { min, max, step })` | `price` | number | A price in the symbol's units. |
| `time(1700000000)` | `time` | number | Unix seconds. |
| `bool(false)` | `bool` | boolean | Accepts `"true"`/`"false"` strings. |
| `source("close")` | `source` | `StudySource` | `open`, `high`, `low`, `close`, `hl2`, `hlc3`, `ohlc4`, `hlcc4`, `volume`; case-insensitive. Read it with `sourceValue(bar, src)`. |
| `select(["sma", "ema"], "ema")` | `select` | one of the options | Options may be `{ value, title }` objects. Defaults to the first option. |
| `color("#2962ff")` | `color` | string | Any CSS colour. |
| `session("0930-1600")` | `session` | string | `HHMM-HHMM`, with optional `:1234567` days, joined by `,` or `\|`, or `24x7`. |
| `symbol("SPY")`, `resolution("1D")`, `text("")` | text-like | string | Numbers are accepted and converted to strings. |

Each helper also takes `title`, `group`, `inline`, `tooltip` and `inLabel`.
Titles default to the humanised id (`fastLength` becomes "Fast length").
Input ids must match `[A-Za-z][A-Za-z0-9_]*` because saved layouts store them.

A v1 `StudyDefinition` can declare the same schema on `inputs`; it is
validated the same way and `compute()` receives every input.

### Resolution rules

`createStudy()`, `load()` and the store resolve inputs the same way:

1. Missing inputs (and `null`/`undefined` values) take their declared default.
2. Numeric strings are accepted for numeric inputs, `"true"`/`"false"` as
   well as real booleans for `bool` inputs, numbers for text-like inputs.
3. `int` values round; `int`, `float` and `price` values outside
   `min`/`max` are **clamped**, with a console warning that names the input.
4. TradingView positional ids (`in_0`, `in_1`, …) map onto the inputs in
   declaration order. So does TradingView's legacy positional array for a
   study with a schema: `createStudy("X", false, false, [30, "close"])` sets
   the first two declared inputs, and an array longer than the schema rejects
   with `unknown-input`. `positionalStudyInputs(schema, [30, "close"])` does
   the same mapping outside the widget. Studies without a schema (the
   built-ins today) do not map positional arrays yet; pass `{ length: 30 }`.
5. An unknown input id or a value of the wrong type (including objects,
   arrays and functions) **rejects** with a `StudyInputError`. Nothing a
   caller passes is dropped silently.

The classic shorthand still works: `createStudy("X", false, false, { length: 9, color: "#f00" })`
feeds a declared `length` input and a declared `color` input. A numeric string
length (`"9"`) is used as the length; any other non-numeric `length`, `Length`
or `periods`, or a `color` that is not a string, rejects with `invalid-value`
instead of falling back to the default.

For v1 definitions without a schema, `compute()` receives
`{ ...defaults, ...inputs, length }` (every default except `color`), and the
same effective inputs are what `save()` stores. Numbers, strings and booleans
are forwarded; any other value rejects with `invalid-value`.

### Restoring saved layouts

Restores are lenient, so a plugin whose schema evolved cannot break a saved
layout. `load()`, `StudyStore.restore()` and undo/redo resolve saved inputs
with `invalidInputs: "default"`: an input id the definition no longer
declares is dropped, and a value that no longer validates (a removed select
option, a changed type) is replaced by its declared default. The other inputs,
the other studies and the drawings are restored as saved. Each affected study
logs one warning naming the study, every dropped or reset input and the fix
(save the layout again), and records the same text on
`StudyInstance.inputWarning` until its inputs are next edited.
`createStudy()` and `StudyStore.update()` stay strict. `StudyStore.add()` is
strict unless its spec sets `invalidInputs: "default"`.

### Errors

`StudyInputError` extends `TypeError`. `createStudy()` rejects with it and
`StudyStore.add()` throws it; `load()` never does (see
[Restoring saved layouts](#restoring-saved-layouts)). The root entry and `/studies` are separate
bundles, each with its own copy of the class: use `instanceof` with the class
from the entry that threw (the root for `createStudy()`), or test
`error.name === "StudyInputError"`.

| `code` | When | Example message |
| --- | --- | --- |
| `invalid-schema` | A definition declares a malformed input: bad id, unknown type, invalid default, `min > max`, empty or duplicate select options. Thrown by `defineIndicator()`, `normalizeInputSchema()`, or the first use of a v1 schema. | `study "X" input "n": default 0 is outside [1, ∞]` |
| `unknown-input` | The caller passed an id the schema does not declare. | `study "X" input "lenght": unknown input. Supported inputs: length, src` |
| `invalid-value` | A value has the wrong type or is not one of the options. | `study "X" input "src": expected one of open, high, …, got "typical"` |

The error carries `code`, `study` and `input` (null for schema-level problems).

Compute failures are not thrown to the caller: the study keeps its id, paints
nothing, logs one warning, records the message on `StudyInstance.error` and
publishes an `error` change (see [Change stream](#change-stream)). The next
data change retries.

### Typed createStudy

Register a study's input types once and `createStudy()` rejects typos and
wrongly typed inputs at compile time:

<!-- prelude: indicator -->
```ts
import type { StudyInputsOf } from "@razedotbot/charts";

declare module "@razedotbot/charts" {
  interface StudyInputsRegistry {
    Envelope: StudyInputsOf<typeof Envelope>;
  }
}

chart.createStudy("Envelope", false, false, { length: 50, src: "hl2" }); // ok
// @ts-expect-error `length` must be a number
chart.createStudy("Envelope", false, false, { length: "50" });
// @ts-expect-error `lenght` is not an input of Envelope
chart.createStudy("Envelope", false, false, { lenght: 50 });
```

Names that are not registered keep the open TradingView input map.

## Compute context

`compute(bars, inputs, ctx)`, `init(inputs, ctx)` and `update(input, state, inputs, ctx)`
receive a frozen, live view of the chart:

| Field | Meaning |
| --- | --- |
| `symbol`, `symbolInfo` | The chart symbol and its resolved `LibrarySymbolInfo` (pricescale, session, timezone). |
| `resolution` | The chart resolution. |
| `timezone` | The resolved IANA zone (`exchange` and an unset option resolve to the symbol's zone). |
| `visibleRange` | The visible bar-index window, only for definitions with `dependsOn: ["visibleRange"]`; otherwise null. |
| `formatPrice(price)` | The chart's price formatter with the symbol's pricescale. |
| `now()` | Server-corrected wall clock in milliseconds. |
| `requestRecompute()` | Ask for a throttled full recompute, for example after an async resource resolves. |

`dependsOn: ["visibleRange"]` recomputes the study when the chart pans or
zooms, and `dependsOn: ["timezone"]` when the display timezone changes. The
store listens to both viewport events, so drag, wheel, pinch, keyboard and
axis-scale gestures, range presets and `setVisibleRange()` all count; the
F-key/double-click fit still writes the range without an event until it moves
to `setViewport()`. Context-driven recomputes are throttled to one pass per
100 ms; a burst of pan events costs one recompute with the latest range.
Symbol and resolution changes reload the bars, which recomputes every study.

Outside a widget, `createStudyContext({ symbolInfo, resolution, timezone })`
builds a context and `runIndicator(definition, bars, inputs, ctx)` returns one
aligned array per plot, which is handy for tests, servers and screeners.

## Store, undo and persistence

`StudyStore` (root entry) owns the live studies of one widget:

- Ids come from the widget's `IdAllocator`, so two widgets that perform the
  same operations produce the same ids (`study_ema_1`, `study_rsi_2`, …), and
  restored ids are reserved.
- Undo history stores **specs** (id, name, length, colour, flags, inputs,
  plot overrides), never computed arrays. Adding then removing six studies on
  500k bars retains well under 2 MB. Undo and redo recompute and restore the
  original ids.
- The history is capped (`raze.undo_limit`, default 100; `CommandStack`'s
  `limit`), dropping the oldest steps first.
- `update(id, { inputs, length, color, plots })` edits a study in place with
  one undo step and the same validation as `createStudy()`.
- `add({ …, invalidInputs: "default" })` restores leniently, like `load()`
  (see [Restoring saved layouts](#restoring-saved-layouts)).
- `add({ …, disableUndo: true })` skips the undo step (TradingView
  `options.disableUndo`), and `plots: { [plotId]: { color, lineWidth, lineStyle, visible } }`
  overrides plot styles.
- `save()` stores the effective inputs, booleans included, and `load()`
  resolves them through the same rules, leniently.

### Change stream

`store.changed` is a `Delegate<[StudyChange]>` that fires `add`, `remove`,
`inputs`, `style`, `values` and `error` changes with the study id (and the
message for `error`). The legend, objects tree and host event bridges build on
it.

## Settings forms

`studyInputFields(schema, values)` turns a schema into a DOM-free form model:
one field per input with its control kind (`number`, `checkbox`, `select`,
`color`, `text`, `datetime`), title, bounds, precision, options, group,
inline row and tooltip. `createStudyInputsForm()` (`src/ui/StudyInputsForm.ts`,
the building block for the study settings dialog) renders that model with the
UI kit: labelled kit controls,
`<fieldset>` groups, shared inline rows, UTC date-times for `time` inputs,
and inline validation messages. Each control has its own message under it,
announced as an alert and linked through `aria-errormessage`, so two invalid
fields keep two messages. Every edit resolves through the rules above, so
what the form commits is exactly what `createStudy()` accepts.

Input titles, groups and tooltips come from the plugin and are shown verbatim:
localise them in the definition. The form's own labels (source names, the
`(UTC)` suffix) go through the library's `t()` catalogue.
