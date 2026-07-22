// Left toolbar — TV chrome parity, fully composable. The item list comes from
// `options.raze.sidebar` (builtin ids, "separator", custom buttons); the
// chart-type picker honours `options.raze.chart_types`. Hidden entirely when
// `left_toolbar` is in disabled_features (minimal/chrome-less).

import type {
  ChartStyleName,
  SidebarCustomItem,
  SidebarItem,
} from "../types/charting_library";
import type { ChartContext, DrawingTool } from "../core/context";
import { isCoarsePointer, openPopup, popupRow, type PopupHandle } from "./popup";

export const LEFT_SIDEBAR_W = 42;

export interface LeftSidebarCallbacks {
  onTool(tool: DrawingTool): void;
  onIndicatorsClick(anchor: HTMLElement): void;
  onFit(): void;
  onScreenshot(): void;
  onFullscreen(): void;
  onChartType(style: ChartStyleId): void;
}

export type ChartStyleId = ChartStyleName;

const ICON = {
  cursor: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 2.5L4 14.5L7.2 11.2L9.1 15.5L11 14.7L9.1 10.4L13.5 10.4L4 2.5Z" fill="currentColor"/></svg>`,
  trend: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 14L8 8L11 11L15 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="15" cy="4" r="1.4" fill="currentColor"/><circle cx="3" cy="14" r="1.4" fill="currentColor"/></svg>`,
  hline: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 9H16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M9 5V13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.35"/></svg>`,
  fib: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 3.5H15M3 7H15M3 11H15M3 14.5H15" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M3 3.5V14.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  rect: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="3.5" y="4.5" width="11" height="9" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>`,
  text: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 4.5H14M9 4.5V14.5M6.5 14.5H11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  indicators: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 12.5L6.5 8.5L9.5 11L15 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 14.5H15" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.4"/></svg>`,
  fit: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 6V3.5H6M12 3.5H15V6M15 12V14.5H12M6 14.5H3V12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  camera: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2.5" y="5" width="13" height="9.5" rx="1.5" stroke="currentColor" stroke-width="1.4"/><circle cx="9" cy="9.5" r="2.4" stroke="currentColor" stroke-width="1.4"/><path d="M6.5 5L7.5 3.5H10.5L11.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  fullscreen: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 6.5V3.5H6M12 3.5H15V6.5M15 11.5V14.5H12M6 14.5H3V11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  candles: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M5 3V15M5 6H7V12H3V6H5ZM13 3V15M13 5H15V11H11V5H13Z" fill="currentColor"/></svg>`,
};

const TOOL_IDS: ReadonlySet<string> = new Set([
  "cursor", "trend_line", "horizontal_line", "fib_retracement", "rectangle", "text",
]);

/** Builtin item id → button title + icon. */
const BUILTIN: Record<string, { title: string; svg: string }> = {
  cursor: { title: "Cursor / pan", svg: ICON.cursor },
  trend_line: { title: "Trend line", svg: ICON.trend },
  horizontal_line: { title: "Horizontal line", svg: ICON.hline },
  fib_retracement: { title: "Fib retracement", svg: ICON.fib },
  rectangle: { title: "Rectangle", svg: ICON.rect },
  text: { title: "Text", svg: ICON.text },
  indicators: { title: "Indicators", svg: ICON.indicators },
  fit: { title: "Fit content (F)", svg: ICON.fit },
  screenshot: { title: "Screenshot", svg: ICON.camera },
  fullscreen: { title: "Fullscreen", svg: ICON.fullscreen },
  chart_type: { title: "Chart type", svg: ICON.candles },
};

/** The stock layout — what you get with no `raze.sidebar` option. */
export const DEFAULT_SIDEBAR_ITEMS: SidebarItem[] = [
  "cursor", "trend_line", "horizontal_line", "fib_retracement", "rectangle", "text",
  "separator",
  "indicators",
  "separator",
  "fit", "screenshot", "fullscreen",
  "separator",
  "chart_type",
];

const ALL_CHART_STYLES: { id: ChartStyleId; title: string; svg: string }[] = [
  { id: "candles", title: "Candles", svg: ICON.candles },
  {
    id: "line",
    title: "Line",
    svg: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2.5 12.5L6.5 7.5L10 10.5L15.5 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  },
  {
    id: "area",
    title: "Area",
    svg: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2.5 13.5L6.5 8L10 11L15.5 4.5V13.5H2.5Z" fill="currentColor" opacity="0.35"/><path d="M2.5 13.5L6.5 8L10 11L15.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  },
  {
    id: "heikin_ashi",
    title: "Heikin Ashi",
    svg: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="4" y="5" width="4" height="8" rx="0.5" fill="currentColor"/><rect x="10" y="3" width="4" height="10" rx="0.5" fill="currentColor" opacity="0.55"/></svg>`,
  },
];

export class LeftSidebar {
  readonly el: HTMLDivElement;
  private toolBtns = new Map<string, HTMLButtonElement>();
  private styleBtn: HTMLButtonElement | null = null;
  private stylePanel: PopupHandle | null = null;
  private activeTool: DrawingTool = "cursor";
  private chartStyle: ChartStyleId = "candles";
  private readonly chartStyles: typeof ALL_CHART_STYLES;

  constructor(
    private readonly context: ChartContext,
    private readonly cbs: LeftSidebarCallbacks,
    items: SidebarItem[] = DEFAULT_SIDEBAR_ITEMS,
    chartTypes?: ChartStyleName[],
  ) {
    this.chartStyles = chartTypes
      ? ALL_CHART_STYLES.filter((s) => chartTypes.includes(s.id))
      : ALL_CHART_STYLES;

    this.el = document.createElement("div");
    this.el.className = "raze-chart-left-sidebar";
    this.el.style.cssText = [
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      `width:${LEFT_SIDEBAR_W}px`,
      "min-width:" + LEFT_SIDEBAR_W + "px",
      "box-sizing:border-box",
      "padding:6px 0",
      "gap:2px",
      "border-right:1px solid var(--tv-color-toolbar-divider-background, #363a45)",
      "background:var(--tv-color-platform-background, #181615)",
      "color:var(--tv-color-toolbar-button-text, #d1d4dc)",
      "user-select:none",
      "z-index:2",
      // Short containers scroll the toolbar instead of clipping it (the
      // scrollbar itself is hidden via the injected base stylesheet).
      "overflow-y:auto",
      "overflow-x:visible",
      "position:relative",
    ].join(";");

    for (const item of items) {
      this.appendItem(item);
    }

    this.setTool("cursor");
    this.setChartStyle("candles");
  }

  private appendItem(item: SidebarItem): void {
    if (item === "separator") {
      this.addSep();
      return;
    }
    if (typeof item !== "string") {
      this.appendCustom(item);
      return;
    }
    const def = BUILTIN[item];
    if (!def) {
      console.warn(`[raze-charts] unknown sidebar item: ${item}`);
      return;
    }
    if (item === "chart_type") {
      this.styleBtn = this.mkBtn(def.title, def.svg);
      this.styleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.stylePanel) this.closeStylePanel();
        else this.openStylePanel();
      });
      this.el.appendChild(this.styleBtn);
      return;
    }
    const b = this.mkBtn(def.title, def.svg);
    this.toolBtns.set(item, b);
    if (item === "indicators") {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cbs.onIndicatorsClick(b);
      });
    } else if (item === "fit") {
      b.addEventListener("click", (e) => { e.stopPropagation(); this.cbs.onFit(); });
    } else if (item === "screenshot") {
      b.addEventListener("click", (e) => { e.stopPropagation(); this.cbs.onScreenshot(); });
    } else if (item === "fullscreen") {
      b.addEventListener("click", (e) => { e.stopPropagation(); this.cbs.onFullscreen(); });
    } else {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setTool(item as DrawingTool);
        this.cbs.onTool(item as DrawingTool);
      });
    }
    this.el.appendChild(b);
  }

  private appendCustom(item: SidebarCustomItem): void {
    const b = this.mkBtn(item.title, item.icon);
    b.dataset.customId = item.id;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      try {
        item.onClick();
      } catch (err) {
        console.warn(`[raze-charts] sidebar item "${item.id}" onClick failed`, err);
      }
    });
    this.toolBtns.set(item.id, b);
    this.el.appendChild(b);
  }

  private mkBtn(title: string, svg: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.title = title;
    b.innerHTML = svg;
    const size = isCoarsePointer() ? 38 : 32;
    b.style.cssText = [
      "display:flex",
      "align-items:center",
      "justify-content:center",
      `width:${size}px`,
      `height:${size}px`,
      "border:0",
      "border-radius:6px",
      "background:transparent",
      "color:inherit",
      "cursor:pointer",
      "padding:0",
      "flex:0 0 auto",
      "touch-action:manipulation",
    ].join(";");
    b.addEventListener("mouseenter", () => {
      if (b.dataset.active !== "1") b.style.background = "rgba(255,255,255,0.06)";
    });
    b.addEventListener("mouseleave", () => {
      if (b.dataset.active !== "1") b.style.background = "transparent";
    });
    return b;
  }

  private addSep(): void {
    const s = document.createElement("div");
    s.style.cssText = "width:22px;height:1px;background:var(--tv-color-toolbar-divider-background,#363a45);margin:4px 0;";
    this.el.appendChild(s);
  }

  setTool(tool: DrawingTool): void {
    this.activeTool = tool;
    for (const [id, b] of this.toolBtns) {
      if (!TOOL_IDS.has(id)) continue;
      const on = id === tool;
      b.dataset.active = on ? "1" : "0";
      b.style.background = on ? "rgba(102,216,158,0.18)" : "transparent";
      b.style.color = on ? "#66d89e" : "inherit";
    }
  }

  getTool(): DrawingTool {
    return this.activeTool;
  }

  setChartStyle(style: ChartStyleId): void {
    this.chartStyle = style;
    if (!this.styleBtn) return;
    const def = this.chartStyles.find((s) => s.id === style) ?? ALL_CHART_STYLES.find((s) => s.id === style);
    if (!def) return;
    this.styleBtn.innerHTML = def.svg;
    this.styleBtn.title = `Chart type: ${def.title}`;
  }

  private openStylePanel(): void {
    if (!this.styleBtn) return;
    const popup = openPopup({
      fontFamily: this.context.fontFamily,
      className: "raze-chart-style-menu",
      minWidth: 140,
      padding: "6px 0",
      anchor: this.styleBtn,
      place: "right-start",
      onClose: () => {
        if (this.stylePanel === popup) this.stylePanel = null;
      },
    });
    this.stylePanel = popup;
    for (const s of this.chartStyles) {
      const on = s.id === this.chartStyle;
      const row = popupRow(
        `<span style="display:inline-flex;width:18px;color:${on ? "#66d89e" : "inherit"}">${s.svg}</span>${on ? "✓ " : ""}${s.title}`,
        () => {
          this.setChartStyle(s.id);
          this.cbs.onChartType(s.id);
          this.closeStylePanel();
        },
      );
      popup.el.appendChild(row);
    }
    popup.reposition();
  }

  private closeStylePanel(): void {
    this.stylePanel?.close();
    this.stylePanel = null;
  }

  destroy(): void {
    this.closeStylePanel();
    this.el.remove();
  }
}
