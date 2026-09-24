// Shared floating-popup container. Every menu the chrome opens (context menu,
// Indicators panel, chart-type picker) uses this so
// styling, stacking, viewport clamping, keyboard flow and dismissal stay
// consistent — and are implemented once. On phones and narrow viewports menus
// render as kit bottom sheets instead of anchored flyouts.

import { lockScroll, trapFocus, type FocusTrap } from "./kit/focus";
import { pushLayer, type Layer } from "./kit/layers";
import { isCoarsePointer, watchSheetPreference } from "./kit/media";
import { resolvePresentation } from "./kit/Popover";
import { createPortal, mirrorTheme, type Portal } from "./kit/portal";
import { setMarkup, trustedMarkup } from "./kit/safe";
import { createSheetFrame, SHEET_STYLES, type SheetFrame } from "./kit/Sheet";
import { adoptStyles, BASE_STYLES, TOKEN_STYLES, type StyleOptions } from "./styles";

export { isCoarsePointer };

export interface PopupOptions {
  fontFamily: string;
  /** Theme scope to mirror when the popup is portalled to document.body. */
  themeRoot?: HTMLElement;
  /** Class name for tests / host-app styling hooks. */
  className?: string;
  minWidth?: number;
  /** Container padding (rows carry their own side padding). */
  padding?: string;
  /** Element to place beside; clicks inside it don't count as "outside". */
  anchor?: HTMLElement;
  /** Placement relative to the anchor. */
  place?: "right-start" | "below-start";
  /** Fixed viewport coords (used when no anchor is given). */
  x?: number;
  y?: number;
  /** Accessible popup role. Menus are the backwards-compatible default. */
  role?: "menu" | "dialog";
  /** Accessible name announced when focus enters the popup. */
  label?: string;
  /** Move focus to the first interactive row after contents are appended. */
  initialFocus?: boolean;
  /**
   * `auto` renders a bottom sheet (backdrop, drag handle, 48px rows) when the
   * primary pointer is coarse or the viewport is narrower than 520px, and
   * closes the popup (restoring focus) if a rotation, resize or pointer change
   * later flips that choice. Defaults to `auto` for menus and `anchored` for
   * dialog-role popups.
   */
  presentation?: "auto" | "anchored" | "sheet";
  onClose?: () => void;
}

export interface PopupHandle {
  el: HTMLDivElement;
  /** Close the popup. Focus returns to the opener unless explicitly disabled. */
  close: (options?: { restoreFocus?: boolean }) => void;
  /** Re-clamp into the viewport (call after mutating contents). */
  reposition: () => void;
  /** Focus a row by index (clamped to the available interactive rows). */
  focusItem: (index?: number) => void;
  /** How the popup is presented (`sheet` on phones / narrow viewports). */
  presentation: "anchored" | "sheet";
}

let popupId = 0;

/**
 * Install the chrome stylesheet (design tokens plus behaviour rules) into the
 * Document or ShadowRoot that renders `target` (default: the document). Pass a
 * CSP `nonce` when the page forbids inline styles and the browser lacks
 * constructable stylesheets.
 */
export function ensureBaseStyles(target?: Node, options?: StyleOptions): void {
  if (typeof document === "undefined") return;
  adoptStyles(target ?? document, [TOKEN_STYLES, BASE_STYLES], options);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target.isContentEditable;
}

function popupItems(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(
    '[role="menuitem"]:not([aria-disabled="true"]),' +
    '[role="menuitemcheckbox"]:not([aria-disabled="true"]),' +
    '[role="menuitemradio"]:not([aria-disabled="true"]),' +
    'button:not([disabled])',
  )).filter((item, index, all) => all.indexOf(item) === index);
}

export function openPopup(opts: PopupOptions): PopupHandle {
  const role = opts.role ?? "menu";
  const requested = opts.presentation ?? (role === "menu" ? "auto" : "anchored");
  const presentation = resolvePresentation(requested, opts.anchor);
  const sheet = presentation === "sheet";
  const el = document.createElement("div");
  el.id = `raze-chart-popup-${++popupId}`;
  if (opts.className) el.className = opts.className;
  el.setAttribute("role", opts.role ?? "menu");
  el.setAttribute("aria-label", opts.label ?? "Chart menu");
  if ((opts.role ?? "menu") === "menu") el.setAttribute("aria-orientation", "vertical");
  el.tabIndex = -1;
  el.dataset.presentation = presentation;
  el.style.cssText = sheet
    ? [
      "padding:4px 8px 8px",
      `font-family:${opts.fontFamily}`,
      "font-size:14px",
      "color:var(--tv-color-popup-element-text, #d1d4dc)",
      "outline:none",
    ].join(";")
    : [
      "position:fixed",
      `min-width:${opts.minWidth ?? 140}px`,
      `padding:${opts.padding ?? "4px 0"}`,
      "border-radius:6px",
      "border:1px solid var(--tv-color-toolbar-divider-background, #363a45)",
      "background:var(--tv-color-popup-background, var(--tv-color-pane-background, #1e222d))",
      "box-shadow:var(--tv-color-popup-shadow, 0 12px 24px -10px rgba(0,0,0,0.6))",
      "z-index:2147483640",
      `font-family:${opts.fontFamily}`,
      "font-size:12px",
      "color:var(--tv-color-popup-element-text, #d1d4dc)",
    ].join(";");

  // Popups live under document.body so they can escape the clipped chart
  // viewport. Mirror the widget's custom properties explicitly; CSS variables
  // would otherwise stop at the portal boundary and light/custom themes would
  // fall back to the dark palette.
  const themeRoot = opts.themeRoot ?? opts.anchor?.closest<HTMLElement>(".raze-chart-root");
  if (!sheet) mirrorTheme(el, themeRoot);

  const activeElement = document.activeElement;
  const returnFocus = opts.anchor ?? (activeElement instanceof HTMLElement ? activeElement : null);
  if (opts.anchor) {
    opts.anchor.setAttribute("aria-haspopup", opts.role ?? "menu");
    opts.anchor.setAttribute("aria-expanded", "true");
    opts.anchor.setAttribute("aria-controls", el.id);
  }

  // Bottom sheet: a kit portal (follows fullscreen and shadow roots) holding
  // a backdrop and a full-width surface. Tapping the backdrop, activating the
  // handle, or swiping down closes the menu and restores focus. The sheet is
  // modal: Tab and Shift+Tab cycle inside it instead of reaching the page
  // hidden behind the backdrop.
  let portal: Portal | null = null;
  let frame: SheetFrame | null = null;
  let unlockScroll: (() => void) | null = null;
  if (sheet) {
    portal = createPortal({
      anchor: opts.anchor ?? (returnFocus?.isConnected ? returnFocus : null),
      themeRoot,
      fontFamily: opts.fontFamily,
      className: opts.className ? `${opts.className}-sheet` : undefined,
    });
    portal.adopt(SHEET_STYLES);
    frame = createSheetFrame(portal.el, { content: el, onDismiss: () => close() });
    unlockScroll = lockScroll(document);
  } else {
    document.body.appendChild(el);
  }
  // Pointer/focus containment covers the whole sheet (backdrop and handle).
  const surface: HTMLElement = portal?.el ?? el;
  // Every popup joins the overlay stack, so focus traps below it (a sheet, a
  // kit dialog) let focus move into it.
  const layer: Layer = { el: surface, modal: sheet };
  const popLayer = pushLayer(layer);
  const trap: FocusTrap | null = sheet ? trapFocus(surface, layer, returnFocus) : null;
  // A presentation chosen automatically must not outlive the environment it
  // was chosen for (a narrow window widened, a tablet rotated or docked).
  const stopWatching = requested === "auto"
    ? watchSheetPreference((wantsSheet) => {
      if (wantsSheet !== sheet) close();
    })
    : null;

  const focusItem = (index = 0): void => {
    const items = popupItems(el);
    if (!items.length) {
      el.focus({ preventScroll: true });
      return;
    }
    const safeIndex = Math.max(0, Math.min(items.length - 1, index));
    items[safeIndex]?.focus({ preventScroll: true });
  };

  const reposition = (): void => {
    if (sheet) return; // sheets are laid out by the kit stylesheet
    let left = opts.x ?? 0;
    let top = opts.y ?? 0;
    const pw = el.offsetWidth || opts.minWidth || 140;
    const ph = el.offsetHeight || 100;
    if (opts.anchor) {
      const r = opts.anchor.getBoundingClientRect();
      if ((opts.place ?? "right-start") === "right-start") {
        left = r.right + 6;
        top = r.top;
        if (left + pw > window.innerWidth - 8) left = Math.max(8, r.left - pw - 6);
      } else {
        left = r.left;
        top = r.bottom + 4;
        if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
      }
    } else if (left + pw > window.innerWidth - 4) {
      left = Math.max(4, window.innerWidth - pw - 4);
    }
    if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };

  let closed = false;
  const close = (options?: { restoreFocus?: boolean }): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onAway, true);
    document.removeEventListener("keydown", onKey, true);
    el.removeEventListener("keydown", onMenuKey);
    el.removeEventListener("focusout", onFocusOut);
    stopWatching?.();
    trap?.release({ restoreFocus: false });
    popLayer();
    frame?.destroy();
    portal?.destroy();
    unlockScroll?.();
    el.remove();
    if (opts.anchor) {
      opts.anchor.setAttribute("aria-expanded", "false");
      if (opts.anchor.getAttribute("aria-controls") === el.id) {
        opts.anchor.removeAttribute("aria-controls");
      }
    }
    opts.onClose?.();
    if (options?.restoreFocus !== false && returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
  };
  const onAway = (e: PointerEvent): void => {
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (surface.contains(target)) return;
    if (opts.anchor?.contains(target)) return; // let the anchor's own toggle run
    close({ restoreFocus: false });
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (!surface.contains(document.activeElement) && document.activeElement !== opts.anchor) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onMenuKey = (e: KeyboardEvent): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    if (isEditableTarget(e.target)) return;
    const items = popupItems(el);
    if (!items.length) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = focused ? items.indexOf(focused) : -1;
    let next = current;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    e.preventDefault();
    items[next]?.focus();
  };
  const onFocusOut = (): void => {
    // A sheet's focus trap keeps focus inside; focus-out dismissal is for
    // anchored menus, where Tab leaving the menu closes it.
    if (sheet) return;
    queueMicrotask(() => {
      if (closed || surface.contains(document.activeElement) || document.activeElement === opts.anchor) return;
      close({ restoreFocus: false });
    });
  };
  el.addEventListener("keydown", onMenuKey);
  el.addEventListener("focusout", onFocusOut);

  // Defer so the opening click doesn't immediately dismiss and callers have
  // time to append rows before the first one receives focus.
  window.setTimeout(() => {
    if (closed) return;
    document.addEventListener("pointerdown", onAway, true);
    document.addEventListener("keydown", onKey, true);
    if (opts.initialFocus !== false) focusItem();
  }, 0);

  reposition();
  return { el, close, reposition, focusItem, presentation };
}

/** Standard hover-highlighted popup row. ≥40px tall on touch devices. */
export function popupRow(
  content: string,
  onClick: (e: MouseEvent) => void,
  options?: {
    role?: "menuitem" | "menuitemcheckbox" | "menuitemradio";
    checked?: boolean;
    label?: string;
    /** Render trusted, library-owned markup. User/feed strings stay text by default. */
    trustedHtml?: boolean;
  },
): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  if (options?.trustedHtml) setMarkup(row, trustedMarkup(content));
  else row.textContent = content;
  row.className = "raze-chart-focusable";
  row.setAttribute("role", options?.role ?? "menuitem");
  if (options?.checked !== undefined) row.setAttribute("aria-checked", String(options.checked));
  if (options?.label) row.setAttribute("aria-label", options.label);
  for (const svg of row.querySelectorAll("svg")) {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
  }
  row.style.cssText = [
    "display:flex",
    "align-items:center",
    "gap:8px",
    "width:100%",
    "border:0",
    "background:transparent",
    "color:inherit",
    isCoarsePointer() ? "padding:12px 14px" : "padding:7px 12px",
    "cursor:pointer",
    "text-align:left",
    "font:inherit",
    "border-radius:3px",
    "white-space:nowrap",
    "box-sizing:border-box",
    "touch-action:manipulation",
  ].join(";");
  row.addEventListener("mouseenter", () => {
    row.style.background = "var(--tv-color-popup-element-background-hover, rgba(255,255,255,0.08))";
  });
  row.addEventListener("mouseleave", () => {
    row.style.background = "transparent";
  });
  row.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return row;
}

/** Add conventional arrow/Home/End navigation to a toolbar without changing Tab order. */
export function enableToolbarKeyboardNavigation(
  toolbar: HTMLElement,
  orientation: "horizontal" | "vertical",
): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const previousKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    if (![previousKey, nextKey, "Home", "End"].includes(e.key)) return;
    const controls = Array.from(toolbar.querySelectorAll<HTMLElement>(
      'button:not([disabled]),[role="button"][tabindex]:not([aria-disabled="true"])',
    ));
    if (!controls.length) return;
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('button,[role="button"]') : null;
    const current = target ? controls.indexOf(target) : -1;
    if (current < 0) return;
    let next = current;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = controls.length - 1;
    else if (e.key === nextKey) next = (current + 1) % controls.length;
    else next = (current - 1 + controls.length) % controls.length;
    e.preventDefault();
    controls[next]?.focus();
  };
  toolbar.addEventListener("keydown", onKey);
  return () => toolbar.removeEventListener("keydown", onKey);
}
