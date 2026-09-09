import type { ChartContext } from "../core/context";
import { TIMEFRAME_PRESETS, type TimeframePreset } from "../core/timeframe";
import { isCoarsePointer } from "./popup";

export class TimeframeBar {
  private buttons = new Map<string, HTMLButtonElement>();
  private active: string | null = null;

  constructor(
    context: ChartContext,
    readonly el: HTMLElement,
    private readonly onPreset: (preset: TimeframePreset) => void,
    private readonly onGoToDate: () => void,
  ) {
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", "Visible time range");
    this.el.style.fontFamily = context.fontFamily;
    this.render();
  }

  private render(): void {
    this.el.innerHTML = "";
    this.buttons.clear();
    for (const preset of TIMEFRAME_PRESETS) {
      this.el.appendChild(this.makeButton(preset, () => this.select(preset)));
    }
    this.el.appendChild(this.makeButton("Date", () => this.onGoToDate(), "Go to date"));
  }

  private makeButton(label: string, onClick: () => void, aria = `Range ${label}`): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "raze-chart-focusable";
    b.textContent = label;
    b.setAttribute("aria-label", aria);
    b.style.cssText = this.btnCss();
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onClick();
    });
    b.addEventListener("mouseenter", () => {
      if (this.active !== label) {
        b.style.background = "var(--tv-color-toolbar-button-background-hover, rgba(255,255,255,0.06))";
      }
    });
    b.addEventListener("mouseleave", () => {
      if (this.active !== label) b.style.background = "transparent";
    });
    this.buttons.set(label, b);
    return b;
  }

  private btnCss(): string {
    const coarse = isCoarsePointer();
    return [
      "display:flex",
      "align-items:center",
      "justify-content:center",
      coarse ? "height:30px" : "height:24px",
      coarse ? "padding:0 8px" : "padding:0 6px",
      "margin:0 1px",
      "border-radius:4px",
      "cursor:pointer",
      "font-size:11px",
      "font-family:inherit",
      "line-height:normal",
      "color:var(--tv-color-toolbar-button-text, #d1d4dc)",
      "background:transparent",
      "border:0",
      "appearance:none",
      "touch-action:manipulation",
      "flex:0 0 auto",
    ].join(";");
  }

  private select(preset: TimeframePreset): void {
    this.setActive(preset);
    this.onPreset(preset);
  }

  setActive(preset: string | null): void {
    this.active = preset;
    for (const [label, b] of this.buttons) {
      const on = label === preset;
      b.setAttribute("aria-pressed", String(on));
      b.style.background = on
        ? "var(--tv-color-toolbar-button-background-active, rgba(255,255,255,0.1))"
        : "transparent";
      b.style.fontWeight = on ? "600" : "400";
    }
  }

  destroy(): void {}
}
