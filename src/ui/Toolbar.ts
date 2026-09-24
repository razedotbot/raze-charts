// The chart header. Hosts the symbol search, interval selector and range
// presets plus a left/right slot for `createButton`-injected HTMLElements.
// Rendered as plain DOM (no iframe) and styled by class rules in one adopted
// stylesheet (HEADER_STYLES) driven by the documented `--raze-*` tokens, so a
// host can restyle any control with ordinary CSS: hover, pressed, focus and
// touch sizing come from `:hover`, `[aria-pressed]`, `:focus-visible` and
// `@media (pointer: coarse)` rather than inline styles or JS listeners.

import type { CreateButtonOptions } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { t } from "../i18n";
import { prefersReducedMotion } from "./kit/media";
import { enableToolbarKeyboardNavigation } from "./popup";
import { adoptStyles, adoptStylesOnConnect, defineStyles, TOKEN_STYLES, type StyleChunk } from "./styles";

export const TOOLBAR_HEIGHT = 38;

// Token reads, each with its TOKEN_STYLES default as the fallback (through
// the same `--tv-color-*` variable where the token has one). TOKEN_STYLES
// defines the tokens only on `.raze-chart-root` and kit portals, and the
// header modules are public exports: mounted anywhere else, a bare
// `var(--raze-*)` would be invalid at computed-value time and leave browser
// defaults (16px text and height, square corners, a pressed button that looks
// idle). Inside a root the token is defined, so a host rule on
// `.raze-chart-root` still wins; outside one, a token the host sets on any
// ancestor does. tests/header-controls.mjs keeps these in step with
// TOKEN_STYLES.
export const TOKEN_BORDER = "var(--raze-border,var(--tv-color-toolbar-divider-background,#363a45))";
export const TOKEN_TOOLBAR_TEXT = "var(--raze-toolbar-text,var(--tv-color-toolbar-button-text,#d1d4dc))";
export const TOKEN_TOOLBAR_HOVER = "var(--raze-toolbar-hover,var(--tv-color-toolbar-button-background-hover,rgba(255,255,255,.06)))";
export const TOKEN_ACTIVE = "var(--raze-active,var(--tv-color-toolbar-button-background-active,rgba(41,98,255,.18)))";
export const TOKEN_ACCENT = "var(--raze-accent,var(--tv-color-toolbar-button-text-hover,#2962ff))";
export const TOKEN_RADIUS_SM = "var(--raze-radius-sm,4px)";
const TOKEN_HOVER = "var(--raze-hover,var(--tv-color-popup-element-background-hover,rgba(255,255,255,.08)))";
const TOKEN_FONT_SIZE = "var(--raze-font-size,12px)";
const TOKEN_CONTROL_HEIGHT = "var(--raze-control-height,26px)";
const TOKEN_TOUCH_CONTROL_HEIGHT = "var(--raze-touch-control-height,32px)";

/**
 * Header chrome. `.raze-chart-toolbar-btn` is the neutral reset every
 * `createButton()` element carries: it lives here rather than inline, so a
 * host that replaces `btn.style.cssText` keeps an unstyled button instead of
 * the browser's native chrome. `.raze-chart-header-btn` is the shared
 * TradingView-style control used by intervals, ranges and styled custom
 * buttons: one font size, height and radius for the whole row.
 *
 * Specificity: library-owned controls are matched as `element.class`, so a
 * page-wide reset (`button{…}` in Bootstrap's reboot or Tailwind's preflight)
 * does not restyle them, while one more class (`.raze-chart-root
 * .raze-chart-header-btn`) overrides them on purpose. The `createButton()`
 * reset is `button:where(…)`: it beats element selectors (adopted sheets come
 * last in the cascade) and loses to any class the host puts on its button.
 *
 * Every token read carries its default (the `TOKEN_*` constants above), so a
 * header module mounted outside a chart root keeps the same look.
 * `--raze-font` alone has none: an unset font inherits, which is the default.
 */
export const HEADER_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "header",
  `.raze-chart-toolbar{display:block;height:${TOOLBAR_HEIGHT}px;min-height:${TOOLBAR_HEIGHT}px;box-sizing:border-box;` +
  `border-bottom:1px solid ${TOKEN_BORDER};background:var(--tv-color-toolbar-button-background,transparent);` +
  `color:${TOKEN_TOOLBAR_TEXT};font-family:var(--raze-font);font-size:${TOKEN_FONT_SIZE};user-select:none;-webkit-user-select:none;` +
  "overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;scroll-behavior:smooth;position:relative;z-index:3}" +
  ".raze-chart-toolbar-rail{display:flex;align-items:center;justify-content:space-between;gap:10px;width:max-content;min-width:100%;height:100%;padding:0 6px;box-sizing:border-box}" +
  ".raze-chart-toolbar-slot{display:flex;align-items:center;gap:2px;flex:0 0 auto;white-space:nowrap}" +
  ".raze-chart-toolbar-slot-end{justify-content:flex-end}" +
  // A hairline before every non-empty group that follows another non-empty
  // one (search | intervals | ranges). General sibling, so a disabled group
  // left empty in between still gets its neighbours separated.
  ".raze-chart-toolbar-slot>.raze-chart-toolbar-slot:not(:empty)~.raze-chart-toolbar-slot:not(:empty)::before" +
  `{content:"";width:1px;height:16px;margin:0 4px 0 2px;background:${TOKEN_BORDER}}` +
  "button:where(.raze-chart-toolbar-btn){appearance:none;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:inherit}" +
  "button.raze-chart-header-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:2px;flex:0 0 auto;box-sizing:border-box;" +
  `height:${TOKEN_CONTROL_HEIGHT};padding:0 7px;margin:0 1px;border:0;border-radius:${TOKEN_RADIUS_SM};background:transparent;box-shadow:none;` +
  `color:${TOKEN_TOOLBAR_TEXT};font:inherit;font-family:var(--raze-font);font-size:${TOKEN_FONT_SIZE};line-height:1;text-transform:none;white-space:nowrap;cursor:pointer;touch-action:manipulation}` +
  `@media (hover:hover){button.raze-chart-header-btn:hover{background:${TOKEN_TOOLBAR_HOVER}}}` +
  `button.raze-chart-header-btn:active,button.raze-chart-header-btn[aria-expanded="true"]{background:${TOKEN_TOOLBAR_HOVER}}` +
  `button.raze-chart-header-btn[aria-pressed="true"]{background:${TOKEN_ACTIVE};color:${TOKEN_ACCENT};font-weight:600}` +
  // Overflow chevron, drawn in CSS (decorative; the button is named).
  ".raze-chart-interval-more::after{content:\"\";width:5px;height:5px;margin:-3px 1px 0;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}" +
  // Menus portalled out of the header (to <body>, outside the token scope, so
  // they fall back to the mirrored --tv-color-* theme): the checked interval
  // and the active symbol result. Their rows carry inline popup styles, hence
  // ::before and an inset shadow rather than colour and background.
  ".raze-chart-interval-menu [role=menuitemradio]::before{content:\"\";width:12px;flex:none}" +
  `.raze-chart-interval-menu [aria-checked=true]::before{content:"✓";color:${TOKEN_ACCENT}}` +
  `.raze-chart-symbol-search [aria-selected=true]{box-shadow:inset 2px 0 0 ${TOKEN_ACCENT},inset 0 0 0 100vmax ${TOKEN_HOVER}}` +
  ".raze-chart-symbol-search-field{display:flex;align-items:center;flex:0 0 auto;margin:0 4px 0 0;font-family:var(--raze-font)}" +
  `input.raze-chart-symbol-search-input{box-sizing:border-box;width:88px;height:${TOKEN_CONTROL_HEIGHT};margin:0;padding:0 8px;` +
  `border:1px solid ${TOKEN_BORDER};border-radius:${TOKEN_RADIUS_SM};background:transparent;box-shadow:none;color:inherit;font:inherit;font-size:${TOKEN_FONT_SIZE}}` +
  `@media (hover:hover){input.raze-chart-symbol-search-input:hover{background:${TOKEN_TOOLBAR_HOVER}}}` +
  `@media (pointer:coarse){button.raze-chart-header-btn,input.raze-chart-symbol-search-input{height:${TOKEN_TOUCH_CONTROL_HEIGHT}}button.raze-chart-header-btn{padding:0 10px}}` +
  "@media (prefers-reduced-motion:reduce){.raze-chart-toolbar{scroll-behavior:auto}}",
);

/** Styles every header module installs (tokens first, so `var()`s resolve in shadow roots). */
export const HEADER_CHUNKS: readonly StyleChunk[] = [TOKEN_STYLES, HEADER_STYLES];

/**
 * Carry the context font (`custom_font_family`) to a header module, so a
 * module mounted outside the widget root still uses it. A custom property
 * rather than inline `font-family`: the class rules read `var(--raze-font)`.
 */
function setHeaderFont(el: HTMLElement, context: Pick<ChartContext, "fontFamily"> | undefined): void {
  if (context?.fontFamily) el.style.setProperty("--raze-font", context.fontFamily);
}

/**
 * Install the header stylesheet (and the context font) for a control mounted
 * outside a `Toolbar` (the header modules are public exports): now, and once
 * more after the caller appended it.
 */
export function adoptHeaderStyles(el: HTMLElement, context?: Pick<ChartContext, "fontFamily">): void {
  setHeaderFont(el, context);
  adoptStyles(el, HEADER_CHUNKS);
  queueMicrotask(() => adoptStyles(el, HEADER_CHUNKS));
}

export class Toolbar {
  readonly el: HTMLDivElement;
  private rail: HTMLDivElement;
  private leftSlot: HTMLDivElement;
  private rightSlot: HTMLDivElement;
  private removeKeyboardNavigation: () => void;
  private stopStyles: () => void;
  private scrollObserver: ResizeObserver | null = null;
  private readonly syncScrollHints = (): void => {
    const max = Math.max(0, this.el.scrollWidth - this.el.clientWidth);
    this.el.dataset.scrollLeft = String(max > 1 && this.el.scrollLeft > 1);
    this.el.dataset.scrollRight = String(max > 1 && this.el.scrollLeft < max - 1);
  };
  /**
   * Keep the focused control visible in the scrolling rail. Smooth scrolling
   * is motion: it becomes an instant jump when the user asked the OS to
   * reduce motion (WCAG 2.3.3).
   */
  private readonly revealFocusedControl = (event: FocusEvent): void => {
    const target = event.target;
    if (target instanceof HTMLElement && typeof target.scrollIntoView === "function") {
      const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
      target.scrollIntoView({ block: "nearest", inline: "nearest", behavior });
    }
  };
  /** Anchor where the interval selector mounts, kept left of custom buttons. */
  readonly intervalSlot: HTMLDivElement;
  readonly searchSlot: HTMLDivElement;
  readonly rangeSlot: HTMLDivElement;

  constructor(context: ChartContext) {
    this.el = document.createElement("div");
    this.el.className = "raze-chart-toolbar";
    setHeaderFont(this.el, context);
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", t("header.toolbar", "Chart toolbar"));
    this.el.setAttribute("aria-orientation", "horizontal");

    const mkSlot = (end = false): HTMLDivElement => {
      const s = document.createElement("div");
      s.className = end ? "raze-chart-toolbar-slot raze-chart-toolbar-slot-end" : "raze-chart-toolbar-slot";
      return s;
    };
    this.leftSlot = mkSlot();
    this.rightSlot = mkSlot(true);
    this.intervalSlot = mkSlot();
    this.intervalSlot.setAttribute("role", "group");
    this.intervalSlot.setAttribute("aria-label", t("header.interval.group", "Chart interval"));
    this.searchSlot = mkSlot();
    this.rangeSlot = mkSlot();

    this.leftSlot.append(this.searchSlot, this.intervalSlot, this.rangeSlot);
    this.rail = document.createElement("div");
    this.rail.className = "raze-chart-toolbar-rail";
    this.rail.append(this.leftSlot, this.rightSlot);
    this.el.appendChild(this.rail);
    this.stopStyles = adoptStylesOnConnect(this.el, HEADER_CHUNKS);
    this.el.addEventListener("scroll", this.syncScrollHints, { passive: true });
    this.el.addEventListener("focusin", this.revealFocusedControl);
    if (typeof ResizeObserver !== "undefined") {
      this.scrollObserver = new ResizeObserver(this.syncScrollHints);
      this.scrollObserver.observe(this.el);
      this.scrollObserver.observe(this.rail);
    }
    queueMicrotask(this.syncScrollHints);
    this.removeKeyboardNavigation = enableToolbarKeyboardNavigation(this.el, "horizontal");
  }

  /**
   * TradingView's `createButton`. The element is a native `<button>` whose
   * reset lives in the stylesheet, so host code may assign `style.cssText`
   * freely. `useTradingViewStyle` (default true) adds the shared header-button
   * look: height, padding, radius, hover and pressed states.
   */
  createButton(options?: CreateButtonOptions): HTMLElement {
    const align = options?.align === "right" ? "right" : "left";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = options?.useTradingViewStyle !== false
      ? "raze-chart-toolbar-btn raze-chart-header-btn raze-chart-focusable"
      : "raze-chart-toolbar-btn raze-chart-focusable";
    if (options?.title) {
      btn.title = options.title;
      btn.setAttribute("aria-label", options.title);
    }
    (align === "right" ? this.rightSlot : this.leftSlot).appendChild(btn);
    queueMicrotask(this.syncScrollHints);
    return btn;
  }

  destroy(): void {
    this.el.removeEventListener("scroll", this.syncScrollHints);
    this.el.removeEventListener("focusin", this.revealFocusedControl);
    this.scrollObserver?.disconnect();
    this.scrollObserver = null;
    this.stopStyles();
    this.removeKeyboardNavigation();
    this.el.remove();
  }
}
