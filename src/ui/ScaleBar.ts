// Bottom-right scale toggles: % / log / auto — TV chrome parity.

import type { ChartContext } from "../core/context";

export class ScaleBar {
  readonly el: HTMLDivElement;
  private pctBtn: HTMLButtonElement;
  private logBtn: HTMLButtonElement;
  private autoBtn: HTMLButtonElement;

  constructor(
    private readonly context: ChartContext,
    private readonly onChange: () => void,
  ) {
    this.el = document.createElement("div");
    this.el.className = "raze-chart-scale-bar";
    this.el.style.cssText = [
      "position:absolute",
      "right:4px",
      "bottom:26px",
      "display:flex",
      "align-items:center",
      "gap:2px",
      "z-index:4",
      `font-family:${context.fontFamily}`,
      "font-size:11px",
      "user-select:none",
      "pointer-events:auto",
    ].join(";");

    this.pctBtn = this.mk("%", "Percent scale");
    this.logBtn = this.mk("log", "Logarithmic scale");
    this.autoBtn = this.mk("auto", "Auto-scale price (double-click axis)");

    this.pctBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.context.percentScale = !this.context.percentScale;
      if (this.context.percentScale) this.context.logScale = false;
      this.context.autoScalePrice = true;
      this.context.priceRange = null;
      this.sync();
      this.onChange();
    });
    this.logBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.context.logScale = !this.context.logScale;
      if (this.context.logScale) this.context.percentScale = false;
      this.context.autoScalePrice = true;
      this.context.priceRange = null;
      this.sync();
      this.onChange();
    });
    this.autoBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.context.autoScalePrice = true;
      this.context.priceRange = null;
      this.sync();
      this.onChange();
    });

    this.el.append(this.pctBtn, this.logBtn, this.autoBtn);
    this.sync();
  }

  private mk(label: string, title: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.style.cssText = [
      "border:0",
      "border-radius:3px",
      "padding:2px 6px",
      "cursor:pointer",
      "background:transparent",
      "color:var(--tv-color-toolbar-button-text, #8b887e)",
      "font:inherit",
    ].join(";");
    return b;
  }

  sync(): void {
    const set = (b: HTMLButtonElement, on: boolean): void => {
      b.style.color = on ? "#66d89e" : "var(--tv-color-toolbar-button-text, #8b887e)";
      b.style.background = on ? "rgba(102,216,158,0.14)" : "transparent";
      b.style.fontWeight = on ? "600" : "400";
    };
    set(this.pctBtn, this.context.percentScale);
    set(this.logBtn, this.context.logScale);
    set(this.autoBtn, this.context.autoScalePrice && !this.context.priceRange);
  }

  destroy(): void {
    this.el.remove();
  }
}
