// Header range presets (1D … All) plus the "Go to date" action. Presets are
// toggle buttons (aria-pressed); the date control is a plain action and is
// always the last button, where the go-to-date popover anchors. Styling comes
// from the shared header-button class (HEADER_STYLES).

import type { ChartContext } from "../core/context";
import { TIMEFRAME_PRESETS, type TimeframePreset } from "../core/timeframe";
import { t } from "../i18n";
import { adoptHeaderStyles } from "./Toolbar";

export class TimeframeBar {
  private buttons = new Map<string, HTMLButtonElement>();

  constructor(
    _context: ChartContext,
    readonly el: HTMLElement,
    private readonly onPreset: (preset: TimeframePreset) => void,
    private readonly onGoToDate: () => void,
  ) {
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", t("header.range.group", "Visible time range"));
    adoptHeaderStyles(this.el);
    this.render();
  }

  private render(): void {
    this.el.replaceChildren();
    this.buttons.clear();
    for (const preset of TIMEFRAME_PRESETS) {
      const button = this.makeButton(preset, () => this.select(preset), t("header.range.button", "Range {label}", { label: preset }));
      button.setAttribute("aria-pressed", "false");
      this.buttons.set(preset, button);
      this.el.appendChild(button);
    }
    this.el.appendChild(this.makeButton(t("header.range.date", "Date"), () => this.onGoToDate(), t("header.range.goToDate", "Go to date")));
  }

  private makeButton(label: string, onClick: () => void, name: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "raze-chart-header-btn raze-chart-focusable";
    b.textContent = label;
    b.setAttribute("aria-label", name);
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onClick();
    });
    return b;
  }

  private select(preset: TimeframePreset): void {
    this.setActive(preset);
    this.onPreset(preset);
  }

  /** Mark `preset` as the applied range (null clears it). */
  setActive(preset: string | null): void {
    for (const [label, b] of this.buttons) {
      b.setAttribute("aria-pressed", String(label === preset));
    }
  }

  destroy(): void {}
}
