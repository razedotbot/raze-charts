// Header interval selector (TradingView's favourite-interval buttons).
//
// Which resolutions exist follows TradingView's precedence: the symbol's
// `supported_resolutions`, then the datafeed configuration's (onReady), then
// the favourites themselves. Seconds need `has_seconds` unless the feed lists
// them explicitly, and `has_seconds: false` / `has_intraday: false` remove
// seconds / intraday resolutions outright.
//
// `favorites.intervals` (default DEFAULT_INTERVAL_FAVORITES) chooses which of
// those become header buttons, in favourites order; an explicit favourite the
// symbol does not support is dropped with a console warning. Every other
// resolution stays reachable from the "More intervals" menu, and the active
// resolution always has a visible button. Programmatic changes arrive through
// setActive(); symbol changes through refresh().

import type { DatafeedConfiguration, LibrarySymbolInfo, ResolutionString } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { t } from "../i18n";
import { openPopup, popupRow, type PopupHandle } from "./popup";
import { adoptStyles } from "./styles";
import { adoptHeaderStyles, HEADER_CHUNKS } from "./Toolbar";
import { parseResolution, resolutionLabel } from "../util/resolution";

/** Default header buttons when `options.favorites.intervals` is omitted. */
export const DEFAULT_INTERVAL_FAVORITES = ["1S", "1", "5", "15", "60", "240", "1D"];

interface Resolved {
  /** Canonical key: "1D" and "D", "60" and "060" compare equal. */
  key: string;
  /** The resolution with an explicit multiplier ("D" → "1D"). */
  text: string;
  ms: number;
  kind: ReturnType<typeof parseResolution>["kind"];
}

/** Parse a resolution for comparison, or null when it is not one. */
function resolve(res: string): Resolved | null {
  const text = String(res).trim().toUpperCase();
  if (!/^\d*[SDWM]?$/.test(text) || text === "" || text === "S") return null;
  const explicit = /^\d/.test(text) ? text : `1${text}`;
  let parsed: ReturnType<typeof parseResolution>;
  try {
    parsed = parseResolution(explicit);
  } catch {
    return null;
  }
  if (!(parsed.ms > 0) || !(parsed.amount > 0)) return null;
  return { key: `${parsed.kind === "hours" ? "minutes" : parsed.kind}:${parsed.amount}`, text: explicit, ms: parsed.ms, kind: parsed.kind };
}

function listOf(values: unknown): string[] {
  return Array.isArray(values) ? values.map(String) : [];
}

export class IntervalSelector {
  private buttons = new Map<string, HTMLButtonElement>();
  private moreButton: HTMLButtonElement | null = null;
  private menu: PopupHandle | null = null;
  private active: string;
  private readonly favorites: string[];
  private readonly explicitFavorites: boolean;
  private readonly warned = new Set<string>();
  /** Whether the last button shows a non-favourite active interval. */
  private temporary = false;
  /** Every available resolution in duration order (menu contents). */
  private available: string[] = [];

  constructor(
    private readonly context: ChartContext,
    private readonly mount: HTMLElement,
    private readonly onSelect: (res: ResolutionString) => void,
    favorites?: string[],
    /** The datafeed configuration from onReady, or a getter for it (`DataManager.getConfig`). */
    private readonly configuration?: DatafeedConfiguration | null | (() => DatafeedConfiguration | null | undefined),
  ) {
    this.explicitFavorites = !!favorites?.length;
    this.favorites = this.explicitFavorites ? favorites!.map(String) : DEFAULT_INTERVAL_FAVORITES;
    this.active = String(context.resolution);
    this.mount.setAttribute("role", "group");
    this.mount.setAttribute("aria-label", t("header.interval.group", "Chart interval"));
    adoptHeaderStyles(this.mount, context);
    this.render();
  }

  private config(): DatafeedConfiguration | null {
    const source = this.configuration;
    try {
      return (typeof source === "function" ? source() : source) ?? null;
    } catch {
      return null;
    }
  }

  /** Resolutions the symbol can show, in duration order, with their canonical keys. */
  private availableResolutions(): { res: string; info: Resolved }[] {
    const symbol: LibrarySymbolInfo | null = this.context.symbolInfo;
    const fromSymbol = listOf(symbol?.supported_resolutions);
    const declared = fromSymbol.length ? fromSymbol : listOf(this.config()?.supported_resolutions);
    const candidates = declared.length ? declared : this.favorites;
    const seen = new Set<string>();
    const out: { res: string; info: Resolved }[] = [];
    for (const res of candidates) {
      const info = resolve(res);
      if (!info || seen.has(info.key)) continue;
      if (info.kind === "seconds" && (symbol?.has_seconds === false || (!declared.length && symbol?.has_seconds !== true))) continue;
      if ((info.kind === "seconds" || info.kind === "minutes" || info.kind === "hours") && symbol?.has_intraday === false) continue;
      seen.add(info.key);
      out.push({ res: info.text, info });
    }
    return out.sort((a, b) => a.info.ms - b.info.ms);
  }

  private warnUnsupported(res: string, supported: string[]): void {
    if (!this.explicitFavorites || this.warned.has(res)) return;
    this.warned.add(res);
    const symbol = this.context.symbolInfo?.name || this.context.symbol || "this symbol";
    console.warn(
      `[raze-charts] favorites.intervals: "${res}" is not a supported resolution for ${symbol} and is not shown. `
      + `Supported resolutions: ${supported.join(", ") || "(none)"}.`,
    );
  }

  private render(): void {
    this.menu?.close({ restoreFocus: false });
    const available = this.availableResolutions();
    const byKey = new Map(available.map((entry) => [entry.info.key, entry.res]));
    this.available = available.map((entry) => entry.res);

    const inline: string[] = [];
    const shown = new Set<string>();
    for (const favorite of this.favorites) {
      const key = resolve(favorite)?.key;
      const res = key === undefined ? undefined : byKey.get(key);
      if (res === undefined) {
        this.warnUnsupported(favorite, this.available);
        continue;
      }
      if (shown.has(key!)) continue;
      shown.add(key!);
      inline.push(res);
    }
    // The current interval is always visible, even when it is not a favourite.
    const activeKey = resolve(this.active)?.key;
    this.temporary = false;
    if (activeKey !== undefined && !shown.has(activeKey)) {
      const res = byKey.get(activeKey) ?? resolve(this.active)?.text ?? this.active;
      shown.add(activeKey);
      inline.push(res);
      this.temporary = true;
    }

    // Keep keyboard focus on the same control across the re-render.
    const rootNode = this.mount.getRootNode() as Document | ShadowRoot;
    const focused = rootNode.activeElement instanceof HTMLElement && this.mount.contains(rootNode.activeElement)
      ? rootNode.activeElement.dataset.interval
      : undefined;

    this.mount.replaceChildren();
    this.buttons.clear();
    for (const res of inline) this.mount.appendChild(this.makeButton(res));
    const hidden = available.some((entry) => !shown.has(entry.info.key));
    this.moreButton = hidden ? this.makeMoreButton() : null;
    if (this.moreButton) this.mount.appendChild(this.moreButton);
    this.repaint();
    if (focused !== undefined) {
      const target = [...this.mount.querySelectorAll<HTMLElement>("[data-interval]")]
        .find((el) => el.dataset.interval === focused || resolve(el.dataset.interval ?? "")?.key === resolve(focused)?.key);
      target?.focus({ preventScroll: true });
    }
  }

  private makeButton(res: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "raze-chart-header-btn raze-chart-focusable";
    const label = resolutionLabel(res);
    b.textContent = label;
    b.dataset.interval = res;
    b.setAttribute("aria-label", t("header.interval.button", "Interval {label}", { label }));
    b.addEventListener("click", () => this.select(res));
    this.buttons.set(res, b);
    return b;
  }

  private makeMoreButton(): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "raze-chart-header-btn raze-chart-focusable raze-chart-interval-more";
    b.dataset.interval = "more";
    b.setAttribute("aria-label", t("header.interval.more", "More intervals"));
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleMenu(b);
    });
    b.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" || this.menu) return;
      event.preventDefault();
      this.toggleMenu(b);
    });
    return b;
  }

  private toggleMenu(anchor: HTMLButtonElement): void {
    if (this.menu) {
      this.menu.close();
      return;
    }
    const menu = openPopup({
      fontFamily: this.context.fontFamily,
      className: "raze-chart-interval-menu",
      anchor,
      place: "below-start",
      minWidth: 120,
      label: t("header.interval.menu", "Intervals"),
      initialFocus: false,
      onClose: () => {
        if (this.menu === menu) this.menu = null;
      },
    });
    this.menu = menu;
    adoptStyles(menu.el, HEADER_CHUNKS);
    const activeKey = resolve(this.active)?.key;
    let activeIndex = 0;
    for (const [index, res] of this.available.entries()) {
      if (resolve(res)?.key === activeKey) activeIndex = index;
      const label = resolutionLabel(res);
      menu.el.appendChild(popupRow(label, () => {
        menu.close();
        this.select(res);
      }, {
        role: "menuitemradio",
        checked: resolve(res)?.key === activeKey,
        label: t("header.interval.button", "Interval {label}", { label }),
      }));
    }
    menu.reposition();
    // Open on the current interval (after openPopup armed its listeners).
    window.setTimeout(() => {
      if (this.menu === menu) menu.focusItem(activeIndex);
    }, 0);
  }

  private select(res: string): void {
    if (res === this.active || resolve(res)?.key === resolve(this.active)?.key) return;
    this.setActive(res);
    this.onSelect(res as unknown as ResolutionString);
  }

  /** Reflect an externally-driven resolution change (no callback). */
  setActive(res: string): void {
    const key = resolve(String(res))?.key;
    const unchanged = key !== undefined && key === resolve(this.active)?.key;
    this.active = String(res);
    if (unchanged) {
      this.repaint();
      return;
    }
    const visible = [...this.buttons.keys()].some((shown) => resolve(shown)?.key === key);
    // A non-favourite gets a temporary button; it goes away with the next change.
    if (!visible || this.temporary) {
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
    const activeKey = resolve(this.active)?.key;
    for (const [res, b] of this.buttons) {
      const on = resolve(res)?.key === activeKey;
      b.setAttribute("aria-pressed", String(on));
      if (on) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
  }

  destroy(): void {
    this.menu?.close({ restoreFocus: false });
    this.menu = null;
  }
}
