import type { SearchSymbolResultItem } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { isCoarsePointer, openPopup, popupRow, type PopupHandle } from "./popup";

export class SymbolSearch {
  readonly el: HTMLDivElement;
  private input: HTMLInputElement;
  private popup: PopupHandle | null = null;
  private timer = 0;

  constructor(
    private readonly context: ChartContext,
    private readonly onPick: (symbol: string) => void,
  ) {
    this.el = document.createElement("div");
    this.el.style.cssText = "display:flex;align-items:center;flex:0 0 auto;margin:0 4px 0 0;";
    this.input = document.createElement("input");
    this.input.type = "search";
    this.input.className = "raze-chart-focusable";
    this.input.setAttribute("aria-label", "Search symbols");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.placeholder = "Symbol";
    this.input.autocomplete = "off";
    const coarse = isCoarsePointer();
    this.input.style.cssText = [
      "width:88px",
      coarse ? "height:30px" : "height:24px",
      "padding:0 8px",
      "border-radius:4px",
      "border:1px solid var(--tv-color-toolbar-divider-background, #363a45)",
      "background:rgba(255,255,255,0.04)",
      "color:inherit",
      "font:inherit",
      "font-size:12px",
    ].join(";");
    this.input.value = context.symbol;
    this.input.addEventListener("focus", () => this.input.select());
    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const value = this.input.value.trim();
        if (value) this.pick(value);
      }
      if (e.key === "Escape") this.close();
    });
    this.el.appendChild(this.input);
  }

  setSymbol(symbol: string): void {
    if (document.activeElement !== this.input) this.input.value = symbol;
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.search(), 120);
  }

  private search(): void {
    const q = this.input.value.trim();
    const search = this.context.datafeed.searchSymbols;
    if (!q || typeof search !== "function") {
      this.close();
      return;
    }
    try {
      search(q, "", "", (items) => this.show(Array.isArray(items) ? items : []));
    } catch {
      this.close();
    }
  }

  private show(items: SearchSymbolResultItem[]): void {
    this.close();
    if (!items.length) return;
    const popup = openPopup({
      fontFamily: this.context.fontFamily,
      className: "raze-chart-symbol-search",
      minWidth: 220,
      padding: "4px 0",
      anchor: this.input,
      place: "below-start",
      role: "menu",
      label: "Symbol results",
      onClose: () => {
        if (this.popup === popup) this.popup = null;
      },
    });
    this.popup = popup;
    for (const item of items.slice(0, 12)) {
      const symbol = item.ticker || item.symbol;
      const row = popupRow(
        `${symbol}  ${item.description || item.full_name || ""}`,
        () => this.pick(symbol),
        { role: "menuitem", label: symbol },
      );
      popup.el.appendChild(row);
    }
    popup.reposition();
  }

  private pick(symbol: string): void {
    this.input.value = symbol;
    this.close();
    this.onPick(symbol);
  }

  private close(): void {
    this.popup?.close();
    this.popup = null;
  }

  destroy(): void {
    window.clearTimeout(this.timer);
    this.close();
    this.el.remove();
  }
}
