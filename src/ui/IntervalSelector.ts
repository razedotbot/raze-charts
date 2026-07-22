// Header interval selector. Renders the symbol's supported resolutions as a
// compact row of buttons (favorites) plus a "more" dropdown, highlights the
// active one, and calls back on selection. Stays in sync with programmatic
// resolution changes via setActive().

import type { ResolutionString } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { resolutionLabel } from "../util/resolution";
import { openPopup, popupRow, type PopupHandle } from "./popup";

/** Default inline favorites (others go in the dropdown). Overridden by the
 *  TV-compatible `options.favorites.intervals`. */
export const DEFAULT_INTERVAL_FAVORITES = ["1S", "1", "5", "15", "60", "240", "1D"];

export class IntervalSelector {
  private buttons = new Map<string, HTMLDivElement>();
  private active: string;
  private dropdown: PopupHandle | null = null;
  private readonly favorites: string[];

  constructor(
    private readonly context: ChartContext,
    private readonly mount: HTMLElement,
    private readonly onSelect: (res: ResolutionString) => void,
    favorites?: string[],
  ) {
    this.favorites = favorites && favorites.length ? favorites.map(String) : DEFAULT_INTERVAL_FAVORITES;
    this.active = String(context.resolution);
    this.render();
  }

  private supported(): string[] {
    const sr = this.context.symbolInfo?.supported_resolutions;
    if (sr && sr.length) return sr.map(String);
    return this.favorites;
  }

  private render(): void {
    this.mount.innerHTML = "";
    this.buttons.clear();
    const supported = this.supported();
    const favorites = supported.filter((r) => this.favorites.includes(r));
    const rest = supported.filter((r) => !this.favorites.includes(r));
    // Ensure the active resolution is always directly visible.
    if (!favorites.includes(this.active) && supported.includes(this.active)) {
      favorites.push(this.active);
    }

    for (const res of favorites) {
      this.mount.appendChild(this.makeButton(res, resolutionLabel(res)));
    }
    if (rest.length) {
      this.mount.appendChild(this.makeMoreButton(rest));
    }
    this.repaint();
  }

  private makeButton(res: string, label: string): HTMLDivElement {
    const b = document.createElement("div");
    b.textContent = label;
    b.style.cssText = this.btnCss();
    b.addEventListener("click", () => this.select(res));
    b.addEventListener("mouseenter", () => { if (res !== this.active) b.style.background = "var(--tv-color-toolbar-button-background-hover, rgba(255,255,255,0.06))"; });
    b.addEventListener("mouseleave", () => { if (res !== this.active) b.style.background = "transparent"; });
    this.buttons.set(res, b);
    return b;
  }

  private makeMoreButton(rest: string[]): HTMLDivElement {
    const b = document.createElement("div");
    b.textContent = "⋯";
    b.style.cssText = this.btnCss();
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleDropdown(b, rest);
    });
    return b;
  }

  private btnCss(): string {
    return [
      "display:flex",
      "align-items:center",
      "height:24px",
      "padding:0 7px",
      "margin:0 1px",
      "border-radius:4px",
      "cursor:pointer",
      "font-size:12px",
      "color:var(--tv-color-toolbar-button-text, #d1d4dc)",
      "background:transparent",
    ].join(";");
  }

  private select(res: string): void {
    if (res === this.active) return;
    this.setActive(res);
    this.onSelect(res as unknown as ResolutionString);
    this.closeDropdown();
  }

  /** Reflect an externally-driven resolution change (no callback). */
  setActive(res: string): void {
    this.active = res;
    if (!this.buttons.has(res)) {
      // The active resolution isn't a visible favorite — re-render to surface it.
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
      b.style.background = on ? "var(--tv-color-toolbar-button-background-active, rgba(255,255,255,0.1))" : "transparent";
      b.style.color = on ? "var(--tv-color-toolbar-button-text-hover, #fff)" : "var(--tv-color-toolbar-button-text, #d1d4dc)";
      b.style.fontWeight = on ? "600" : "400";
    }
  }

  private toggleDropdown(anchor: HTMLElement, rest: string[]): void {
    if (this.dropdown) { this.closeDropdown(); return; }
    const popup = openPopup({
      fontFamily: this.context.fontFamily,
      className: "raze-chart-interval-menu",
      minWidth: 80,
      padding: "4px",
      anchor,
      place: "below-start",
      onClose: () => {
        if (this.dropdown === popup) this.dropdown = null;
      },
    });
    this.dropdown = popup;
    for (const res of rest) {
      const row = popupRow(resolutionLabel(res), () => this.select(res));
      row.style.padding = "6px 10px";
      popup.el.appendChild(row);
    }
    popup.reposition();
  }

  private closeDropdown(): void {
    this.dropdown?.close();
    this.dropdown = null;
  }

  destroy(): void {
    this.closeDropdown();
  }
}
