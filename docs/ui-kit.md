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
| `openDialog(options)` | Settings, go-to, shortcuts, search | `role="dialog"` + `aria-modal`, named by its title; with the default `auto` presentation an open dialog switches between centred dialog and bottom sheet when the viewport crosses 520px or the primary pointer changes, keeping its content, tab, field values and focus (`DialogHandle.presentation` reports the current one); Tab and Shift+Tab are trapped; Escape cancels; focus returns to the opener; optional tab list with arrow/Home/End keys and lazily rendered panels; OK, Cancel and "Reset to defaults"; Enter submits and `onSubmit` may return `false` to stay open; while an async `onSubmit` is pending the dialog is `aria-busy`, Cancel and Close are disabled, and Escape, backdrop and swipe dismissals are refused (a sheet snaps back), so a half-applied submit is never reported as a cancel, though `close()` from code still closes it; draggable by the header on desktop; page scroll is locked. A backdrop click dismisses sheets, but desktop dialogs ignore it unless `closeOnBackdrop` is set, so a stray click cannot discard edits. |
| `openPopover(options)` | Colour picker, inline pickers | Anchored and non-modal. It flips and shifts to stay in the viewport, caps its height to the available space, and closes on Escape, an outside press or focus leaving it. |
| `attachTooltip(target, text)` | Icon buttons | Replaces `title`. It shows on hover after a short delay (instantly while warm) and on keyboard focus, never on touch. It stays open while hovered, Escape dismisses it, and it is linked with `aria-describedby`. A target without a name gets the text as its `aria-label`. A visible tooltip hides itself when its target leaves the DOM. `destroy()` restores the `title` it replaced and removes an `aria-label` only the tooltip provided. |
| `showToast(message, options)` | Confirmations, errors | Bottom-centre stack inside a named region. Persistent live regions announce toasts (polite for info/success, assertive for warning/error). Timers pause on hover or focus, one optional action is allowed, and at most three toasts are visible. |

On a coarse primary pointer or a viewport narrower than 520px (`prefersSheet()`),
dialogs, popovers and the widget's menus render as **bottom sheets**: full
width, anchored to the bottom edge, at most 70% of the viewport height,
padded by `env(safe-area-inset-bottom)`, with 48px rows and a dimmed
backdrop. Tapping the backdrop, activating the drag handle, or swiping down
(on the handle, or on the content while it is scrolled to the top) dismisses
the sheet and restores focus. Sheets are modal: the page behind is
scroll-locked, Tab and Shift+Tab stay inside the sheet, and the sheet is
exposed as an `aria-modal` dialog. `aria-modal` is only valid on dialogs, so
a sheet whose content is a dialog (kit dialogs, dialog-role popovers and
popups) marks that content, and a sheet holding a menu, listbox or group gets
a `role="dialog"` container named like its content. On wider touch
screens (tablets) a sheet is a centred column of at most 640px
(`--raze-sheet-max-width`). Touch-capable laptops with a mouse keep anchored
menus. `openPopup()` exposes this as
`presentation: "auto" | "anchored" | "sheet"`: menus default to `auto`, and
dialog-role popups such as search results stay anchored. An `auto` menu closes,
restoring focus to its opener, when a resize, rotation or pointer change flips
`prefersSheet()` (`watchSheetPreference()`); reopening picks the presentation
that fits.

Menus from `openPopup()` decide what counts as inside from the composed event
path and the focused element inside shadow roots, so a sheet portalled into
the chart's shadow root handles taps, arrow keys and Escape, and an anchor
inside a shadow root still toggles its anchored menu. An anchored menu closes
when focus arrives outside it, its anchor and overlays opened from it; moving
focus between its rows (by keyboard or by pressing a row) keeps it open. A
mouse press on a row of a focused menu keeps focus in the menu and moves it to
that row, so engines that do not focus pressed buttons (WebKit) behave the
same. Focus that goes nowhere is checked a task later, and a focused row that
a re-render removed hands focus back to the menu instead of closing it. Tab
and Shift+Tab close a menu and continue from its opener.

Anchored menus render in a portal too (below), so they work in element
fullscreen and in shadow roots. Placement uses `computePosition()`: the menu
flips to the side of its anchor with room, is capped at the viewport height
minus 16px and scrolls inside (`overscroll-behavior: contain`), and follows
its anchor through resizes, scrolls, content-size changes and fullscreen
changes; it closes if its anchor leaves the DOM. A context menu (no anchor)
opens at the cursor and flips around it. Rows (`popupRow()`) and separators
(`popupSeparator()`) are styled by the `POPUP_STYLES` chunk: hover, focus,
`aria-selected` and `aria-disabled` states are CSS, the highlight is single
(hovering a row of a focused menu focuses it), and every menu shares the 4px
`--raze-popup-inset` (`PopupOptions.padding` still overrides it but is
deprecated). Menus fade and scale in over 120ms from the corner nearest their
anchor, with no animation under `prefers-reduced-motion`.

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
  `<meta property="csp-nonce" nonce="…">`). A nonce passed explicitly is
  remembered for its document, so overlays that later adopt styles into a
  shadow root or fullscreen element of the same page reuse it. The document
  element keeps the historic id `raze-chart-base-css`.

`--raze-*` tokens (surface, text, border, hover, active, accent, focus, danger,
success, warning, shadow, backdrop, radius, row heights, duration, z-index) are
defined on widget roots and kit portals. They default to the
TradingView-compatible `--tv-color-*` variables, so existing theme overrides
keep working.

`LoadingScreen` (a public export) adopts its own spinner keyframes and
reduced-motion rule into the document, and into the shadow root it is
mounted in, so it spins without the widget's chrome stylesheet.

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
silently staying English. Overlapping `setLocale()` calls apply in call order:
the most recent call wins even if an earlier call's pack loads later, and a
superseded call resolves without changing the locale or notifying listeners. `setTranslateHook()` installs a host hook, the seam
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
  The lint accepts only a string literal or an ALL_CAPS constant (or a member
  of one) as its argument. Any other argument needs an allow-list entry that
  says where the markup comes from.
- `setMarkup(element, markup)` accepts only those results. When the browser
  supports Trusted Types, it writes through a lazily created `raze-charts`
  policy that converts only the markup it is currently writing. Allow it with
  `trusted-types raze-charts` (add `'allow-duplicates'` if two library copies
  share a page), or supply an app policy with `setTrustedTypesPolicy()`.
- `safeUrl(url)` allows http(s), mailto, tel, relative and base64 raster image
  URLs, and warns and returns `""` for anything else. `h()` applies it to URL
  attributes and refuses `on*`, `srcdoc` and `style` attributes.

`node scripts/check-dom-sinks.mjs` fails on `innerHTML`/`outerHTML`
assignment (including `+=`, `??=`, `||=` and `&&=`), the property named as a
string (`el["innerHTML"]`, `Reflect.set`, `Object.defineProperty`) or as an
object key (`Object.assign(el, { innerHTML })`), `insertAdjacentHTML`,
`setHTMLUnsafe`, `document.write`, `createContextualFragment`,
`DOMParser.parseFromString`, `srcdoc`, event-handler attributes,
`eval`/`new Function`, string timers, `javascript:` URLs, `new SafeMarkup()`,
renaming `trustedMarkup` on import, and `trustedMarkup()` with a non-constant
argument, anywhere in `src/`. The exceptions are the allow-listed statements
in the script, each with its reason: `setMarkup()` and the two `SafeMarkup`
factories, the documented host-markup opt-ins (`popupRow`'s `trustedHtml` and
a string `SidebarCustomItem.icon`), the library chart-type icon table, and the
native SVG stage, whose markup is generated with escaped text. Comments and
string contents are ignored, so documentation that mentions a sink does not
trip the lint.

The eval family is matched by name, not only as a direct call: any code
reference to `eval` (including `globalThis.eval(s)`, the `window["eval"]` form,
`(0, eval)(s)` and aliases), the `Function` constructor with or without `new`
(`Function(s)`, `new window.Function(s)`, `self["Function"]`, a `Function`
alias, and `fn.constructor(s)`), and `on*` attribute names built at run time
(`setAttribute("on" + type, …)`, ``setAttribute(`on${type}`, …)``,
`setAttributeNS`, `createAttribute`). Library code has no other use for these
names, so the `Function` type is rejected too; write a signature such as
`(...args: never[]) => unknown`.

Some forms cannot be checked statically. Keep them out of UI modules:

- A property name computed at run time (`el[name] = s`).
- A string passed to a timer through a variable (`setTimeout(code, 10)`); the
  lint only sees that the argument is not a literal, and callbacks look the
  same. Under `require-trusted-types-for 'script'` or a CSP without
  `'unsafe-eval'` the browser blocks string timers anyway.
- URLs assembled at run time (`a.href = base + path`,
  `setAttribute("href", "java" + "script:…")`). Pass them through
  `safeUrl()` or set them with `h()`, which applies it.

## Tests

| Test | Covers |
| --- | --- |
| `tests/ui-kit.spec.ts` | Real Chromium: dialog audit (plus axe when installed), Tab trap and focus return, keyboard-operable controls and colour popover, header drag, 390×844 touch sheets (kit dialog and the widget's Indicators menu), swipe and backdrop dismissal, Tab trapping in sheet menus, sheet modality (menu sheets and menu-role popover sheets are `aria-modal` dialog containers), sheet width on tablets, sheet menus closing when a narrow window widens, fullscreen and shadow-root portals, `openPopup()` menus anchored inside a shadow root (sheet taps, arrows, Escape, backdrop; anchored toggling and focus-out), pressing a non-focused row in an anchored widget menu, a standalone `LoadingScreen` spinning in documents and shadow roots, strict CSP for the kit and for the whole widget (zero violations with no `'unsafe-inline'`), nonce fallback, Trusted Types enforcement on the full widget including Element sidebar icons, tooltips, toasts, reduced motion |
| `tests/popups.spec.ts` | Real Chromium: mouse-clicking non-focused Indicators rows (RSI, MACD, Bollinger) and a press that does not move focus, Tab/Shift+Tab and outside dismissal, the single highlight and the shared 4px inset across the widget's menus, context-menu separators, removals and cursor flipping, a 60-row objects tree that scrolls within the viewport (End, Home, wheel without zooming the chart), every menu in element fullscreen by mouse and keyboard, the widget in a shadow root (scoped styles, menus), `raze.style_nonce` with the `<style>` fallback under a nonce-only CSP, flip placement, following the anchor on resize, reduced motion, and a kit dialog switching between dialog and sheet while open |
| `tests/popup-menus.mjs` | TradingView context-menu conventions, separator and disabled-row semantics, class-only row styling, the deprecated padding override, closing when the anchor leaves the DOM, Tab leaving a menu, re-render focus recovery, tooltip teardown, the string-container error |
| `tests/ui-kit-dom.mjs` | Stylesheet adoption and nonces (including reuse across roots), placement math, control semantics, dialog lifecycle and busy submits, cleanup when a content or tab render callback throws, sheet `aria-modal` placement, anchored-menu focus rules, tooltip and toast lifecycles, the sheet-preference watcher, popup presentation |
| `tests/i18n-runtime.mjs` | Defaults, packs, fallback chain, lazy loaders, overlapping `setLocale()` calls, plurals, hooks, isolation, misuse |
| `tests/safe-text.mjs` | Escaping, `setMarkup`, Trusted Types policy behaviour, URL filtering, `h()` |
| `tests/dom-sinks.mjs` | The lint on the repository and on each sink family |
| `tests/extract-messages.mjs` | Extraction, conflicts, pack coverage |

The browser spec builds the kit from source with esbuild. Every audited
surface (desktop dialog, sheet dialog, colour popover, the Indicators menu
sheet, menu-role and dialog-role popover sheets) gets an in-page
structural check of names, allowed roles, ARIA references and values,
required parents and children, nested interactive controls and `aria-hidden`
focus. axe-core is not a dependency yet. The spec runs axe on the same
surfaces automatically once `axe-core` resolves from the repository root, and
otherwise records an `axe` annotation on the test.
