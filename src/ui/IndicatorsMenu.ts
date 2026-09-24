// Floating "Indicators" panel — opened from the left sidebar (not the header).
// Rows come from `options.raze.indicator_presets` (default: EMA/SMA/RSI presets
// + one row per custom study); toggling adds/removes studies without the host
// app calling createStudy.

import type { IndicatorPreset, RazeChartsOptions } from "../types/charting_library";
import type { ChartContext } from "../core/context";
import type { StudyStore } from "../studies/StudyStore";
import type { StudyRegistry } from "../studies/registry";
import { t } from "../i18n";
import { fillMenuRow, ICON_TRASH, MENU_ROW_STYLES, menuSeparator } from "./icons";
import { openPopup, popupRow, type PopupHandle } from "./popup";
import { adoptStyles } from "./styles";

/** A preset with every field resolved against its study definition. */
export interface ResolvedIndicatorPreset {
  label: string;
  name: string;
  length: number;
  color: string;
}

export const DEFAULT_INDICATOR_PRESETS: IndicatorPreset[] = [
  { label: "EMA 9", name: "EMA", length: 9, color: "#f5a623" },
  { label: "EMA 21", name: "EMA", length: 21, color: "#26a69a" },
  { label: "SMA 20", name: "SMA", length: 20, color: "#2962ff" },
  { label: "SMA 50", name: "SMA", length: 50, color: "#e040fb" },
  { label: "RSI 14", name: "RSI", length: 14, color: "#7E57C2" },
  { label: "VWAP", name: "VWAP", color: "#e040fb" },
  { label: "Bollinger 20", name: "Bollinger Bands", length: 20, color: "#2962ff" },
  { label: "MACD", name: "MACD", length: 26, color: "#2962ff" },
];

/** Resolve the panel rows: explicit `indicator_presets`, or the defaults plus
 *  one row per custom study. Unknown study names are dropped with a warning. */
export function resolveIndicatorPresets(
  raze: RazeChartsOptions | undefined,
  registry: StudyRegistry,
): ResolvedIndicatorPreset[] {
  const source: IndicatorPreset[] = raze?.indicator_presets ?? [
    ...DEFAULT_INDICATOR_PRESETS,
    ...(raze?.custom_studies ?? []).map((d) => ({ name: d.name })),
  ];
  const out: ResolvedIndicatorPreset[] = [];
  for (const p of source) {
    const def = registry.resolve(p.name);
    if (!def) {
      console.warn(`[raze-charts] indicator preset references unknown study: ${p.name}`);
      continue;
    }
    const length = Math.max(1, Math.floor(p.length ?? def.defaults?.length ?? 14));
    out.push({
      label: p.label ?? `${def.name} ${length}`,
      name: def.name,
      length,
      color: p.color ?? def.defaults?.color ?? "#f5a623",
    });
  }
  return out;
}

export class IndicatorsMenu {
  private popup: PopupHandle | null = null;
  private anchor: HTMLElement | null = null;
  private readonly presets: ResolvedIndicatorPreset[];

  constructor(
    private readonly context: ChartContext,
    private readonly studies: StudyStore,
    presets?: ResolvedIndicatorPreset[],
  ) {
    this.presets = presets ?? resolveIndicatorPresets(undefined, studies.registry);
  }

  /** Toggle the panel anchored to a sidebar (or any) button. */
  toggle(anchor: HTMLElement): void {
    if (this.popup && this.anchor === anchor) {
      this.close();
      return;
    }
    this.close();
    this.open(anchor);
  }

  open(anchor: HTMLElement): void {
    this.anchor = anchor;
    anchor.setAttribute("aria-haspopup", "menu");
    anchor.setAttribute("aria-expanded", "false");
    const popup = openPopup({
      fontFamily: this.context.fontFamily,
      className: "raze-chart-indicators-menu",
      minWidth: 168,
      padding: "6px 0",
      anchor,
      place: "right-start",
      role: "menu",
      label: t("sidebar.indicators", "Indicators"),
      onClose: () => {
        if (this.popup === popup) {
          this.popup = null;
          this.anchor = null;
        }
      },
    });
    this.popup = popup;
    adoptStyles(popup.el, MENU_ROW_STYLES);
    this.renderRows(popup.el);
    popup.reposition();
  }

  private renderRows(panel: HTMLDivElement, focusIndex?: number): void {
    panel.replaceChildren();
    const activeKey = new Set(
      this.studies.list().map((s) => `${s.name}:${s.length}`),
    );

    for (const [index, p] of this.presets.entries()) {
      const on = activeKey.has(`${p.name}:${p.length}`);
      const row = popupRow("", () => {
        if (on) {
          for (const s of this.studies.list()) {
            if (s.name === p.name && s.length === p.length) this.studies.remove(s.id);
          }
        } else {
          this.studies.add({ name: p.name, length: p.length, color: p.color });
        }
        this.renderRows(panel, index);
      }, { role: "menuitemcheckbox", checked: on, label: p.label });
      const swatch = document.createElement("span");
      swatch.className = "raze-menu-swatch";
      swatch.style.background = p.color;
      panel.appendChild(fillMenuRow(row, { checked: on, icon: swatch, label: p.label }));
    }

    // A separated, secondary action in the muted text token, which keeps AA
    // contrast on light and dark popups.
    const clear = popupRow("", () => {
      this.studies.clear();
      this.close();
    }, { role: "menuitem", label: t("indicators.clearAllLabel", "Clear all indicators") });
    panel.append(
      menuSeparator(),
      fillMenuRow(clear, { icon: ICON_TRASH, label: t("indicators.clearAll", "Clear all"), muted: true }),
    );
    if (focusIndex !== undefined) this.popup?.focusItem(focusIndex);
  }

  close(): void {
    this.popup?.close();
    this.popup = null;
    this.anchor = null;
  }

  destroy(): void {
    this.close();
  }
}
