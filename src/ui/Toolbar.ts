// The chart header. Hosts the interval selector (added in P3) plus a left/right
// slot for `createButton`-injected HTMLElements. Rendered as plain DOM (no
// iframe), themed via CSS custom properties set by setCSSCustomProperty.

import type { CreateButtonOptions } from "../types/charting_library";
import type { ChartContext } from "../core/context";

export const TOOLBAR_HEIGHT = 38;

export class Toolbar {
  readonly el: HTMLDivElement;
  private leftSlot: HTMLDivElement;
  private rightSlot: HTMLDivElement;
  /** Anchor where the interval selector mounts (P3), kept left of custom buttons. */
  readonly intervalSlot: HTMLDivElement;

  constructor(private readonly context: ChartContext) {
    this.el = document.createElement("div");
    this.el.className = "raze-chart-toolbar";
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
      "position:relative",
      "z-index:3",
    ].join(";");

    const mkSlot = (justify: string): HTMLDivElement => {
      const s = document.createElement("div");
      s.style.cssText = `display:flex;align-items:center;gap:2px;justify-content:${justify};`;
      return s;
    };
    this.leftSlot = mkSlot("flex-start");
    this.rightSlot = mkSlot("flex-end");
    this.intervalSlot = mkSlot("flex-start");

    this.leftSlot.appendChild(this.intervalSlot);
    this.el.appendChild(this.leftSlot);
    this.el.appendChild(this.rightSlot);
  }

  createButton(options?: CreateButtonOptions): HTMLElement {
    const align = options?.align === "right" ? "right" : "left";
    const useTv = options?.useTradingViewStyle !== false;
    const btn = document.createElement("div");
    btn.className = "raze-chart-toolbar-btn";
    if (useTv) {
      btn.style.cssText = [
        "display:flex",
        "align-items:center",
        "height:26px",
        "padding:0 8px",
        "margin:0 1px",
        "border-radius:4px",
        "cursor:pointer",
        "white-space:nowrap",
        "color:var(--tv-color-toolbar-button-text, #d1d4dc)",
        "background:transparent",
      ].join(";");
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "var(--tv-color-toolbar-button-background-hover, rgba(255,255,255,0.06))";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "transparent";
      });
    }
    if (options?.title) btn.title = options.title;
    (align === "right" ? this.rightSlot : this.leftSlot).appendChild(btn);
    return btn;
  }

  destroy(): void {
    this.el.remove();
  }
}
