// Header interval selector. Renders the symbol's supported resolutions as one
// inline row of toolbar buttons, highlights the active one, and calls back on
// selection. `favorites.intervals` only affects order (favorites first).
// Stays in sync with programmatic resolution changes via setActive().

import type { ResolutionString } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { isCoarsePointer } from "./popup";
import { parseResolution, resolutionLabel } from "../util/resolution";

/** Default leading intervals when `options.favorites.intervals` is omitted. */
export const DEFAULT_INTERVAL_FAVORITES = ["1S", "1", "5", "15", "60", "240", "1D"];

export class IntervalSelector {
  private buttons = new Map<string, HTMLButtonElement>();
  private active: string;
  private readonly favorites: string[];

  constructor(
    private readonly context: ChartContext,
    private readonly mount: HTMLElement,
    private readonly onSelect: (res: ResolutionString) => void,
    favorites?: string[],
  ) {
    this.favorites = favorites && favorites.length ? favorites.map(String) : DEFAULT_INTERVAL_FAVORITES;
    this.active = String(context.resolution);
    this.mount.setAttribute("role", "group");
    this.mount.setAttribute("aria-label", "Chart interval");
    this.render();
  }

  private supported(): string[] {
    const sr = this.context.symbolInfo?.supported_resolutions;
    const values = sr && sr.length ? sr.map(String) : this.favorites;
    return Array.from(new Set(values));
  }

  private ordered(): string[] {
    return this.supported()
      .slice()
      .sort((a, b) => parseResolution(a).ms - parseResolution(b).ms);
  }

  private render(): void {
    this.mount.innerHTML = "";
    this.buttons.clear();
    for (const res of this.ordered()) {
      this.mount.appendChild(this.makeButton(res));
    }
    this.repaint();
  }

  private makeButton(res: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "raze-chart-focusable";
    b.textContent = resolutionLabel(res);
    b.setAttribute("aria-label", `Interval ${resolutionLabel(res)}`);
    b.style.cssText = this.btnCss();
    b.addEventListener("click", () => this.select(res));
    b.addEventListener("mouseenter", () => {
      if (res !== this.active) b.style.background = "var(--tv-color-toolbar-button-background-hover, rgba(255,255,255,0.06))";
    });
    b.addEventListener("mouseleave", () => {
      if (res !== this.active) b.style.background = "transparent";
    });
    this.buttons.set(res, b);
    return b;
  }

  private btnCss(): string {
    const coarse = isCoarsePointer();
    return [
      "display:flex",
      "align-items:center",
      "justify-content:center",
      coarse ? "height:30px" : "height:24px",
      coarse ? "padding:0 10px" : "padding:0 7px",
      "margin:0 1px",
      "border-radius:4px",
      "cursor:pointer",
      "font-size:12px",
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

  private select(res: string): void {
    if (res === this.active) return;
    this.setActive(res);
    this.onSelect(res as unknown as ResolutionString);
  }

  /** Reflect an externally-driven resolution change (no callback). */
  setActive(res: string): void {
    this.active = res;
    if (!this.buttons.has(res)) {
      this.render();
      return;
    }
    this.repaint();
  }

  /** Re-render when the symbol (and its supported_resolutions) changes. */
  refresh(): void {
    this.render();
  }

  private repaint(): void {
    for (const [res, b] of this.buttons) {
      const on = res === this.active;
      b.setAttribute("aria-pressed", String(on));
      if (on) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
      b.style.background = on ? "var(--tv-color-toolbar-button-background-active, rgba(255,255,255,0.1))" : "transparent";
      b.style.color = on ? "var(--tv-color-toolbar-button-text-hover, #fff)" : "var(--tv-color-toolbar-button-text, #d1d4dc)";
      b.style.fontWeight = on ? "600" : "400";
    }
  }

  destroy(): void {}
}
