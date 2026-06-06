// Header interval selector. Renders the symbol's supported resolutions as a
// compact row of buttons (favorites) plus a "more" dropdown, highlights the
// active one, and calls back on selection. Stays in sync with programmatic
// resolution changes via setActive().

import type { ResolutionString } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { resolutionLabel } from "../util/resolution";

/** Inline favorites shown directly in the header (others go in the dropdown). */
const FAVORITES = ["1S", "1", "5", "15", "60", "240", "1D"];

export class IntervalSelector {
  private buttons = new Map<string, HTMLDivElement>();
  private active: string;
  private dropdown: HTMLDivElement | null = null;

  constructor(
    private readonly context: ChartContext,
    private readonly mount: HTMLElement,
    private readonly onSelect: (res: ResolutionString) => void,
  ) {
    this.active = String(context.resolution);
    this.render();
  }

  private supported(): string[] {
    const sr = this.context.symbolInfo?.supported_resolutions;
    if (sr && sr.length) return sr.map(String);
    return FAVORITES;
  }

  private render(): void {
    this.mount.innerHTML = "";
    this.buttons.clear();
    const supported = this.supported();
    const favorites = supported.filter((r) => FAVORITES.includes(r));
    const rest = supported.filter((r) => !FAVORITES.includes(r));
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
    const menu = document.createElement("div");
    menu.style.cssText = [
      "position:fixed",
      "min-width:80px",
      "background:var(--tv-color-popup-background, #1e222d)",
      "border:1px solid var(--tv-color-toolbar-divider-background, #363a45)",
      "border-radius:4px",
      "box-shadow:0 12px 24px -10px rgba(0,0,0,0.6)",
      "padding:4px",
      "z-index:2147483640",
      `font-family:${this.context.fontFamily}`,
      "font-size:12px",
      "display:flex",
      "flex-direction:column",
    ].join(";");
    for (const res of rest) {
      const row = document.createElement("div");
      row.textContent = resolutionLabel(res);
      row.style.cssText = "padding:6px 10px;cursor:pointer;border-radius:3px;color:var(--tv-color-popup-element-text,#d1d4dc);";
      row.addEventListener("mouseenter", () => { row.style.background = "var(--tv-color-popup-element-background-hover, rgba(255,255,255,0.08))"; });
      row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
      row.addEventListener("click", () => this.select(res));
      menu.appendChild(row);
    }
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    document.body.appendChild(menu);
    this.dropdown = menu;
    window.setTimeout(() => {
      const away = (e: MouseEvent): void => {
        if (!menu.contains(e.target as Node)) { this.closeDropdown(); }
        else document.addEventListener("mousedown", away, { once: true });
      };
      document.addEventListener("mousedown", away, { once: true });
    }, 0);
  }

  private closeDropdown(): void {
    this.dropdown?.remove();
    this.dropdown = null;
  }

  destroy(): void {
    this.closeDropdown();
  }
}
