// Accessible tooltips that replace `title` attributes: shown on hover (after
// a short delay, instantly while "warm") and on keyboard focus, hoverable,
// dismissible with Escape, never shown for touch, and linked to the target
// with aria-describedby while visible. A target without an accessible name
// gets the tooltip text as its aria-label. A visible tooltip hides itself when
// its target leaves the DOM (chrome re-render, widget destroy), which fires
// neither pointerleave nor blur reliably. destroy() puts back the `title`
// and removes the `aria-label` the tooltip replaced or added.

import { defineStyles, type StyleChunk } from "../styles";
import { uid } from "./dom";
import { createPortal, type Portal } from "./portal";
import { computePosition, type Placement } from "./position";

export const TOOLTIP_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "kit-tooltip",
  ".raze-kit-tooltip{position:fixed;max-width:min(320px,calc(100vw - 16px));padding:5px 8px;border-radius:var(--raze-radius-sm,4px);" +
  "background:var(--raze-tooltip-background,#e0e3eb);color:var(--raze-tooltip-text,#131722);font-size:12px;line-height:1.35;" +
  "white-space:pre-line;overflow-wrap:anywhere;box-shadow:0 2px 8px rgba(0,0,0,.25);animation:raze-kit-tip-in 120ms ease-out}" +
  "@keyframes raze-kit-tip-in{from{opacity:0}}" +
  "@media (prefers-reduced-motion:reduce){.raze-kit-tooltip{animation:none}}" +
  "@media (forced-colors:active){.raze-kit-tooltip{border:1px solid CanvasText}}",
);

export interface TooltipOptions {
  placement?: Placement;
  /** Hover delay in ms before showing (default 450). */
  delay?: number;
  themeRoot?: Element | null;
}

export interface TooltipHandle {
  /** Change the text (updates a visible tooltip in place). */
  update(text: string): void;
  show(): void;
  hide(): void;
  destroy(): void;
}

const WARM_WINDOW = 400;
/** How often a visible tooltip checks that its target is still attached. */
const DETACH_CHECK_MS = 250;
let lastHiddenAt = -Infinity;

function accessibleName(target: HTMLElement): string {
  return (target.getAttribute("aria-label") ?? target.textContent ?? "").trim();
}

/** Attach a tooltip to `target`. Removes any `title` attribute it replaces. */
export function attachTooltip(target: HTMLElement, text: string, options: TooltipOptions = {}): TooltipHandle {
  const doc = target.ownerDocument;
  let content = text;
  let portal: Portal | null = null;
  let bubble: HTMLDivElement | null = null;
  let showTimer = 0;
  let hideTimer = 0;
  let detachTimer = 0;
  let destroyed = false;
  const id = uid("tooltip");

  const replacedTitle = target.getAttribute("title");
  target.removeAttribute("title");
  const labels = !accessibleName(target) && !target.hasAttribute("aria-labelledby");
  if (labels) target.setAttribute("aria-label", content);
  /** The aria-label this tooltip last wrote (so destroy() leaves a host's own label alone). */
  let ownLabel = labels ? content : null;

  const describe = (on: boolean): void => {
    const ids = (target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((value) => value && value !== id);
    if (on && accessibleName(target) !== content.trim()) ids.push(id);
    if (ids.length) target.setAttribute("aria-describedby", ids.join(" "));
    else target.removeAttribute("aria-describedby");
  };

  const position = (): void => {
    if (!bubble) return;
    const view = doc.defaultView;
    if (!view) return;
    const rect = target.getBoundingClientRect();
    const placed = computePosition(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      { width: bubble.offsetWidth, height: bubble.offsetHeight },
      { width: view.innerWidth, height: view.innerHeight },
      { placement: options.placement ?? "bottom", gap: 6, direction: portal?.el.dir === "rtl" ? "rtl" : "ltr" },
    );
    bubble.style.left = `${placed.left}px`;
    bubble.style.top = `${placed.top}px`;
  };

  const clearTimers = (): void => {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    showTimer = 0;
    hideTimer = 0;
  };

  const hide = (): void => {
    clearTimers();
    window.clearInterval(detachTimer);
    detachTimer = 0;
    if (!bubble) return;
    doc.removeEventListener("keydown", onDocumentKey, true);
    portal?.destroy();
    portal = null;
    bubble = null;
    describe(false);
    lastHiddenAt = Date.now();
  };

  const show = (): void => {
    clearTimers();
    if (destroyed || bubble || !target.isConnected || !content.trim()) return;
    portal = createPortal({ anchor: target, themeRoot: options.themeRoot });
    portal.adopt(TOOLTIP_STYLES);
    bubble = doc.createElement("div");
    bubble.className = "raze-kit-tooltip";
    bubble.id = id;
    bubble.setAttribute("role", "tooltip");
    bubble.textContent = content;
    bubble.addEventListener("pointerenter", () => window.clearTimeout(hideTimer));
    bubble.addEventListener("pointerleave", scheduleHide);
    portal.el.appendChild(bubble);
    position();
    describe(true);
    doc.addEventListener("keydown", onDocumentKey, true);
    detachTimer = window.setInterval(() => {
      if (!target.isConnected) hide();
    }, DETACH_CHECK_MS);
  };

  function scheduleHide(): void {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 100);
  }

  function onDocumentKey(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !bubble) return;
    hide();
    // Consume the key only when focus is on the target, so Escape still
    // reaches open menus/dialogs elsewhere.
    if (event.target === target) event.stopPropagation();
  }

  const onPointerEnter = (event: PointerEvent): void => {
    if (event.pointerType === "touch") return;
    window.clearTimeout(hideTimer);
    if (bubble) return;
    const warm = Date.now() - lastHiddenAt < WARM_WINDOW;
    showTimer = window.setTimeout(show, warm ? 0 : options.delay ?? 450);
  };
  const onFocus = (): void => {
    let keyboard = true;
    try {
      keyboard = target.matches(":focus-visible");
    } catch {
      // Older engines: treat focus as keyboard focus.
    }
    if (keyboard) show();
  };

  target.addEventListener("pointerenter", onPointerEnter);
  target.addEventListener("pointerleave", scheduleHide);
  target.addEventListener("pointerdown", hide);
  target.addEventListener("focus", onFocus);
  target.addEventListener("blur", hide);

  return {
    update(next) {
      content = next;
      if (labels) {
        target.setAttribute("aria-label", next);
        ownLabel = next;
      }
      if (bubble) {
        bubble.textContent = next;
        position();
        describe(true);
      }
    },
    show,
    hide,
    destroy() {
      if (destroyed) return;
      hide();
      destroyed = true;
      target.removeEventListener("pointerenter", onPointerEnter);
      target.removeEventListener("pointerleave", scheduleHide);
      target.removeEventListener("pointerdown", hide);
      target.removeEventListener("focus", onFocus);
      target.removeEventListener("blur", hide);
      // Hand the target back as it was: its own title again, and no label
      // that only this tooltip provided (a host that relabelled it keeps its label).
      if (ownLabel !== null && target.getAttribute("aria-label") === ownLabel) target.removeAttribute("aria-label");
      if (replacedTitle !== null && !target.hasAttribute("title")) target.setAttribute("title", replacedTitle);
    },
  };
}
