// Bottom-sheet presentation shared by menus, popovers and dialogs on phones
// and narrow viewports: a dimmed backdrop, a full-width surface anchored to
// the bottom edge (max 70% of the viewport height, safe-area padded), a drag
// handle, swipe-down-to-dismiss (from the handle, or from the content while it
// is scrolled to the top) and touch-sized rows. On wide touch screens
// (tablets) the sheet stays a readable 640px column, centred.

import { t } from "../../i18n";
import { defineStyles, type StyleChunk } from "../styles";
import { prefersReducedMotion } from "./media";

export const SHEET_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "kit-sheet",
  ".raze-kit-backdrop{position:fixed;inset:0;background:var(--raze-backdrop,rgba(0,0,0,.5));" +
  "animation:raze-kit-fade var(--raze-duration,160ms) ease-out;touch-action:none}" +
  ".raze-kit-sheet{position:fixed;left:0;right:0;bottom:0;width:100%;max-width:var(--raze-sheet-max-width,640px);max-height:70vh;display:flex;flex-direction:column;" +
  "margin:0 auto;background:var(--raze-surface,#1e222d);color:var(--raze-text,#d1d4dc);" +
  "border-radius:var(--raze-radius-lg,12px) var(--raze-radius-lg,12px) 0 0;box-shadow:0 -8px 28px rgba(0,0,0,.35);" +
  "padding:0 0 env(safe-area-inset-bottom,0px);font-size:var(--raze-font-size-lg,14px);outline:none;" +
  "animation:raze-kit-rise .24s cubic-bezier(.2,.8,.2,1)}" +
  ".raze-kit-sheet[data-entered]{animation:none}" +
  ".raze-kit-sheet[data-dragging]{animation:none;transition:none!important}" +
  ".raze-kit-sheet-handle{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:100%;height:28px;" +
  "margin:0;padding:0;border:0;background:transparent;color:inherit;cursor:grab;touch-action:none;border-radius:inherit}" +
  ".raze-kit-sheet-handle::before{content:\"\";width:36px;height:4px;border-radius:2px;background:currentColor;opacity:.4}" +
  ".raze-kit-sheet-content{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}" +
  ".raze-kit-sheet-content :is([role^=menuitem],[role=option],[role=tab],.raze-kit-row){min-height:var(--raze-touch-row-height,48px)}" +
  "@keyframes raze-kit-rise{from{transform:translateY(100%)}}" +
  "@keyframes raze-kit-fade{from{opacity:0}}" +
  "@media (prefers-reduced-motion:reduce){.raze-kit-sheet,.raze-kit-backdrop{animation:none}}" +
  "@media (forced-colors:active){.raze-kit-sheet{border:1px solid CanvasText;border-bottom:0}.raze-kit-sheet-handle::before{background:CanvasText}}",
);

export type SheetDismissReason = "backdrop" | "swipe" | "handle";

export interface SheetFrameOptions {
  /** Content placed below the handle. */
  content: HTMLElement;
  /** Element whose scroll position gates content swipes (defaults to `content`). */
  scroller?: HTMLElement;
  /**
   * Accessible name for a sheet whose content is not itself a modal dialog
   * (a menu, listbox or group). The sheet then becomes the `role="dialog"`
   * `aria-modal="true"` container, because `aria-modal` is only valid on
   * dialogs; assistive technology keeps its reading cursor inside the sheet
   * instead of reaching the page behind the backdrop. Omit it when the
   * content is the dialog (it carries `aria-modal` itself).
   */
  modalLabel?: string;
  /**
   * Called once when the user dismisses by backdrop, swipe or handle. Return
   * `false` to refuse (for example while a dialog is submitting): the sheet
   * snaps back and can be dismissed again later.
   */
  onDismiss(reason: SheetDismissReason): boolean | void;
}

export interface SheetFrame {
  readonly backdrop: HTMLDivElement;
  readonly sheet: HTMLDivElement;
  readonly handle: HTMLButtonElement;
  destroy(): void;
}

/** Distance (px) or flick velocity (px/ms) that dismisses a dragged sheet. */
const DISMISS_DISTANCE = 96;
const DISMISS_VELOCITY = 0.5;

/** Build a sheet inside `parent` (normally a kit portal). */
export function createSheetFrame(parent: HTMLElement, options: SheetFrameOptions): SheetFrame {
  const doc = parent.ownerDocument;
  const backdrop = doc.createElement("div");
  backdrop.className = "raze-kit-backdrop";
  backdrop.setAttribute("data-raze-sheet-backdrop", "");

  const sheet = doc.createElement("div");
  sheet.className = "raze-kit-sheet";
  if (options.modalLabel) {
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", options.modalLabel);
  }
  // The entrance animation must run once: re-enabling it after a drag would
  // replay the slide-up from off-screen.
  const entered = (): void => sheet.setAttribute("data-entered", "");
  sheet.addEventListener("animationend", entered, { once: true });

  const handle = doc.createElement("button");
  handle.type = "button";
  handle.className = "raze-kit-sheet-handle";
  handle.tabIndex = -1;
  handle.setAttribute("aria-label", t("kit.sheet.close", "Close"));

  options.content.classList.add("raze-kit-sheet-content");
  sheet.append(handle, options.content);
  parent.append(backdrop, sheet);

  const scroller = options.scroller ?? options.content;
  let dismissed = false;
  let offset = 0;
  let startY = 0;
  let startTime = 0;
  let suppressClick = false;

  const setOffset = (value: number): void => {
    offset = Math.max(0, value);
    sheet.style.transform = offset ? `translateY(${offset}px)` : "";
    const height = sheet.offsetHeight || 1;
    backdrop.style.opacity = offset ? String(Math.max(0, 1 - offset / height)) : "";
  };

  /** Return to the resting position, animated unless motion is reduced. */
  const snapBack = (): void => {
    if (offset && !prefersReducedMotion(doc.defaultView ?? undefined)) {
      sheet.style.transition = "transform .18s ease-out";
      const clear = (): void => {
        sheet.style.transition = "";
      };
      sheet.addEventListener("transitionend", clear, { once: true });
      setTimeout(clear, 250);
    }
    setOffset(0);
  };

  const dismiss = (reason: SheetDismissReason): void => {
    if (dismissed) return;
    dismissed = true;
    if (options.onDismiss(reason) === false) {
      dismissed = false;
      snapBack();
    }
  };

  const begin = (y: number, time: number): void => {
    startY = y;
    startTime = time;
    offset = 0;
    entered();
    sheet.setAttribute("data-dragging", "");
  };

  const finish = (time: number): void => {
    sheet.removeAttribute("data-dragging");
    const velocity = offset / Math.max(1, time - startTime);
    if (offset > 4) suppressClick = true;
    if (offset >= DISMISS_DISTANCE || (offset > 24 && velocity > DISMISS_VELOCITY)) {
      dismiss("swipe");
      return;
    }
    snapBack();
  };

  // Keep focus where it is (inside the sheet or on its opener) when the
  // backdrop or handle is pressed; focus-out would otherwise dismiss first.
  const keepFocus = (event: Event): void => event.preventDefault();
  backdrop.addEventListener("mousedown", keepFocus);
  handle.addEventListener("mousedown", keepFocus);
  backdrop.addEventListener("click", () => dismiss("backdrop"));

  let pointerId: number | null = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events in tests have no active pointer to capture.
    }
    begin(event.clientY, event.timeStamp);
  });
  handle.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    setOffset(event.clientY - startY);
  });
  const endPointer = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    finish(event.timeStamp);
  };
  handle.addEventListener("pointerup", endPointer);
  handle.addEventListener("pointercancel", endPointer);
  handle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    dismiss("handle");
  });

  // Content swipe: only when already scrolled to the top and moving down, so
  // normal scrolling inside a long sheet keeps working.
  let touchTracking = false;
  let touchDragging = false;
  const onTouchStart = (event: TouchEvent): void => {
    // The handle drives its own drag through pointer events.
    if (event.touches.length !== 1 || handle.contains(event.target as Node)) {
      touchTracking = false;
      return;
    }
    touchTracking = scroller.scrollTop <= 0;
    touchDragging = false;
    startY = event.touches[0]!.clientY;
    startTime = event.timeStamp;
  };
  const onTouchMove = (event: TouchEvent): void => {
    if (!touchTracking) return;
    const delta = event.touches[0]!.clientY - startY;
    if (!touchDragging) {
      if (delta <= 0 || scroller.scrollTop > 0) {
        touchTracking = false;
        return;
      }
      if (delta < 6) return;
      touchDragging = true;
      begin(startY, startTime);
    }
    if (event.cancelable) event.preventDefault();
    setOffset(delta);
  };
  const onTouchEnd = (event: TouchEvent): void => {
    if (touchDragging) finish(event.timeStamp);
    touchTracking = false;
    touchDragging = false;
  };
  const onClickCapture = (event: MouseEvent): void => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  sheet.addEventListener("touchstart", onTouchStart, { passive: true });
  sheet.addEventListener("touchmove", onTouchMove, { passive: false });
  sheet.addEventListener("touchend", onTouchEnd);
  sheet.addEventListener("touchcancel", onTouchEnd);
  sheet.addEventListener("click", onClickCapture, true);

  return {
    backdrop,
    sheet,
    handle,
    destroy() {
      dismissed = true;
      backdrop.remove();
      sheet.remove();
      options.content.classList.remove("raze-kit-sheet-content");
    },
  };
}
