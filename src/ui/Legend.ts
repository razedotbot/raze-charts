// DOM legend in the chart's overlay host (AD-04). Renders the LegendModel the
// legend painter builds every frame (src/engine/paint/legend.ts):
//
//   ● MOCK · 1m · Mock  Description   O 6,797 H 6,863 L 6,787 C 6,815 +18 (+0.26%)
//   Vol 45.5K
//   EMA 9 6,800                                                           ×
//   BB 20 2 6,809 6,900 6,700                                             ×
//   +3
//
// Every line is clipped to the plot width, so nothing reaches the price axis.
// Study rows beyond the vertical budget collapse into a "+N" toggle. The
// container ignores the pointer so chart gestures pass through; only buttons
// take pointer input. A row's actions show while the chart crosshair (or the
// pointer) is over it, or while it holds keyboard focus.

import { t } from "../i18n";
import {
  LEGEND_MAX_HEIGHT_FRACTION,
  type LegendFrame,
  type LegendModel,
  type LegendStudy,
  type LegendView,
} from "../engine/paint/legend";
import { adoptStyles, defineStyles, type StyleChunk } from "./styles";
import { legendIcon, LegendRow, setText, syncValues } from "./LegendRow";

export const LEGEND_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "legend",
  ".raze-legend{position:absolute;z-index:1;margin-left:-4px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;" +
  "pointer-events:none;white-space:nowrap;font:12px/18px var(--raze-legend-font,inherit);color:var(--raze-legend-text);" +
  "font-variant-numeric:tabular-nums;outline:none}" +
  ".raze-legend[hidden],.raze-legend [hidden]{display:none!important}" +
  ".raze-legend-line{display:flex;align-items:center;gap:8px;box-sizing:border-box;max-width:100%;min-width:0;" +
  "padding:0 4px;border-radius:4px;background:var(--raze-legend-bg)}" +
  ".raze-legend-series{flex-wrap:wrap;column-gap:10px;overflow:hidden}" +
  ".raze-legend-title,.raze-legend-ohlc,.raze-legend-main{min-width:0;overflow:hidden;text-overflow:ellipsis}" +
  ".raze-legend-symbol{color:var(--raze-text,currentColor);font-weight:600}" +
  ".raze-legend-status{display:inline-block;width:6px;height:6px;margin:0 6px 1px 0;border-radius:50%;background:var(--raze-success,#089981)}" +
  ".raze-legend-status[data-status=closed]{background:currentColor}" +
  ".raze-legend-ohlc>span+span,.raze-legend-values>span{margin-left:8px}" +
  ".raze-legend-key{color:var(--raze-legend-text)}" +
  ".raze-legend-studies{display:flex;flex-direction:column;align-items:flex-start;gap:2px;max-width:100%;margin:0;padding:0;list-style:none}" +
  ".raze-legend-studies[data-scroll]{overflow:hidden auto;pointer-events:auto;overscroll-behavior:contain}" +
  ".raze-legend-actions{display:inline-flex;opacity:0;transition:opacity var(--raze-duration,160ms)}" +
  ".raze-legend-row[data-hover] .raze-legend-actions,.raze-legend-row:hover .raze-legend-actions,.raze-legend-row:focus-within .raze-legend-actions{opacity:1}" +
  ".raze-legend-button{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 3px;border:0;" +
  "border-radius:var(--raze-radius-sm,4px);background:var(--raze-legend-bg);color:inherit;font:inherit;cursor:pointer;pointer-events:auto}" +
  ".raze-legend-button:hover{background:var(--raze-hover,rgba(255,255,255,.08));color:var(--raze-text,currentColor)}" +
  ".raze-legend-button:focus{outline:none}.raze-legend-button:focus-visible{outline:2px solid var(--raze-focus,#2962ff)}" +
  ".raze-legend-icon{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}" +
  ".raze-legend-sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}" +
  "@media (hover:none){.raze-legend-actions{opacity:1}}" +
  "@media (pointer:coarse){.raze-legend-button{min-width:28px;height:28px}}" +
  "@media (prefers-reduced-motion:reduce){.raze-legend-actions{transition:none}}" +
  "@media (forced-colors:active){.raze-legend-line{background:Canvas}.raze-legend-status{forced-color-adjust:none}" +
  ".raze-legend-button:focus-visible{outline-color:Highlight}}",
);

/** What the legend asks of its owner (the widget's LegendController). */
export interface LegendActions {
  /** Remove a study (undoable). Returns false when nothing was removed. */
  remove(id: string): boolean;
  undo?(): void;
  redo?(): void;
  /** Polite screen-reader announcement. */
  announce?(message: string): void;
  /** Return keyboard focus to the chart. */
  focusChart?(): void;
}

export class Legend implements LegendView {
  readonly el: HTMLDivElement;
  private readonly series: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private readonly status: HTMLSpanElement;
  private readonly symbol: HTMLSpanElement;
  private readonly meta: HTMLSpanElement;
  private readonly ohlc: HTMLSpanElement;
  private readonly change: HTMLSpanElement;
  private readonly volume: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private readonly toggle: HTMLButtonElement;
  private readonly rows = new Map<string, LegendRow>();
  private order: LegendRow[] = [];
  /** User choice from the toggle; "auto" fits the height budget. */
  private mode: "auto" | "expanded" | "collapsed" = "auto";
  private frame: LegendFrame | null = null;
  private styleKey = "";
  private layoutKey = "";
  private capacity = Infinity;
  private hovered: LegendRow | null = null;
  private pending: { index: number; keyboard: boolean } | null = null;

  constructor(host: HTMLElement, private readonly actions: LegendActions) {
    const doc = host.ownerDocument;
    adoptStyles(host, LEGEND_STYLES);
    const make = <K extends "div" | "span" | "ul" | "button">(tag: K, className: string): HTMLElementTagNameMap[K] => {
      const el = doc.createElement(tag);
      el.className = className;
      return el;
    };
    this.el = make("div", "raze-legend");
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", t("legend.label", "Chart legend"));
    this.el.tabIndex = -1;
    this.el.hidden = true;

    this.series = make("div", "raze-legend-line raze-legend-series");
    this.title = make("span", "raze-legend-title");
    this.status = make("span", "raze-legend-status");
    this.status.setAttribute("role", "img");
    this.symbol = make("span", "raze-legend-symbol");
    this.meta = make("span", "raze-legend-meta");
    this.title.append(this.status, this.symbol, this.meta);
    this.ohlc = make("span", "raze-legend-ohlc");
    this.change = make("span", "raze-legend-change");
    this.series.append(this.title, this.ohlc, this.change);
    this.volume = make("div", "raze-legend-line raze-legend-volume");
    this.list = make("ul", "raze-legend-studies");
    this.list.setAttribute("aria-label", t("legend.indicators", "Indicators"));
    this.toggle = make("button", "raze-legend-button raze-legend-toggle");
    this.toggle.type = "button";
    this.toggle.addEventListener("click", () => {
      this.mode = this.toggle.getAttribute("aria-expanded") === "true" ? "collapsed" : "expanded";
      if (this.frame) this.render(this.frame);
    });
    this.el.append(this.series, this.volume, this.list, this.toggle);
    this.el.addEventListener("keydown", this.onKeyDown);
    host.appendChild(this.el);
  }

  render(frame: LegendFrame): void {
    this.frame = frame;
    const model = frame.model;
    this.el.hidden = !model || frame.width <= 0;
    if (!model || this.el.hidden) return;
    const style = this.el.style;
    style.left = `${frame.left}px`;
    style.top = `${frame.top}px`;
    style.maxWidth = `${frame.width}px`;
    const { text, background, font } = model.theme;
    const styleKey = `${text}|${background}|${font}`;
    if (styleKey !== this.styleKey) {
      this.styleKey = styleKey;
      style.setProperty("--raze-legend-text", text);
      style.setProperty("--raze-legend-bg", background || "transparent");
      style.setProperty("--raze-legend-font", font);
    }
    this.renderSeries(model);
    this.renderStudies(model.studies);
    this.layout(frame, model);
    this.updateHover(frame);
    this.restoreFocus();
  }

  destroy(): void {
    this.el.removeEventListener("keydown", this.onKeyDown);
    this.el.remove();
    this.rows.clear();
    this.order = [];
    this.frame = null;
  }

  private renderSeries(model: LegendModel): void {
    const title = model.title;
    this.title.hidden = !title;
    if (title) {
      setText(this.symbol, title.symbol);
      setText(this.meta, [title.interval, title.exchange].filter(Boolean).map((part) => ` · ${part}`).join("")
        + (title.description ? `  ${title.description}` : ""));
      this.status.hidden = !title.status;
      if (title.status && this.status.dataset.status !== title.status) {
        this.status.dataset.status = title.status;
        this.status.setAttribute("aria-label", title.status === "open"
          ? t("legend.status.open", "Market open")
          : t("legend.status.closed", "Market closed"));
      }
    }
    const series = model.series;
    syncValues(this.ohlc, series?.values ?? [], "raze-legend-key", true);
    setText(this.change, series?.change ?? "");
    this.change.style.color = series?.color ?? "";
    this.change.hidden = !series?.change;
    this.series.hidden = !series && !title;
    syncValues(this.volume, model.volume ? [model.volume] : [], "raze-legend-key", true);
    this.volume.hidden = !model.volume;
  }

  private renderStudies(studies: readonly LegendStudy[]): void {
    const next = studies.map((study) => {
      let row = this.rows.get(study.id);
      if (!row) {
        row = new LegendRow(this.el.ownerDocument, study.id, (target, keyboard) => this.remove(target, keyboard));
        this.rows.set(study.id, row);
      }
      row.update(study);
      return row;
    });
    for (const [id, row] of this.rows) {
      if (next.includes(row)) continue;
      row.el.remove();
      this.rows.delete(id);
    }
    // Re-append only when the order changed; appending moves existing nodes.
    if (next.some((row, i) => this.list.children[i] !== row.el)) this.list.append(...next.map((row) => row.el));
    this.order = next;
  }

  /** How many study rows fit the height budget; measured only when inputs change. */
  private layout(frame: LegendFrame, model: LegendModel): void {
    const rows = this.order;
    const count = rows.length;
    const budget = frame.height * LEGEND_MAX_HEIGHT_FRACTION;
    const key = `${frame.width}|${budget}|${count}|${model.narrow}|${!!model.volume}|${this.title.textContent}|${this.mode}`;
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.list.hidden = false;
      for (const row of rows) row.el.hidden = false;
      const top = this.list.offsetTop;
      const rowHeight = rows[0] ? rows[0].el.offsetHeight + 2 : 0;
      const fits = rowHeight ? Math.floor((budget - top) / rowHeight) : Infinity;
      // Reserve a line for the "+N" toggle once rows start to collapse.
      this.capacity = count <= fits ? count : Math.max(1, fits - 1);
      this.list.style.maxHeight = rowHeight ? `${Math.max(rowHeight * 2, budget - top)}px` : "";
    }
    const visible = this.mode === "collapsed" ? 0 : this.mode === "expanded" ? count : Math.min(count, this.capacity);
    rows.forEach((row, i) => { row.el.hidden = i >= visible; });
    this.list.toggleAttribute("data-scroll", this.mode === "expanded" && count > this.capacity);
    this.list.hidden = visible === 0;

    const hidden = count - visible;
    this.toggle.hidden = count === 0;
    const state = String(hidden);
    if (this.toggle.dataset.hiddenRows === state) return;
    this.toggle.dataset.hiddenRows = state;
    this.toggle.setAttribute("aria-expanded", String(hidden === 0));
    if (hidden === 0) {
      this.toggle.replaceChildren(legendIcon(this.el.ownerDocument, "M5 11l4-4 4 4"));
      this.toggle.setAttribute("aria-label", t("legend.collapse", "Hide indicators"));
    } else {
      this.toggle.textContent = `+${hidden}`;
      this.toggle.setAttribute("aria-label", t("legend.more", "Show all indicators ({count} hidden)", { count: hidden }));
    }
  }

  /** Reveal the actions of the row under the chart crosshair. */
  private updateHover(frame: LegendFrame): void {
    let hovered: LegendRow | null = null;
    const pointer = frame.pointer;
    const x = pointer ? pointer.x - frame.left : -1;
    const y = pointer ? pointer.y - frame.top + this.list.scrollTop : -1;
    // Cheap bounds check first, so layout is only read near the legend.
    if (x >= 0 && y >= 0 && x <= frame.width && y <= frame.height) {
      hovered = this.order.find((row) => !row.el.hidden && y >= row.el.offsetTop
        && y < row.el.offsetTop + row.el.offsetHeight && x <= row.el.offsetWidth) ?? null;
    }
    if (hovered === this.hovered) return;
    this.hovered?.el.removeAttribute("data-hover");
    hovered?.el.setAttribute("data-hover", "");
    this.hovered = hovered;
  }

  private remove(row: LegendRow, keyboard: boolean): void {
    if (!row.removable) return;
    const index = this.order.indexOf(row);
    const label = row.label;
    if (!this.actions.remove(row.id)) return;
    this.pending = { index, keyboard };
    this.actions.announce?.(t("legend.removed", "{name} removed. Press Ctrl+Z to undo.", { name: label }));
  }

  /** After a removal re-renders the rows, keep focus in the legend. */
  private restoreFocus(): void {
    const pending = this.pending;
    this.pending = null;
    const doc = this.el.ownerDocument;
    const active = doc.activeElement;
    if (!pending || (active && active !== doc.body && !this.el.contains(active))) return;
    if (pending.keyboard) {
      const rows = this.order.filter((row) => !row.el.hidden);
      if (rows[Math.min(pending.index, rows.length - 1)]?.focusRemove()) return;
      if (!this.toggle.hidden) return this.toggle.focus({ preventScroll: true });
      if (this.actions.focusChart) return this.actions.focusChart();
    }
    // Pointer removal: focus the legend itself so Ctrl+Z undoes right away.
    this.el.focus({ preventScroll: true });
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && (key === "z" || key === "y")) {
      event.preventDefault();
      if (key === "z" && !event.shiftKey) this.actions.undo?.();
      else this.actions.redo?.();
    } else if (key === "escape" && this.actions.focusChart) {
      event.preventDefault();
      this.actions.focusChart();
    }
  };
}
