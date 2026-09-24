// Shared floating-popup container. Every menu the chrome opens (context menu,
// Indicators panel, chart-type picker, objects tree, symbol results) uses this
// so styling, stacking, placement, keyboard flow and dismissal stay
// consistent — and are implemented once. On phones and narrow viewports menus
// render as kit bottom sheets instead of anchored flyouts.
//
// Anchored menus render inside a kit portal, like every other overlay: it
// follows the chart into element fullscreen (only the fullscreen subtree is
// painted) and into the shadow root it is mounted in, mirrors the widget's
// theme variables, and adopts the popup stylesheet into whichever root it
// lands in. Rows are styled by that stylesheet (hover, focus, selection,
// disabled and separator states are CSS), placement flips to the side with
// room, height is capped to the viewport (long lists scroll inside the
// popup), and an open popup follows its anchor through resizes and scrolls.

import { t } from "../i18n";
import { composedContains, deepActiveElement, focusWithoutScroll } from "./kit/dom";
import { lockScroll, trapFocus, type FocusTrap } from "./kit/focus";
import { isInLayerAbove, pushLayer, type Layer } from "./kit/layers";
import { isCoarsePointer, watchSheetPreference } from "./kit/media";
import { resolvePresentation } from "./kit/Popover";
import { createPortal, type Portal } from "./kit/portal";
import { computePosition, type Side } from "./kit/position";
import { setMarkup, trustedMarkup } from "./kit/safe";
import { createSheetFrame, SHEET_STYLES, type SheetFrame } from "./kit/Sheet";
import { adoptStyles, BASE_STYLES, defineStyles, TOKEN_STYLES, type StyleChunk, type StyleOptions } from "./styles";

export { isCoarsePointer };

/** Distance (px) every anchored popup keeps from the viewport edges. */
const VIEWPORT_MARGIN = 8;

/**
 * Popup and row rules. One inset rule (`--raze-popup-inset`, 4px) for every
 * menu; a single highlight: the focused row, or the hovered row while focus
 * is outside the popup (a combobox keeps focus in its input), or the
 * `aria-selected` option. Keyboard focus and the pointer never light two rows
 * at once because the pointer moves focus inside a focused menu.
 */
export const POPUP_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "popup",
  ".raze-chart-popup{box-sizing:border-box;color:var(--raze-text,#d1d4dc);outline:none}" +
  ".raze-chart-popup[data-presentation=anchored]{position:fixed;min-width:140px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);" +
  "padding:var(--raze-popup-inset,4px);scroll-padding:var(--raze-popup-inset,4px);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;" +
  "scrollbar-color:var(--raze-border,#363a45) transparent;background:var(--raze-surface,#1e222d);border:1px solid var(--raze-border,#363a45);" +
  "border-radius:var(--raze-radius,6px);box-shadow:var(--raze-shadow,0 12px 24px -10px rgba(0,0,0,.6));font-size:var(--raze-font-size,12px);" +
  "animation:raze-chart-popup-in var(--raze-popup-duration,120ms) cubic-bezier(.2,.8,.2,1)}" +
  ".raze-chart-popup[data-presentation=sheet]{padding:4px 8px 8px;font-size:var(--raze-font-size-lg,14px)}" +
  "@keyframes raze-chart-popup-in{from{opacity:0;transform:scale(.96)}}" +
  ".raze-chart-popup-row{display:flex;align-items:center;gap:8px;width:100%;min-height:28px;margin:0;padding:6px 10px;border:0;" +
  "border-radius:var(--raze-radius-sm,4px);background:transparent;color:inherit;font:inherit;text-align:start;white-space:nowrap;" +
  "cursor:pointer;box-sizing:border-box;touch-action:manipulation;outline:none;-webkit-tap-highlight-color:transparent}" +
  ".raze-chart-popup-row[data-touch],.raze-kit-sheet-content .raze-chart-popup-row{padding:12px 14px}" +
  ".raze-chart-popup-row:focus,.raze-chart-popup-row[aria-selected=true]," +
  ".raze-chart-popup:not(:focus-within) .raze-chart-popup-row:not([aria-disabled=true]):hover{background:var(--raze-hover,rgba(255,255,255,.08))}" +
  ".raze-chart-popup-row[aria-disabled=true]{opacity:.5;cursor:default}" +
  ".raze-chart-popup-row svg{flex:0 0 auto}" +
  ".raze-chart-popup-separator{height:1px;margin:4px 0;background:var(--raze-border,#363a45)}" +
  ".raze-kit-sheet-content .raze-chart-popup-separator{margin:4px 14px}" +
  "@media (prefers-reduced-motion:reduce){.raze-chart-popup[data-presentation]{animation:none;transition:none}}" +
  "@media (forced-colors:active){.raze-chart-popup[data-presentation=anchored]{border-color:CanvasText}" +
  ".raze-chart-popup-row:focus,.raze-chart-popup-row[aria-selected=true]{outline:2px solid Highlight;outline-offset:-2px}" +
  ".raze-chart-popup-separator{background:CanvasText}}",
);

export interface PopupOptions {
  fontFamily: string;
  /** Widget root whose theme variables the popup mirrors (and, without an anchor, the chart it belongs to). */
  themeRoot?: HTMLElement;
  /** Class name for tests / host-app styling hooks. */
  className?: string;
  /** Minimum width in px (default 140). */
  minWidth?: number;
  /**
   * @deprecated Overrides the standard container inset (`--raze-popup-inset`,
   * 4px) that every built-in menu shares. Prefer the default, or set the
   * custom property, so rows line up with other menus.
   */
  padding?: string;
  /** Element to place beside; clicks inside it don't count as "outside". */
  anchor?: HTMLElement;
  /**
   * Placement relative to the anchor. `right-start` flips to the left and
   * `below-start` flips above the anchor when the preferred side lacks room.
   */
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
  /**
   * Re-place the popup now. Placement also follows content-size changes,
   * viewport resizes, scrolling and fullscreen changes on its own.
   */
  reposition: () => void;
  /** Focus a row by index (clamped to the available interactive rows) and scroll it into view. */
  focusItem: (index?: number) => void;
  /** How the popup is presented (`sheet` on phones / narrow viewports). */
  presentation: "anchored" | "sheet";
}

let popupId = 0;

/**
 * Install the chrome stylesheet (design tokens, behaviour rules and popup
 * rows) into the Document or ShadowRoot that renders `target` (default: the
 * document). Pass a CSP `nonce` when the page forbids inline styles and the
 * browser lacks constructable stylesheets; it is remembered for every other
 * root of that document the chrome later renders in.
 */
export function ensureBaseStyles(target?: Node, options?: StyleOptions): void {
  if (typeof document === "undefined") return;
  adoptStyles(target ?? document, [TOKEN_STYLES, BASE_STYLES, POPUP_STYLES], options);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target.isContentEditable;
}

/**
 * The node an event really started on. Document-level listeners see events
 * from inside a shadow root retargeted to the shadow host; the composed path
 * still starts at the pressed or focused node (for open shadow roots).
 */
function eventOrigin(event: Event): Node | null {
  const origin = event.composedPath?.()[0] ?? event.target;
  return origin && typeof (origin as Node).nodeType === "number" ? origin as Node : null;
}

const ITEM_SELECTOR =
  '[role="menuitem"]:not([aria-disabled="true"]),' +
  '[role="menuitemcheckbox"]:not([aria-disabled="true"]),' +
  '[role="menuitemradio"]:not([aria-disabled="true"]),' +
  'button:not([disabled]):not([aria-disabled="true"])';

function popupItems(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
}

/** The interactive row of `el` that contains `node`, if any. */
function itemAt(el: HTMLElement, node: EventTarget | null): HTMLElement | null {
  const element = node instanceof Element ? node : (node as Node | null)?.parentElement ?? null;
  const item = element?.closest<HTMLElement>(ITEM_SELECTOR) ?? null;
  return item && item !== el && el.contains(item) ? item : null;
}

/** Scroll a row into the visible part of its scrolling popup (no page scroll). */
function revealItem(item: HTMLElement): void {
  try {
    item.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  } catch {
    // Engines without scrollIntoView options: the focus() scroll suffices.
  }
}

/** Transform origin for the enter animation: the corner nearest the anchor. */
function originFor(side: Side, rtl: boolean): string {
  const start = rtl ? "right" : "left";
  switch (side) {
    case "right": return "left top";
    case "left": return "right top";
    case "top": return `${start} bottom`;
    case "bottom": return `${start} top`;
  }
}

export function openPopup(opts: PopupOptions): PopupHandle {
  const role = opts.role ?? "menu";
  const requested = opts.presentation ?? (role === "menu" ? "auto" : "anchored");
  const presentation = resolvePresentation(requested, opts.anchor);
  const sheet = presentation === "sheet";
  const doc = opts.anchor?.ownerDocument ?? opts.themeRoot?.ownerDocument ?? document;
  const view: Window = doc.defaultView ?? window;
  const el = doc.createElement("div");
  el.id = `raze-chart-popup-${++popupId}`;
  el.className = opts.className ? `raze-chart-popup ${opts.className}` : "raze-chart-popup";
  el.setAttribute("role", role);
  el.setAttribute("aria-label", opts.label ?? t("popup.label", "Chart menu"));
  if (role === "menu") el.setAttribute("aria-orientation", "vertical");
  el.tabIndex = -1;
  el.dataset.presentation = presentation;
  if (!sheet) {
    if (opts.minWidth !== undefined) el.style.minWidth = `${opts.minWidth}px`;
    if (opts.padding !== undefined) el.style.padding = opts.padding;
  }

  const themeRoot = opts.themeRoot ?? opts.anchor?.closest<HTMLElement>(".raze-chart-root") ?? undefined;
  const activeElement = deepActiveElement(doc);
  const returnFocus = opts.anchor ?? (activeElement instanceof HTMLElement && activeElement !== doc.body ? activeElement : null);
  if (opts.anchor) {
    opts.anchor.setAttribute("aria-haspopup", role);
    opts.anchor.setAttribute("aria-expanded", "true");
    opts.anchor.setAttribute("aria-controls", el.id);
  }

  // Every popup renders in a kit portal: it follows the chart into element
  // fullscreen and into its shadow root, mirrors the widget's theme
  // variables (CSS variables would otherwise stop at the portal boundary and
  // light/custom themes would fall back to the dark palette), and adopts the
  // popup stylesheet wherever it lands. A context menu has no anchor; its
  // chart (the theme root) decides where it renders.
  const portal: Portal = createPortal({
    anchor: opts.anchor ?? themeRoot ?? (returnFocus?.isConnected ? returnFocus : null),
    themeRoot,
    fontFamily: opts.fontFamily,
    className: sheet && opts.className ? `${opts.className}-sheet` : undefined,
  });
  portal.adopt(sheet ? [POPUP_STYLES, SHEET_STYLES] : POPUP_STYLES);

  // Bottom sheet: a backdrop and a full-width surface. Tapping the backdrop,
  // activating the handle, or swiping down closes the menu and restores
  // focus. The sheet is modal: Tab and Shift+Tab cycle inside it instead of
  // reaching the page hidden behind the backdrop, and it is exposed as an
  // aria-modal dialog (the menu role cannot carry aria-modal itself).
  let frame: SheetFrame | null = null;
  let unlockScroll: (() => void) | null = null;
  if (sheet) {
    if (role === "dialog") el.setAttribute("aria-modal", "true");
    frame = createSheetFrame(portal.el, {
      content: el,
      modalLabel: role === "dialog" ? undefined : el.getAttribute("aria-label") ?? undefined,
      onDismiss: () => close(),
    });
    unlockScroll = lockScroll(doc);
  } else {
    portal.el.appendChild(el);
  }
  // Pointer/focus containment covers the whole portal (sheet backdrop and handle too).
  const surface: HTMLElement = portal.el;
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
    }, view)
    : null;

  const focusItem = (index = 0): void => {
    const items = popupItems(el);
    if (!items.length) {
      focusWithoutScroll(el);
      return;
    }
    const item = items[Math.max(0, Math.min(items.length - 1, index))]!;
    focusWithoutScroll(item);
    revealItem(item);
  };

  // ── Placement ──────────────────────────────────────────────────────────
  const reposition = (): void => {
    if (sheet || closed) return; // sheets are laid out by the kit stylesheet
    if (opts.anchor && !opts.anchor.isConnected) {
      // The control the popup belongs to is gone (chrome re-render, widget
      // destroy); a popup pointing at nothing must not linger.
      close({ restoreFocus: false });
      return;
    }
    const width = view.innerWidth;
    const height = view.innerHeight;
    // Measure at the tallest allowed height, then narrow to the chosen side.
    el.style.maxHeight = `${Math.max(0, height - VIEWPORT_MARGIN * 2)}px`;
    const size = {
      width: el.offsetWidth || opts.minWidth || 140,
      height: el.offsetHeight || 100,
    };
    const rtl = portal.el.dir === "rtl";
    let left: number;
    let top: number;
    let maxHeight = height - VIEWPORT_MARGIN * 2;
    let origin: string;
    if (opts.anchor) {
      const rect = opts.anchor.getBoundingClientRect();
      const below = opts.place === "below-start";
      const placed = computePosition(
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        size,
        { width, height },
        {
          placement: below ? "bottom-start" : "right-start",
          gap: below ? 4 : 6,
          margin: VIEWPORT_MARGIN,
          direction: rtl ? "rtl" : "ltr",
        },
      );
      left = placed.left;
      top = placed.top;
      maxHeight = placed.maxHeight;
      el.dataset.side = placed.side;
      origin = originFor(placed.side, rtl);
    } else {
      // A point (context menu): open down and to the end of the cursor, and
      // flip to the other side of it on either axis when that side lacks room.
      const x = opts.x ?? 0;
      const y = opts.y ?? 0;
      const fitsAfter = x + size.width <= width - VIEWPORT_MARGIN;
      const fitsBefore = x - size.width >= VIEWPORT_MARGIN;
      const before = rtl ? fitsBefore || !fitsAfter : !fitsAfter && fitsBefore;
      left = before ? x - size.width : x;
      left = Math.max(VIEWPORT_MARGIN, Math.min(left, width - VIEWPORT_MARGIN - size.width));
      const above = y + size.height > height - VIEWPORT_MARGIN && y - size.height >= VIEWPORT_MARGIN;
      top = above ? y - size.height : Math.max(VIEWPORT_MARGIN, Math.min(y, height - VIEWPORT_MARGIN - size.height));
      el.dataset.side = above ? "top" : "bottom";
      origin = `${left < x ? "right" : "left"} ${above ? "bottom" : "top"}`;
    }
    el.style.maxHeight = `${Math.max(0, Math.floor(maxHeight))}px`;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.transformOrigin = origin;
  };

  let frameRequest = 0;
  const cancelFrame = (): void => {
    if (!frameRequest) return;
    if (view.cancelAnimationFrame) view.cancelAnimationFrame(frameRequest);
    else view.clearTimeout(frameRequest);
    frameRequest = 0;
  };
  const scheduleReposition = (): void => {
    if (frameRequest || closed || sheet) return;
    const run = (): void => {
      frameRequest = 0;
      reposition();
    };
    frameRequest = view.requestAnimationFrame ? view.requestAnimationFrame(run) : view.setTimeout(run, 16);
  };
  const onScroll = (e: Event): void => {
    // Scrolling the popup's own list does not move its anchor.
    if (!isInside(eventOrigin(e))) scheduleReposition();
  };
  const ResizeObserverImpl = (view as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  const resizeObserver = !sheet && ResizeObserverImpl ? new ResizeObserverImpl(() => scheduleReposition()) : null;

  let closed = false;
  const close = (options?: { restoreFocus?: boolean }): void => {
    if (closed) return;
    closed = true;
    cancelFrame();
    resizeObserver?.disconnect();
    doc.removeEventListener("pointerdown", onAway, true);
    doc.removeEventListener("keydown", onKey, true);
    for (const root of focusRoots) root.removeEventListener("focusin", onFocusIn as EventListener, true);
    focusRoots = [];
    doc.removeEventListener("scroll", onScroll, true);
    doc.removeEventListener("fullscreenchange", onFullscreenChange);
    doc.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    view.removeEventListener("resize", scheduleReposition);
    el.removeEventListener("keydown", onMenuKey);
    el.removeEventListener("focusout", onFocusOut);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("mousedown", onMouseDown);
    stopWatching?.();
    trap?.release({ restoreFocus: false });
    popLayer();
    frame?.destroy();
    portal.destroy();
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
      focusWithoutScroll(returnFocus);
    }
  };
  // Where a node sits relative to the popup. Containment is composed, so a
  // popup portalled into the chart's shadow root (and an anchor inside one)
  // is recognised from document-level listeners.
  const isInside = (node: Node | null): boolean => !!node && composedContains(surface, node);
  const isAnchor = (node: Node | null): boolean => !!node && !!opts.anchor && composedContains(opts.anchor, node);
  const isAbove = (node: Node | null): boolean => isInLayerAbove(layer, node); // an overlay opened from this popup
  const focusIsInside = (): boolean => isInside(deepActiveElement(doc));

  const onAway = (e: PointerEvent): void => {
    const target = eventOrigin(e);
    if (!target) return;
    if (isInside(target) || isAbove(target)) return;
    if (isAnchor(target)) return; // let the anchor's own toggle run
    close({ restoreFocus: false });
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    // Escape belongs to the popup while focus is in it or on its anchor. The
    // deep active element and the composed origin both see into (open)
    // shadow roots, where document.activeElement is only the shadow host.
    const owned = [deepActiveElement(doc), eventOrigin(e)].some((node) => isInside(node) || isAnchor(node));
    if (!owned) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onMenuKey = (e: KeyboardEvent): void => {
    if (e.key === "Tab" && !sheet && role === "menu" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Menu-button pattern: Tab and Shift+Tab leave the menu. It closes and
      // returns focus to its opener first, so the browser's own Tab moves on
      // from there to the next (or previous) control rather than walking
      // the rows, which are navigated with the arrow keys.
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    if (isEditableTarget(e.target)) return;
    const items = popupItems(el);
    if (!items.length) return;
    const active = deepActiveElement(doc);
    const current = active ? items.indexOf(active as HTMLElement) : -1;
    let next = current;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    e.preventDefault();
    focusItem(next);
  };
  // The pointer moves the one highlight: inside a menu that holds focus,
  // hovering a row focuses it (the native menu model), so a keyboard-focused
  // row and a hovered row are never lit together. Popups whose focus stays
  // elsewhere (combobox results) use CSS :hover instead.
  const onPointerMove = (e: PointerEvent): void => {
    if (sheet || e.pointerType === "touch" || !focusIsInside()) return;
    const item = itemAt(el, e.target);
    if (item && item !== deepActiveElement(doc)) focusWithoutScroll(item);
  };
  // A mouse press on a row of a menu that holds focus lands on that row
  // without a focus round-trip through <body>. Browsers disagree on whether a
  // pressed <button> takes focus (WebKit does not), and a press that dropped
  // focus looked like focus leaving the menu. Keeping focus in the menu and
  // moving it to the pressed row makes the click reliable everywhere.
  const onMouseDown = (e: MouseEvent): void => {
    if (sheet || e.button !== 0 || !focusIsInside()) return;
    const item = itemAt(el, e.target);
    if (!item) return;
    e.preventDefault();
    if (item !== deepActiveElement(doc)) focusWithoutScroll(item);
  };
  // Focus leaving an anchored menu (Tab, or focus moved by code) closes it.
  // A sheet's focus trap keeps focus inside instead. The decision is made
  // when focus ARRIVES somewhere (focusin), from the composed target: during
  // a user-initiated focus change document.activeElement is <body> while
  // focusout runs, so a check there closed the menu whenever a press moved
  // focus from one row to another, before that row's click could run.
  // Only focus that was inside the popup can leave it: focus moving elsewhere
  // before the first row is focused (a context menu's canvas) or in popups
  // that never take focus (a combobox's results) does not close them.
  let hadFocus = false;
  const onFocusIn = (e: FocusEvent): void => {
    if (sheet || closed) return;
    const target = eventOrigin(e);
    if (!target) return;
    if (isInside(target)) {
      hadFocus = true;
      return;
    }
    if (!hadFocus || isAnchor(target) || isAbove(target)) return;
    close({ restoreFocus: false });
  };
  // A focus change between two nodes of one shadow tree never reaches the
  // document (propagation stops at the host once target and relatedTarget
  // retarget to it), so focusin is also watched on the shadow roots holding
  // the popup and its anchor. Fullscreen can move the portal to another root.
  let focusRoots: Array<Document | ShadowRoot> = [];
  const syncFocusRoots = (): void => {
    const next: Array<Document | ShadowRoot> = [doc];
    for (const node of [surface, opts.anchor]) {
      const root = node?.getRootNode?.();
      if (root && root.nodeType === 11 && "host" in root && !next.includes(root as ShadowRoot)) next.push(root as ShadowRoot);
    }
    for (const root of focusRoots) if (!next.includes(root)) root.removeEventListener("focusin", onFocusIn as EventListener, true);
    for (const root of next) if (!focusRoots.includes(root)) root.addEventListener("focusin", onFocusIn as EventListener, true);
    focusRoots = next;
  };
  // The portal re-homes itself into (or out of) the fullscreen element in
  // its own (capturing) listener; placement and focus roots follow.
  const onFullscreenChange = (): void => {
    if (closed) return;
    syncFocusRoots();
    scheduleReposition();
  };
  // Focus that goes nowhere (blur() from code, Tab out of the page) fires no
  // focusin. The check waits a task, not a microtask: while a press is still
  // moving focus the active element is <body>, and some engines focus the
  // pressed element asynchronously. The window itself losing focus leaves
  // the active element inside, so the menu stays. A focused row removed by a
  // re-render hands focus back to the menu instead of closing it.
  const onFocusOut = (e: FocusEvent): void => {
    if (sheet || e.relatedTarget) return;
    const from = e.target as Node | null;
    view.setTimeout(() => {
      if (closed) return;
      const active = deepActiveElement(doc);
      if (isInside(active) || isAnchor(active) || isAbove(active)) return;
      if ((!active || active === doc.body) && from && !from.isConnected && el.isConnected) {
        focusItem();
        return;
      }
      close({ restoreFocus: false });
    }, 0);
  };
  el.addEventListener("keydown", onMenuKey);
  el.addEventListener("focusout", onFocusOut);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("mousedown", onMouseDown);
  syncFocusRoots();
  doc.addEventListener("fullscreenchange", onFullscreenChange);
  doc.addEventListener("webkitfullscreenchange", onFullscreenChange);
  if (!sheet) {
    view.addEventListener("resize", scheduleReposition);
    doc.addEventListener("scroll", onScroll, true);
    resizeObserver?.observe(el);
  }

  // Defer so the opening click doesn't immediately dismiss and callers have
  // time to append rows before the first one receives focus.
  view.setTimeout(() => {
    if (closed) return;
    doc.addEventListener("pointerdown", onAway, true);
    doc.addEventListener("keydown", onKey, true);
    if (opts.initialFocus !== false) focusItem();
  }, 0);

  reposition();
  return { el, close, reposition, focusItem, presentation };
}

/** Standard popup row: CSS hover/focus/selected states, ≥40px tall on touch devices. */
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
  row.className = "raze-chart-popup-row";
  if (isCoarsePointer()) row.dataset.touch = "";
  row.setAttribute("role", options?.role ?? "menuitem");
  if (options?.checked !== undefined) row.setAttribute("aria-checked", String(options.checked));
  if (options?.label) row.setAttribute("aria-label", options.label);
  for (const svg of row.querySelectorAll("svg")) {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
  }
  row.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return row;
}

/**
 * A divider between groups of popup rows. It is exposed as a separator and
 * is not a stop for the arrow keys, Home or End.
 */
export function popupSeparator(): HTMLDivElement {
  const separator = document.createElement("div");
  separator.className = "raze-chart-popup-separator";
  separator.setAttribute("role", "separator");
  return separator;
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
