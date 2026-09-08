// The chart header. Hosts the interval selector (added in P3) plus a left/right
// slot for `createButton`-injected HTMLElements. Rendered as plain DOM (no
// iframe), themed via CSS custom properties set by setCSSCustomProperty.

import type { CreateButtonOptions } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { enableToolbarKeyboardNavigation, isCoarsePointer } from "./popup";

export const TOOLBAR_HEIGHT = 38;

export class Toolbar {
  readonly el: HTMLDivElement;
  private leftSlot: HTMLDivElement;
  private rightSlot: HTMLDivElement;
  private removeKeyboardNavigation: () => void;
  /** Anchor where the interval selector mounts (P3), kept left of custom buttons. */
  readonly intervalSlot: HTMLDivElement;

  constructor(private readonly context: ChartContext) {
    this.el = document.createElement("div");
    this.el.className = "raze-chart-toolbar";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Chart toolbar");
    this.el.setAttribute("aria-orientation", "horizontal");
    this.el.style.cssText = [
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      `height:${TOOLBAR_HEIGHT}px`,
      "min-height:" + TOOLBAR_HEIGHT + "px",
      "padding:0 6px",
      "box-sizing:border-box",
      "border-bottom:1px solid var(--tv-color-toolbar-divider-background, #363a45)",
      "background:var(--tv-color-toolbar-button-background, transparent)",
      "color:var(--tv-color-toolbar-button-text, #d1d4dc)",
      `font-family:${this.context.fontFamily}`,
      "font-size:13px",
      "user-select:none",
      "overflow:visible",
      "position:relative",
      "z-index:3",
    ].join(";");

    const mkSlot = (justify: string): HTMLDivElement => {
      const s = document.createElement("div");
      s.style.cssText = `display:flex;align-items:center;gap:2px;justify-content:${justify};`;
      return s;
    };
    this.leftSlot = mkSlot("flex-start");
    // Narrow screens scroll the left cluster horizontally instead of clipping
    // (scrollbar hidden by the injected base stylesheet).
    this.leftSlot.className = "raze-chart-toolbar-scroll";
    this.leftSlot.style.cssText += ";min-width:0;flex:1 1 auto;overflow-x:auto;overflow-y:hidden;";
    this.rightSlot = mkSlot("flex-end");
    this.rightSlot.style.flex = "0 0 auto";
    this.intervalSlot = mkSlot("flex-start");
    this.intervalSlot.style.flex = "0 0 auto";
    this.intervalSlot.setAttribute("role", "group");
    this.intervalSlot.setAttribute("aria-label", "Chart interval");

    this.leftSlot.appendChild(this.intervalSlot);
    this.el.appendChild(this.leftSlot);
    this.el.appendChild(this.rightSlot);
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
    return btn;
  }

  destroy(): void {
    this.removeKeyboardNavigation();
    this.el.remove();
  }
}
