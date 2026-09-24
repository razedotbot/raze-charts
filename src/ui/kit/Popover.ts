// Anchored, non-modal floating panel (colour pickers, go-to-date, inline
// pickers). It flips and shifts to stay in the viewport, caps its height to
// the available space, follows fullscreen/shadow roots through the portal,
// and becomes a modal bottom sheet on phones and narrow viewports.

import { defineStyles, type StyleChunk } from "../styles";
import { composedContains, deepActiveElement, focusWithoutScroll, uid } from "./dom";
import { lockScroll, tabbables, trapFocus, type FocusTrap } from "./focus";
import { isInLayerAbove, pushLayer, type Layer } from "./layers";
import { prefersSheet } from "./media";
import { createPortal, type Portal } from "./portal";
import { computePosition, type Placement } from "./position";
import { createSheetFrame, SHEET_STYLES, type SheetFrame } from "./Sheet";
import { SURFACE_STYLES } from "./surface";

export const POPOVER_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "kit-popover",
  ".raze-kit-popover{position:fixed;display:flex;flex-direction:column;min-width:160px;overflow:auto;overscroll-behavior:contain;" +
  "padding:8px;animation:raze-kit-pop var(--raze-duration,160ms) ease-out}" +
  "@keyframes raze-kit-pop{from{opacity:0;transform:scale(.98)}}" +
  "@media (prefers-reduced-motion:reduce){.raze-kit-popover{animation:none}}",
);

export type Presentation = "auto" | "anchored" | "sheet";

export type PopoverCloseReason = "escape" | "outside" | "focus-out" | "backdrop" | "swipe" | "handle" | "api";

export interface PopoverOptions {
  /** Element the popover is anchored to; focus returns here on close. */
  anchor: HTMLElement;
  /** Accessible name of the popover. */
  label: string;
  /** Initial content, or a render callback receiving the content element. */
  content?: Node | string | ((body: HTMLElement) => void);
  /** ARIA role of the surface (default `dialog`). */
  role?: "dialog" | "menu" | "listbox" | "group";
  placement?: Placement;
  /** `auto` (default) uses a bottom sheet on coarse pointers / narrow viewports. */
  presentation?: Presentation;
  /** Widget root whose theme is mirrored (defaults to the anchor's widget). */
  themeRoot?: Element | null;
  fontFamily?: string;
  className?: string;
  /** Focus the first control on open (default), a specific element, or nothing. */
  initialFocus?: boolean | HTMLElement;
  onClose?(reason: PopoverCloseReason): void;
}

export interface PopoverHandle {
  /** The surface; append or replace content here. */
  readonly el: HTMLElement;
  readonly presentation: "anchored" | "sheet";
  readonly closed: boolean;
  close(options?: { restoreFocus?: boolean; reason?: PopoverCloseReason }): void;
  /** Recompute placement after content changes (no-op for sheets). */
  reposition(): void;
}

/** Resolve `auto` presentation for the current environment. */
export function resolvePresentation(presentation: Presentation | undefined, anchor?: Element | null): "anchored" | "sheet" {
  if (presentation === "anchored" || presentation === "sheet") return presentation;
  return prefersSheet(anchor?.ownerDocument?.defaultView ?? undefined) ? "sheet" : "anchored";
}

export function openPopover(options: PopoverOptions): PopoverHandle {
  const { anchor } = options;
  const doc = anchor.ownerDocument;
  const presentation = resolvePresentation(options.presentation, anchor);
  const returnFocus = anchor;
  const portal: Portal = createPortal({
    anchor,
    themeRoot: options.themeRoot,
    fontFamily: options.fontFamily,
    className: options.className,
  });
  portal.adopt([SURFACE_STYLES, POPOVER_STYLES, SHEET_STYLES]);

  const surface = doc.createElement("div");
  surface.id = uid("popover");
  surface.tabIndex = -1;
  surface.setAttribute("role", options.role ?? "dialog");
  surface.setAttribute("aria-label", options.label);
  if (typeof options.content === "function") options.content(surface);
  else if (options.content) surface.append(options.content); // strings render as text
  portal.update(); // adopt styles of controls the content rendered

  const layer: Layer = { el: portal.el, modal: presentation === "sheet" };
  const popLayer = pushLayer(layer);
  let frame: SheetFrame | null = null;
  let trap: FocusTrap | null = null;
  let unlockScroll: (() => void) | null = null;
  let closed = false;
  let frameRequest = 0;

  anchor.setAttribute("aria-expanded", "true");
  anchor.setAttribute("aria-controls", surface.id);
  if (!anchor.hasAttribute("aria-haspopup")) anchor.setAttribute("aria-haspopup", options.role ?? "dialog");

  const reposition = (): void => {
    if (closed || frame) return;
    const view = doc.defaultView;
    if (!view) return;
    surface.style.maxHeight = "";
    const rect = anchor.getBoundingClientRect();
    const position = computePosition(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      { width: surface.offsetWidth, height: surface.offsetHeight },
      { width: view.innerWidth, height: view.innerHeight },
      { placement: options.placement ?? "bottom-start", direction: portal.el.dir === "rtl" ? "rtl" : "ltr" },
    );
    surface.style.left = `${position.left}px`;
    surface.style.top = `${position.top}px`;
    surface.style.maxHeight = `${position.maxHeight}px`;
    surface.style.maxWidth = `${position.maxWidth}px`;
    surface.dataset.side = position.side;
  };
  const scheduleReposition = (): void => {
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      reposition();
    });
  };

  const close = (closeOptions?: { restoreFocus?: boolean; reason?: PopoverCloseReason }): void => {
    if (closed) return;
    closed = true;
    if (frameRequest) cancelAnimationFrame(frameRequest);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.defaultView?.removeEventListener("resize", scheduleReposition);
    doc.defaultView?.removeEventListener("scroll", scheduleReposition, true);
    anchor.removeEventListener("keydown", onKeyDown);
    trap?.release({ restoreFocus: false });
    unlockScroll?.();
    frame?.destroy();
    popLayer();
    portal.destroy();
    anchor.setAttribute("aria-expanded", "false");
    if (anchor.getAttribute("aria-controls") === surface.id) anchor.removeAttribute("aria-controls");
    options.onClose?.(closeOptions?.reason ?? "api");
    if (closeOptions?.restoreFocus !== false && returnFocus.isConnected) focusWithoutScroll(returnFocus);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close({ reason: "escape" });
  };
  const onPointerDown = (event: PointerEvent): void => {
    const target = (event.composedPath?.()[0] ?? event.target) as Node | null;
    if (!target || composedContains(portal.el, target) || composedContains(anchor, target)) return;
    if (isInLayerAbove(layer, target)) return;
    close({ restoreFocus: false, reason: "outside" });
  };
  const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget as Node | null;
    queueMicrotask(() => {
      if (closed || frame) return;
      const active = next ?? deepActiveElement(doc);
      if (!active || active === doc.body) return; // focus moved to nothing (e.g. window blur)
      if (composedContains(portal.el, active) || active === anchor || isInLayerAbove(layer, active)) return;
      close({ restoreFocus: false, reason: "focus-out" });
    });
  };

  surface.addEventListener("keydown", onKeyDown);
  surface.addEventListener("focusout", onFocusOut);
  anchor.addEventListener("keydown", onKeyDown);

  if (presentation === "sheet") {
    // A sheet is modal. aria-modal is only valid on dialogs, so a menu,
    // listbox or group surface gets a dialog container that carries it.
    const isDialog = (options.role ?? "dialog") === "dialog";
    if (isDialog) surface.setAttribute("aria-modal", "true");
    frame = createSheetFrame(portal.el, {
      content: surface,
      modalLabel: isDialog ? undefined : options.label,
      onDismiss: (reason) => close({ reason }),
    });
    unlockScroll = lockScroll(doc);
    trap = trapFocus(surface, layer, returnFocus);
  } else {
    surface.className = "raze-kit-surface raze-kit-popover";
    portal.el.appendChild(surface);
    reposition();
    doc.defaultView?.addEventListener("resize", scheduleReposition);
    doc.defaultView?.addEventListener("scroll", scheduleReposition, true);
  }

  // Defer outside-dismissal so the opening click cannot close the popover.
  setTimeout(() => {
    if (!closed) doc.addEventListener("pointerdown", onPointerDown, true);
  }, 0);

  if (options.initialFocus !== false) {
    const target = options.initialFocus instanceof HTMLElement
      ? options.initialFocus
      : tabbables(surface)[0] ?? surface;
    focusWithoutScroll(target);
  }

  return {
    el: surface,
    presentation,
    get closed() {
      return closed;
    },
    close,
    reposition,
  };
}
