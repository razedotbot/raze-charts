// The chart header. Hosts the interval selector (added in P3) plus a left/right
// slot for `createButton`-injected HTMLElements. Rendered as plain DOM (no
// iframe), themed via CSS custom properties set by setCSSCustomProperty.

import type { CreateButtonOptions } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { enableToolbarKeyboardNavigation, isCoarsePointer } from "./popup";

export const TOOLBAR_HEIGHT = 38;

export class Toolbar {
  readonly el: HTMLDivElement;
  private rail: HTMLDivElement;
  private leftSlot: HTMLDivElement;
  private rightSlot: HTMLDivElement;
  private removeKeyboardNavigation: () => void;
  private scrollObserver: ResizeObserver | null = null;
  private readonly syncScrollHints = (): void => {
    const max = Math.max(0, this.el.scrollWidth - this.el.clientWidth);
    this.el.dataset.scrollLeft = String(max > 1 && this.el.scrollLeft > 1);
    this.el.dataset.scrollRight = String(max > 1 && this.el.scrollLeft < max - 1);
  };
  private readonly revealFocusedControl = (event: FocusEvent): void => {
    const target = event.target;
    if (target instanceof HTMLElement && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }
  };
  /** Anchor where the interval selector mounts (P3), kept left of custom buttons. */
  readonly intervalSlot: HTMLDivElement;
  readonly searchSlot: HTMLDivElement;
  readonly rangeSlot: HTMLDivElement;

  constructor(private readonly context: ChartContext) {
    this.el = document.createElement("div");
    this.el.className = "raze-chart-toolbar";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Chart toolbar");
    this.el.setAttribute("aria-orientation", "horizontal");
    this.el.style.cssText = [
      "display:block",
      `height:${TOOLBAR_HEIGHT}px`,
      "min-height:" + TOOLBAR_HEIGHT + "px",
      "box-sizing:border-box",
      "border-bottom:1px solid var(--tv-color-toolbar-divider-background, #363a45)",
      "background:var(--tv-color-toolbar-button-background, transparent)",
      "color:var(--tv-color-toolbar-button-text, #d1d4dc)",
      `font-family:${this.context.fontFamily}`,
      "font-size:13px",
      "user-select:none",
      "overflow-x:auto",
      "overflow-y:hidden",
      "overscroll-behavior-x:contain",
      "scroll-behavior:smooth",
      "-webkit-overflow-scrolling:touch",
      "position:relative",
      "z-index:3",
    ].join(";");

    const mkSlot = (justify: string): HTMLDivElement => {
      const s = document.createElement("div");
      s.style.cssText = `display:flex;align-items:center;gap:2px;justify-content:${justify};flex:0 0 auto;white-space:nowrap;`;
      return s;
    };
    this.leftSlot = mkSlot("flex-start");
    this.rightSlot = mkSlot("flex-end");
    this.intervalSlot = mkSlot("flex-start");
    this.intervalSlot.setAttribute("role", "group");
    this.intervalSlot.setAttribute("aria-label", "Chart interval");
    this.searchSlot = mkSlot("flex-start");
    this.rangeSlot = mkSlot("flex-start");

    this.leftSlot.append(this.searchSlot, this.intervalSlot, this.rangeSlot);
    this.rail = document.createElement("div");
    this.rail.className = "raze-chart-toolbar-rail";
    this.rail.style.cssText = [
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "gap:10px",
      "width:max-content",
      "min-width:100%",
      "height:100%",
      "padding:0 6px",
      "box-sizing:border-box",
    ].join(";");
    this.rail.append(this.leftSlot, this.rightSlot);
    this.el.appendChild(this.rail);
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

  createButton(options?: CreateButtonOptions): HTMLElement {
    const align = options?.align === "right" ? "right" : "left";
    const useTv = options?.useTradingViewStyle !== false;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "raze-chart-toolbar-btn raze-chart-focusable";
    btn.style.cssText = [
      "appearance:none",
      "border:0",
      "margin:0",
      "padding:0",
      "background:transparent",
      "color:inherit",
      "font:inherit",
      "text-align:inherit",
    ].join(";");
    if (useTv) {
      btn.style.cssText = [
        "display:flex",
        "align-items:center",
        isCoarsePointer() ? "height:32px" : "height:26px",
        "padding:0 8px",
        "margin:0 1px",
        "border-radius:4px",
        "cursor:pointer",
        "white-space:nowrap",
        "color:var(--tv-color-toolbar-button-text, #d1d4dc)",
        "background:transparent",
        "touch-action:manipulation",
        "border:0",
        "font:inherit",
        "appearance:none",
      ].join(";");
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "var(--tv-color-toolbar-button-background-hover, rgba(255,255,255,0.06))";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "transparent";
      });
    } else {
      // A div was historically returned here; retain its block formatting while
      // providing native button semantics and keyboard activation.
      btn.style.display = "block";
    }
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
    this.removeKeyboardNavigation();
    this.el.remove();
  }
}
