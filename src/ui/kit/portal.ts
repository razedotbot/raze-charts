// Overlay portal. Floating UI must escape the chart's clipped layout, but it
// also has to stay visible and styled when the chart is:
// - in element fullscreen (only the fullscreen subtree renders), or
// - mounted inside a shadow root (document styles do not apply there).
//
// A portal is a zero-size fixed container that mirrors the widget's theme
// variables, font and direction. It is attached to the fullscreen element,
// the anchor's shadow root, or document.body (in that order of preference),
// re-homes itself when fullscreen changes, and adopts the kit stylesheet into
// whichever root it lands in.

import { adoptStyles, defineStyles, sharedStyles, TOKEN_STYLES, type StyleChunk } from "../styles";
import { composedContains, deepActiveElement, focusWithoutScroll } from "./dom";

export const PORTAL_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "kit-portal",
  ".raze-kit-portal{position:fixed;top:0;left:0;width:0;height:0;overflow:visible;z-index:var(--raze-z,2147483640);" +
  "font-family:var(--raze-portal-font,inherit);font-size:var(--raze-font-size,12px);line-height:1.4;color:var(--raze-text,#d1d4dc);" +
  "text-align:start;-webkit-tap-highlight-color:transparent}" +
  ".raze-kit-portal *,.raze-kit-portal *::before,.raze-kit-portal *::after{box-sizing:border-box}",
);

export interface PortalOptions {
  /** Element the overlay belongs to (focus return, placement, shadow root). */
  anchor?: Element | null;
  /** Widget root whose theme variables/font/direction are mirrored. */
  themeRoot?: Element | null;
  /** Explicit font stack (defaults to the theme root's computed font). */
  fontFamily?: string;
  /** Extra class for host styling hooks. */
  className?: string;
}

export interface Portal {
  readonly el: HTMLDivElement;
  /** Adopt additional style chunks (re-adopted if the portal moves roots). */
  adopt(chunks: StyleChunk | readonly StyleChunk[]): void;
  /** Re-home into the correct container now (fullscreen/shadow changes). */
  update(): void;
  destroy(): void;
}

/** Custom properties always mirrored, even when only computed from a stylesheet. */
const MIRRORED = [
  "--tv-color-pane-background",
  "--tv-color-platform-background",
  "--tv-color-toolbar-button-background",
  "--tv-color-toolbar-button-background-hover",
  "--tv-color-toolbar-button-background-active",
  "--tv-color-toolbar-button-text",
  "--tv-color-toolbar-button-text-hover",
  "--tv-color-toolbar-divider-background",
  "--tv-color-popup-background",
  "--tv-color-popup-element-text",
  "--tv-color-popup-element-background-hover",
  "--tv-color-popup-shadow",
];

/** The fullscreen element of a document or shadow root (prefixed WebKit too). */
export function fullscreenElementOf(root: Document | ShadowRoot): Element | null {
  const withPrefix = root as (Document | ShadowRoot) & { webkitFullscreenElement?: Element | null };
  return root.fullscreenElement ?? withPrefix.webkitFullscreenElement ?? null;
}

/** Replaced/void elements cannot host overlay children. */
function canHost(element: Element): boolean {
  return !/^(?:CANVAS|VIDEO|IMG|IFRAME|OBJECT|EMBED|AUDIO|INPUT|TEXTAREA|SELECT)$/.test(element.tagName);
}

/**
 * Where an overlay for `anchor` must be attached: the fullscreen element, the
 * anchor's shadow root, or the document body.
 */
export function portalContainerFor(anchor?: Element | null, doc: Document = anchor?.ownerDocument ?? document): Element | ShadowRoot {
  const root = anchor?.getRootNode?.();
  const shadow = root && root.nodeType === 11 && "host" in root ? root as ShadowRoot : null;
  const documentFullscreen = fullscreenElementOf(doc);
  if (shadow) {
    const shadowFullscreen = fullscreenElementOf(shadow);
    if (shadowFullscreen && shadowFullscreen !== documentFullscreen && canHost(shadowFullscreen)) return shadowFullscreen;
    if (!documentFullscreen || composedContains(documentFullscreen, shadow.host)) return shadow;
  }
  if (documentFullscreen && canHost(documentFullscreen)) return documentFullscreen;
  return doc.body;
}

/** Copy theme variables, font and direction from a widget root. */
export function mirrorTheme(target: HTMLElement, source: Element | null | undefined, fontFamily?: string): void {
  if (fontFamily) target.style.setProperty("--raze-portal-font", fontFamily);
  if (!source) return;
  const view = source.ownerDocument.defaultView;
  const computed = view?.getComputedStyle?.(source) ?? null;
  const inline = (source as HTMLElement).style;
  const names = new Set(MIRRORED);
  if (inline) {
    for (let index = 0; index < inline.length; index++) {
      const name = inline.item(index);
      if (name.startsWith("--")) names.add(name);
    }
  }
  for (const name of names) {
    const value = (inline?.getPropertyValue(name) || computed?.getPropertyValue(name) || "").trim();
    if (value) target.style.setProperty(name, value);
  }
  if (!fontFamily) {
    const font = inline?.fontFamily || computed?.fontFamily;
    if (font) target.style.setProperty("--raze-portal-font", font);
  }
  const direction = source.closest("[dir]")?.getAttribute("dir") || computed?.direction;
  if (direction === "rtl" || direction === "ltr") target.dir = direction;
  const lang = source.closest("[lang]")?.getAttribute("lang");
  if (lang) target.lang = lang;
}

const live = new Set<Portal>();
let listening = false;

function onFullscreenChange(): void {
  for (const portal of live) portal.update();
}

function listen(doc: Document): void {
  if (listening) return;
  listening = true;
  doc.addEventListener("fullscreenchange", onFullscreenChange, true);
  doc.addEventListener("webkitfullscreenchange", onFullscreenChange, true);
}

/** Create and attach an overlay portal. */
export function createPortal(options: PortalOptions = {}): Portal {
  const doc = options.anchor?.ownerDocument ?? document;
  const el = doc.createElement("div");
  el.className = options.className ? `raze-kit-portal ${options.className}` : "raze-kit-portal";
  el.setAttribute("data-raze-portal", "");
  const themeRoot = options.themeRoot ?? options.anchor?.closest(".raze-chart-root") ?? null;
  mirrorTheme(el, themeRoot, options.fontFamily);

  const chunks: StyleChunk[] = [TOKEN_STYLES, PORTAL_STYLES];
  let destroyed = false;

  const portal: Portal = {
    el,
    adopt(next) {
      for (const chunk of Array.isArray(next) ? next : [next as StyleChunk]) {
        if (!chunks.includes(chunk)) chunks.push(chunk);
      }
      if (el.isConnected) adoptStyles(el, [...chunks, ...sharedStyles()]);
    },
    update() {
      if (destroyed) return;
      const container = portalContainerFor(options.anchor, doc);
      if (el.parentNode !== container) {
        // Moving a subtree blurs it; keep keyboard users where they were.
        const active = deepActiveElement(doc);
        const hadFocus = !!active && composedContains(el, active);
        container.appendChild(el);
        if (hadFocus) focusWithoutScroll(active as HTMLElement);
      }
      adoptStyles(el, [...chunks, ...sharedStyles()]);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      live.delete(portal);
      el.remove();
    },
  };
  portal.update();
  live.add(portal);
  listen(doc);
  return portal;
}
