// Focus management: tabbable discovery, modal focus trapping with restore,
// and reference-counted page scroll locking.

import { composedContains, deepActiveElement, focusWithoutScroll } from "./dom";
import { isInLayerAbove, type Layer } from "./layers";

const TABBABLE = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type=\"hidden\"])",
  "select",
  "textarea",
  "iframe",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable=\"false\"])",
  "[tabindex]",
].join(",");

function isRendered(element: HTMLElement): boolean {
  if (element.closest("[hidden],[inert]")) return false;
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle?.(element);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

/** Keyboard-reachable elements inside `container`, in DOM order. */
export function tabbables(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE)).filter((element) => {
    if (element.tabIndex < 0) return false;
    if ((element as HTMLButtonElement).disabled) return false;
    return isRendered(element);
  });
}

export interface FocusTrap {
  /** Stop trapping; optionally restore focus to the element focused before. */
  release(options?: { restoreFocus?: boolean }): void;
}

/**
 * Keep keyboard focus inside `container` (and overlays stacked above
 * `layer`). Tab and Shift+Tab cycle; focus that escapes by pointer or
 * programmatically is pulled back.
 */
export function trapFocus(
  container: HTMLElement,
  layer: Layer,
  returnFocus: HTMLElement | null,
): FocusTrap {
  const doc = container.ownerDocument;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const items = tabbables(container);
    if (!items.length) {
      event.preventDefault();
      focusWithoutScroll(container);
      return;
    }
    const active = deepActiveElement(doc);
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const index = active ? items.indexOf(active as HTMLElement) : -1;
    if (event.shiftKey && (index <= 0)) {
      event.preventDefault();
      focusWithoutScroll(last);
    } else if (!event.shiftKey && (index === -1 || index === items.length - 1)) {
      event.preventDefault();
      focusWithoutScroll(first);
    }
  };

  const onFocusIn = (event: FocusEvent): void => {
    const target = (event.composedPath?.()[0] ?? event.target) as Node | null;
    if (!target || composedContains(container, target) || isInLayerAbove(layer, target)) return;
    focusWithoutScroll(tabbables(container)[0] ?? container);
  };

  container.addEventListener("keydown", onKeyDown);
  doc.addEventListener("focusin", onFocusIn, true);

  let released = false;
  return {
    release(options) {
      if (released) return;
      released = true;
      container.removeEventListener("keydown", onKeyDown);
      doc.removeEventListener("focusin", onFocusIn, true);
      if (options?.restoreFocus !== false && returnFocus?.isConnected) focusWithoutScroll(returnFocus);
    },
  };
}

interface ScrollLockState {
  count: number;
  overflow: string;
  paddingRight: string;
}

const locks = new WeakMap<Document, ScrollLockState>();

/**
 * Prevent the page behind a modal or sheet from scrolling. Nested locks are
 * reference-counted; the scrollbar gutter is compensated to avoid a shift.
 */
export function lockScroll(doc: Document = document): () => void {
  const root = doc.documentElement;
  let state = locks.get(doc);
  if (!state) {
    const view = doc.defaultView;
    const gutter = view ? Math.max(0, view.innerWidth - root.clientWidth) : 0;
    state = { count: 0, overflow: root.style.overflow, paddingRight: root.style.paddingRight };
    locks.set(doc, state);
    root.style.overflow = "hidden";
    if (gutter > 0) root.style.paddingRight = `${gutter}px`;
  }
  state.count += 1;
  let unlocked = false;
  return () => {
    if (unlocked) return;
    unlocked = true;
    const current = locks.get(doc);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    root.style.overflow = current.overflow;
    root.style.paddingRight = current.paddingRight;
    locks.delete(doc);
  };
}
