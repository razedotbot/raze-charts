// One study row of the DOM legend: the definition-built label, every plot
// value in its plot colour, and the row actions (remove). Rows are keyed by
// study id and updated in place every frame; text nodes are rewritten only
// when a value changes. syncValues() also renders the OHLC and volume values.

import { t } from "../i18n";
import type { LegendStudy, LegendValue } from "../engine/paint/legend";

/** Decorative 18px stroke icon (hidden from assistive tech). */
export function legendIcon(doc: Document, d: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("class", "raze-legend-icon");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

export function setText(el: Node, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * Keep `host`'s children in sync with `values`: one `<span>` per value holding
 * its title (in `keyClass`) and text, coloured with the value colour.
 */
export function syncValues(host: HTMLElement, values: readonly LegendValue[], keyClass: string, showTitles: boolean): void {
  const doc = host.ownerDocument;
  while (host.children.length > values.length) host.lastElementChild!.remove();
  values.forEach((value, i) => {
    let el = host.children[i] as HTMLElement | undefined;
    if (!el) {
      el = doc.createElement("span");
      const key = doc.createElement("span");
      key.className = keyClass;
      el.append(key, doc.createTextNode(""));
      host.appendChild(el);
    }
    setText(el.firstChild!, showTitles && value.title ? `${value.title} ` : "");
    setText(el.lastChild!, value.text);
    if (el.dataset.color !== value.color) {
      el.dataset.color = value.color;
      el.style.color = value.color;
    }
  });
}

export class LegendRow {
  readonly el: HTMLLIElement;
  private readonly labelEl: HTMLSpanElement;
  private readonly valuesEl: HTMLSpanElement;
  private readonly button: HTMLButtonElement;
  private study: LegendStudy | null = null;

  /** `remove(row, keyboard)` runs when the remove button is activated. */
  constructor(doc: Document, readonly id: string, remove: (row: LegendRow, keyboard: boolean) => void) {
    const span = (className: string): HTMLSpanElement => {
      const el = doc.createElement("span");
      el.className = className;
      return el;
    };
    this.el = doc.createElement("li");
    this.el.className = "raze-legend-line raze-legend-row";
    this.el.dataset.studyId = id;
    const main = span("raze-legend-main");
    this.labelEl = span("raze-legend-label");
    this.valuesEl = span("raze-legend-values");
    main.append(this.labelEl, this.valuesEl);
    const actions = span("raze-legend-actions");
    this.button = doc.createElement("button");
    this.button.type = "button";
    this.button.className = "raze-legend-button";
    this.button.appendChild(legendIcon(doc, "M4.5 4.5l9 9M13.5 4.5l-9 9"));
    // detail 0: activated from the keyboard (Enter/Space), not by a pointer.
    this.button.addEventListener("click", (event) => remove(this, event.detail === 0));
    actions.appendChild(this.button);
    this.el.append(main, actions);
  }

  /** The row's label ("EMA 9"), used in announcements. */
  get label(): string {
    return this.study?.label ?? "";
  }

  get removable(): boolean {
    return !!this.study?.removable;
  }

  update(study: LegendStudy): void {
    if (this.study?.label !== study.label) {
      this.labelEl.textContent = study.label;
      this.button.setAttribute("aria-label", t("legend.remove", "Remove {name}", { name: study.label }));
    }
    // A hidden title stays in the accessibility tree so the values keep a name.
    this.labelEl.classList.toggle("raze-legend-sr", !study.showLabel);
    this.button.hidden = !study.removable;
    this.study = study;
    syncValues(this.valuesEl, study.values, "raze-legend-sr", study.values.length > 1);
  }

  /** Move focus to this row's remove button. Returns false when it has none. */
  focusRemove(): boolean {
    if (!this.removable || this.el.hidden) return false;
    this.button.focus({ preventScroll: true });
    return true;
  }
}
