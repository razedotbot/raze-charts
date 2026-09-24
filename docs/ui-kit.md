# UI kit, stylesheet, i18n and safe text

Every chrome surface in Raze Charts (settings dialogs, pickers, menus,
tooltips, notifications) is built from one internal kit so accessibility,
touch behaviour, theming, CSP compatibility and localization are implemented
once. This guide is for contributors adding UI. The kit lives in
`src/ui/kit/`, the stylesheet runtime in `src/ui/styles.ts`, and the
translation runtime in `src/i18n/index.ts`. They are internal modules: the
public widget API is unchanged except where noted in the
[capability matrix](./capabilities.md#ui-kit-csp-and-localization).

## Rules for new UI

1. Build overlays with the kit (`openDialog`, `openPopover`, `attachTooltip`,
   `showToast`) and form rows with the control factories. Do not hand-roll
   focus handling, positioning or dismissal.
2. Write every user-visible string as `t("scope.key", "English default")`.
   Keys and defaults must be string literals.
3. Style with classes in a `defineStyles()` chunk and the `--raze-*` tokens.
   No literal colours outside token fallbacks, no `style` attributes in markup,
   no `title` attributes (use `attachTooltip`).
4. Render datafeed, host and user strings as text (`textContent`, `setText`,
   `h()` children). Library markup goes through `html` or `trustedMarkup()` and
   `setMarkup()`. `innerHTML` and other sinks are rejected by the lint.
5. New UI ships with a regression test, keyboard support, accessible names,
   visible focus, reduced-motion and forced-colors behaviour.

## Overlays

| Primitive | Use for | Behaviour |
| --- | --- | --- |
| `openDialog(options)` | Settings, go-to, shortcuts, search | `role="dialog"` + `aria-modal`, named by its title; Tab and Shift+Tab are trapped; Escape cancels; focus returns to the opener; optional tab list with arrow/Home/End keys and lazily rendered panels; OK, Cancel and "Reset to defaults"; Enter submits and `onSubmit` may return `false` to stay open; draggable by the header on desktop; page scroll is locked. A backdrop click dismisses sheets, but desktop dialogs ignore it unless `closeOnBackdrop` is set, so a stray click cannot discard edits. |
| `openPopover(options)` | Colour picker, inline pickers | Anchored and non-modal. It flips and shifts to stay in the viewport, caps its height to the available space, and closes on Escape, an outside press or focus leaving it. |
| `attachTooltip(target, text)` | Icon buttons | Replaces `title`. It shows on hover after a short delay (instantly while warm) and on keyboard focus, never on touch. It stays open while hovered, Escape dismisses it, and it is linked with `aria-describedby`. A target without a name gets the text as its `aria-label`. |
| `showToast(message, options)` | Confirmations, errors | Bottom-centre stack inside a named region. Persistent live regions announce toasts (polite for info/success, assertive for warning/error). Timers pause on hover or focus, one optional action is allowed, and at most three toasts are visible. |

On a coarse primary pointer or a viewport narrower than 520px (`prefersSheet()`),
dialogs, popovers and the widget's menus render as **bottom sheets**: full
width, anchored to the bottom edge, at most 70% of the viewport height,
padded by `env(safe-area-inset-bottom)`, with 48px rows and a dimmed
backdrop. Tapping the backdrop, activating the drag handle, or swiping down
(on the handle, or on the content while it is scrolled to the top) dismisses
the sheet and restores focus. The page behind is scroll-locked. Touch-capable
laptops with a mouse keep anchored menus. `openPopup()` exposes this as
`presentation: "auto" | "anchored" | "sheet"`: menus default to `auto`, and
dialog-role popups such as search results stay anchored.

### Portals

Overlays render in a portal: a zero-size fixed container that mirrors the
widget root's theme variables, font, `dir` and `lang`. The portal is attached
to the fullscreen element when the chart is in element fullscreen, to the
chart's shadow root when it is mounted in a web component, and to
`document.body` otherwise. It moves when fullscreen changes and keeps keyboard
focus when it moves. An internal layer stack lets a popover opened from a
dialog receive focus without the dialog's trap pulling it back.

## Form controls

Each factory returns a `Field<T>` with a labelled row (`el`), the focusable
`control`, a `value` accessor (setting it does not fire `onChange`) and
`setDisabled()`.

| Factory | Control | Keyboard |
| --- | --- | --- |
| `checkboxField` | Native checkbox + label | Space |
| `textField` | Native input (`text`, `search`, `url`, `date`, `time`, `datetime-local`) | Native |
| `numberField` | `role="spinbutton"` input with −/+ buttons, min/max/step/precision/unit | Arrow Up/Down, Page Up/Down (×10), Home/End, Enter commits. Comma decimals are accepted and invalid text reverts. Press-and-hold repeats. |
| `selectField` | Native select (native picker on phones) | Native. An unknown initial value throws with the allowed list. |
| `colorField` | Swatch button + popover with palette listbox, hex/rgb input and opacity slider | Enter opens the popover; arrows move through the palette grid; Space selects; Enter selects and closes. |
| `lineWidthField`, `lineStyleField` | Segmented `radiogroup` | Arrows (mirrored in RTL), Home/End, roving tabindex |

## Stylesheet and design tokens

`defineStyles(id, css)` declares a chunk. `adoptStyles(node, chunks)` installs
chunks into the root that renders `node`. Each Document or ShadowRoot gets
exactly one library stylesheet that grows as chunks are adopted:

- Browsers with constructable stylesheets use `adoptedStyleSheets`, which a
  strict `style-src` without `'unsafe-inline'` does not block.
- Otherwise a `<style>` element is created with the configured nonce
  (`configureStyles({ nonce })`, `ensureBaseStyles(target, { nonce })`, or
  `<meta property="csp-nonce" nonce="…">`). The document element keeps the
  historic id `raze-chart-base-css`.

`--raze-*` tokens (surface, text, border, hover, active, accent, focus, danger,
success, warning, shadow, backdrop, radius, row heights, duration, z-index) are
defined on widget roots and kit portals. They default to the
TradingView-compatible `--tv-color-*` variables, so existing theme overrides
keep working.

## Translation runtime

```ts
import { t, plural, setLocale, registerMessages, registerLocaleLoader } from "../../i18n";

t("kit.dialog.ok", "OK");
t("legend.value", "Value {value}", { value: "12.3" });
plural("drawings.count", count, { one: "{count} drawing", other: "{count} drawings" });

registerMessages("de", { "kit.dialog.ok": "OK", "kit.dialog.cancel": "Abbrechen" });
registerLocaleLoader("ja", () => import("./locales/ja.js"));
await setLocale("ja-JP"); // loads ja lazily, then notifies onLocaleChange listeners
```

Lookups walk the locale chain (`pt-BR`, then `pt`, then the inline English
default). Selecting a locale with no registered messages warns once instead of
silently staying English. `setTranslateHook()` installs a host hook, the seam
for a TradingView `custom_translate_function` adapter. `direction()` and
`isRtlLocale()` drive RTL mirroring. `createI18n()` returns an isolated
runtime. The top-level functions are separate exports, so a bundle only pays
for what it calls.

Extract the catalog and check locale packs:

```bash
node scripts/extract-messages.mjs                      # print the catalog
node scripts/extract-messages.mjs --out messages.json  # write it
node scripts/extract-messages.mjs --check de.json      # coverage; add --strict to require every key
```

Extraction fails when a key or default is not a literal, or when one key has
two different defaults. `--check` fails on unknown keys and placeholder
mismatches.

## Safe text and Trusted Types

`src/ui/kit/safe.ts` is the only module that writes HTML:

- `setText(node, value)` and `toText(value)` coerce any feed or host value to
  text without throwing.
- The `html` tagged template escapes every interpolated value in text and
  attribute context. Nested `html` results and arrays of them stay markup.
- `trustedMarkup(constant)` marks library-owned constants such as icon SVG.
- `setMarkup(element, markup)` accepts only those results. When the browser
  supports Trusted Types, it writes through a lazily created `raze-charts`
  policy that converts only the markup it is currently writing. Allow it with
  `trusted-types raze-charts` (add `'allow-duplicates'` if two library copies
  share a page), or supply an app policy with `setTrustedTypesPolicy()`.
- `safeUrl(url)` allows http(s), mailto, tel, relative and base64 raster image
  URLs, and warns and returns `""` for anything else. `h()` applies it to URL
  attributes and refuses `on*`, `srcdoc` and `style` attributes.

`node scripts/check-dom-sinks.mjs` fails on `innerHTML`/`outerHTML`
assignment, `insertAdjacentHTML`, `document.write`,
`createContextualFragment`, `DOMParser.parseFromString`, `srcdoc`,
event-handler attributes, `eval`/`new Function`, string timers and
`javascript:` URLs anywhere in `src/`. The exceptions are the allow-listed
statements in the script: `setMarkup()`, and the native SVG stage, whose
markup is generated with escaped text. Comments and string contents are
ignored, so documentation that mentions a sink does not trip the lint.

## Tests

| Test | Covers |
| --- | --- |
| `tests/ui-kit.spec.ts` | Real Chromium: dialog audit, Tab trap and focus return, keyboard-operable controls and colour popover, header drag, 390×844 touch sheets (kit dialog and the widget's Indicators menu), swipe and backdrop dismissal, fullscreen and shadow-root portals, strict CSP and nonce fallback, Trusted Types enforcement on the full widget, tooltips, toasts, reduced motion |
| `tests/ui-kit-dom.mjs` | Stylesheet adoption and nonces, placement math, control semantics, dialog lifecycle, popup presentation |
| `tests/i18n-runtime.mjs` | Defaults, packs, fallback chain, lazy loaders, plurals, hooks, isolation, misuse |
| `tests/safe-text.mjs` | Escaping, `setMarkup`, Trusted Types policy behaviour, URL filtering, `h()` |
| `tests/dom-sinks.mjs` | The lint on the repository and on each sink family |
| `tests/extract-messages.mjs` | Extraction, conflicts, pack coverage |

The browser spec builds the kit from source with esbuild. It does not depend
on axe-core, so the dialog audit is an in-page structural check of names,
roles, ARIA references and values, required parents and children, nested
interactive controls and `aria-hidden` focus.
