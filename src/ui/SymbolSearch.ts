// Header symbol search: a combobox input with a listbox of datafeed results.
// The active option follows the arrow keys and the moving mouse (pointer
// movement, not enter events, which also fire when results scroll under a
// still pointer) and is highlighted by the stylesheet, so keyboard users see
// it too.

import type { SearchSymbolResultItem } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { t } from "../i18n";
import { openPopup, popupRow, type PopupHandle } from "./popup";
import { adoptStyles } from "./styles";
import { adoptHeaderStyles, HEADER_CHUNKS } from "./Toolbar";

export class SymbolSearch {
  readonly el: HTMLDivElement;
  private input: HTMLInputElement;
  private popup: PopupHandle | null = null;
  private timer = 0;
  private requestGeneration = 0;
  private destroyed = false;
  private resultOptions: { symbol: string; row: HTMLButtonElement }[] = [];
  private activeIndex = -1;

  constructor(
    private readonly context: ChartContext,
    private readonly onPick: (symbol: string) => void,
  ) {
    this.el = document.createElement("div");
    this.el.className = "raze-chart-symbol-search-field";
    this.input = document.createElement("input");
    this.input.type = "search";
    this.input.className = "raze-chart-symbol-search-input raze-chart-focusable";
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-label", t("header.symbolSearch.label", "Search symbols"));
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-haspopup", "listbox");
    this.input.setAttribute("aria-expanded", "false");
    this.input.placeholder = t("header.symbolSearch.placeholder", "Symbol");
    this.input.autocomplete = "off";
    this.input.value = context.symbol;
    this.input.addEventListener("focus", () => this.input.select());
    this.input.addEventListener("blur", () => {
      queueMicrotask(() => {
        if (this.destroyed || this.popup?.el.contains(document.activeElement)) return;
        this.close(false);
      });
    });
    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (this.resultOptions.length) {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          const start = this.activeIndex < 0
            ? (delta > 0 ? -1 : 0)
            : this.activeIndex;
          this.setActiveIndex(
            (start + delta + this.resultOptions.length) % this.resultOptions.length,
          );
          e.preventDefault();
        }
        return;
      }
      if (e.key === "Home" && this.resultOptions.length) {
        this.setActiveIndex(0);
        e.preventDefault();
        return;
      }
      if (e.key === "End" && this.resultOptions.length) {
        this.setActiveIndex(this.resultOptions.length - 1);
        e.preventDefault();
        return;
      }
      if (e.key === "Enter") {
        const active = this.resultOptions[this.activeIndex];
        if (active) {
          e.preventDefault();
          this.pick(active.symbol);
          return;
        }
        const value = this.input.value.trim();
        if (value) {
          e.preventDefault();
          this.pick(value);
        }
      }
      if (e.key === "Escape") {
        this.invalidatePendingRequest();
        this.close();
      }
    });
    this.el.appendChild(this.input);
    adoptHeaderStyles(this.el, context);
  }

  setSymbol(symbol: string): void {
    if (this.destroyed) return;
    if (document.activeElement !== this.input) {
      this.invalidatePendingRequest();
      this.input.value = symbol;
      this.close(false);
    }
  }

  private schedule(): void {
    if (this.destroyed) return;
    window.clearTimeout(this.timer);
    this.timer = 0;
    const generation = ++this.requestGeneration;
    const query = this.input.value.trim();
    this.close(false);
    if (!query || typeof this.context.datafeed.searchSymbols !== "function") return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.search(query, generation);
    }, 120);
  }

  private search(query: string, generation: number): void {
    if (!this.isCurrent(query, generation)) return;
    const search = this.context.datafeed.searchSymbols;
    if (typeof search !== "function") return;
    let settled = false;
    try {
      search(query, "", "", (items) => {
        if (settled) return;
        settled = true;
        if (!this.isCurrent(query, generation)) return;
        this.show(Array.isArray(items) ? items : [], query, generation);
      });
    } catch {
      if (this.isCurrent(query, generation)) this.close(false);
    }
  }

  private isCurrent(query: string, generation: number): boolean {
    return !this.destroyed
      && generation === this.requestGeneration
      && this.input.value.trim() === query;
  }

  private show(items: SearchSymbolResultItem[], query: string, generation: number): void {
    if (!this.isCurrent(query, generation)) return;
    const results = items.slice(0, 12).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const rawSymbol = item.ticker || item.symbol;
      if (typeof rawSymbol !== "string" || !rawSymbol.trim()) return [];
      const symbol = rawSymbol.trim();
      const detail = typeof item.description === "string"
        ? item.description
        : typeof item.full_name === "string"
          ? item.full_name
          : "";
      return [{ symbol, detail }];
    });
    this.close(false);
    if (!results.length || !this.isCurrent(query, generation)) return;
    const popup = openPopup({
      fontFamily: this.context.fontFamily,
      className: "raze-chart-symbol-search",
      minWidth: 220,
      anchor: this.input,
      place: "below-start",
      role: "dialog",
      label: t("header.symbolSearch.results", "Symbol results"),
      initialFocus: false,
      onClose: () => {
        if (this.popup === popup) {
          this.popup = null;
          this.resultOptions = [];
          this.activeIndex = -1;
          this.input.removeAttribute("aria-activedescendant");
        }
      },
    });
    popup.el.setAttribute("role", "listbox");
    adoptStyles(popup.el, HEADER_CHUNKS);
    this.input.setAttribute("aria-haspopup", "listbox");
    this.popup = popup;
    this.resultOptions = [];
    this.activeIndex = -1;
    for (const [index, item] of results.entries()) {
      const row = popupRow(
        "",
        () => this.pick(item.symbol),
        { role: "menuitem" },
      );
      row.id = `${popup.el.id}-option-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.tabIndex = -1;
      row.textContent = item.detail ? `${item.symbol}  ${item.detail}` : item.symbol;
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("pointermove", (event) => {
        if (event.pointerType === "mouse" && this.activeIndex !== index) this.setActiveIndex(index, false);
      });
      popup.el.appendChild(row);
      this.resultOptions.push({ symbol: item.symbol, row });
    }
    popup.reposition();
  }

  private setActiveIndex(index: number, reveal = true): void {
    if (!this.resultOptions.length) return;
    const next = Math.max(0, Math.min(this.resultOptions.length - 1, index));
    this.activeIndex = next;
    for (const [itemIndex, option] of this.resultOptions.entries()) {
      option.row.setAttribute("aria-selected", String(itemIndex === next));
    }
    const row = this.resultOptions[next]!.row;
    this.input.setAttribute("aria-activedescendant", row.id);
    if (reveal) row.scrollIntoView?.({ block: "nearest" });
  }

  private pick(symbol: string): void {
    if (this.destroyed) return;
    this.invalidatePendingRequest();
    this.input.value = symbol;
    this.close();
    this.onPick(symbol);
  }

  private close(restoreFocus = true): void {
    this.popup?.close({ restoreFocus });
    this.popup = null;
    this.resultOptions = [];
    this.activeIndex = -1;
    this.input.removeAttribute("aria-activedescendant");
  }

  private invalidatePendingRequest(): void {
    this.requestGeneration += 1;
    window.clearTimeout(this.timer);
    this.timer = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.invalidatePendingRequest();
    this.close(false);
    this.el.remove();
  }
}
