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
| Left / Right Arrow | Pan the visible range |
| Up / Down Arrow | Move a selected editable trading line by one minimum tick (Shift = 10 ticks) |
| `+` / `-` | Zoom in / out |
| `F` | Fit all loaded data |
| Escape | Cancel the active drawing and clear selection |
| Delete / Backspace | Remove the selected drawing or cancel the selected trading order |
| Ctrl/Cmd+Z | Undo the last drawing or study command |
| Ctrl/Cmd+Shift+Z or Ctrl+Y | Redo |

Keyboard actions announce concise state changes without moving focus. Pointer
down moves focus to the Canvas without a visible ring. Keyboard focus (Tab or
a subsequent key press) receives a visible ring.

## Built-in chrome

The header, left tools, and scale controls expose named toolbar/group semantics
and orientation. Controls use native buttons with accessible labels and state:

- interval selection exposes the current item;
- timeframe presets and go-to-date are a labelled range group;
- symbol search is a labelled search field when the header search feature is on;
- drawing, magnet, stay-in-mode, objects-tree, and scale toggles expose pressed/checked state;
- decorative icons are hidden from assistive technology;
- separators are semantic;
- loading uses `role="status"`, polite live updates, and busy state.

Popup triggers expose `aria-haspopup`, `aria-expanded`, and `aria-controls`.
Menus are named and use menu item, radio item, or checkbox item semantics.
Opening moves focus into the popup. Arrow Up/Down and Home/End navigate,
Escape closes and returns focus, and focus-out/outside click dismisses. An
indicator menu rerender preserves focus on the corresponding row.

On phones (coarse primary pointer) and viewports narrower than 520px, menus
open as bottom sheets with 48px rows. A named drag handle ("Close"), a
backdrop tap, a swipe down or Escape closes a sheet and returns focus to the
button that opened it. The page behind a sheet does not scroll.

Animation on the loading state and on sheets respects
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
