# Accessibility guide

Raze carries accessibility metadata through definitions and provides keyboard
and semantic behavior for its built-in financial UI. That is a baseline for a
good integration, not a blanket WCAG conformance claim for every chart, theme,
dataset, and host application.

## Native SVG and Canvas charts

Always replace the generic `"Chart"` fallback with a useful accessible name.
Use `ariaDescription` for the message a visual reader would infer from trend,
unit, period, or comparison.

```ts
const definition = defineChart({
  marks: [line(revenue, { x: "month", y: "value", name: "Revenue" })],
  ariaLabel: "Monthly revenue in euros",
  ariaDescription: "Revenue increased from January through March 2026.",
});
```

SVG output uses `role="img"`, `aria-label`, and a linked SVG description when
provided. Mounted Canvas output uses the same image semantics and a visually
hidden bounded summary derived from the description, series names, and values.
This keeps renderer choice from dropping the chart's high-level meaning.

Default series palettes are tuned for colour-vision deficiencies: every pair of
slots stays distinguishable under simulated protanopia, deuteranopia and
tritanopia. Gains/losses, heatmaps and the scatter ramp use the theme's
`accent` and `down` tokens, green and red by default. Pass
`theme: COLORBLIND_CHART_THEME` (or `COLORBLIND_LIGHT_CHART_THEME`) to switch
those encodings to blue and orange, or spread a preset to adjust single
tokens:

```ts
import { COLORBLIND_LIGHT_CHART_THEME, defineChart, heatmap } from "@razedotbot/charts/chart";

const definition = defineChart({
  marks: [heatmap(returns, { x: "month", y: "asset", valueKey: "change" })],
  theme: { ...COLORBLIND_LIGHT_CHART_THEME, font: "Inter, sans-serif" },
});
```

Mounted charts put a native toggle button over each series legend entry on
both renderers. The buttons sit in a labelled "Series" group, are named by the
series, expose visibility through `aria-pressed`, and toggle with Enter or
Space. On a pie, each button toggles one slice. The buttons are the only
interactive element per entry and take no pointer events: a mouse click or a
tap lands on the painted entry itself (the SVG row or the Canvas pixels), so
no second hit target is stacked over it, and the mount shows the pointer
cursor there. A legend press toggles the series and does not also fire
`onSelect`. The static SVG markup itself carries no pointer cursor. The
`+N more` summary is translated through `chart.legend.more`. Range presets are a labelled group of pressed-state buttons
whose active indicator keeps at least 3:1 contrast against the pane in light
and dark themes.

Pointer tooltips are not a screen-reader data browser. When exact values or
point-by-point comparison are necessary, render an adjacent HTML table or
textual summary from the same source data. Keep that representation available
without hover, fine pointer control, or color perception.

## Financial widget

Set the accessible name and summary under `raze`:

```ts
new widget({
  // ...required widget options
  raze: {
    aria_label: "ETH/USD one-minute financial chart",
    aria_description: "Live candlesticks in US dollars with volume and EMA 21.",
  },
});
```

Without a custom name, the widget uses `"<symbol> financial chart"` and updates
that default after `setSymbol()`. The root is a named region. The focusable
Canvas is exposed as an interactive financial chart, links to a hidden
description, includes fallback text, advertises keyboard shortcuts, and uses a
polite live status for the result of keyboard actions.

When the Canvas has focus:

| Key | Action |
| --- | --- |
| Left / Right Arrow | Pan the visible range (announces the start or end of the data at the pan bound) |
| Up / Down Arrow | Move a selected editable trading line by one minimum tick (Shift = 10 ticks) |
| `+` / `-` | Zoom in / out (announces when the zoom limit is reached) |
| `F` | Fit all loaded data (every loaded bar in view, price autoscale on); double-click in empty plot does the same |
| Escape | Cancel an in-progress drag (drawing, trading line, pan or axis), restoring the previous state; otherwise (including a press that has not moved yet) cancel the active drawing and clear selection |
| Delete / Backspace | Remove the selected drawing or cancel the selected trading order |
| Ctrl/Cmd+Z | Undo the last drawing or study command |
| Ctrl/Cmd+Shift+Z or Ctrl+Y | Redo |

Keyboard actions announce concise state changes without moving focus. Pointer
down moves focus to the Canvas without a visible ring. Keyboard focus (Tab or
a subsequent key press) receives a visible ring.

Text drawings are typed into a labelled inline editor ("Drawing text") placed
at the anchor: Enter commits, Shift+Enter adds a line, Escape cancels, and
moving focus away commits. Keys typed there never reach chart shortcuts, and
focus returns to the Canvas afterwards. Double-clicking a text drawing
re-opens the editor. Timescale-mark and trading-line tooltips render as
`role="tooltip"` elements referenced from the Canvas's `aria-describedby`
while visible, instead of `title` attributes.

## Built-in chrome

The header, left tools, and scale controls expose named toolbar/group semantics
and orientation. Controls use native buttons with accessible labels and state:

- interval selection exposes the current item;
- timeframe presets and go-to-date are a labelled range group;
- symbol search is a labelled search field when the header search feature is on;
- drawing, magnet, stay-in-mode, objects-tree, and scale toggles expose pressed/checked state;
- decorative icons are hidden from assistive technology;
- left-toolbar buttons show a themed tooltip (kit `attachTooltip`, no `title`
  attributes) after 500ms of hover, on keyboard focus, or on a touch
  long-press (which does not activate the button). It sits to the right of
  the toolbar, includes the keyboard shortcut where one exists ("Fit content
  F", exposed through `aria-describedby` and `aria-keyshortcuts="F"`), and
  Escape dismisses it;
- separators are semantic;
- loading uses `role="status"`, polite live updates, and busy state.
- the legend is a named group ("Chart legend") after the canvas in tab order:
  each study row is a list item whose values carry their plot names for screen
  readers, its remove button is named after the row ("Remove EMA 9"), removal is
  announced and Ctrl/Cmd+Z undoes it from the legend, focus moves to the next
  row, the `+N` toggle exposes `aria-expanded`, and Escape returns to the chart.

Popup triggers expose `aria-haspopup`, `aria-expanded`, and `aria-controls`.
Menus are named and use menu item, radio item, or checkbox item semantics.
Checked state is a check icon in a fixed-width slot at the start of each row,
never text in the label, so labels start at the same position in checked and
unchecked rows and screen readers hear the label plus the checked state.
Secondary rows (Indicators "Clear all") use the `--raze-text-muted` token,
which keeps at least 4.5:1 contrast on the dark and light popup surfaces.
Opening moves focus into the popup's first enabled row. Arrow Up/Down and
Home/End navigate and skip separators. Disabled items (`aria-disabled`, such
as a context-menu item without a handler) stay reachable with the arrow keys,
as the WAI-ARIA menu pattern recommends, so screen reader users can discover
them, but Enter, Space and clicks do nothing on them. Escape closes and
returns focus. Tab and Shift+Tab on a row close the menu and move on from its
button; a field or other control a host places inside a menu keeps the normal
Tab order. An outside press or focus moving out of the menu dismisses it.
Pressing a row moves focus to it without closing the menu, so its action
runs, in every engine (the press is not left to the browser's focus-on-click
rules). Hovering a row of a focused menu moves focus to it, so the keyboard
and the mouse share one highlight. The highlight is a background; keyboard
focus also draws a 2px ring in the focus colour (`--raze-focus`, the theme
accent), and forced-colours mode draws a `Highlight` outline. Long menus
scroll inside the viewport and keep the focused row visible. An indicator
menu rerender preserves focus on the corresponding row. These rules also hold
when the chart is mounted inside an (open) shadow root.

On phones (coarse primary pointer) and viewports narrower than 520px, menus
open as bottom sheets with 48px rows. A named drag handle ("Close"), a
backdrop tap, a swipe down or Escape closes a sheet and returns focus to the
button that opened it. Tab and Shift+Tab stay inside an open sheet, the sheet
is announced as a modal dialog (`aria-modal`) named after its menu, and the
page behind it does not scroll. If a resize or rotation means the menu should
switch between sheet and flyout, it closes and focus returns to its button.
A kit dialog instead switches in place, keeping its content and focus.

Menus stay usable in element fullscreen: they render inside the fullscreen
chart rather than behind it. A menu that is open when the chart enters or
leaves fullscreen moves with the chart and keeps focus on the same row.

Animation on the loading state, on menus and on sheets respects
`prefers-reduced-motion`. Built-in focus styles remain visible in
forced-color mode.

New settings surfaces are built on the internal [UI kit](./ui-kit.md). Its
modal dialogs trap Tab and Shift+Tab, cancel on Escape and restore focus to
their opener. Its tab lists, radio groups, spin buttons and colour palette
follow the ARIA keyboard patterns.

## Integration responsibilities

- Name the chart's subject, unit/currency, and period when those are not already
  obvious from nearby labelled content.
- Describe the useful conclusion, not every decorative detail. Avoid putting a
  raw dump of thousands of values in `ariaDescription`.
- Provide an HTML table, summary, export, or equivalent workflow when users
  need exact data exploration.
- Do not remove focus outlines from the chart or chrome. If product styles
  replace them, preserve a clearly visible keyboard indicator.
- Test custom colors in normal, hover, selected, disabled, high-contrast, and
  forced-color states. Raze cannot guarantee contrast after theme overrides.
- Do not use color alone for gain/loss, selection, or alerts in surrounding
  product UI.
- Keep touch targets large when replacing built-in chrome, and test zoomed text
  without clipping the plot controls.
- Localize surrounding instructions and summaries. Built-in control labels and
  keyboard announcements are currently English.

## Known limitations

- Native dashboard points do not have arrow-key point-by-point navigation.
- Neither runtime generates a complete accessible data table automatically.
- Financial Canvas semantics describe the chart and controls; they do not
  expose every candle, drawing, or study as an accessibility-tree node.
- Menus do not implement typeahead search.
- Built-in accessibility strings are not yet localized.
- Visual snapshots and DOM assertions are regression protection, not a
  substitute for manual screen-reader and keyboard testing.

Before release, test at minimum keyboard-only use, browser zoom, reduced
motion, forced colors, VoiceOver/Safari, and NVDA/Firefox or NVDA/Chrome on the
actual product page. Include loading, empty, error, dense-data, popup, drawing,
and teardown states.
