# Drawings

Every drawing kind is a tool definition in one page-wide registry. The built-in
tools use exactly the same contract as tools you register. There are no
per-kind branches in the paint or hit-testing code, so a registered tool is
painted, hit-tested, drafted with its own anchor count, undone, listed in the
objects tree and saved/loaded like a built-in one.

- Contract: `src/drawings/types.ts` (`DrawingToolDefinition`).
- Registry: `src/drawings/registry.ts`.
- Built-in tools: `src/drawings/tools/*`.
- Runtime (paint order, handles, hit seams, axis tags): `src/engine/paint/shapes.ts`.

## Built-in tools

| Tool id | Anchors | Aliases | Style properties (TradingView names) |
| --- | --- | --- | --- |
| `trend_line` | 2 | | `linecolor`, `linewidth`, `linestyle`, `extendLeft`, `extendRight` |
| `ray` | 2 | | as `trend_line`; `extendRight` defaults to `true` |
| `extended_line` | 2 | `extended` | as `trend_line`; both extensions default to `true` |
| `horizontal_line` | 1 | | `linecolor`, `linewidth`, `linestyle`, `showPrice`, `textcolor`, `fontsize`, `bold`, `italic` |
| `vertical_line` | 1 | | `linecolor`, `linewidth`, `linestyle` |
| `rectangle` | 2 | | `linecolor`, `linewidth`, `linestyle`, `backgroundColor`, `fillBackground`, `transparency` |
| `fib_retracement` | 2 | | `linecolor`, `linewidth`, `linestyle`, `levels`, `reverse`, `extendLines`, `showCoeffs`, `showPrices`, `fillBackground`, `transparency` |
| `measure` | 2 | `date_and_price_range` | `linecolor`, `linewidth`, `linestyle`, `fillBackground`, `transparency` |
| `text` | 1 | | `color` (or `textcolor`, then `linecolor`), `fontsize`, `bold`, `italic`, `backgroundColor`, `fillBackground`, `borderColor`, `drawBorder`, `wordWrap`, `wordWrapWidth` |

Conventions shared by every tool:

- `linestyle` uses TradingView numbering: `0` solid, `1` dotted, `2` dashed,
  `3` large dashed and `4` sparse dotted. Dash lengths scale with `linewidth`.
- An empty or unset colour follows the theme. Lines use the
  `drawingDefault` token (`#2962ff`), which UI-created and API-created
  drawings share. Text uses `labelText`.
- `transparency` runs from `0` (opaque) to `100` (invisible), as in TradingView.
- Every drawing is clipped to the price plot. Rays and extended lines are
  clipped exactly at the plot edges (Liang-Barsky), so they stay visible at
  any zoom, even when their anchors are far off-screen.
- Everything a tool paints can be hit: the extensions of rays and extended
  lines, every fib level line, a text label's measured box (never the empty
  space next to it) and a filled rectangle's interior.
- Handles appear only while a drawing is hovered or selected. They are rings
  filled with the pane background and outlined in the drawing's colour. A
  selected drawing gets larger handles and a soft halo in its own colour.
- Drawings paint in store z order (`zOrder`, then creation order) whatever
  their kind. Horizontal lines no longer always paint on top.

### Tool-specific behaviour

- **Fib retracement** follows TradingView's direction: level `1` sits at the
  first anchor and level `0` at the second. A fib drawn from a low to a high
  therefore labels the high 0% and puts 61.8% at `high - 0.618 × range`.
  `reverse: true` flips it. Earlier releases put level 0 at the first anchor,
  so a layout saved by those releases shows its levels mirrored unless you
  add `reverse: true`. Levels are computed in price space, so they stay exact
  on log and percent scales. `levels` takes `{ value, color?, visible? }` rows.
- **Measure** shows the price change formatted with the symbol's formatter
  (`pricescale`, `custom_formatters`, `raze.format_price`), the percentage
  change, and `<n> bars, <span>` (for example `42 bars, 42d`). The label sits
  on a theme backdrop above a rise or below a fall, kept inside the plot.
- **Text** is anchored at its top-left corner. `\n` starts a new line and
  `wordWrap` wraps at `wordWrapWidth` CSS px. The backdrop is on by default
  and uses the `labelBackground` token. The text colour is `color`, then its
  TradingView alias `textcolor`, then `linecolor`, which earlier releases
  painted text with (text drawn from the toolbar was saved with a
  `linecolor`), so saved layouts keep their colours. With none of them set,
  text uses the `labelText` token.
- **Horizontal line** queues its `showPrice` tag on the frame's axis-tag list
  (`view.axisTags`). The axis-overlay pass paints that list after the price
  axis, so the tag is never hidden under the axis. Labels of lines closer
  than 14px are stacked.

## Theme tokens

| Token | Override key | Default |
| --- | --- | --- |
| `drawingDefault` | `drawings.defaultColor` | `#2962ff` in both themes |
| `handleFill` | `drawings.handleFillColor` | the pane background |
| `handleStroke` | `drawings.handleBorderColor` | unset: each drawing's own colour |
| `labelBackground` | `drawings.labelBackgroundColor` | the pane background at 92% opacity |
| `labelText` | `drawings.labelTextColor` | `#d1d4dc` on dark backdrops, `#131722` on light ones (≥ 4.5:1) |

Pass the keys through the widget `overrides` option.

## Registering a tool

```ts
import { defineDrawingTool } from "@razedotbot/charts";

defineDrawingTool({
  id: "acme_triangle", // [a-z][a-z0-9_]*, stored in saved layouts
  title: "Triangle",
  icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 3L15 15H3Z" stroke="currentColor"/></svg>',
  group: "shapes",
  anchors: 3, // or { min: 2, finish: "double-click" } for a free-form path
  props: {
    linecolor: { type: "color", title: "Line color", default: "" },
    fill: { type: "boolean", title: "Fill", default: true },
  },
  paint(ctx, drawing, { anchors }, env) {
    const points = anchors.filter((p) => p !== null);
    if (points.length < 2) return;
    ctx.strokeStyle = drawing.props.linecolor || env.theme.drawingDefault;
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
  },
  hitTest(point, drawing, { anchors }, env, tolerance) {
    // Return { kind: "anchor", index }, { kind: "body" }, { kind: "label" } or null.
    return null;
  },
});
```

- `paint` runs inside `save()`/`restore()`, clipped to the plot, with the
  anchors mapped to CSS pixels. An anchor is `null` when it cannot be mapped.
  `env` provides the theme tokens, the symbol's price formatter, the duration
  formatter, the bar spacing, coordinate converters and `pushAxisTag()` for
  axis pills. Pair every `save()` with a `restore()` in your own code. If
  `paint` throws, or leaves its saves unbalanced, the runtime unwinds the
  canvas to its own saved state. The rest of the frame keeps its clip and
  styles, and a throwing tool is skipped with a one-time warning.
- `hitTest` must hit what `paint` draws. The runtime publishes it as
  `ShapeHit.hitTest` with the drawing's `z`, so gestures can hit-test
  topmost-first against the geometry of the last frame.
- The optional hooks are `handles` (defaults to the anchors), `constrain`
  (adjusts a dragged or drafted anchor), `validateProps` and `describe`.
- Registration throws a `TypeError` that names the problem. That covers an
  invalid id, an id or alias that is already registered, icon markup with
  scripts, event handlers, links or `url()`, a bad anchor spec, missing
  `paint`/`hitTest`, and property defaults that do not match their field type.
  Registering an identical definition again (the same object, or the same
  field values) does nothing.
- Development reloads (HMR) run your module again and build a new definition
  with new functions, which would throw as an id that is already registered.
  Pass `{ replace: true }` to swap it in place:
  `defineDrawingTool(definition, { replace: true })`. Existing drawings of that
  kind keep their data and use the new definition from the chart's next
  frame, and `onDrawingToolsChanged` listeners are notified. Built-in tools
  cannot be replaced.
- A saved drawing whose kind is not registered stays in the store and in
  `save()` output, but it is not painted. The chart warns once and names the
  registered kinds.

Other registry functions: `getDrawingTool(idOrAlias)`, `listDrawingTools()`,
`drawingToolDefaults(id)`, `removeDrawingTool(id)` (host tools only) and
`onDrawingToolsChanged(listener)`.

### Current limits

- Tools registered at runtime do not get a left-sidebar button yet, because
  the sidebar still lists the built-in ids. Until it reads the registry,
  create these drawings through `createMultipointShape(points, { shape: "<id>" })`.
  Once created, they select, drag, undo and save/load like built-ins.
- Free-form tools (`anchors: { min, finish }`) collect points, but finishing
  them with a double-click or Enter depends on the drafting interaction.
